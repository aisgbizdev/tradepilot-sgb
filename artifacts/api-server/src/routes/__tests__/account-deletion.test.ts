import { describe, it, expect, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users, sessions } from "@workspace/db/schema";
import { accountDeletionLimiter } from "../../middleware/rate-limit";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `acct-del-${RUN_ID}`;
const SECURITY_QUESTION = "Nama hewan peliharaan pertama kamu?";
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
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Acct Del ${RUN_ID} ${suffix}`,
      securityQuestion: SECURITY_QUESTION,
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `${EMAIL_PREFIX}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  seededIds.push(row.id);
  return { id: row.id, email, token };
}

afterAll(async () => {
  if (seededIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededIds));
    await db.delete(users).where(inArray(users.id, seededIds));
  }
  // Sweep prefix-tagged residue from any failed tests (defense in depth) —
  // most rows should already be gone via the endpoint under test itself.
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  // Limiter store is a module-scoped Map shared across all tests in this
  // file; supertest always connects from 127.0.0.1, so the per-IP fallback
  // key would otherwise bleed state across cases if a test ever ran
  // unauthenticated. Clear before every test for a clean budget.
  accountDeletionLimiter.store.clear();
});

describe("DELETE /auth/account", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app).delete("/api/auth/account").send({ currentPassword: PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rejects a missing/empty currentPassword with 400", async () => {
    const u = await createUser();
    const res = await request(app)
      .delete("/api/auth/account")
      .set("Authorization", `Bearer ${u.token}`)
      .send({});
    expect(res.status).toBe(400);

    // Nothing should have been deleted.
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, u.id));
    expect(row).toBeDefined();
  });

  it("rejects the wrong password with 401 and does not delete the account", async () => {
    const u = await createUser();
    const res = await request(app)
      .delete("/api/auth/account")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ currentPassword: "totally-wrong" });
    expect(res.status).toBe(401);

    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, u.id));
    expect(row).toBeDefined();
  });

  it("deletes the account with the correct password, and the deleted user's own token stops working", async () => {
    const u = await createUser();
    const res = await request(app)
      .delete("/api/auth/account")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ currentPassword: PASSWORD });
    expect(res.status).toBe(200);

    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, u.id));
    expect(row).toBeUndefined();

    // The session row is gone (cascaded), so the same token must now be
    // rejected rather than silently still authenticating.
    const followUp = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${u.token}`);
    expect(followUp.status).toBe(401);
  });

  it("deleting one user's account never affects another user's account or session", async () => {
    const a = await createUser();
    const b = await createUser();

    const res = await request(app)
      .delete("/api/auth/account")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ currentPassword: PASSWORD });
    expect(res.status).toBe(200);

    // User B is completely unaffected — their row and their session both
    // still work normally.
    const [bRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, b.id));
    expect(bRow).toBeDefined();

    const bMe = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${b.token}`);
    expect(bMe.status).toBe(200);
    expect(bMe.body.id).toBe(b.id);
  });

  it("rate-limits repeated deletion attempts per account", async () => {
    const u = await createUser();
    // 5 wrong-password attempts consume the limiter's budget (max: 5) without
    // ever deleting the account; the 6th must be rejected with 429 before
    // even reaching the password check.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .delete("/api/auth/account")
        .set("Authorization", `Bearer ${u.token}`)
        .send({ currentPassword: "wrong" });
      expect(res.status).toBe(401);
    }
    const limited = await request(app)
      .delete("/api/auth/account")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ currentPassword: "wrong" });
    expect(limited.status).toBe(429);

    // Still not deleted — every attempt used the wrong password.
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, u.id));
    expect(row).toBeDefined();
  });
});
