/**
 * GET /admin/stats — the "Login Hari Ini" / "Logout Hari Ini" counters,
 * sourced from the append-only auth_events log and counted per event (not
 * per distinct user), independent of totalAnalysesToday (see routes/admin.ts).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users, sessions } from "@workspace/db/schema";
import { applyCreditLedgerEntry } from "../../lib/credits";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `admin-stats-test-${RUN_ID}`;
const seededUserIds: number[] = [];

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

async function createUser(role: "user" | "super_admin" = "user"): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Admin Stats Test ${RUN_ID}`,
      role,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `admin-stats-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("GET /admin/stats — totalLoginsToday / totalLogoutsToday", () => {
  const PASSWORD = "Correct123";

  async function createPasswordUser(
    role: "user" | "admin" | "super_admin" = "user",
  ): Promise<{ id: number; email: string }> {
    const email = `${EMAIL_PREFIX}-pw-${randomBytes(6).toString("hex")}@example.test`;
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const securityAnswerHash = await bcrypt.hash("answer", 4);
    const [row] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        displayName: `Admin Stats Login Test ${RUN_ID}`,
        role,
        securityQuestion: "test?",
        securityAnswerHash,
      })
      .returning({ id: users.id });
    seededUserIds.push(row.id);
    return { id: row.id, email };
  }

  it("counts a real login and a real logout as one event each, independent of analyses/active-user counts", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const loginsBefore = before.body.totalLoginsToday as number;
    const logoutsBefore = before.body.totalLogoutsToday as number;

    const pwUser = await createPasswordUser();
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: pwUser.email, password: PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token as string;

    const afterLogin = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(afterLogin.body.totalLoginsToday).toBe(loginsBefore + 1);
    expect(afterLogin.body.totalLogoutsToday).toBe(logoutsBefore);

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);

    const afterLogout = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    // Login count is untouched by the logout — they're independent counters.
    expect(afterLogout.body.totalLoginsToday).toBe(loginsBefore + 1);
    expect(afterLogout.body.totalLogoutsToday).toBe(logoutsBefore + 1);
  });

  it("logging in 3 times counts as 3 login events, not 1 (unlike the sessions table, which only ever keeps one row)", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const loginsBefore = before.body.totalLoginsToday as number;

    const pwUser = await createPasswordUser();
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: pwUser.email, password: PASSWORD });
      expect(res.status).toBe(200);
    }

    const after = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(after.body.totalLoginsToday).toBe(loginsBefore + 3);

    const rows = await db.select().from(sessions).where(eq(sessions.userId, pwUser.id));
    expect(rows).toHaveLength(1);
  });

  it("excludes admin/super_admin logins and logouts — only role='user' accounts count", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const loginsBefore = before.body.totalLoginsToday as number;
    const logoutsBefore = before.body.totalLogoutsToday as number;

    const staffAdmin = await createPasswordUser("admin");
    const staffLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: staffAdmin.email, password: PASSWORD });
    expect(staffLogin.status).toBe(200);
    const staffToken = staffLogin.body.token as string;

    const staffSuperAdmin = await createPasswordUser("super_admin");
    const staffSuperAdminLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: staffSuperAdmin.email, password: PASSWORD });
    expect(staffSuperAdminLogin.status).toBe(200);

    const afterStaffLogins = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(afterStaffLogins.body.totalLoginsToday).toBe(loginsBefore);

    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${staffToken}`);

    const afterStaffLogout = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(afterStaffLogout.body.totalLogoutsToday).toBe(logoutsBefore);

    // Confirm a genuine role='user' login still counts normally alongside
    // the excluded staff ones above, proving this isn't just a broken query.
    const pwUser = await createPasswordUser("user");
    await request(app).post("/api/auth/login").send({ email: pwUser.email, password: PASSWORD });
    const afterRealUserLogin = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(afterRealUserLogin.body.totalLoginsToday).toBe(loginsBefore + 1);
  });
});

describe("GET /admin/stats — totalFreeUsers / totalPaidUsers / totalDevUsers", () => {
  it("a plain user with no top-up and no quota override counts as free only", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const freeBefore = before.body.totalFreeUsers as number;
    const paidBefore = before.body.totalPaidUsers as number;
    const devBefore = before.body.totalDevUsers as number;

    await createUser();

    const after = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(after.body.totalFreeUsers).toBe(freeBefore + 1);
    expect(after.body.totalPaidUsers).toBe(paidBefore);
    expect(after.body.totalDevUsers).toBe(devBefore);
  });

  it("a user with a lifetime topup_approval ledger entry counts as paid, not free", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const freeBefore = before.body.totalFreeUsers as number;
    const paidBefore = before.body.totalPaidUsers as number;

    const paidUser = await createUser();
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: paidUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `topup:${RUN_ID}-${randomBytes(4).toString("hex")}`,
      });
    });

    const after = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(after.body.totalPaidUsers).toBe(paidBefore + 1);
    expect(after.body.totalFreeUsers).toBe(freeBefore);
  });

  it("a user with an admin quota override counts as Development, even if they also topped up", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const paidBefore = before.body.totalPaidUsers as number;
    const devBefore = before.body.totalDevUsers as number;

    const devUser = await createUser();
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: devUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `topup:${RUN_ID}-${randomBytes(4).toString("hex")}`,
      });
    });
    await db.update(users).set({ customQuotaPerDay: 100 }).where(eq(users.id, devUser.id));

    const after = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    // Development wins over Top Up despite the real top-up on record.
    expect(after.body.totalDevUsers).toBe(devBefore + 1);
    expect(after.body.totalPaidUsers).toBe(paidBefore);
  });

  it("free + paid + dev always sums to totalUsers", async () => {
    const superAdmin = await createUser("super_admin");
    const res = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const { totalFreeUsers, totalPaidUsers, totalDevUsers, totalUsers } = res.body;
    expect(totalFreeUsers + totalPaidUsers + totalDevUsers).toBe(totalUsers);
  });
});
