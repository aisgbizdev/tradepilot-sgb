import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, ilike } from "drizzle-orm";

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
const EMAIL_PREFIX = `bcast-test-${RUN_ID}`;
const TITLE_MARKER = `BcastTest-${RUN_ID}`;
const TAG_EMPTY = `bcast_test_${RUN_ID}_empty`;

const seeded: SeedUser[] = [];
let superAdmin: SeedUser;
let admin: SeedUser;
let regularUser: SeedUser;

async function createUser(role: Role): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${role}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used-by-tests", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);

  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Bcast Test ${role} ${suffix}`,
      role,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `bcast-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const seed: SeedUser = { id: row.id, email, token };
  seeded.push(seed);
  return seed;
}

function authHeader(u: SeedUser): [string, string] {
  return ["Authorization", `Bearer ${u.token}`];
}

beforeAll(async () => {
  superAdmin = await createUser("super_admin");
  admin = await createUser("admin");
  regularUser = await createUser("user");
});

afterAll(async () => {
  // Broadcasts targeted at audienceType=all/role can fan out notifications
  // to real (non-seeded) users on the shared DB. Scrub by RUN_ID marker
  // baked into every test broadcast title before touching seeded rows.
  const runMarker = `%${TITLE_MARKER}%`;
  await db.delete(notifications).where(ilike(notifications.title, runMarker));
  await db.delete(broadcasts).where(ilike(broadcasts.title, runMarker));

  const ids = seeded.map((u) => u.id);
  if (ids.length === 0) return;

  // Cascade safety net for anything still tied to our seeded users.
  await db.delete(notifications).where(inArray(notifications.userId, ids));
  await db.delete(userTags).where(inArray(userTags.userId, ids));
  await db.delete(sessions).where(inArray(sessions.userId, ids));
  await db
    .delete(broadcasts)
    .where(inArray(broadcasts.senderId, ids));
  await db.delete(users).where(inArray(users.id, ids));
});

describe("POST /admin/notifications role gate", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .send({
        title: `${TITLE_MARKER} unauth`,
        message: "Body",
        audienceType: "all",
      });
    expect(res.status).toBe(401);
  });

  it("returns 403 for role=user", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(regularUser))
      .send({
        title: `${TITLE_MARKER} user`,
        message: "Body",
        audienceType: "all",
      });
    expect(res.status).toBe(403);
  });

  it("returns 403 for role=admin (only super_admin may broadcast)", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(admin))
      .send({
        title: `${TITLE_MARKER} admin`,
        message: "Body",
        audienceType: "all",
      });
    expect(res.status).toBe(403);
  });

  it("returns 201 for role=super_admin with a valid payload", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} ok`,
        message: "Body",
        audienceType: "role",
        audienceValue: "super_admin",
      });
    expect(res.status).toBe(201);
    expect(typeof res.body.broadcastId).toBe("number");
  });

  it("none of the rejected requests created a broadcast row", async () => {
    // Sanity check: only the one super_admin POST above should have inserted
    // a broadcast row carrying our RUN_ID marker.
    const rows = await db
      .select({
        id: broadcasts.id,
        title: broadcasts.title,
      })
      .from(broadcasts)
      .where(ilike(broadcasts.title, `%${TITLE_MARKER}%`));
    // At this point only the "ok" broadcast must be present from the gate
    // tests above. Validation tests below don't insert. Audience tests below
    // each insert exactly one. Just assert the negative outcomes left no row.
    for (const r of rows) {
      expect(r.title).not.toContain("unauth");
      expect(r.title).not.toContain(`${TITLE_MARKER} user`);
      expect(r.title).not.toContain(`${TITLE_MARKER} admin`);
    }
  });
});

describe("POST /admin/notifications audience validation", () => {
  it("rejects empty title with 400 and never inserts an empty-titled broadcast row", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({ title: "", message: "Body", audienceType: "all" });
    expect(res.status).toBe(400);

    // The empty-title payload would never carry our TITLE_MARKER, so the
    // catch-all assertion below can't see it. Pin it down by senderId.
    const rows = await db
      .select({ id: broadcasts.id, title: broadcasts.title })
      .from(broadcasts)
      .where(eq(broadcasts.senderId, superAdmin.id));
    for (const r of rows) {
      expect(r.title).not.toBe("");
    }
  });

  it("rejects whitespace-only message with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} blank-msg`,
        message: "   ",
        audienceType: "all",
      });
    expect(res.status).toBe(400);
  });

  it("rejects unknown audienceType with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} bad-aud`,
        message: "Body",
        audienceType: "everyone",
      });
    expect(res.status).toBe(400);
  });

  it("rejects unknown notification type with 400", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} bad-type`,
        message: "Body",
        audienceType: "all",
        type: "critical",
      });
    expect(res.status).toBe(400);
  });

  it("rejects audienceType=role without an audienceValue", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} role-no-val`,
        message: "Body",
        audienceType: "role",
      });
    expect(res.status).toBe(400);
  });

  it("rejects audienceType=tag with an empty audienceValue", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} tag-empty-val`,
        message: "Body",
        audienceType: "tag",
        audienceValue: "   ",
      });
    expect(res.status).toBe(400);
  });

  it("rejects audienceType=role with an unknown role value", async () => {
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} bad-role`,
        message: "Body",
        audienceType: "role",
        audienceValue: "wizard",
      });
    expect(res.status).toBe(400);
  });

  it("none of the validation failures inserted a broadcast row", async () => {
    // Every payload above carries TITLE_MARKER plus a unique sub-tag. None
    // of those sub-tags should appear in the broadcasts table.
    const rows = await db
      .select({ title: broadcasts.title })
      .from(broadcasts)
      .where(ilike(broadcasts.title, `%${TITLE_MARKER}%`));
    const titles = rows.map((r) => r.title);
    for (const sub of [
      "blank-msg",
      "bad-aud",
      "bad-type",
      "role-no-val",
      "tag-empty-val",
      "bad-role",
    ]) {
      expect(titles.find((t) => t.includes(sub))).toBeUndefined();
    }
  });
});

describe("POST /admin/notifications recipient count is non-negative", () => {
  it("records the broadcast even when zero users match (recipientCount === 0, never negative)", async () => {
    // Use a tag that no user carries so the audience resolves to an empty set.
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} zero-recipients`,
        message: "Nobody listens",
        audienceType: "tag",
        audienceValue: TAG_EMPTY,
      });
    expect(res.status).toBe(201);
    expect(res.body.recipientCount).toBe(0);
    expect(res.body.recipientCount).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.broadcastId).toBe("number");

    const [row] = await db
      .select({
        recipientCount: broadcasts.recipientCount,
        audienceValue: broadcasts.audienceValue,
        title: broadcasts.title,
      })
      .from(broadcasts)
      .where(eq(broadcasts.id, res.body.broadcastId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.recipientCount).toBe(0);
    expect(row.recipientCount).toBeGreaterThanOrEqual(0);
    expect(row.audienceValue).toBe(TAG_EMPTY);

    // No notification rows were written either — empty audience must NOT
    // fan out to anyone.
    const written = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.title, `${TITLE_MARKER} zero-recipients`));
    expect(written.length).toBe(0);
  });

  it("records a positive recipientCount that matches the response and never goes negative", async () => {
    // audienceType=role + super_admin should match at least our seeded
    // super_admin (and possibly real ones on the shared DB).
    const res = await request(app)
      .post("/api/admin/notifications")
      .set(...authHeader(superAdmin))
      .send({
        title: `${TITLE_MARKER} positive-recipients`,
        message: "Hello supers",
        audienceType: "role",
        audienceValue: "super_admin",
      });
    expect(res.status).toBe(201);
    expect(res.body.recipientCount).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ recipientCount: broadcasts.recipientCount })
      .from(broadcasts)
      .where(eq(broadcasts.id, res.body.broadcastId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.recipientCount).toBeGreaterThanOrEqual(1);
    expect(row.recipientCount).toBe(res.body.recipientCount);
  });
});
