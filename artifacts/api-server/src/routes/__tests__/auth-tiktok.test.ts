/**
 * TikTok Login Kit web flow (GET /auth/tiktok, GET /auth/tiktok/callback,
 * GET /auth/tiktok/pending-signup, POST /auth/tiktok/complete-signup).
 *
 * Kept in its own file (mirrors the pattern used for the credit-quota and
 * timeframe-switch-bonus suites) rather than added to the already-large
 * auth.test.ts, since it needs its own vi.mock of lib/tiktok-oauth and its
 * own env-var scoping for TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET.
 *
 * Stubs only the network-touching exchangeCodeForTiktokProfile — every
 * other function (buildTiktokAuthUrl, generateCodeVerifier,
 * isTiktokOAuthConfigured) runs for real, same convention as the Google/
 * Apple suites.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";

vi.mock("../../lib/tiktok-oauth", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/tiktok-oauth")>();
  return { ...actual, exchangeCodeForTiktokProfile: vi.fn() };
});

const request_ = request;
const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, pendingTiktokSignups } = await import("@workspace/db/schema");
const { tiktokOAuthLimiter, tiktokCompleteSignupLimiter } = await import("../../middleware/rate-limit");
const { exchangeCodeForTiktokProfile } = await import("../../lib/tiktok-oauth");

const mockExchange = vi.mocked(exchangeCodeForTiktokProfile);

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `tiktok-auth-test-${RUN_ID}`;
const seededIds: number[] = [];

function tiktokProfile(over: Partial<{ tiktokId: string; displayName: string | null; avatarUrl: string | null }> = {}) {
  return {
    tiktokId: over.tiktokId ?? `tt-${randomBytes(8).toString("hex")}`,
    displayName: over.displayName === undefined ? "TikTok User" : over.displayName,
    avatarUrl: over.avatarUrl === undefined ? "https://example.test/avatar.png" : over.avatarUrl,
  };
}

const ENV_KEYS = ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "PUBLIC_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env["TIKTOK_CLIENT_KEY"] = "test-tiktok-client-key";
  process.env["TIKTOK_CLIENT_SECRET"] = "test-tiktok-client-secret";
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
  await db.delete(pendingTiktokSignups).where(like(pendingTiktokSignups.tiktokId, "tt-%"));
});

beforeEach(() => {
  mockExchange.mockReset();
  tiktokOAuthLimiter.store.clear();
  tiktokCompleteSignupLimiter.store.clear();
});

describe("GET /auth/tiktok", () => {
  it("returns 503 when not configured", async () => {
    const saved = process.env["TIKTOK_CLIENT_KEY"];
    delete process.env["TIKTOK_CLIENT_KEY"];
    try {
      const res = await request_(app).get("/api/auth/tiktok");
      expect(res.status).toBe(503);
    } finally {
      process.env["TIKTOK_CLIENT_KEY"] = saved;
    }
  });

  it("redirects to TikTok's consent screen with PKCE + state cookies", async () => {
    const res = await request_(app).get("/api/auth/tiktok");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("tiktok.com");
    expect(res.headers["location"]).toContain("code_challenge=");
    expect(res.headers["location"]).toContain(
      encodeURIComponent("http://localhost:5173/api/auth/tiktok/callback"),
    );
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("tt_oauth_state=");
    expect(setCookie).toContain("tt_oauth_verifier=");
  });
});

describe("GET /auth/tiktok/callback", () => {
  it("mismatched state redirects to /login?error=tiktok", async () => {
    const res = await request_(app)
      .get("/api/auth/tiktok/callback?code=abc&state=WRONG")
      .set("Cookie", ["tt_oauth_state=RIGHT", "tt_oauth_verifier=v"]);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=tiktok");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("a brand-new TikTok sign-in issues a pending-signup cookie and redirects to complete-signup, without creating a user", async () => {
    const profile = tiktokProfile({ displayName: "Baru Di Sini" });
    mockExchange.mockResolvedValue(profile);

    const res = await request_(app)
      .get("/api/auth/tiktok/callback?code=abc&state=S1")
      .set("Cookie", ["tt_oauth_state=S1", "tt_oauth_verifier=v1"]);

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/auth/tiktok/complete-signup");
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("tt_pending_signup=");
    expect(setCookie).not.toContain("session_token=");

    const byTiktokId = await db
      .select()
      .from(users)
      .where(eq(users.tiktokId, profile.tiktokId));
    expect(byTiktokId).toHaveLength(0);
  });

  it("a returning TikTok user (existing tiktok_id) logs straight in with a session cookie", async () => {
    const tiktokId = `tt-${randomBytes(8).toString("hex")}`;
    const email = `${EMAIL_PREFIX}-return-${randomBytes(4).toString("hex")}@example.test`;
    const [existing] = await db
      .insert(users)
      .values({
        email,
        tiktokId,
        tiktokDisplayName: "Old Name",
        displayName: "Returning TikTok User",
        selectedMode: "pro",
      })
      .returning();
    seededIds.push(existing.id);

    mockExchange.mockResolvedValue(
      tiktokProfile({ tiktokId, displayName: "Updated Name" }),
    );

    const res = await request_(app)
      .get("/api/auth/tiktok/callback?code=abc&state=S2")
      .set("Cookie", ["tt_oauth_state=S2", "tt_oauth_verifier=v2"]);

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/dashboard");
    expect(String(res.headers["set-cookie"] ?? "")).toContain("session_token=");

    const [row] = await db.select().from(users).where(eq(users.id, existing.id)).limit(1);
    // Display name/avatar refreshed on every login (the actual product
    // goal of this feature) even though the account itself is unchanged.
    expect(row.tiktokDisplayName).toBe("Updated Name");
  });

  it("a failed code exchange redirects to /login?error=tiktok", async () => {
    mockExchange.mockRejectedValue(new Error("boom"));
    const res = await request_(app)
      .get("/api/auth/tiktok/callback?code=abc&state=S3")
      .set("Cookie", ["tt_oauth_state=S3", "tt_oauth_verifier=v3"]);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=tiktok");
  });
});

describe("GET /auth/tiktok/pending-signup + POST /auth/tiktok/complete-signup", () => {
  async function startPendingSignup(profile = tiktokProfile()) {
    mockExchange.mockResolvedValueOnce(profile);
    const callbackRes = await request_(app)
      .get(`/api/auth/tiktok/callback?code=abc&state=P-${profile.tiktokId}`)
      .set("Cookie", [`tt_oauth_state=P-${profile.tiktokId}`, "tt_oauth_verifier=vp"]);
    const rawCookies = callbackRes.headers["set-cookie"];
    const cookieList = Array.isArray(rawCookies) ? rawCookies : [String(rawCookies ?? "")];
    const pendingCookie = cookieList.find((c) => c.startsWith("tt_pending_signup="))!;
    return { profile, pendingCookie: pendingCookie.split(";")[0] };
  }

  it("GET pending-signup returns 404 with no cookie", async () => {
    const res = await request_(app).get("/api/auth/tiktok/pending-signup");
    expect(res.status).toBe(404);
  });

  it("GET pending-signup returns the display name for a valid pending cookie, never the tiktok_id", async () => {
    const { pendingCookie } = await startPendingSignup(tiktokProfile({ displayName: "Sultan Trading" }));
    const res = await request_(app)
      .get("/api/auth/tiktok/pending-signup")
      .set("Cookie", pendingCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayName: "Sultan Trading", avatarUrl: "https://example.test/avatar.png" });
    expect(JSON.stringify(res.body)).not.toContain("tt-");
  });

  it("POST complete-signup with no pending cookie is rejected", async () => {
    const res = await request_(app)
      .post("/api/auth/tiktok/complete-signup")
      .send({ email: "nobody@example.test" });
    expect(res.status).toBe(400);
  });

  it("POST complete-signup creates the account, captures the TikTok profile, and sets a session cookie", async () => {
    const { profile, pendingCookie } = await startPendingSignup(
      tiktokProfile({ displayName: "Fresh Signup" }),
    );
    const email = `${EMAIL_PREFIX}-complete-${randomBytes(4).toString("hex")}@example.test`;

    const res = await request_(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(String(res.headers["set-cookie"] ?? "")).toContain("session_token=");

    const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row).toBeDefined();
    seededIds.push(row.id);
    expect(row.tiktokId).toBe(profile.tiktokId);
    expect(row.tiktokDisplayName).toBe("Fresh Signup");
    expect(row.passwordHash).toBeNull();
  });

  it("POST complete-signup rejects an email that's already registered", async () => {
    const existingEmail = `${EMAIL_PREFIX}-taken-${randomBytes(4).toString("hex")}@example.test`;
    const [existing] = await db
      .insert(users)
      .values({ email: existingEmail, displayName: "Existing", selectedMode: "pro" })
      .returning();
    seededIds.push(existing.id);

    const { pendingCookie } = await startPendingSignup();
    const res = await request_(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email: existingEmail });

    expect(res.status).toBe(409);
  });

  it("the pending token is single-use — a second complete-signup attempt with the same cookie fails", async () => {
    const { pendingCookie } = await startPendingSignup();
    const email1 = `${EMAIL_PREFIX}-once1-${randomBytes(4).toString("hex")}@example.test`;
    const email2 = `${EMAIL_PREFIX}-once2-${randomBytes(4).toString("hex")}@example.test`;

    const first = await request_(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email: email1 });
    expect(first.status).toBe(201);
    seededIds.push(first.body.user.id);

    const second = await request_(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email: email2 });
    expect(second.status).toBe(400);
  });

  it("rejects an invalid email", async () => {
    const { pendingCookie } = await startPendingSignup();
    const res = await request_(app)
      .post("/api/auth/tiktok/complete-signup")
      .set("Cookie", pendingCookie)
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});
