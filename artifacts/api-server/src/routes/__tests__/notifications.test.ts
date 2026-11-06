import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like, and, isNull } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import {
  users,
  sessions,
  notifications,
} from "@workspace/db/schema";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `notif-test-${RUN_ID}`;
const TITLE_MARKER = `NotifTest-${RUN_ID}`;

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
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Notif Test ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `notif-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
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

async function seedNotification(userId: number, opts: { read?: boolean } = {}): Promise<number> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      title: `${TITLE_MARKER} Title`,
      message: `${TITLE_MARKER} Message ${randomBytes(4).toString("hex")}`,
      type: "info",
      readAt: opts.read ? new Date() : null,
    })
    .returning({ id: notifications.id });
  return row.id;
}

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("GET /notifications auth gate", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });

  it("returns 401 with a bogus bearer token", async () => {
    const res = await request(app)
      .get("/api/notifications")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

describe("GET /notifications ownership and filtering", () => {
  it("only returns notifications owned by the requesting user", async () => {
    await seedNotification(alice.id);
    await seedNotification(alice.id, { read: true });
    await seedNotification(bob.id);

    const res = await request(app)
      .get("/api/notifications")
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    for (const n of res.body.notifications) {
      expect(n.userId).toBe(alice.id);
    }
    // bob's row must never appear in alice's response.
    expect(res.body.notifications.find((n: { userId: number }) => n.userId === bob.id)).toBeUndefined();
  });

  it("filters to unread only when unreadOnly=true", async () => {
    // Reset alice's notifications to a known shape.
    await db.delete(notifications).where(eq(notifications.userId, alice.id));
    await seedNotification(alice.id);                 // unread
    await seedNotification(alice.id);                 // unread
    await seedNotification(alice.id, { read: true }); // read

    const all = await request(app)
      .get("/api/notifications")
      .set(...authHeader(alice));
    expect(all.body.notifications.length).toBe(3);

    const unread = await request(app)
      .get("/api/notifications?unreadOnly=true")
      .set(...authHeader(alice));
    expect(unread.body.notifications.length).toBe(2);
    for (const n of unread.body.notifications) {
      expect(n.readAt).toBeNull();
    }
  });

  it("orders results most-recent-first", async () => {
    await db.delete(notifications).where(eq(notifications.userId, alice.id));
    const idA = await seedNotification(alice.id);
    await new Promise((r) => setTimeout(r, 10));
    const idB = await seedNotification(alice.id);

    const res = await request(app)
      .get("/api/notifications")
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.notifications[0].id).toBe(idB);
    expect(res.body.notifications[1].id).toBe(idA);
  });
});

describe("PATCH /notifications/:id/read", () => {
  it("returns 401 without auth", async () => {
    const id = await seedNotification(alice.id);
    const res = await request(app).patch(`/api/notifications/${id}/read`);
    expect(res.status).toBe(401);
  });

  it("marks the notification as read for its owner", async () => {
    const id = await seedNotification(alice.id);
    const res = await request(app)
      .patch(`/api/notifications/${id}/read`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);

    const [row] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1);
    expect(row.readAt).not.toBeNull();
  });

  it("returns 404 (not 403) when a non-owner tries to mark someone else's notification as read", async () => {
    const id = await seedNotification(alice.id);
    const res = await request(app)
      .patch(`/api/notifications/${id}/read`)
      .set(...authHeader(bob));
    expect(res.status).toBe(404);

    // And critically, the notification stays unread.
    const [row] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1);
    expect(row.readAt).toBeNull();
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app)
      .patch(`/api/notifications/999999999/read`)
      .set(...authHeader(alice));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /notifications/read-all", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).patch("/api/notifications/read-all");
    expect(res.status).toBe(401);
  });

  it("marks all of the user's unread notifications as read; never touches other users", async () => {
    await db.delete(notifications).where(eq(notifications.userId, alice.id));
    await db.delete(notifications).where(eq(notifications.userId, bob.id));
    await seedNotification(alice.id);
    await seedNotification(alice.id);
    const bobUnread = await seedNotification(bob.id);

    const res = await request(app)
      .patch("/api/notifications/read-all")
      .set(...authHeader(alice));
    expect(res.status).toBe(200);

    const aliceUnread = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, alice.id), isNull(notifications.readAt)));
    expect(aliceUnread.length).toBe(0);

    // bob's notification still unread.
    const [bobRow] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, bobUnread))
      .limit(1);
    expect(bobRow.readAt).toBeNull();
  });
});
