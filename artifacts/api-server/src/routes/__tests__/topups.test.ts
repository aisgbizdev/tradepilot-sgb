import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like, ilike } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import {
  users,
  sessions,
  notifications,
  creditTopupRequests,
  creditLedger,
  creditBalances,
} from "@workspace/db/schema";
import { getTopupPackages } from "../../lib/credits";

// The four fixed packages (see lib/credits.ts) — tests that go through the
// real POST /topups endpoint must use one of these exact amounts now;
// there is no free-text amount or flat rate to compute an arbitrary valid
// one from anymore.
const [PKG_5K, PKG_20K, PKG_40K] = getTopupPackages();

type Role = "user" | "admin" | "super_admin";

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `topups-test-${RUN_ID}`;
// The old manual/proof-upload self-service endpoint (POST /topups) has
// been retired — every package now goes exclusively through DOKU Checkout
// (see topups-doku.test.ts). This fixed stand-in object path is only used
// when seeding a "pending" row directly (insertPendingTopup below) to
// drive the admin review endpoints, which still matter for historical
// rows.
const PROOF_PATH = `objects/topups-test-${RUN_ID}-proof.jpg`;

const seededUserIds: number[] = [];
const seededRequestIds: number[] = [];

async function createUser(role: Role = "user"): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${role}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Topups Test ${RUN_ID} ${role} ${suffix}`,
      role,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `topups-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
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

// POST /topups auto-approves every request now (see routes/topups.ts), so
// there's no longer a way to reach a "pending" row through the public API
// — insert one directly to exercise the admin review endpoints, which
// still matter for whatever a future rollback / manual review flow needs.
// Bypasses the fixed-package validation POST /topups enforces (this
// writes straight to the DB), so `amountRupiah`/`creditsRequested` don't
// need to match a real package — these rows exist purely to drive the
// admin-review endpoints, most of which don't care about the exact
// numbers.
async function insertPendingTopup(
  user: SeedUser,
  amountRupiah: number,
  creditsRequested: number,
): Promise<number> {
  const [row] = await db
    .insert(creditTopupRequests)
    .values({
      userId: user.id,
      amountRupiah,
      creditsRequested,
      conversionRateSnapshot: Math.round(amountRupiah / creditsRequested),
      proofObjectPath: PROOF_PATH,
      status: "pending",
    })
    .returning({ id: creditTopupRequests.id });
  seededRequestIds.push(row!.id);
  return row!.id;
}

let alice: SeedUser;
let admin: SeedUser;
let superAdmin: SeedUser;

beforeAll(async () => {
  alice = await createUser("user");
  admin = await createUser("admin");
  superAdmin = await createUser("super_admin");
});

afterAll(async () => {
  const runMarker = `%${RUN_ID}%`;
  await db.delete(notifications).where(ilike(notifications.message, runMarker));
  if (seededRequestIds.length) {
    await db.delete(creditLedger).where(inArray(creditLedger.topupRequestId, seededRequestIds));
    await db.delete(creditTopupRequests).where(inArray(creditTopupRequests.id, seededRequestIds));
  }
  if (seededUserIds.length) {
    await db.delete(creditLedger).where(inArray(creditLedger.userId, seededUserIds));
    await db.delete(creditBalances).where(inArray(creditBalances.userId, seededUserIds));
    await db.delete(creditTopupRequests).where(inArray(creditTopupRequests.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("GET /topups/config", () => {
  it("returns the fixed packages with their allowed DOKU methods", async () => {
    const res = await request(app).get("/api/topups/config").set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.packages).toEqual(
      getTopupPackages().map((p) => {
        const dokuMethods = p.amountRupiah >= 20_000 ? ["va", "qris"] : ["qris"];
        return { ...p, dokuMethods, adminFeeRupiah: 5_000 };
      }),
    );
  });
});

describe("GET /topups/balance", () => {
  it("returns 0 for a user with no top-ups yet", async () => {
    const res = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(0);
  });
});

describe("GET /topups/mine", () => {
  it("only returns the caller's own requests", async () => {
    await insertPendingTopup(alice, PKG_5K.amountRupiah, PKG_5K.credits);

    const res = await request(app)
      .get("/api/topups/mine")
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.requests.every((r: { userId: number }) => r.userId === alice.id)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /admin/topups", () => {
  it("returns 403 for a regular user", async () => {
    const res = await request(app)
      .get("/api/admin/topups")
      .set(...authHeader(alice));
    expect(res.status).toBe(403);
  });

  it("lists pending requests with the requester's email/name for an admin", async () => {
    const pendingId = await insertPendingTopup(alice, 30_000, 90);
    const res = await request(app)
      .get("/api/admin/topups")
      .set(...authHeader(admin))
      .query({ status: "pending" });
    expect(res.status).toBe(200);
    const mine = res.body.requests.find((r: { id: number }) => r.id === pendingId);
    expect(mine).toBeDefined();
    expect(mine.userEmail).toBe(alice.email);
  });
});

// There is no public endpoint that produces a "pending" row any more (the
// old manual self-service path is retired, and DOKU Checkout rows only go
// pending through a real DOKU call — see topups-doku.test.ts), but the
// admin review endpoints themselves are unchanged and still need to work
// correctly against whatever pending rows exist — seed those directly.
describe("PATCH /admin/topups/:id/status", () => {
  it("returns 403 for a plain admin (approval requires super_admin)", async () => {
    const id = await insertPendingTopup(alice, 25_000, 5);

    const res = await request(app)
      .patch(`/api/admin/topups/${id}/status`)
      .set(...authHeader(admin))
      .send({ status: "approved" });
    expect(res.status).toBe(403);
  });

  it("approves a request, credits the balance, and notifies the user", async () => {
    const id = await insertPendingTopup(alice, 1_750, 7);

    const before = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    const balanceBefore = before.body.balance as number;

    const res = await request(app)
      .patch(`/api/admin/topups/${id}/status`)
      .set(...authHeader(superAdmin))
      .send({ status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.creditsGranted).toBe(7);

    const after = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    expect(after.body.balance).toBe(balanceBefore + 7);

    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.topupRequestId, id));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.amount).toBe(7);

    // Fresh test users default to users.lang = "en", so the notification is
    // sent in English, not Indonesian.
    const notif = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, alice.id));
    expect(notif.some((n) => n.title === "Top-up approved")).toBe(true);
  });

  it("rejects a request without touching the credit balance", async () => {
    const id = await insertPendingTopup(alice, 750, 3);

    const before = await request(app).get("/api/topups/balance").set(...authHeader(alice));

    const res = await request(app)
      .patch(`/api/admin/topups/${id}/status`)
      .set(...authHeader(superAdmin))
      .send({ status: "rejected", reviewNote: "bukti tidak jelas" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(res.body.creditsGranted).toBeNull();

    const after = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    expect(after.body.balance).toBe(before.body.balance);
  });

  it("only lets one of two concurrent reviews win; the other gets 409", async () => {
    const id = await insertPendingTopup(alice, 1_000, 4);

    const [resA, resB] = await Promise.all([
      request(app)
        .patch(`/api/admin/topups/${id}/status`)
        .set(...authHeader(superAdmin))
        .send({ status: "approved" }),
      request(app)
        .patch(`/api/admin/topups/${id}/status`)
        .set(...authHeader(superAdmin))
        .send({ status: "approved" }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.topupRequestId, id));
    expect(ledgerRows).toHaveLength(1);
  });
});

describe("POST /admin/topups/manual", () => {
  it("returns 403 for a plain admin (super_admin only)", async () => {
    const res = await request(app)
      .post("/api/admin/topups/manual")
      .set(...authHeader(admin))
      .send({ userId: alice.id, amountRupiah: 20_000, credits: 70, note: "test" });
    expect(res.status).toBe(403);
  });

  it("rejects a missing note with 400", async () => {
    const res = await request(app)
      .post("/api/admin/topups/manual")
      .set(...authHeader(superAdmin))
      .send({ userId: alice.id, amountRupiah: 20_000, credits: 70 });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown userId with 400", async () => {
    const res = await request(app)
      .post("/api/admin/topups/manual")
      .set(...authHeader(superAdmin))
      .send({ userId: 999_999_999, amountRupiah: 20_000, credits: 70, note: "test" });
    expect(res.status).toBe(400);
  });

  it("grants credits immediately, records an already-approved request with no proof, and notifies the user", async () => {
    const before = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    const balanceBefore = before.body.balance as number;

    const res = await request(app)
      .post("/api/admin/topups/manual")
      .set(...authHeader(superAdmin))
      .send({
        userId: alice.id,
        amountRupiah: 20_000,
        credits: 70,
        note: "Confirmed via WhatsApp, proof upload failed",
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("approved");
    expect(res.body.creditsGranted).toBe(70);
    expect(res.body.proofObjectPath).toBeNull();
    expect(res.body.reviewNote).toBe("Confirmed via WhatsApp, proof upload failed");
    seededRequestIds.push(res.body.id);

    const after = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    expect(after.body.balance).toBe(balanceBefore + 70);

    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.topupRequestId, res.body.id));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.amount).toBe(70);
    expect(ledgerRows[0]!.source).toBe("topup_approval");

    const notif = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, alice.id));
    expect(notif.some((n) => n.title === "Top-up approved")).toBe(true);
  });

  it("is not constrained to the fixed self-service packages — any amount/credits pair works", async () => {
    const res = await request(app)
      .post("/api/admin/topups/manual")
      .set(...authHeader(superAdmin))
      .send({ userId: alice.id, amountRupiah: 12_345, credits: 99, note: "one-off support correction" });
    expect(res.status).toBe(201);
    expect(res.body.amountRupiah).toBe(12_345);
    expect(res.body.creditsGranted).toBe(99);
    seededRequestIds.push(res.body.id);
  });
});

describe("GET /admin/topups/summary", () => {
  it("returns 403 for a plain user and for a plain admin", async () => {
    const resUser = await request(app).get("/api/admin/topups/summary").set(...authHeader(alice));
    expect(resUser.status).toBe(403);
    const resAdmin = await request(app).get("/api/admin/topups/summary").set(...authHeader(admin));
    expect(resAdmin.status).toBe(403);
  });

  it("sums only approved rows, grouped by user, excluding pending/rejected", async () => {
    const bob = await createUser("user");

    // Every self-service package now goes through DOKU Checkout, which
    // this file doesn't mock (see topups-doku.test.ts for that). Drive
    // every amount here through the admin-approve path instead
    // (insertPendingTopup bypasses fixed-package validation entirely),
    // which reaches the exact same "approved" end state this test cares
    // about.
    async function submitAndApprove(user: SeedUser, amountRupiah: number, creditsGranted: number) {
      const id = await insertPendingTopup(user, amountRupiah, creditsGranted);
      const res = await request(app)
        .patch(`/api/admin/topups/${id}/status`)
        .set(...authHeader(superAdmin))
        .send({ status: "approved" });
      expect(res.status).toBe(200);
      expect(res.body.creditsGranted).toBe(creditsGranted);
      return id;
    }

    // Rejected/pending rows — seed a pending row directly, then (for
    // "reject") drive it through the real admin endpoint. Arbitrary
    // amounts here — insertPendingTopup bypasses the fixed-package
    // validation.
    async function submitAndReject(user: SeedUser, amountRupiah: number, creditsRequested: number) {
      const id = await insertPendingTopup(user, amountRupiah, creditsRequested);
      await request(app)
        .patch(`/api/admin/topups/${id}/status`)
        .set(...authHeader(superAdmin))
        .send({ status: "rejected" });
    }

    async function submitPending(user: SeedUser, amountRupiah: number, creditsRequested: number) {
      await insertPendingTopup(user, amountRupiah, creditsRequested);
    }

    // bob buys the two smaller packages; `other` buys the third.
    await submitAndApprove(bob, PKG_5K.amountRupiah, PKG_5K.credits);
    await submitAndApprove(bob, PKG_20K.amountRupiah, PKG_20K.credits);
    await submitAndReject(bob, 999_000, 999); // must not count
    await submitPending(bob, 888_000, 888); // must not count

    const other = await createUser("user");
    await submitAndApprove(other, PKG_40K.amountRupiah, PKG_40K.credits);

    const res = await request(app).get("/api/admin/topups/summary").set(...authHeader(superAdmin));
    expect(res.status).toBe(200);

    const bobTotalAmount = PKG_5K.amountRupiah + PKG_20K.amountRupiah;
    const bobTotalCredits = PKG_5K.credits + PKG_20K.credits;
    const bobRow = res.body.byUser.find((r: { userId: number }) => r.userId === bob.id);
    expect(bobRow).toMatchObject({
      totalAmountRupiah: bobTotalAmount,
      totalCreditsGranted: bobTotalCredits,
      requestCount: 2,
    });
    expect(bobRow.lastApprovedAt).not.toBeNull();

    const otherRow = res.body.byUser.find((r: { userId: number }) => r.userId === other.id);
    expect(otherRow).toMatchObject({
      totalAmountRupiah: PKG_40K.amountRupiah,
      totalCreditsGranted: PKG_40K.credits,
      requestCount: 1,
    });

    // Totals include at least this test's approved rows (other tests in this
    // file/suite may also contribute approved rows to the shared totals, so
    // assert a lower bound rather than exact equality).
    const minTotalAmount = bobTotalAmount + PKG_40K.amountRupiah;
    const minTotalCredits = bobTotalCredits + PKG_40K.credits;
    expect(res.body.totalAmountRupiah).toBeGreaterThanOrEqual(minTotalAmount);
    expect(res.body.totalCreditsGranted).toBeGreaterThanOrEqual(minTotalCredits);
    expect(res.body.approvedRequestCount).toBeGreaterThanOrEqual(3);

    // byMonth: every approval above just happened, so they all land in the
    // current WIB (UTC+7) calendar month's bucket — same lower-bound
    // reasoning as the totals above (other tests share this bucket too).
    const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const monthKey = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
    const monthRow = res.body.byMonth.find((r: { month: string }) => r.month === monthKey);
    expect(monthRow).toBeTruthy();
    expect(monthRow.totalAmountRupiah).toBeGreaterThanOrEqual(minTotalAmount);
    expect(monthRow.totalCreditsGranted).toBeGreaterThanOrEqual(minTotalCredits);
    expect(monthRow.requestCount).toBeGreaterThanOrEqual(3);
  });

  it("excludes a user with only a pending or rejected request from byUser", async () => {
    const carol = await createUser("user");
    await insertPendingTopup(carol, 750, 3);
    // Left pending — never approved.

    const res = await request(app).get("/api/admin/topups/summary").set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.byUser.some((r: { userId: number }) => r.userId === carol.id)).toBe(false);
  });
});

describe("DELETE /admin/topups/:id", () => {
  it("returns 401 without auth", async () => {
    const id = await insertPendingTopup(alice, 1_000, 4);
    const res = await request(app).delete(`/api/admin/topups/${id}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a plain admin (super_admin only)", async () => {
    const id = await insertPendingTopup(alice, 1_000, 4);
    const res = await request(app)
      .delete(`/api/admin/topups/${id}`)
      .set(...authHeader(admin));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app)
      .delete("/api/admin/topups/999999999")
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(404);
  });

  it("deletes a pending request without touching the credit balance", async () => {
    const id = await insertPendingTopup(alice, 1_000, 4);
    const before = await request(app).get("/api/topups/balance").set(...authHeader(alice));

    const res = await request(app)
      .delete(`/api/admin/topups/${id}`)
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, creditsReversed: 0 });

    const after = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    expect(after.body.balance).toBe(before.body.balance);

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, id));
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.deletedByUserId).toBe(superAdmin.id);
  });

  it("deleting an approved request claws back the granted credits via a reversal ledger entry", async () => {
    const id = await insertPendingTopup(alice, PKG_5K.amountRupiah, PKG_5K.credits);
    const approved = await request(app)
      .patch(`/api/admin/topups/${id}/status`)
      .set(...authHeader(superAdmin))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);

    const before = await request(app).get("/api/topups/balance").set(...authHeader(alice));

    const res = await request(app)
      .delete(`/api/admin/topups/${id}`)
      .set(...authHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, creditsReversed: PKG_5K.credits });
    expect(res.body.creditBalance).toBe(before.body.balance - PKG_5K.credits);

    const after = await request(app).get("/api/topups/balance").set(...authHeader(alice));
    expect(after.body.balance).toBe(before.body.balance - PKG_5K.credits);

    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.topupRequestId, id));
    expect(ledgerRows).toHaveLength(2);
    const reversal = ledgerRows.find((r) => r.source === "topup_reversal");
    expect(reversal?.amount).toBe(-PKG_5K.credits);
  });

  it("a deleted request no longer appears in GET /admin/topups or GET /admin/topups/summary", async () => {
    const dave = await createUser("user");
    const id = await insertPendingTopup(dave, PKG_5K.amountRupiah, PKG_5K.credits);
    await request(app)
      .patch(`/api/admin/topups/${id}/status`)
      .set(...authHeader(superAdmin))
      .send({ status: "approved" });

    await request(app).delete(`/api/admin/topups/${id}`).set(...authHeader(superAdmin));

    const list = await request(app)
      .get("/api/admin/topups")
      .set(...authHeader(admin))
      .query({ status: "approved" });
    expect(list.body.requests.some((r: { id: number }) => r.id === id)).toBe(false);

    const summary = await request(app).get("/api/admin/topups/summary").set(...authHeader(superAdmin));
    expect(summary.body.byUser.some((r: { userId: number }) => r.userId === dave.id)).toBe(false);
  });

  it("returns 404 on a second delete of the same request (already deleted)", async () => {
    const id = await insertPendingTopup(alice, 1_000, 4);
    const first = await request(app)
      .delete(`/api/admin/topups/${id}`)
      .set(...authHeader(superAdmin));
    expect(first.status).toBe(200);

    const second = await request(app)
      .delete(`/api/admin/topups/${id}`)
      .set(...authHeader(superAdmin));
    expect(second.status).toBe(404);
  });
});
