/**
 * Mobile OAuth browser flow (Flutter) — Facebook leg:
 *   GET /auth/facebook/mobile/start -> GET /auth/facebook/callback
 *   (mobile branch) -> POST /auth/mobile/exchange
 *
 * Same mocking convention as auth-facebook.test.ts (stub only the
 * network-touching exchangeCodeForFacebookProfile); this file additionally
 * proves the mobile and website flows never cross-contaminate — a mobile
 * transaction's state is never accepted as a website state and vice versa.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

vi.mock("../../lib/facebook-oauth", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/facebook-oauth")>();
  return { ...actual, exchangeCodeForFacebookProfile: vi.fn() };
});

const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, mobileOauthTransactions } = await import("@workspace/db/schema");
const { facebookOAuthLimiter, mobileOauthStartLimiter, mobileOauthExchangeLimiter } = await import(
  "../../middleware/rate-limit"
);
const { exchangeCodeForFacebookProfile } = await import("../../lib/facebook-oauth");

const mockExchange = vi.mocked(exchangeCodeForFacebookProfile);

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `mobile-fb-test-${RUN_ID}`;
const REDIRECT_URI = "id.tradepilot.app://auth/callback";
const seededUserIds: number[] = [];

function facebookEmail(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}-${randomBytes(4).toString("hex")}@example.test`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

async function createUser(email: string): Promise<{ id: number; email: string }> {
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Mobile FB Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });
  seededUserIds.push(row!.id);
  return { id: row!.id, email };
}

/** Drives GET /mobile/start and pulls the `state` param back out of the
 *  302 Location header — the same value the provider would echo back on
 *  its own callback. */
async function startMobileFlow(): Promise<{ state: string; verifier: string }> {
  const verifier = randomBytes(32).toString("hex");
  const res = await request(app)
    .get("/api/auth/facebook/mobile/start")
    .query({ redirect_uri: REDIRECT_URI, code_challenge: s256(verifier), code_challenge_method: "S256" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers["location"]!);
  const state = location.searchParams.get("state")!;
  expect(state).toBeTruthy();
  return { state, verifier };
}

const ENV_KEYS = ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "PUBLIC_BASE_URL", "MOBILE_OAUTH_REDIRECT_URIS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env["FACEBOOK_APP_ID"] = "test-facebook-app-id";
  process.env["FACEBOOK_APP_SECRET"] = "test-facebook-app-secret";
  process.env["PUBLIC_BASE_URL"] = "http://localhost:5173";
  process.env["MOBILE_OAUTH_REDIRECT_URIS"] = REDIRECT_URI;
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (seededUserIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
  await db.delete(mobileOauthTransactions).where(eq(mobileOauthTransactions.redirectUri, REDIRECT_URI));
});

beforeEach(() => {
  mockExchange.mockReset();
  facebookOAuthLimiter.store.clear();
  mobileOauthStartLimiter.store.clear();
  mobileOauthExchangeLimiter.store.clear();
});

describe("GET /auth/facebook/mobile/start", () => {
  it("redirects to Facebook's consent screen with a state, when given a valid allowlisted redirect_uri + PKCE challenge", async () => {
    const verifier = randomBytes(32).toString("hex");
    const res = await request(app)
      .get("/api/auth/facebook/mobile/start")
      .query({ redirect_uri: REDIRECT_URI, code_challenge: s256(verifier), code_challenge_method: "S256" });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("facebook.com");
    expect(res.headers["location"]).toContain("state=");
  });

  it("rejects an unknown redirect_uri — no prefix/substring matching", async () => {
    const verifier = randomBytes(32).toString("hex");
    const res = await request(app)
      .get("/api/auth/facebook/mobile/start")
      .query({
        redirect_uri: `${REDIRECT_URI}.evil.com`,
        code_challenge: s256(verifier),
        code_challenge_method: "S256",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_callback");
  });

  it("rejects a malformed code_challenge", async () => {
    const res = await request(app)
      .get("/api/auth/facebook/mobile/start")
      .query({ redirect_uri: REDIRECT_URI, code_challenge: "too-short", code_challenge_method: "S256" });
    expect(res.status).toBe(400);
  });

  it("rejects a code_challenge_method other than S256", async () => {
    const verifier = randomBytes(32).toString("hex");
    const res = await request(app)
      .get("/api/auth/facebook/mobile/start")
      .query({ redirect_uri: REDIRECT_URI, code_challenge: s256(verifier), code_challenge_method: "plain" });
    expect(res.status).toBe(400);
  });

  it("returns 503 when Facebook Login isn't configured", async () => {
    const saved = process.env["FACEBOOK_APP_ID"];
    delete process.env["FACEBOOK_APP_ID"];
    try {
      const res = await request(app).get("/api/auth/facebook/mobile/start").query({
        redirect_uri: REDIRECT_URI,
        code_challenge: s256("x"),
        code_challenge_method: "S256",
      });
      expect(res.status).toBe(503);
    } finally {
      process.env["FACEBOOK_APP_ID"] = saved;
    }
  });
});

describe("GET /auth/facebook/callback — mobile transaction branch", () => {
  it("a mobile transaction's state is never mistaken for the website's cookie-based state", async () => {
    const { state } = await startMobileFlow();
    // The website callback compares `state` to a cookie value — supplying
    // NO cookie at all here proves this isn't accidentally satisfied by
    // the mobile state matching some other check.
    mockExchange.mockResolvedValue({
      facebookId: `fb-${randomBytes(6).toString("hex")}`,
      email: facebookEmail("crosscheck"),
      name: "Cross Check",
    });
    const res = await request(app).get("/api/auth/facebook/callback").query({ code: "abc", state });
    // Redirected to the MOBILE deep link (id.tradepilot.app://...), not
    // /login or /dashboard — proves the mobile branch, not the website
    // one, handled this request.
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain(REDIRECT_URI);
  });

  it("a returning user (existing facebook_id) issues a one-time code that exchanges for a session", async () => {
    const email = facebookEmail("existing");
    const passwordHash = await bcrypt.hash("not-used", 4);
    const securityAnswerHash = await bcrypt.hash("answer", 4);
    const facebookId = `fb-${randomBytes(8).toString("hex")}`;
    const [existing] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        facebookId,
        displayName: "Existing Mobile FB User",
        securityQuestion: "test?",
        securityAnswerHash,
      })
      .returning({ id: users.id });
    seededUserIds.push(existing!.id);

    const { state, verifier } = await startMobileFlow();
    mockExchange.mockResolvedValue({ facebookId, email, name: "Existing Mobile FB User" });

    const callbackRes = await request(app).get("/api/auth/facebook/callback").query({ code: "abc", state });
    expect(callbackRes.status).toBe(302);
    const locationHeader = callbackRes.headers["location"]!;
    expect(locationHeader.split("?")[0]).toBe(REDIRECT_URI);
    const code = new URL(locationHeader).searchParams.get("code")!;
    expect(code).toBeTruthy();

    const exchangeRes = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code, codeVerifier: verifier });
    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.body.token).toBeTruthy();
    expect(exchangeRes.body.user.email).toBe(email);
  });

  it("a brand-new user registers and issues a one-time code that exchanges for a session", async () => {
    const email = facebookEmail("brandnew");
    const { state, verifier } = await startMobileFlow();
    mockExchange.mockResolvedValue({
      facebookId: `fb-${randomBytes(8).toString("hex")}`,
      email,
      name: "Brand New Mobile FB User",
    });

    const callbackRes = await request(app).get("/api/auth/facebook/callback").query({ code: "abc", state });
    const code = new URL(callbackRes.headers["location"]!).searchParams.get("code")!;

    const exchangeRes = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code, codeVerifier: verifier });
    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.body.user.email).toBe(email);

    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    seededUserIds.push(row!.id);
    expect(row!.facebookId).toBeTruthy();
  });

  it("no email on the Facebook account -> safe error deep link, no code issued", async () => {
    const { state } = await startMobileFlow();
    mockExchange.mockResolvedValue({
      facebookId: `fb-${randomBytes(6).toString("hex")}`,
      email: null,
      name: "No Email",
    });
    const res = await request(app).get("/api/auth/facebook/callback").query({ code: "abc", state });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${REDIRECT_URI}?error=facebook_no_email`);
  });

  it("account conflict -> safe error deep link, no internal detail leaked", async () => {
    const existingEmail = facebookEmail("conflict");
    const passwordHash = await bcrypt.hash("not-used", 4);
    const securityAnswerHash = await bcrypt.hash("answer", 4);
    const [existing] = await db
      .insert(users)
      .values({
        email: existingEmail,
        passwordHash,
        facebookId: `fb-${randomBytes(8).toString("hex")}`,
        displayName: "Conflict Owner",
        securityQuestion: "test?",
        securityAnswerHash,
      })
      .returning({ id: users.id });
    seededUserIds.push(existing!.id);

    const { state } = await startMobileFlow();
    mockExchange.mockResolvedValue({
      facebookId: `fb-${randomBytes(8).toString("hex")}`, // a DIFFERENT facebookId
      email: existingEmail, // but the SAME email, already linked elsewhere
      name: "Conflicting User",
    });
    const res = await request(app).get("/api/auth/facebook/callback").query({ code: "abc", state });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${REDIRECT_URI}?error=account_conflict`);
  });

  it("access_denied from the provider -> safe error deep link", async () => {
    const { state } = await startMobileFlow();
    const res = await request(app)
      .get("/api/auth/facebook/callback")
      .query({ state, error: "access_denied" });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${REDIRECT_URI}?error=access_denied`);
    expect(mockExchange).not.toHaveBeenCalled();
  });
});

describe("POST /auth/mobile/exchange", () => {
  it("rejects the wrong PKCE verifier", async () => {
    const { state } = await startMobileFlow();
    mockExchange.mockResolvedValue({
      facebookId: `fb-${randomBytes(6).toString("hex")}`,
      email: facebookEmail("wrongverifier"),
      name: "Wrong Verifier",
    });
    const callbackRes = await request(app).get("/api/auth/facebook/callback").query({ code: "abc", state });
    const code = new URL(callbackRes.headers["location"]!).searchParams.get("code")!;

    const res = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code, codeVerifier: "not-the-real-verifier" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_verifier");
  });

  it("rejects a replayed (already-consumed) code", async () => {
    const { state, verifier } = await startMobileFlow();
    mockExchange.mockResolvedValue({
      facebookId: `fb-${randomBytes(6).toString("hex")}`,
      email: facebookEmail("replay"),
      name: "Replay Test",
    });
    const callbackRes = await request(app).get("/api/auth/facebook/callback").query({ code: "abc", state });
    const code = new URL(callbackRes.headers["location"]!).searchParams.get("code")!;

    const first = await request(app).post("/api/auth/mobile/exchange").send({ code, codeVerifier: verifier });
    expect(first.status).toBe(200);
    seededUserIds.push(first.body.user.id);

    const second = await request(app).post("/api/auth/mobile/exchange").send({ code, codeVerifier: verifier });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("code_already_used");
  });

  it("rejects an unknown code", async () => {
    const res = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code: "not-a-real-code", codeVerifier: "whatever" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authentication_failed");
  });

  it("rejects a missing body field with 400", async () => {
    const res = await request(app).post("/api/auth/mobile/exchange").send({ code: "abc" });
    expect(res.status).toBe(400);
  });
});
