/**
 * Facebook Login web flow (GET /auth/facebook, GET /auth/facebook/callback).
 * Mirrors the "Google OAuth login/registration" describe block in
 * auth.test.ts and the TikTok suite's structure — kept in its own file
 * for the same reason (its own vi.mock, its own env-var scoping).
 *
 * Stubs only the network-touching exchangeCodeForFacebookProfile; every
 * other function runs for real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

vi.mock("../../lib/facebook-oauth", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/facebook-oauth")>();
  return { ...actual, exchangeCodeForFacebookProfile: vi.fn() };
});

const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions } = await import("@workspace/db/schema");
const { facebookOAuthLimiter } = await import("../../middleware/rate-limit");
const { exchangeCodeForFacebookProfile } = await import("../../lib/facebook-oauth");

const mockExchange = vi.mocked(exchangeCodeForFacebookProfile);

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `facebook-auth-test-${RUN_ID}`;
const seededIds: number[] = [];

function facebookEmail(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}-${randomBytes(4).toString("hex")}@example.test`;
}

async function createUser(email: string): Promise<{ id: number; email: string }> {
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Facebook Auth Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });
  seededIds.push(row.id);
  return { id: row.id, email };
}

const ENV_KEYS = ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "PUBLIC_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env["FACEBOOK_APP_ID"] = "test-facebook-app-id";
  process.env["FACEBOOK_APP_SECRET"] = "test-facebook-app-secret";
  process.env["PUBLIC_BASE_URL"] = "http://localhost:5173";
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (seededIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededIds));
    await db.delete(users).where(inArray(users.id, seededIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  mockExchange.mockReset();
  facebookOAuthLimiter.store.clear();
});

describe("GET /auth/facebook", () => {
  it("returns 503 when not configured", async () => {
    const saved = process.env["FACEBOOK_APP_ID"];
    delete process.env["FACEBOOK_APP_ID"];
    try {
      const res = await request(app).get("/api/auth/facebook");
      expect(res.status).toBe(503);
    } finally {
      process.env["FACEBOOK_APP_ID"] = saved;
    }
  });

  it("redirects to Facebook's consent screen and sets a state cookie", async () => {
    const res = await request(app).get("/api/auth/facebook");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("facebook.com");
    expect(res.headers["location"]).toContain(
      encodeURIComponent("http://localhost:5173/api/auth/facebook/callback"),
    );
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("fb_oauth_state=");
  });
});

describe("GET /auth/facebook/callback", () => {
  it("mismatched state redirects to /login?error=facebook", async () => {
    const res = await request(app)
      .get("/api/auth/facebook/callback?code=abc&state=WRONG")
      .set("Cookie", "fb_oauth_state=RIGHT");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=facebook");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("a Facebook account with no email redirects to /login?error=facebook_no_email", async () => {
    mockExchange.mockResolvedValue({
      facebookId: `fb-${randomBytes(6).toString("hex")}`,
      email: null,
      name: "No Email User",
    });
    const res = await request(app)
      .get("/api/auth/facebook/callback?code=abc&state=S1")
      .set("Cookie", "fb_oauth_state=S1");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=facebook_no_email");
  });

  it("callback for a brand-new Facebook user creates the account and sets a session cookie", async () => {
    const email = facebookEmail("new");
    const facebookId = `fb-${randomBytes(8).toString("hex")}`;
    mockExchange.mockResolvedValue({ facebookId, email, name: "New Facebook User" });

    const res = await request(app)
      .get("/api/auth/facebook/callback?code=abc&state=S2")
      .set("Cookie", "fb_oauth_state=S2");

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/dashboard");
    expect(String(res.headers["set-cookie"] ?? "")).toContain("session_token=");

    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row).toBeDefined();
    seededIds.push(row.id);
    expect(row.facebookId).toBe(facebookId);
    expect(row.passwordHash).toBeNull();
    expect(row.displayName).toBe("New Facebook User");
  });

  it("callback links Facebook to an existing password account with the same email", async () => {
    const existing = await createUser(facebookEmail("link"));
    const facebookId = `fb-${randomBytes(8).toString("hex")}`;
    mockExchange.mockResolvedValue({ facebookId, email: existing.email, name: "Linked User" });

    const before = await db
      .select({ c: users.id })
      .from(users)
      .where(like(users.email, `${EMAIL_PREFIX}%`));

    const res = await request(app)
      .get("/api/auth/facebook/callback?code=abc&state=S3")
      .set("Cookie", "fb_oauth_state=S3");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/dashboard");

    const [row] = await db.select().from(users).where(eq(users.id, existing.id)).limit(1);
    expect(row.facebookId).toBe(facebookId);
    expect(row.passwordHash).not.toBeNull();

    const after = await db
      .select({ c: users.id })
      .from(users)
      .where(like(users.email, `${EMAIL_PREFIX}%`));
    expect(after.length).toBe(before.length); // no new user row
  });

  it("callback rejects an email already linked to a different Facebook account", async () => {
    const existing = await createUser(facebookEmail("conflict"));
    const firstFacebookId = `fb-${randomBytes(8).toString("hex")}`;
    mockExchange.mockResolvedValueOnce({
      facebookId: firstFacebookId,
      email: existing.email,
      name: "First Link",
    });
    await request(app)
      .get("/api/auth/facebook/callback?code=abc&state=S4a")
      .set("Cookie", "fb_oauth_state=S4a");

    const secondFacebookId = `fb-${randomBytes(8).toString("hex")}`;
    mockExchange.mockResolvedValueOnce({
      facebookId: secondFacebookId,
      email: existing.email,
      name: "Second Attempt",
    });
    const res = await request(app)
      .get("/api/auth/facebook/callback?code=abc&state=S4b")
      .set("Cookie", "fb_oauth_state=S4b");

    expect(res.status).toBe(302);
    // fail() logs the specific "account_conflict" reason but redirects
    // with the default "facebook" error code (see routes/auth.ts) — same
    // convention as the Google web callback's conflict path.
    expect(res.headers["location"]).toBe("/login?error=facebook");
  });

  it("a failed code exchange redirects to /login?error=facebook", async () => {
    mockExchange.mockRejectedValue(new Error("boom"));
    const res = await request(app)
      .get("/api/auth/facebook/callback?code=abc&state=S5")
      .set("Cookie", "fb_oauth_state=S5");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=facebook");
  });
});
