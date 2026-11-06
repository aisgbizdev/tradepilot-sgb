import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, and, ilike, or } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import {
  users,
  sessions,
  notifications,
  userTags,
  broadcasts,
} from "@workspace/db/schema";

type Role = "user" | "admin" | "super_admin";

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const RUN_ID = randomBytes(4).toString("hex");
const TAG_TARGETED = `cc_test_${RUN_ID}_targeted`;
const TAG_EMPTY = `cc_test_${RUN_ID}_empty`;
const TAG_FOR_CRUD = `cc_test_${RUN_ID}_crud`;

const seeded: SeedUser[] = [];
let superAdmin: SeedUser;
let admin: SeedUser;
let regularUser: SeedUser;
let secondRegularUser: SeedUser;

async function createUser(role: Role): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `cc-test-${role}-${RUN_ID}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used-by-tests", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);

  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `CC Test ${role} ${suffix}`,
      role,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `cc-test-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt,
  });

  const seed: SeedUser = { id: row.id, email, token };
  seeded.push(seed);
  return seed;
}

function authHeader(user: SeedUser): [string, string] {
  return ["Authorization", `Bearer ${user.token}`];
}

beforeAll(async () => {
  superAdmin = await createUser("super_admin");
  admin = await createUser("admin");
  regularUser = await createUser("user");
  secondRegularUser = await createUser("user");

  // Seed user_tags so we can assert tag-based audience resolution.
  await db.insert(userTags).values([
    { userId: regularUser.id, tag: TAG_TARGETED },
    { userId: secondRegularUser.id, tag: TAG_TARGETED },
  ]);
});

afterAll(async () => {
  const ids = seeded.map((u) => u.id);

  // Clean up EVERYTHING our broadcasts touched, not just rows attached to
  // seeded users. Broadcasts of audienceType=all/role can fan out to real
  // (non-seeded) users on this shared DB, so we must purge by our RUN_ID
  // marker baked into every test broadcast title.
  const runMarker = `%${RUN_ID}%`;
  await db.delete(notifications).where(ilike(notifications.title, runMarker));
  await db.delete(broadcasts).where(ilike(broadcasts.title, runMarker));

  if (ids.length === 0) return;

  // Cascade safety net for any rows still tied to our seeded users.
  await db.delete(notifications).where(inArray(notifications.userId, ids));
  await db.delete(userTags).where(inArray(userTags.userId, ids));
  await db.delete(sessions).where(inArray(sessions.userId, ids));
  await db
    .delete(broadcasts)
    .where(
      or(
        inArray(broadcasts.senderId, ids),
        inArray(broadcasts.audienceValue, [TAG_TARGETED, TAG_EMPTY]),
      ),
    );
  await db.delete(users).where(inArray(users.id, ids));
});

describe("requireSuperAdmin gate", () => {
  it("GET /admin/broadcasts returns 401 without auth", async () => {
    const res = await request(app).get("/api/admin/broadcasts");
    expect(res.status).toBe(401);
  });

  it("GET /admin/broadcasts returns 403 for role=user", async () => {
    const res = await request(app)
      .get("/api/admin/broadcasts")
      .set(...authHeader(regularUser));
    expect(res.status).toBe(403);
  });

  it("GET /admin/broadcasts returns 403 for role=admin", async () => {
    const res = await request(app)
      .get("/api/admin/broadcasts")
      .set(...authHeader(admin));
    expect(res.status).toBe(403);
  });

  it("GET /admin/broadcasts returns 200 for role=super_admin", async () => {
    const res = await request(app)
      .get("/api/admin/broadcasts")
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.broadcasts)).toBe(true);
  });

  it("POST /admin/notifications returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .send({
        title: "Should not send",
        message: "Should not send",
        audienceType: "all",
      });
    expect(res.status).toBe(401);
  });

  it("POST /admin/notifications returns 403 for role=user", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(regularUser))
      .send({
        title: "Should not send",
        message: "Should not send",
        audienceType: "all",
      });
    expect(res.status).toBe(403);
  });

  it("POST /admin/notifications returns 403 for role=admin", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(admin))
      .send({
        title: "Should not send",
        message: "Should not send",
        audienceType: "all",
      });
    expect(res.status).toBe(403);
  });

  it("GET /superadmin/tags returns 403 for role=admin and 401 unauth", async () => {
    const r1 = await request(app).get("/api/superadmin/tags");
    expect(r1.status).toBe(401);

    const r2 = await request(app)
      .get("/api/superadmin/tags")
      .set(...authHeader(admin));
    expect(r2.status).toBe(403);
  });

  it("POST /superadmin/users/:id/tags returns 403 for role=admin", async () => {
    const res = await request(app)
      .post(`/api/superadmin/users/${regularUser.id}/tags`)
      .set(...authHeader(admin))
      .send({ tag: "nope" });
    expect(res.status).toBe(403);
  });

  it("POST /admin/notifications returns 201 for role=super_admin", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `Hello ${RUN_ID}`,
        message: "Body text",
        audienceType: "tag",
        audienceValue: TAG_TARGETED,
        type: "info",
      });
    expect(res.status).toBe(201);
    expect(typeof res.body.broadcastId).toBe("number");
  });
});

describe("POST /admin/notifications validation", () => {
  it("rejects empty title with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({ title: "", message: "Body", audienceType: "all" });
    expect(res.status).toBe(400);
  });

  it("rejects whitespace-only title with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({ title: "   ", message: "Body", audienceType: "all" });
    expect(res.status).toBe(400);
  });

  it("rejects empty message with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({ title: "Title", message: "", audienceType: "all" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid audienceType with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: "Title",
        message: "Body",
        audienceType: "everyone",
      });
    expect(res.status).toBe(400);
  });

  it("rejects invalid type with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: "Title",
        message: "Body",
        audienceType: "all",
        type: "critical",
      });
    expect(res.status).toBe(400);
  });
});

describe("audience resolution", () => {
  it("audienceType=all targets every user", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `All ${RUN_ID}`,
        message: "Body",
        audienceType: "all",
      });
    expect(res.status).toBe(201);
    const broadcastId: number = res.body.broadcastId;

    const [bRow] = await db
      .select({
        audienceType: broadcasts.audienceType,
        audienceValue: broadcasts.audienceValue,
        recipientCount: broadcasts.recipientCount,
      })
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId))
      .limit(1);
    expect(bRow.audienceType).toBe("all");
    expect(bRow.audienceValue).toBeNull();
    // Should include at least our 4 seeded users.
    expect(bRow.recipientCount).toBeGreaterThanOrEqual(4);
    expect(res.body.recipientCount).toBe(bRow.recipientCount);
  });

  it("audienceType=role filters by role", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `Role ${RUN_ID}`,
        message: "Body",
        audienceType: "role",
        audienceValue: "super_admin",
      });
    expect(res.status).toBe(201);

    const [bRow] = await db
      .select({
        audienceType: broadcasts.audienceType,
        audienceValue: broadcasts.audienceValue,
      })
      .from(broadcasts)
      .where(eq(broadcasts.id, res.body.broadcastId))
      .limit(1);
    expect(bRow.audienceType).toBe("role");
    expect(bRow.audienceValue).toBe("super_admin");

    // Our super_admin should have received the notification.
    const recvd = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, superAdmin.id),
          eq(notifications.title, `Role ${RUN_ID}`),
        ),
      );
    expect(recvd.length).toBe(1);

    // And the regular user should NOT have received it.
    const notRecvd = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, regularUser.id),
          eq(notifications.title, `Role ${RUN_ID}`),
        ),
      );
    expect(notRecvd.length).toBe(0);
  });

  it("audienceType=role rejects unknown role with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: "Title",
        message: "Body",
        audienceType: "role",
        audienceValue: "wizard",
      });
    expect(res.status).toBe(400);
  });

  it("audienceType=tag filters by tag membership", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `Tag ${RUN_ID}`,
        message: "Body",
        audienceType: "tag",
        audienceValue: TAG_TARGETED,
      });
    expect(res.status).toBe(201);
    expect(res.body.recipientCount).toBe(2);

    // Both tagged users should have a notification row.
    const tagged = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          inArray(notifications.userId, [
            regularUser.id,
            secondRegularUser.id,
          ]),
          eq(notifications.title, `Tag ${RUN_ID}`),
        ),
      );
    const taggedIds = new Set(tagged.map((r) => r.userId));
    expect(taggedIds.has(regularUser.id)).toBe(true);
    expect(taggedIds.has(secondRegularUser.id)).toBe(true);

    // Admin (no tag) should not have received it.
    const adminRecvd = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, admin.id),
          eq(notifications.title, `Tag ${RUN_ID}`),
        ),
      );
    expect(adminRecvd.length).toBe(0);
  });

  it("audienceType=role/tag without audienceValue returns 400", async () => {
    const r1 = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: "Title",
        message: "Body",
        audienceType: "role",
      });
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: "Title",
        message: "Body",
        audienceType: "tag",
        audienceValue: "   ",
      });
    expect(r2.status).toBe(400);
  });
});

describe("broadcast history insert", () => {
  it("records broadcast even when recipient count is 0", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `Empty ${RUN_ID}`,
        message: "Nobody",
        audienceType: "tag",
        audienceValue: TAG_EMPTY,
      });
    expect(res.status).toBe(201);
    expect(res.body.recipientCount).toBe(0);
    expect(typeof res.body.broadcastId).toBe("number");

    const [bRow] = await db
      .select({
        recipientCount: broadcasts.recipientCount,
        audienceValue: broadcasts.audienceValue,
        title: broadcasts.title,
      })
      .from(broadcasts)
      .where(eq(broadcasts.id, res.body.broadcastId))
      .limit(1);
    expect(bRow).toBeDefined();
    expect(bRow.recipientCount).toBe(0);
    expect(bRow.audienceValue).toBe(TAG_EMPTY);
    expect(bRow.title).toBe(`Empty ${RUN_ID}`);

    // No notification rows should have been written for this broadcast title.
    const written = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.title, `Empty ${RUN_ID}`));
    expect(written.length).toBe(0);
  });
});

describe("tag CRUD", () => {
  it("POST /superadmin/users/:id/tags adds a tag and is idempotent", async () => {
    const r1 = await request(app)
      .post(`/api/superadmin/users/${regularUser.id}/tags`)
      .set(...authHeader(superAdmin))
      .send({ tag: TAG_FOR_CRUD });
    expect(r1.status).toBe(200);
    expect(r1.body.tags).toContain(TAG_FOR_CRUD);

    const r2 = await request(app)
      .post(`/api/superadmin/users/${regularUser.id}/tags`)
      .set(...authHeader(superAdmin))
      .send({ tag: TAG_FOR_CRUD });
    expect(r2.status).toBe(200);
    // Still present, only once.
    const occurrences = r2.body.tags.filter(
      (t: string) => t === TAG_FOR_CRUD,
    ).length;
    expect(occurrences).toBe(1);

    const rows = await db
      .select({ id: userTags.id })
      .from(userTags)
      .where(
        and(
          eq(userTags.userId, regularUser.id),
          eq(userTags.tag, TAG_FOR_CRUD),
        ),
      );
    expect(rows.length).toBe(1);
  });

  it("POST rejects invalid tag with 400", async () => {
    const res = await request(app)
      .post(`/api/superadmin/users/${regularUser.id}/tags`)
      .set(...authHeader(superAdmin))
      .send({ tag: "" });
    expect(res.status).toBe(400);
  });

  it("DELETE /superadmin/users/:id/tags/:tag removes only the matching pair", async () => {
    // Ensure tag exists on regularUser only (secondRegularUser still has TAG_TARGETED).
    await db
      .insert(userTags)
      .values({ userId: regularUser.id, tag: TAG_FOR_CRUD })
      .onConflictDoNothing();

    const res = await request(app)
      .delete(
        `/api/superadmin/users/${regularUser.id}/tags/${TAG_FOR_CRUD}`,
      )
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.tags).not.toContain(TAG_FOR_CRUD);

    // The (regularUser, TAG_TARGETED) pair must NOT have been touched.
    const stillTargeted = await db
      .select({ id: userTags.id })
      .from(userTags)
      .where(
        and(
          eq(userTags.userId, regularUser.id),
          eq(userTags.tag, TAG_TARGETED),
        ),
      );
    expect(stillTargeted.length).toBe(1);

    // The (secondRegularUser, TAG_TARGETED) pair must NOT have been touched.
    const secondTargeted = await db
      .select({ id: userTags.id })
      .from(userTags)
      .where(
        and(
          eq(userTags.userId, secondRegularUser.id),
          eq(userTags.tag, TAG_TARGETED),
        ),
      );
    expect(secondTargeted.length).toBe(1);
  });

  it("GET /superadmin/tags returns distinct tags including ours", async () => {
    const res = await request(app)
      .get("/api/superadmin/tags")
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tags)).toBe(true);

    expect(res.body.tags).toContain(TAG_TARGETED);

    // Distinct: every tag appears at most once even though TAG_TARGETED is on
    // multiple users.
    const counts = new Map<string, number>();
    for (const t of res.body.tags as string[]) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const [, n] of counts) {
      expect(n).toBe(1);
    }
  });
});
