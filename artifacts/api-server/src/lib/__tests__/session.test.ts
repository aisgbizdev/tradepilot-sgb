/**
 * lib/session.ts: single-session-per-account creation, the append-only
 * auth_events log it writes on every login/logout, and the "web" 15-minute
 * idle auto-logout in resolveSession — native/mobile sessions are exempt
 * (see the platform comment on the `sessions` schema).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db";
import { users, sessions, authEvents } from "@workspace/db/schema";
import { createSingleSession, resolveSession, endSession, WEB_IDLE_TIMEOUT_MS } from "../session";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `session-lib-test-${RUN_ID}`;
const seededUserIds: number[] = [];

async function seedUser(): Promise<number> {
  const email = `${EMAIL_PREFIX}-${randomBytes(4).toString("hex")}@example.test`;
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Session Lib Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });
  seededUserIds.push(row!.id);
  return row!.id;
}

afterAll(async () => {
  if (seededUserIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
});

describe("createSingleSession", () => {
  it("defaults to platform 'web' and logs a matching login auth event", async () => {
    const userId = await seedUser();
    const token = randomBytes(16).toString("hex");
    await createSingleSession(userId, token, new Date(Date.now() + 60_000));

    const [row] = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(row!.platform).toBe("web");

    const events = await db.select().from(authEvents).where(eq(authEvents.userId, userId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "login", platform: "web", reason: null });
  });

  it("records platform 'native' when passed explicitly", async () => {
    const userId = await seedUser();
    const token = randomBytes(16).toString("hex");
    await createSingleSession(userId, token, new Date(Date.now() + 60_000), "native");

    const [row] = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(row!.platform).toBe("native");

    const events = await db.select().from(authEvents).where(eq(authEvents.userId, userId));
    expect(events[0]).toMatchObject({ eventType: "login", platform: "native" });
  });
});

describe("resolveSession — web idle timeout", () => {
  it("resolves a fresh web session normally", async () => {
    const userId = await seedUser();
    const token = randomBytes(16).toString("hex");
    await createSingleSession(userId, token, new Date(Date.now() + 60_000));

    const resolved = await resolveSession(token);
    expect(resolved).toEqual({ userId });
  });

  it("invalidates a web session idle past the 15-minute threshold, deletes the row, and logs a logout with reason idle_timeout", async () => {
    const userId = await seedUser();
    const token = randomBytes(16).toString("hex");
    await createSingleSession(userId, token, new Date(Date.now() + 60 * 60 * 1000));
    await db
      .update(sessions)
      .set({ lastActivityAt: new Date(Date.now() - WEB_IDLE_TIMEOUT_MS - 1000) })
      .where(eq(sessions.userId, userId));

    const resolved = await resolveSession(token);
    expect(resolved).toBeNull();

    const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(0);

    const logoutEvents = await db
      .select()
      .from(authEvents)
      .where(and(eq(authEvents.userId, userId), eq(authEvents.eventType, "logout")));
    expect(logoutEvents).toHaveLength(1);
    expect(logoutEvents[0]).toMatchObject({ platform: "web", reason: "idle_timeout" });
  });

  it("does NOT idle-timeout a native session, no matter how stale lastActivityAt is", async () => {
    const userId = await seedUser();
    const token = randomBytes(16).toString("hex");
    await createSingleSession(userId, token, new Date(Date.now() + 60 * 60 * 1000), "native");
    await db
      .update(sessions)
      .set({ lastActivityAt: new Date(Date.now() - WEB_IDLE_TIMEOUT_MS * 10) })
      .where(eq(sessions.userId, userId));

    const resolved = await resolveSession(token);
    expect(resolved).toEqual({ userId });

    const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("bumps lastActivityAt on a stale-but-not-yet-expired web session", async () => {
    const userId = await seedUser();
    const token = randomBytes(16).toString("hex");
    await createSingleSession(userId, token, new Date(Date.now() + 60 * 60 * 1000));
    const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000);
    await db.update(sessions).set({ lastActivityAt: staleTimestamp }).where(eq(sessions.userId, userId));

    const resolved = await resolveSession(token);
    expect(resolved).toEqual({ userId });

    const [row] = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(row!.lastActivityAt.getTime()).toBeGreaterThan(staleTimestamp.getTime());
  });

  it("returns null for an unknown token without throwing", async () => {
    const resolved = await resolveSession("not-a-real-token");
    expect(resolved).toBeNull();
  });
});

describe("endSession", () => {
  it("deletes the session and logs a logout event with the session's own platform", async () => {
    const userId = await seedUser();
    const token = randomBytes(16).toString("hex");
    await createSingleSession(userId, token, new Date(Date.now() + 60_000), "native");

    await endSession(token, "user_initiated");

    const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(0);

    const logoutEvents = await db
      .select()
      .from(authEvents)
      .where(and(eq(authEvents.userId, userId), eq(authEvents.eventType, "logout")));
    expect(logoutEvents).toHaveLength(1);
    expect(logoutEvents[0]).toMatchObject({ platform: "native", reason: "user_initiated" });
  });

  it("is a no-op for an unknown token", async () => {
    await expect(endSession("not-a-real-token")).resolves.toBeUndefined();
  });
});
