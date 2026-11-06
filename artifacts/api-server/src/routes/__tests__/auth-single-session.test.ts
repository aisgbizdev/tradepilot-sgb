/**
 * Only one active session per account (product decision — see chat):
 * logging in anywhere invalidates every other session for that user, so
 * a second concurrent login on another device signs the first one out.
 * Enforced centrally by lib/session.ts's createSingleSession, used by
 * every login/registration route. Covers the password login path here;
 * the OAuth suites (auth.test.ts's Google/Apple blocks, auth-tiktok,
 * auth-facebook) already exercise the same helper for their own flows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions } = await import("@workspace/db/schema");
const { loginLimiter } = await import("../../middleware/rate-limit");

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `single-session-test-${RUN_ID}`;
const PASSWORD = "Correct123";
const seededIds: number[] = [];

async function createUser(): Promise<{ id: number; email: string }> {
  const email = `${EMAIL_PREFIX}-${randomBytes(6).toString("hex")}@example.test`;
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Single Session Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });
  seededIds.push(row.id);
  return { id: row.id, email };
}

afterAll(async () => {
  if (seededIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededIds));
    await db.delete(users).where(inArray(users.id, seededIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  loginLimiter.store.clear();
});

describe("single active session per account", () => {
  it("a second login invalidates the first session's token", async () => {
    const user = await createUser();

    const first = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    expect(first.status).toBe(200);
    const firstToken = first.body.token as string;

    const meBefore = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${firstToken}`);
    expect(meBefore.status).toBe(200);

    const second = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    expect(second.status).toBe(200);
    const secondToken = second.body.token as string;
    expect(secondToken).not.toBe(firstToken);

    const meAfterFirst = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${firstToken}`);
    expect(meAfterFirst.status).toBe(401);

    const meAfterSecond = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${secondToken}`);
    expect(meAfterSecond.status).toBe(200);
  });

  it("only ever keeps one session row for the user, regardless of how many times they log in", async () => {
    const user = await createUser();

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: user.email, password: PASSWORD });
      expect(res.status).toBe(200);
    }

    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
  });
});

describe("web session 15-minute idle auto-logout", () => {
  it("a web session idle for over 15 minutes is rejected on its next request and removed", async () => {
    const user = await createUser();
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const token = login.body.token as string;

    await db
      .update(sessions)
      .set({ lastActivityAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(sessions.userId, user.id));

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);

    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("a web session active within the last 15 minutes still works", async () => {
    const user = await createUser();
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: PASSWORD });
    const token = login.body.token as string;

    await db
      .update(sessions)
      .set({ lastActivityAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(sessions.userId, user.id));

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
