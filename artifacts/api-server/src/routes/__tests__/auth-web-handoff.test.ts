/**
 * Mobile-app-to-browser session handoff:
 *   POST /auth/web-handoff (Bearer) -> GET /auth/web-handoff/consume (no auth)
 *
 * Mirrors account-deletion.test.ts's plain user+session seeding (no OAuth
 * provider mocking needed here). See lib/web-handoff.ts for the one-time
 * code issue/consume logic this exercises end to end against the real DB.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users, sessions, webHandoffCodes } from "@workspace/db/schema";
import { webHandoffIssueLimiter, webHandoffConsumeLimiter } from "../../middleware/rate-limit";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `web-handoff-test-${RUN_ID}`;
const PASSWORD = "Correct123";
const seededIds: number[] = [];

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

async function createUser(): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash, displayName: `Handoff ${RUN_ID} ${suffix}` })
    .returning({ id: users.id });

  // Seeded "native" app session the Bearer token belongs to — the whole
  // point of createHandoffSession is to leave this row alone.
  const token = `${EMAIL_PREFIX}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row!.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    platform: "native",
  });

  seededIds.push(row!.id);
  return { id: row!.id, email, token };
}

async function extractCode(res: request.Response): Promise<string> {
  const url = new URL(res.body.url);
  return url.searchParams.get("code")!;
}

afterAll(async () => {
  if (seededIds.length > 0) {
    await db.delete(webHandoffCodes).where(inArray(webHandoffCodes.userId, seededIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededIds));
    await db.delete(users).where(inArray(users.id, seededIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  // Limiter stores are module-scoped Maps shared across every test in this
  // file; supertest always connects from 127.0.0.1, so a leftover bucket
  // from a prior test would otherwise bleed into the next one.
  webHandoffIssueLimiter.store.clear();
  webHandoffConsumeLimiter.store.clear();
});

describe("POST /auth/web-handoff", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).post("/api/auth/web-handoff").send({ next: "/topup" });
    expect(res.status).toBe(401);
  });

  it("rejects next paths outside the allowlist with 400", async () => {
    const u = await createUser();
    for (const next of [
      "https://evil.com/topup",
      "//evil.com/topup",
      "/topup/../../etc/passwd",
      "/not-allowed",
      "topup",
      "",
    ]) {
      // Isolate from webHandoffIssueLimiter's 5/min budget — this test is
      // about the allowlist check, not the rate limiter (covered below).
      webHandoffIssueLimiter.store.clear();
      const res = await request(app)
        .post("/api/auth/web-handoff")
        .set("Authorization", `Bearer ${u.token}`)
        .send({ next });
      expect(res.status).toBe(400);
    }
  });

  it("mints a URL whose code sets the cookie and redirects to next on consume", async () => {
    const u = await createUser();
    const issueRes = await request(app)
      .post("/api/auth/web-handoff")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ next: "/topup" });
    expect(issueRes.status).toBe(201);
    expect(issueRes.body.expiresIn).toBe(60);
    expect(issueRes.body.url).toContain("/api/auth/web-handoff/consume?code=");

    const code = await extractCode(issueRes);
    const consumeRes = await request(app).get("/api/auth/web-handoff/consume").query({ code });
    expect(consumeRes.status).toBe(302);
    expect(consumeRes.headers["location"]).toBe("/topup");
    expect(consumeRes.headers["set-cookie"]?.[0]).toContain("session_token=");
    expect(consumeRes.headers["cache-control"]).toBe("no-store");
    expect(consumeRes.headers["referrer-policy"]).toBe("no-referrer");

    // The resulting cookie actually authenticates as this user.
    const cookie = consumeRes.headers["set-cookie"]![0]!.split(";")[0]!;
    const meRes = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meRes.status).toBe(200);
    expect(meRes.body.id).toBe(u.id);
  });

  it("accepts the /topup?source=app variant for the mobile-app return flow", async () => {
    const u = await createUser();
    const issueRes = await request(app)
      .post("/api/auth/web-handoff")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ next: "/topup?source=app" });
    expect(issueRes.status).toBe(201);

    const code = await extractCode(issueRes);
    const consumeRes = await request(app).get("/api/auth/web-handoff/consume").query({ code });
    expect(consumeRes.status).toBe(302);
    expect(consumeRes.headers["location"]).toBe("/topup?source=app");
  });

  it("leaves the native session that requested the handoff intact", async () => {
    const u = await createUser();
    const issueRes = await request(app)
      .post("/api/auth/web-handoff")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ next: "/topup" });
    const code = await extractCode(issueRes);
    await request(app).get("/api/auth/web-handoff/consume").query({ code });

    // The Bearer token from the native session must still work — the
    // whole point of createHandoffSession over createSingleSession.
    const meRes = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${u.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.id).toBe(u.id);
  });

  it("rejects a code used twice, redirecting to /login?error=handoff_expired", async () => {
    const u = await createUser();
    const issueRes = await request(app)
      .post("/api/auth/web-handoff")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ next: "/topup" });
    const code = await extractCode(issueRes);

    const first = await request(app).get("/api/auth/web-handoff/consume").query({ code });
    expect(first.status).toBe(302);
    expect(first.headers["location"]).toBe("/topup");

    const second = await request(app).get("/api/auth/web-handoff/consume").query({ code });
    expect(second.status).toBe(302);
    expect(second.headers["location"]).toBe("/login?error=handoff_expired");
  });

  it("rejects an expired code", async () => {
    const u = await createUser();
    const issueRes = await request(app)
      .post("/api/auth/web-handoff")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ next: "/topup" });
    const code = await extractCode(issueRes);

    // Force-expire the row directly rather than waiting out the real 60s TTL.
    await db.update(webHandoffCodes).set({ expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).get("/api/auth/web-handoff/consume").query({ code });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=handoff_expired");
  });

  it("two parallel consume attempts for the same code: exactly one succeeds", async () => {
    const u = await createUser();
    const issueRes = await request(app)
      .post("/api/auth/web-handoff")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ next: "/topup" });
    const code = await extractCode(issueRes);

    const [a, b] = await Promise.all([
      request(app).get("/api/auth/web-handoff/consume").query({ code }),
      request(app).get("/api/auth/web-handoff/consume").query({ code }),
    ]);
    const outcomes = [a, b].map((r) => r.headers["location"]);
    expect(outcomes.filter((loc) => loc === "/topup")).toHaveLength(1);
    expect(outcomes.filter((loc) => loc === "/login?error=handoff_expired")).toHaveLength(1);
  });

  it("rejects an unknown/random code without a 500", async () => {
    const res = await request(app)
      .get("/api/auth/web-handoff/consume")
      .query({ code: randomBytes(32).toString("base64url") });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=handoff_expired");
  });

  it("rate limits repeated issue attempts for the same user", async () => {
    const u = await createUser();
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/web-handoff")
        .set("Authorization", `Bearer ${u.token}`)
        .send({ next: "/topup" });
      lastStatus = res.status;
      if (res.status === 429) {
        expect(res.headers["retry-after"]).toBeDefined();
        break;
      }
    }
    expect(lastStatus).toBe(429);
  });
});
