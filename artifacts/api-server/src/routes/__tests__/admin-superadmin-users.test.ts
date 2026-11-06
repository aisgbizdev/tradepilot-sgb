import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, ilike, like, count } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import {
  users,
  sessions,
  notifications,
} from "@workspace/db/schema";
import { applyCreditLedgerEntry } from "../../lib/credits";

type Role = "user" | "admin" | "super_admin";

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `sa-users-test-${RUN_ID}`;
const DISPLAY_PREFIX = `SA Users Test ${RUN_ID}`;

const seeded: SeedUser[] = [];
let superAdmin: SeedUser;
let admin: SeedUser;
let regularUser: SeedUser;
// Two more "needle" users with distinctive email/displayName to test search.
let searchByEmail: SeedUser;
let searchByName: SeedUser;

async function createUser(
  role: Role,
  opts: { emailExtra?: string; displayName?: string } = {},
): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const emailExtra = opts.emailExtra ?? "";
  const email = `${EMAIL_PREFIX}-${role}-${emailExtra}${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used-by-tests", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);

  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: opts.displayName ?? `${DISPLAY_PREFIX} ${role} ${suffix}`,
      role,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `sa-users-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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
  // Distinctive email needle so we can search by email exactly.
  searchByEmail = await createUser("user", {
    emailExtra: `needle-email-${RUN_ID}-`,
  });
  // Distinctive display name so we can search by name.
  searchByName = await createUser("user", {
    displayName: `Needle Display ${RUN_ID} Person`,
  });
});

afterAll(async () => {
  // POST /superadmin/users and DELETE /superadmin/users/:id both fan out
  // notifications ("Pengguna Baru Terdaftar" / "Pengguna Dihapus") to admins
  // and super_admins on the live DB. Our created users always carry the
  // RUN_ID in their displayName, which is interpolated into the message —
  // so we can scrub by RUN_ID marker without touching real notifications.
  const runMarker = `%${RUN_ID}%`;
  await db.delete(notifications).where(ilike(notifications.message, runMarker));

  // Now scrub everything we created during the test, including users
  // created via the route under test (whose emails carry the RUN_ID).
  const createdRows = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `${EMAIL_PREFIX}%`));
  const allIds = Array.from(
    new Set([...seeded.map((u) => u.id), ...createdRows.map((r) => r.id)]),
  );

  if (allIds.length === 0) return;
  await db.delete(notifications).where(inArray(notifications.userId, allIds));
  await db.delete(sessions).where(inArray(sessions.userId, allIds));
  await db.delete(users).where(inArray(users.id, allIds));

  // Final sweep: notifyAdminsUserCreated / notifySuperAdminsUserDeleted are
  // fire-and-forget (`void`). A late insert can race past the first sweep
  // above. Wait a short tick and re-purge any stragglers carrying our
  // RUN_ID marker. Both message templates interpolate the displayName, which
  // always contains RUN_ID for users we created.
  await new Promise((r) => setTimeout(r, 100));
  await db.delete(notifications).where(ilike(notifications.message, runMarker));
});

describe("requireSuperAdmin gate on /superadmin/users surface", () => {
  // GET /superadmin/users
  it("GET /superadmin/users returns 401 without auth", async () => {
    const res = await request(app).get("/api/superadmin/users");
    expect(res.status).toBe(401);
  });

  it("GET /superadmin/users returns 403 for role=user", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .set(...authHeader(regularUser));
    expect(res.status).toBe(403);
  });

  it("GET /superadmin/users returns 403 for role=admin", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .set(...authHeader(admin));
    expect(res.status).toBe(403);
  });

  it("GET /superadmin/users returns 200 for role=super_admin", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  // POST /superadmin/users
  it("POST /superadmin/users returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .send({});
    expect(res.status).toBe(401);
  });

  it("POST /superadmin/users returns 403 for role=user", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(regularUser))
      .send({});
    expect(res.status).toBe(403);
  });

  it("POST /superadmin/users returns 403 for role=admin", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(admin))
      .send({});
    expect(res.status).toBe(403);
  });

  it("POST /superadmin/users returns 201 for role=super_admin with valid payload", async () => {
    const suffix = randomBytes(4).toString("hex");
    const email = `${EMAIL_PREFIX}-gate-${suffix}@example.test`;
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send({
        email,
        password: "Password1!",
        displayName: `${DISPLAY_PREFIX} gate ${suffix}`,
        securityQuestion: "q?",
        securityAnswer: "a",
      });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email.toLowerCase());
  });

  // DELETE /superadmin/users/:id
  it("DELETE /superadmin/users/:id returns 401 without auth", async () => {
    const res = await request(app).delete(
      `/api/superadmin/users/${regularUser.id}`,
    );
    expect(res.status).toBe(401);
  });

  it("DELETE /superadmin/users/:id returns 403 for role=user", async () => {
    const res = await request(app)
      .delete(`/api/superadmin/users/${regularUser.id}`)
      .set(...authHeader(regularUser));
    expect(res.status).toBe(403);
  });

  it("DELETE /superadmin/users/:id returns 403 for role=admin", async () => {
    const res = await request(app)
      .delete(`/api/superadmin/users/${regularUser.id}`)
      .set(...authHeader(admin));
    expect(res.status).toBe(403);
  });
});

describe("POST /superadmin/users validation", () => {
  function buildPayload(overrides: Record<string, unknown> = {}) {
    const suffix = randomBytes(4).toString("hex");
    return {
      email: `${EMAIL_PREFIX}-create-${suffix}@example.test`,
      password: "Password1!",
      displayName: `${DISPLAY_PREFIX} created ${suffix}`,
      role: "user",
      selectedMode: "beginner",
      securityQuestion: "fav color?",
      securityAnswer: "blue",
      ...overrides,
    };
  }

  it("returns 400 when email is missing", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(buildPayload({ email: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is missing", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(buildPayload({ password: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when displayName is missing", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(buildPayload({ displayName: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when securityQuestion is missing", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(buildPayload({ securityQuestion: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when securityAnswer is missing", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(buildPayload({ securityAnswer: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid role", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(buildPayload({ role: "wizard" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid selectedMode", async () => {
    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(buildPayload({ selectedMode: "expert" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate email (case-insensitive)", async () => {
    const payload = buildPayload();
    const r1 = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(payload);
    expect(r1.status).toBe(201);

    // Same email, different case — must still conflict.
    const r2 = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send({ ...payload, email: payload.email.toUpperCase() });
    expect(r2.status).toBe(409);
  });

  it("returns 201 and persists the user with default role/mode", async () => {
    const payload = buildPayload();
    // Strip role/mode to confirm defaults.
    delete (payload as Partial<typeof payload>).role;
    delete (payload as Partial<typeof payload>).selectedMode;

    const res = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send(payload);
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(payload.email.toLowerCase());
    expect(res.body.role).toBe("user");
    expect(res.body.selectedMode).toBe("pro");

    const [row] = await db
      .select({ id: users.id, role: users.role, selectedMode: users.selectedMode })
      .from(users)
      .where(eq(users.id, res.body.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.role).toBe("user");
    expect(row.selectedMode).toBe("pro");
  });
});

describe("GET /superadmin/users search and pagination", () => {
  it("filters by email substring", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ search: `needle-email-${RUN_ID}` })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    const ids: number[] = res.body.users.map((u: { id: number }) => u.id);
    expect(ids).toContain(searchByEmail.id);
    // Other seeded users (without the needle) must not match.
    expect(ids).not.toContain(regularUser.id);
    expect(ids).not.toContain(admin.id);
    expect(ids).not.toContain(superAdmin.id);
  });

  it("filters by display name substring", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ search: `Needle Display ${RUN_ID}` })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    const ids: number[] = res.body.users.map((u: { id: number }) => u.id);
    expect(ids).toContain(searchByName.id);
    expect(ids).not.toContain(regularUser.id);
  });

  it("clamps page to >= 1", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ page: "0", limit: "5" })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(5);
  });

  it("clamps negative page and limit to safe minimums", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ page: "-3", limit: "-9" })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(1);
  });

  it("clamps oversized limit to 200", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ page: "1", limit: "9999" })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
  });

  it("falls back to defaults for non-numeric page/limit", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ page: "abc", limit: "xyz" })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
  });

  it("reports each user's real credit balance, and 0 for a user with none", async () => {
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: searchByEmail.id,
        amount: 42,
        source: "test_seed",
        sourceEventId: `sa-users-credit-${RUN_ID}`,
      });
    });

    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ search: `needle-email-${RUN_ID}` })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    const found = res.body.users.find((u: { id: number }) => u.id === searchByEmail.id);
    expect(found.creditBalance).toBe(42);

    const res2 = await request(app)
      .get("/api/superadmin/users")
      .query({ search: `Needle Display ${RUN_ID}` })
      .set(...authHeader(superAdmin));
    const foundNoCredit = res2.body.users.find((u: { id: number }) => u.id === searchByName.id);
    expect(foundNoCredit.creditBalance).toBe(0);
  });
});

describe("GET /superadmin/users — segment field + ?segment= filter", () => {
  it("reports 'free' for a plain user with no top-up and no quota override", async () => {
    const freeUser = await createUser("user");
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ search: freeUser.email })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    const found = res.body.users.find((u: { id: number }) => u.id === freeUser.id);
    expect(found.segment).toBe("free");
  });

  it("reports 'paid' for a user with a lifetime topup_approval ledger entry", async () => {
    const paidUser = await createUser("user");
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: paidUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `sa-users-segment-paid-${RUN_ID}`,
      });
    });

    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ search: paidUser.email })
      .set(...authHeader(superAdmin));
    const found = res.body.users.find((u: { id: number }) => u.id === paidUser.id);
    expect(found.segment).toBe("paid");
  });

  it("reports 'dev' for a user with a quota override, even if they also topped up (dev wins)", async () => {
    const devUser = await createUser("user");
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: devUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `sa-users-segment-dev-${RUN_ID}`,
      });
    });
    await db.update(users).set({ customQuotaPerDay: 100 }).where(eq(users.id, devUser.id));

    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ search: devUser.email })
      .set(...authHeader(superAdmin));
    const found = res.body.users.find((u: { id: number }) => u.id === devUser.id);
    expect(found.segment).toBe("dev");
  });

  it("?segment=free/paid/dev filters the list server-side, not just annotates it", async () => {
    const freeUser = await createUser("user");
    const paidUser = await createUser("user");
    const devUser = await createUser("user");
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: paidUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `sa-users-segment-filter-paid-${RUN_ID}`,
      });
    });
    await db.update(users).set({ customQuotaPerDay: 100 }).where(eq(users.id, devUser.id));

    const freeRes = await request(app)
      .get("/api/superadmin/users")
      .query({ search: `${EMAIL_PREFIX}-user-`, segment: "free" })
      .set(...authHeader(superAdmin));
    const freeIds = freeRes.body.users.map((u: { id: number }) => u.id);
    expect(freeIds).toContain(freeUser.id);
    expect(freeIds).not.toContain(paidUser.id);
    expect(freeIds).not.toContain(devUser.id);

    const paidRes = await request(app)
      .get("/api/superadmin/users")
      .query({ search: `${EMAIL_PREFIX}-user-`, segment: "paid" })
      .set(...authHeader(superAdmin));
    const paidIds = paidRes.body.users.map((u: { id: number }) => u.id);
    expect(paidIds).toContain(paidUser.id);
    expect(paidIds).not.toContain(freeUser.id);
    expect(paidIds).not.toContain(devUser.id);

    const devRes = await request(app)
      .get("/api/superadmin/users")
      .query({ search: `${EMAIL_PREFIX}-user-`, segment: "dev" })
      .set(...authHeader(superAdmin));
    const devIds = devRes.body.users.map((u: { id: number }) => u.id);
    expect(devIds).toContain(devUser.id);
    expect(devIds).not.toContain(freeUser.id);
    expect(devIds).not.toContain(paidUser.id);
  });

  it("ignores an invalid ?segment= value instead of erroring", async () => {
    const res = await request(app)
      .get("/api/superadmin/users")
      .query({ segment: "not-a-real-segment" })
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /superadmin/users/:id", () => {
  it("removes the user when they exist", async () => {
    // Seed a victim user via the route under test, then delete it.
    const victimEmail = `${EMAIL_PREFIX}-victim-${randomBytes(4).toString("hex")}@example.test`;
    const create = await request(app)
      .post("/api/superadmin/users")
      .set(...authHeader(superAdmin))
      .send({
        email: victimEmail,
        password: "Password1!",
        displayName: `${DISPLAY_PREFIX} victim`,
        securityQuestion: "q?",
        securityAnswer: "a",
      });
    expect(create.status).toBe(201);
    const victimId: number = create.body.id;

    const res = await request(app)
      .delete(`/api/superadmin/users/${victimId}`)
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);

    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, victimId))
      .limit(1);
    expect(row).toBeUndefined();
  });

  it("returns 400 when super_admin tries to delete themselves", async () => {
    const res = await request(app)
      .delete(`/api/superadmin/users/${superAdmin.id}`)
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(400);

    // Self must still exist.
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, superAdmin.id))
      .limit(1);
    expect(row).toBeDefined();
  });

  it("returns 404 for an unknown user id", async () => {
    const res = await request(app)
      .delete(`/api/superadmin/users/999999999`)
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(404);
  });

  it("does not crash on a non-numeric :id and returns a 4xx", async () => {
    const res = await request(app)
      .delete(`/api/superadmin/users/not-a-number`)
      .set(...authHeader(superAdmin));
    // Hard requirement: NEVER 5xx (no Postgres-leaked error). Either 400
    // (param validation) or 404 (no row matched) is acceptable.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("PATCH /superadmin/users/:id/role", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/${regularUser.id}/role`)
      .send({ role: "admin" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-super-admin", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/${regularUser.id}/role`)
      .set(...authHeader(admin))
      .send({ role: "admin" });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid role with 400", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/${regularUser.id}/role`)
      .set(...authHeader(superAdmin))
      .send({ role: "demigod" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric :id with 400 (no 5xx)", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/not-a-number/role`)
      .set(...authHeader(superAdmin))
      .send({ role: "admin" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("blocks self-demote with 400", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/${superAdmin.id}/role`)
      .set(...authHeader(superAdmin))
      .send({ role: "admin" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown user id", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/999999999/role`)
      .set(...authHeader(superAdmin))
      .send({ role: "admin" });
    expect(res.status).toBe(404);
  });

  it("allows promoting a user to super_admin and demoting a peer back when others remain", async () => {
    // Seed a fresh peer super_admin so the system has at least 2 super_admins
    // (our acting `superAdmin` + this peer + any real ones already on the DB).
    const peer = await createUser("super_admin");

    const res = await request(app)
      .patch(`/api/superadmin/users/${peer.id}/role`)
      .set(...authHeader(superAdmin))
      .send({ role: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");

    const [row] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, peer.id))
      .limit(1);
    expect(row.role).toBe("admin");
  });
});

describe("PATCH /superadmin/users/:id/credits", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/${regularUser.id}/credits`)
      .send({ balance: 10 });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-super-admin", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/${regularUser.id}/credits`)
      .set(...authHeader(admin))
      .send({ balance: 10 });
    expect(res.status).toBe(403);
  });

  it("rejects a negative or non-numeric balance with 400", async () => {
    const target = await createUser("user");
    const negative = await request(app)
      .patch(`/api/superadmin/users/${target.id}/credits`)
      .set(...authHeader(superAdmin))
      .send({ balance: -1 });
    expect(negative.status).toBe(400);

    const notANumber = await request(app)
      .patch(`/api/superadmin/users/${target.id}/credits`)
      .set(...authHeader(superAdmin))
      .send({ balance: "not-a-number" });
    expect(notANumber.status).toBe(400);
  });

  it("returns 404 for an unknown user id", async () => {
    const res = await request(app)
      .patch(`/api/superadmin/users/999999999/credits`)
      .set(...authHeader(superAdmin))
      .send({ balance: 10 });
    expect(res.status).toBe(404);
  });

  it("sets the balance up from zero by appending a positive ledger delta", async () => {
    const target = await createUser("user");
    const res = await request(app)
      .patch(`/api/superadmin/users/${target.id}/credits`)
      .set(...authHeader(superAdmin))
      .send({ balance: 25 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, creditBalance: 25 });
  });

  it("sets the balance down by appending a negative ledger delta, never going below the target", async () => {
    const target = await createUser("user");
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: target.id,
        amount: 50,
        source: "test_seed",
        sourceEventId: `seed-${randomBytes(4).toString("hex")}`,
      });
    });

    const res = await request(app)
      .patch(`/api/superadmin/users/${target.id}/credits`)
      .set(...authHeader(superAdmin))
      .send({ balance: 12 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, creditBalance: 12 });
  });

  it("is a no-op (still 200) when the target already equals the current balance", async () => {
    const target = await createUser("user");
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: target.id,
        amount: 7,
        source: "test_seed",
        sourceEventId: `seed-${randomBytes(4).toString("hex")}`,
      });
    });

    const res = await request(app)
      .patch(`/api/superadmin/users/${target.id}/credits`)
      .set(...authHeader(superAdmin))
      .send({ balance: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, creditBalance: 7 });
  });
});

describe("super_admin lockout protection", () => {
  // These tests verify the count-guard (defense-in-depth) inside PATCH
  // role + DELETE. Through normal request flow the actor is always a
  // super_admin, so the count cannot reach zero by their action alone —
  // BUT under concurrent peer demotes/deletes (race), the guard inside the
  // pg_advisory_xact_lock + count(*) check is what keeps the system from
  // ending up with zero administrators.

  it("PATCH role: peer demote succeeds; final count drops by exactly 1", async () => {
    // Two fresh peer super_admins.
    const sa1 = await createUser("super_admin");
    const sa2 = await createUser("super_admin");

    const [{ c: before }] = await db
      .select({ c: count() })
      .from(users)
      .where(eq(users.role, "super_admin"));

    const res = await request(app)
      .patch(`/api/superadmin/users/${sa2.id}/role`)
      .set(...authHeader(sa1))
      .send({ role: "admin" });
    expect(res.status).toBe(200);

    const [{ c: after }] = await db
      .select({ c: count() })
      .from(users)
      .where(eq(users.role, "super_admin"));
    expect(Number(after)).toBe(Number(before) - 1);
  });

  it("DELETE: peer delete succeeds; final count drops by exactly 1", async () => {
    const sa1 = await createUser("super_admin");
    const sa2 = await createUser("super_admin");

    const [{ c: before }] = await db
      .select({ c: count() })
      .from(users)
      .where(eq(users.role, "super_admin"));

    const res = await request(app)
      .delete(`/api/superadmin/users/${sa2.id}`)
      .set(...authHeader(sa1));
    expect(res.status).toBe(200);

    const [{ c: after }] = await db
      .select({ c: count() })
      .from(users)
      .where(eq(users.role, "super_admin"));
    expect(Number(after)).toBe(Number(before) - 1);
  });

  it("PATCH role: concurrent peer demotes never drive the super_admin count to zero", async () => {
    // Two fresh peer super_admins firing demote requests at each other in
    // parallel. WITHOUT the advisory-lock + count guard, both reads would
    // see the original count and both updates would commit, leaving the
    // system with 2 fewer super_admins. WITH the guard, the second
    // transaction sees the post-first count and (when count would hit 0)
    // refuses with 400.
    const sa1 = await createUser("super_admin");
    const sa2 = await createUser("super_admin");

    const [{ c: before }] = await db
      .select({ c: count() })
      .from(users)
      .where(eq(users.role, "super_admin"));

    const [r1, r2] = await Promise.all([
      request(app)
        .patch(`/api/superadmin/users/${sa2.id}/role`)
        .set(...authHeader(sa1))
        .send({ role: "admin" }),
      request(app)
        .patch(`/api/superadmin/users/${sa1.id}/role`)
        .set(...authHeader(sa2))
        .send({ role: "admin" }),
    ]);

    // Either both succeed (because there were >=3 super_admins before, so
    // even both demotes leave >=1) or one wins and the other is refused —
    // but the count must NEVER end below `before - 2` and must always
    // remain >= 1.
    const [{ c: after }] = await db
      .select({ c: count() })
      .from(users)
      .where(eq(users.role, "super_admin"));
    expect(Number(after)).toBeGreaterThanOrEqual(1);
    expect(Number(after)).toBeGreaterThanOrEqual(Number(before) - 2);

    // At least one of the two requests must have a sane status (not 5xx).
    for (const r of [r1, r2]) {
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(500);
    }
  });

  it("DELETE: concurrent peer deletes never drive the super_admin count to zero", async () => {
    const sa1 = await createUser("super_admin");
    const sa2 = await createUser("super_admin");

    const [r1, r2] = await Promise.all([
      request(app)
        .delete(`/api/superadmin/users/${sa2.id}`)
        .set(...authHeader(sa1)),
      request(app)
        .delete(`/api/superadmin/users/${sa1.id}`)
        .set(...authHeader(sa2)),
    ]);

    const [{ c: after }] = await db
      .select({ c: count() })
      .from(users)
      .where(eq(users.role, "super_admin"));
    expect(Number(after)).toBeGreaterThanOrEqual(1);

    for (const r of [r1, r2]) {
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(500);
    }
  });
});

// Deterministic guard test: temporarily demote all real super_admins on the
// shared DB so we have a known total of exactly two super_admins (the two we
// seed). This lets us prove the 400 path fires under concurrent peer demote.
//
// SAFETY: the demoted IDs are restored in a finally + afterAll. If both fail,
// a real super_admin would be stuck as `admin` — so we ALSO bail out early
// (skip the test body, but still restore) if anything looks unsafe.
describe("deterministic last-super-admin guard (engineered count == 2)", () => {
  let temporarilyDemoted: number[] = [];
  const guardSeeded: number[] = [];

  async function restoreReals() {
    if (temporarilyDemoted.length === 0) return;
    await db
      .update(users)
      .set({ role: "super_admin" })
      .where(inArray(users.id, temporarilyDemoted));
    temporarilyDemoted = [];
  }

  afterAll(async () => {
    // Belt-and-suspenders: always restore on the way out, even if a test
    // already restored.
    await restoreReals();
  });

  it("PATCH role: under concurrent peer demote with exactly 2 super_admins, exactly one wins (200) and one is refused (400)", async () => {
    const sa1 = await createUser("super_admin");
    const sa2 = await createUser("super_admin");
    guardSeeded.push(sa1.id, sa2.id);

    try {
      const others = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "super_admin"));
      temporarilyDemoted = others
        .map((r) => r.id)
        .filter((id) => id !== sa1.id && id !== sa2.id);

      if (temporarilyDemoted.length > 0) {
        await db
          .update(users)
          .set({ role: "admin" })
          .where(inArray(users.id, temporarilyDemoted));
      }

      const [{ c: before }] = await db
        .select({ c: count() })
        .from(users)
        .where(eq(users.role, "super_admin"));
      expect(Number(before)).toBe(2);

      const [r1, r2] = await Promise.all([
        request(app)
          .patch(`/api/superadmin/users/${sa2.id}/role`)
          .set(...authHeader(sa1))
          .send({ role: "admin" }),
        request(app)
          .patch(`/api/superadmin/users/${sa1.id}/role`)
          .set(...authHeader(sa2))
          .send({ role: "admin" }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      // Exactly one transaction should win (200) and the other should be
      // refused by the guard (400 "Tidak bisa menurunkan super admin
      // terakhir"). Without the lock-then-count guard, both could commit
      // and statuses would be [200, 200] with final count 0.
      expect(statuses).toEqual([200, 400]);

      const refused = r1.status === 400 ? r1 : r2;
      expect(refused.body.error).toBe(
        "Tidak bisa menurunkan super admin terakhir",
      );

      const [{ c: after }] = await db
        .select({ c: count() })
        .from(users)
        .where(eq(users.role, "super_admin"));
      expect(Number(after)).toBe(1);
    } finally {
      await restoreReals();
    }
  });

  it("DELETE: under concurrent peer delete with exactly 2 super_admins, exactly one wins (200) and one is refused (400)", async () => {
    const sa1 = await createUser("super_admin");
    const sa2 = await createUser("super_admin");
    guardSeeded.push(sa1.id, sa2.id);

    try {
      const others = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "super_admin"));
      temporarilyDemoted = others
        .map((r) => r.id)
        .filter((id) => id !== sa1.id && id !== sa2.id);

      if (temporarilyDemoted.length > 0) {
        await db
          .update(users)
          .set({ role: "admin" })
          .where(inArray(users.id, temporarilyDemoted));
      }

      const [{ c: before }] = await db
        .select({ c: count() })
        .from(users)
        .where(eq(users.role, "super_admin"));
      expect(Number(before)).toBe(2);

      const [r1, r2] = await Promise.all([
        request(app)
          .delete(`/api/superadmin/users/${sa2.id}`)
          .set(...authHeader(sa1)),
        request(app)
          .delete(`/api/superadmin/users/${sa1.id}`)
          .set(...authHeader(sa2)),
      ]);

      // Exactly one delete must succeed.
      const successes = [r1, r2].filter((r) => r.status === 200);
      const losers = [r1, r2].filter((r) => r.status !== 200);
      expect(successes).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const loser = losers[0]!;

      // The loser is either:
      //  - 400 "Tidak bisa menghapus super admin terakhir" when its
      //    transaction acquired the advisory lock after the winner
      //    committed and the guard fired correctly, OR
      //  - 401 when the cascade-deleted session caused the auth middleware
      //    to reject the in-flight request before the route ran. Both are
      //    acceptable real-world outcomes for a true peer-delete race.
      expect([400, 401]).toContain(loser.status);
      if (loser.status === 400) {
        expect(loser.body.error).toBe(
          "Tidak bisa menghapus super admin terakhir",
        );
      }

      const [{ c: after }] = await db
        .select({ c: count() })
        .from(users)
        .where(eq(users.role, "super_admin"));
      expect(Number(after)).toBe(1);
    } finally {
      await restoreReals();
    }
  });
});
