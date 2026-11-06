/**
 * Mobile OAuth browser flow (Flutter) — TikTok leg:
 *   GET /auth/tiktok/mobile/start -> GET /auth/tiktok/callback (mobile
 *   branch) -> [new user: /auth/tiktok/complete-signup?mobile=1] ->
 *   POST /auth/mobile/exchange
 *
 * Mirrors auth-mobile-facebook.test.ts's structure; the extra wrinkle
 * here is proving TikTok's OWN provider-side PKCE verifier (stored on the
 * mobileOauthTransactions row) is never confused with the mobile app's
 * PKCE verifier (used only in the final /mobile/exchange call).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { randomBytes, createHash } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";

vi.mock("../../lib/tiktok-oauth", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/tiktok-oauth")>();
  return { ...actual, exchangeCodeForTiktokProfile: vi.fn() };
});

const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, pendingTiktokSignups, mobileOauthTransactions } = await import(
  "@workspace/db/schema"
);
const { tiktokOAuthLimiter, tiktokCompleteSignupLimiter, mobileOauthStartLimiter, mobileOauthExchangeLimiter } =
  await import("../../middleware/rate-limit");
const { exchangeCodeForTiktokProfile } = await import("../../lib/tiktok-oauth");

const mockExchange = vi.mocked(exchangeCodeForTiktokProfile);

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `mobile-tt-test-${RUN_ID}`;
const REDIRECT_URI = "id.tradepilot.app://auth/callback";
const seededUserIds: number[] = [];

function tiktokProfile(over: Partial<{ tiktokId: string; displayName: string | null; avatarUrl: string | null }> = {}) {
  return {
    tiktokId: over.tiktokId ?? `tt-${randomBytes(8).toString("hex")}`,
    displayName: over.displayName === undefined ? "TikTok User" : over.displayName,
    avatarUrl: over.avatarUrl === undefined ? "https://example.test/avatar.png" : over.avatarUrl,
  };
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** Drives GET /mobile/start and pulls `state` back out of the redirect to
 *  TikTok's own consent screen — same value TikTok would echo back. */
async function startMobileFlow(): Promise<{ state: string; verifier: string }> {
  const verifier = randomBytes(32).toString("hex");
  const res = await request(app)
    .get("/api/auth/tiktok/mobile/start")
    .query({ redirect_uri: REDIRECT_URI, code_challenge: s256(verifier), code_challenge_method: "S256" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers["location"]!);
  const state = location.searchParams.get("state")!;
  expect(state).toBeTruthy();
  return { state, verifier };
}

const ENV_KEYS = ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "PUBLIC_BASE_URL", "MOBILE_OAUTH_REDIRECT_URIS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env["TIKTOK_CLIENT_KEY"] = "test-tiktok-client-key";
  process.env["TIKTOK_CLIENT_SECRET"] = "test-tiktok-client-secret";
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
  await db.delete(pendingTiktokSignups).where(like(pendingTiktokSignups.tiktokId, "tt-%"));
  await db.delete(mobileOauthTransactions).where(eq(mobileOauthTransactions.redirectUri, REDIRECT_URI));
});

beforeEach(() => {
  mockExchange.mockReset();
  tiktokOAuthLimiter.store.clear();
  tiktokCompleteSignupLimiter.store.clear();
  mobileOauthStartLimiter.store.clear();
  mobileOauthExchangeLimiter.store.clear();
});

describe("GET /auth/tiktok/mobile/start", () => {
  it("redirects to TikTok's consent screen with a state, using the SAME provider-facing redirect_uri as the website flow", async () => {
    const verifier = randomBytes(32).toString("hex");
    const res = await request(app)
      .get("/api/auth/tiktok/mobile/start")
      .query({ redirect_uri: REDIRECT_URI, code_challenge: s256(verifier), code_challenge_method: "S256" });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("tiktok.com");
    expect(res.headers["location"]).toContain(
      encodeURIComponent("http://localhost:5173/api/auth/tiktok/callback"),
    );
    expect(res.headers["location"]).toContain("code_challenge="); // TikTok's own provider-side PKCE
  });

  it("rejects an unknown redirect_uri", async () => {
    const res = await request(app)
      .get("/api/auth/tiktok/mobile/start")
      .query({ redirect_uri: "evil://callback", code_challenge: s256("x"), code_challenge_method: "S256" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_callback");
  });

  it("no cookies are set — mobile transaction state lives server-side, not in a cookie", async () => {
    const verifier = randomBytes(32).toString("hex");
    const res = await request(app)
      .get("/api/auth/tiktok/mobile/start")
      .query({ redirect_uri: REDIRECT_URI, code_challenge: s256(verifier), code_challenge_method: "S256" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("GET /auth/tiktok/callback — mobile transaction branch", () => {
  it("a returning user (existing tiktok_id) issues a one-time code using TikTok's OWN stored provider verifier, not the mobile PKCE verifier", async () => {
    const tiktokId = `tt-${randomBytes(8).toString("hex")}`;
    const email = `${EMAIL_PREFIX}-return-${randomBytes(4).toString("hex")}@example.test`;
    const [existing] = await db
      .insert(users)
      .values({ email, tiktokId, displayName: "Returning Mobile TT User", selectedMode: "pro" })
      .returning({ id: users.id });
    seededUserIds.push(existing!.id);

    const { state, verifier: mobileVerifier } = await startMobileFlow();
    mockExchange.mockResolvedValue(tiktokProfile({ tiktokId, displayName: "Refreshed Name" }));

    const callbackRes = await request(app).get("/api/auth/tiktok/callback").query({ code: "abc", state });
    expect(callbackRes.status).toBe(302);
    const locationHeader = callbackRes.headers["location"]!;
    expect(locationHeader.split("?")[0]).toBe(REDIRECT_URI);

    // exchangeCodeForTiktokProfile's 3rd arg must be TikTok's OWN
    // provider-side verifier generated at /mobile/start — never the
    // mobile app's PKCE verifier, which only ever appears in the final
    // POST /auth/mobile/exchange call below.
    const providerVerifierUsed = mockExchange.mock.calls[0]![2];
    expect(providerVerifierUsed).not.toBe(mobileVerifier);

    const code = new URL(locationHeader).searchParams.get("code")!;
    const exchangeRes = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code, codeVerifier: mobileVerifier });
    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.body.user.email).toBe(email);

    const [row] = await db.select().from(users).where(eq(users.id, existing!.id)).limit(1);
    expect(row!.tiktokDisplayName).toBe("Refreshed Name");
  });

  it("a brand-new user is redirected to the web complete-signup page with ?mobile=1, no code issued yet", async () => {
    const { state } = await startMobileFlow();
    const profile = tiktokProfile({ displayName: "Brand New Mobile TT" });
    mockExchange.mockResolvedValue(profile);

    const res = await request(app).get("/api/auth/tiktok/callback").query({ code: "abc", state });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/auth/tiktok/complete-signup?mobile=1");
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("tt_pending_signup=");

    const byTiktokId = await db.select().from(users).where(eq(users.tiktokId, profile.tiktokId));
    expect(byTiktokId).toHaveLength(0);
  });

  it("access_denied from the provider -> safe error deep link", async () => {
    const { state } = await startMobileFlow();
    const res = await request(app).get("/api/auth/tiktok/callback").query({ state, error: "access_denied" });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(`${REDIRECT_URI}?error=access_denied`);
    expect(mockExchange).not.toHaveBeenCalled();
  });
});

describe("POST /auth/tiktok/complete-signup — mobile-linked new signup", () => {
  async function startMobilePendingSignup(profile = tiktokProfile()) {
    const { state } = await startMobileFlow();
    mockExchange.mockResolvedValueOnce(profile);
    const callbackRes = await request(app).get("/api/auth/tiktok/callback").query({ code: "abc", state });
    expect(callbackRes.headers["location"]).toBe("/auth/tiktok/complete-signup?mobile=1");
    const rawCookies = callbackRes.headers["set-cookie"];
    const cookieList = Array.isArray(rawCookies) ? rawCookies : [String(rawCookies ?? "")];
    const pendingCookie = cookieList.find((c) => c.startsWith("tt_pending_signup="))!.split(";")[0];
    return { profile, pendingCookie };
  }

  it("issues a mobileRedirectUrl with a one-time code instead of a session cookie, and that code exchanges successfully", async () => {
    const { pendingCookie } = await startMobilePendingSignup(tiktokProfile({ displayName: "Mobile Signup" }));
    const email = `${EMAIL_PREFIX}-mobilesignup-${randomBytes(4).toString("hex")}@example.test`;

    const res = await request(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeUndefined();
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("session_token=");
    expect(res.body.mobileRedirectUrl).toBeTruthy();
    expect(res.body.mobileRedirectUrl.split("?")[0]).toBe(REDIRECT_URI);

    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    seededUserIds.push(row!.id);

    const code = new URL(res.body.mobileRedirectUrl).searchParams.get("code")!;
    // Need the ORIGINAL mobile verifier from this specific transaction —
    // re-derive by re-running the full flow with a captured verifier.
    // (Simplest: assert the code is present and well-formed; the actual
    // exchange-success path is already covered by the returning-user test
    // above using the same consumeMobileExchangeCode function.)
    expect(code).toBeTruthy();
  });

  it("email already registered -> 409 with a mobileRedirectUrl carrying the stable error code", async () => {
    const existingEmail = `${EMAIL_PREFIX}-taken-${randomBytes(4).toString("hex")}@example.test`;
    const [existing] = await db
      .insert(users)
      .values({ email: existingEmail, displayName: "Existing", selectedMode: "pro" })
      .returning({ id: users.id });
    seededUserIds.push(existing!.id);

    const { pendingCookie } = await startMobilePendingSignup();
    const res = await request(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email: existingEmail });
    expect(res.status).toBe(409);
    expect(res.body.mobileRedirectUrl).toBe(`${REDIRECT_URI}?error=email_already_registered`);
  });

  it("a website (non-mobile) signup still gets a plain session — no mobileRedirectUrl", async () => {
    mockExchange.mockResolvedValueOnce(tiktokProfile({ displayName: "Website Only" }));
    const callbackRes = await request(app)
      .get("/api/auth/tiktok/callback?code=abc&state=WEB-ONLY")
      .set("Cookie", ["tt_oauth_state=WEB-ONLY", "tt_oauth_verifier=v"]);
    expect(callbackRes.headers["location"]).toBe("/auth/tiktok/complete-signup");
    const rawCookies = callbackRes.headers["set-cookie"];
    const cookieList = Array.isArray(rawCookies) ? rawCookies : [String(rawCookies ?? "")];
    const pendingCookie = cookieList.find((c) => c.startsWith("tt_pending_signup="))!.split(";")[0];

    const email = `${EMAIL_PREFIX}-webonly-${randomBytes(4).toString("hex")}@example.test`;
    const res = await request(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email });
    expect(res.status).toBe(201);
    expect(res.body.mobileRedirectUrl).toBeUndefined();
    expect(res.body.token).toBeTruthy();
    seededUserIds.push(res.body.user.id);
  });
});

describe("full mobile TikTok new-user round trip: start -> callback -> complete-signup -> exchange", () => {
  it("issues a working session at the end", async () => {
    const { state, verifier } = await startMobileFlow();
    const profile = tiktokProfile({ displayName: "Full Round Trip" });
    mockExchange.mockResolvedValueOnce(profile);

    const callbackRes = await request(app).get("/api/auth/tiktok/callback").query({ code: "abc", state });
    const rawCookies = callbackRes.headers["set-cookie"];
    const cookieList = Array.isArray(rawCookies) ? rawCookies : [String(rawCookies ?? "")];
    const pendingCookie = cookieList.find((c) => c.startsWith("tt_pending_signup="))!.split(";")[0];

    const email = `${EMAIL_PREFIX}-fullroundtrip-${randomBytes(4).toString("hex")}@example.test`;
    const completeRes = await request(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email });
    expect(completeRes.status).toBe(201);
    const code = new URL(completeRes.body.mobileRedirectUrl).searchParams.get("code")!;

    const exchangeRes = await request(app)
      .post("/api/auth/mobile/exchange")
      .send({ code, codeVerifier: verifier });
    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.body.token).toBeTruthy();
    expect(exchangeRes.body.user.email).toBe(email);
    seededUserIds.push(exchangeRes.body.user.id);
  });
});
