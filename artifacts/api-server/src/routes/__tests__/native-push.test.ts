import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users, sessions, nativePushDevices } from "@workspace/db/schema";
import {
  nativePushRegisterLimiter,
  nativePushTestLimiter,
} from "../../middleware/rate-limit";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `native-push-${RUN_ID}`;

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const seededUserIds: number[] = [];
let alice: SeedUser;
let bob: SeedUser;

async function createUser(): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${suffix}@example.test`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await bcrypt.hash("not-used", 4),
      displayName: `Native Push ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash: await bcrypt.hash("answer", 4),
    })
    .returning({ id: users.id });

  const token = `${EMAIL_PREFIX}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

function authHeader(u: SeedUser): [string, string] {
  return ["Authorization", `Bearer ${u.token}`];
}

function fakeToken(label: string): string {
  // FCM tokens are long opaque strings; 20+ chars is all the schema
  // requires, so a randomized string comfortably clears the min length.
  return `${label}-${randomBytes(24).toString("hex")}`;
}

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(nativePushDevices).where(inArray(nativePushDevices.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  nativePushRegisterLimiter.store.clear();
  nativePushTestLimiter.store.clear();
});

describe("POST /native-push/register", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/native-push/register")
      .send({ token: fakeToken("anon"), platform: "android" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed (too short) token with 400", async () => {
    const res = await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token: "short", platform: "android" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid platform with 400", async () => {
    const res = await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token: fakeToken("bad-platform"), platform: "windows-phone" });
    expect(res.status).toBe(400);
  });

  it("rejects unknown body keys (strict schema)", async () => {
    const res = await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token: fakeToken("extra"), platform: "android", extra: "nope" });
    expect(res.status).toBe(400);
  });

  it("registers a new device and never echoes the token back in the response", async () => {
    const token = fakeToken("alice-phone");
    const res = await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token, platform: "android" });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(token);

    const [row] = await db
      .select()
      .from(nativePushDevices)
      .where(eq(nativePushDevices.token, token));
    expect(row).toBeTruthy();
    expect(row.userId).toBe(alice.id);
    expect(row.platform).toBe("android");
    expect(row.enabled).toBe(true);
    expect(row.lastSeenAt).toBeTruthy();
  });

  it("upserts on re-register: same token, updates lastSeenAt and platform", async () => {
    const token = fakeToken("alice-tablet");
    await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token, platform: "android" });

    const [first] = await db
      .select()
      .from(nativePushDevices)
      .where(eq(nativePushDevices.token, token));

    await new Promise((r) => setTimeout(r, 5));

    const res = await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token, platform: "ios" });
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(nativePushDevices)
      .where(eq(nativePushDevices.token, token));
    // Upsert, not a second row.
    expect(rows.length).toBe(1);
    expect(rows[0]!.platform).toBe("ios");
    expect(new Date(rows[0]!.lastSeenAt!).getTime()).toBeGreaterThan(
      new Date(first.lastSeenAt!).getTime(),
    );
  });

  it("transfers ownership when a different user registers the same device token", async () => {
    const token = fakeToken("shared-device");
    await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token, platform: "android" });

    // Device logs out of alice's account, bob logs in and registers the
    // same physical device token.
    const res = await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(bob))
      .send({ token, platform: "android" });
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(nativePushDevices)
      .where(eq(nativePushDevices.token, token));
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(bob.id);
  });
});

describe("DELETE /native-push/unregister", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .delete("/api/native-push/unregister")
      .send({ token: fakeToken("anon") });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed token with 400", async () => {
    const res = await request(app)
      .delete("/api/native-push/unregister")
      .set(...authHeader(alice))
      .send({ token: "x" });
    expect(res.status).toBe(400);
  });

  it("removes the caller's own device registration", async () => {
    const token = fakeToken("alice-to-remove");
    await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token, platform: "android" });

    const res = await request(app)
      .delete("/api/native-push/unregister")
      .set(...authHeader(alice))
      .send({ token });
    expect(res.status).toBe(200);

    const rows = await db.select().from(nativePushDevices).where(eq(nativePushDevices.token, token));
    expect(rows.length).toBe(0);
  });

  it("does NOT remove another user's device registration (ownership-scoped delete)", async () => {
    const token = fakeToken("bob-device");
    await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(bob))
      .send({ token, platform: "ios" });

    // Alice tries to unregister bob's token.
    const res = await request(app)
      .delete("/api/native-push/unregister")
      .set(...authHeader(alice))
      .send({ token });
    // Idempotent-style 200 (no error leaked about whose token it is), but
    // the row must still exist afterward — that's the real assertion.
    expect(res.status).toBe(200);

    const rows = await db.select().from(nativePushDevices).where(eq(nativePushDevices.token, token));
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(bob.id);
  });
});

describe("POST /native-push/test", () => {
  it("returns 404 when the caller has no registered mobile devices", async () => {
    const fresh = await createUser();
    const res = await request(app)
      .post("/api/native-push/test")
      .set(...authHeader(fresh));
    expect(res.status).toBe(404);
  });

  it("returns 503 (not a fake success) when Firebase isn't configured on the server", async () => {
    const u = await createUser();
    await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(u))
      .send({ token: fakeToken("test-ep"), platform: "android" });

    // FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY are unset in tests, so
    // the channel is genuinely unconfigured. The endpoint must say so
    // (503) rather than reporting devices-targeted as if that meant
    // anything was delivered.
    const res = await request(app)
      .post("/api/native-push/test")
      .set(...authHeader(u));
    expect(res.status).toBe(503);
  });

  it("rejects the request from a token/URL in the body — it accepts neither", async () => {
    const u = await createUser();
    await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(u))
      .send({ token: fakeToken("test-strict"), platform: "android" });

    // Extra body fields are simply ignored; the endpoint never reads a
    // token or url from the request. It still reaches the "not
    // configured" 503 (Firebase is unset in tests) rather than ever
    // acting on the attacker-supplied token/url.
    const res = await request(app)
      .post("/api/native-push/test")
      .set(...authHeader(u))
      .send({ token: "attacker-token", url: "https://evil.example" });
    expect(res.status).toBe(503);
  });

  it("requires auth", async () => {
    const res = await request(app).post("/api/native-push/test");
    expect(res.status).toBe(401);
  });
});

describe("POST /native-push/register rate limit", () => {
  it("returns 429 once the per-user quota is exhausted within the window", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post("/api/native-push/register")
        .set(...authHeader(alice))
        .send({ token: fakeToken(`burst-${i}`), platform: "android" });
      expect(res.status).toBe(201);
    }
    const blocked = await request(app)
      .post("/api/native-push/register")
      .set(...authHeader(alice))
      .send({ token: fakeToken("burst-over"), platform: "android" });
    expect(blocked.status).toBe(429);
  });
});
