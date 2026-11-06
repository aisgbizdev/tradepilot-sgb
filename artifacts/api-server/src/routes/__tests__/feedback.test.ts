import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import {
  users,
  sessions,
  analyses,
  feedback,
  xpLedger,
} from "@workspace/db/schema";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `feedback-test-${RUN_ID}`;
const INSTRUMENT_PREFIX = `FB-${RUN_ID}`;

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

type Role = "user" | "admin" | "super_admin";

const seededUserIds: number[] = [];
const seededAnalysisIds: number[] = [];

let alice: SeedUser;
let bob: SeedUser;
let adminUser: SeedUser;
let superAdminUser: SeedUser;

let aliceAnalysisId: number;
let bobAnalysisId: number;

async function createUser(role: Role = "user"): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Feedback Test ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash,
      role,
    })
    .returning({ id: users.id });

  const token = `feedback-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
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

async function seedAnalysis(userId: number): Promise<number> {
  const [row] = await db
    .insert(analyses)
    .values({
      userId,
      instrument: `${INSTRUMENT_PREFIX}-${randomBytes(2).toString("hex")}`,
      timeframe: "1h",
      mode: "beginner",
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      marketCondition: "ranging",
      riskLevel: "low",
      confidenceMin: 50,
      confidenceMax: 70,
    })
    .returning({ id: analyses.id });
  seededAnalysisIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
  adminUser = await createUser("admin");
  superAdminUser = await createUser("super_admin");
  aliceAnalysisId = await seedAnalysis(alice.id);
  bobAnalysisId = await seedAnalysis(bob.id);
});

afterAll(async () => {
  if (seededAnalysisIds.length > 0) {
    // feedback rows cascade-delete with the analyses (FK ON DELETE CASCADE),
    // but be explicit so a leaked row never survives a partial test run.
    await db
      .delete(feedback)
      .where(inArray(feedback.analysisId, seededAnalysisIds));
    await db.delete(analyses).where(inArray(analyses.id, seededAnalysisIds));
  }
  if (seededUserIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  // Final sweep by email prefix in case any test created a user we didn't track.
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("POST /analyses/:id/feedback auth gate", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .send({ feedbackType: "useful" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a bogus bearer token", async () => {
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set("Authorization", "Bearer not-a-real-token")
      .send({ feedbackType: "useful" });
    expect(res.status).toBe(401);
  });
});

describe("POST /analyses/:id/feedback owns-the-analysis check", () => {
  it("returns 404 when another user tries to attach feedback to someone else's analysis (no enumeration, no leak)", async () => {
    // bob tries to post feedback on alice's analysis — must look identical
    // to a missing analysis from his perspective.
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set(...authHeader(bob))
      .send({ feedbackType: "useful" });
    expect(res.status).toBe(404);

    // And no feedback row may have been written.
    const rows = await db
      .select({ id: feedback.id })
      .from(feedback)
      .where(eq(feedback.analysisId, aliceAnalysisId));
    expect(rows.length).toBe(0);
  });

  it("returns 404 for an unknown analysis id", async () => {
    const res = await request(app)
      .post(`/api/analyses/999999999/feedback`)
      .set(...authHeader(alice))
      .send({ feedbackType: "useful" });
    expect(res.status).toBe(404);
  });
});

describe("POST /analyses/:id/feedback enum validation", () => {
  it("returns 400 when feedbackType is missing", async () => {
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set(...authHeader(alice))
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when feedbackType is empty string", async () => {
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set(...authHeader(alice))
      .send({ feedbackType: "" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown feedbackType value", async () => {
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set(...authHeader(alice))
      .send({ feedbackType: "amazing" });
    expect(res.status).toBe(400);
  });

  it("validates feedbackType BEFORE touching the analysis (no row leak on bad enum even with wrong owner)", async () => {
    // bob hits alice's analysis with a bad enum — must still 400, never 404,
    // and must never insert a row.
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set(...authHeader(bob))
      .send({ feedbackType: "amazing" });
    expect(res.status).toBe(400);

    const rows = await db
      .select({ id: feedback.id })
      .from(feedback)
      .where(eq(feedback.analysisId, aliceAnalysisId));
    expect(rows.length).toBe(0);
  });
});

describe("POST /analyses/:id/feedback happy path", () => {
  it("creates a new feedback row with 201 and persists feedbackType / outcome / note", async () => {
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set(...authHeader(alice))
      .send({
        feedbackType: "useful",
        outcome: "correct",
        note: `note-${RUN_ID}`,
      });
    expect(res.status).toBe(201);
    expect(res.body.feedbackType).toBe("useful");
    expect(res.body.outcome).toBe("correct");
    expect(res.body.note).toBe(`note-${RUN_ID}`);
    expect(res.body.userId).toBe(alice.id);
    expect(res.body.analysisId).toBe(aliceAnalysisId);

    const [row] = await db
      .select()
      .from(feedback)
      .where(eq(feedback.id, res.body.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.feedbackType).toBe("useful");
    expect(row.outcome).toBe("correct");
    expect(row.note).toBe(`note-${RUN_ID}`);
    const awards = await db.select().from(xpLedger).where(eq(xpLedger.userId, alice.id));
    expect(awards.filter((award) => award.source === "analysis_evaluation")).toHaveLength(1);
    expect(awards.find((award) => award.source === "analysis_evaluation")?.xp).toBe(12);
  });

  it("a second POST from the same owner UPDATES (not duplicates) the existing row", async () => {
    // Re-submit with different values; route should return 200 (not 201)
    // and there should still be exactly one feedback row for (analysis, user).
    const res = await request(app)
      .post(`/api/analyses/${aliceAnalysisId}/feedback`)
      .set(...authHeader(alice))
      .send({
        feedbackType: "not_useful",
        outcome: "wrong",
        note: null,
      });
    expect(res.status).toBe(200);
    expect(res.body.feedbackType).toBe("not_useful");
    const awards = await db.select().from(xpLedger).where(eq(xpLedger.userId, alice.id));
    expect(awards.filter((award) => award.source === "analysis_evaluation")).toHaveLength(1);
    expect(res.body.outcome).toBe("wrong");
    expect(res.body.note).toBeNull();

    const rows = await db
      .select({ id: feedback.id, feedbackType: feedback.feedbackType })
      .from(feedback)
      .where(eq(feedback.analysisId, aliceAnalysisId));
    expect(rows.length).toBe(1);
    expect(rows[0].feedbackType).toBe("not_useful");
  });

  it("bob can attach feedback to his OWN analysis without leaking onto alice's", async () => {
    const res = await request(app)
      .post(`/api/analyses/${bobAnalysisId}/feedback`)
      .set(...authHeader(bob))
      .send({ feedbackType: "useful" });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(bob.id);
    expect(res.body.analysisId).toBe(bobAnalysisId);

    // Bob's feedback must not appear under alice's analysis.
    const aliceRows = await db
      .select({ userId: feedback.userId })
      .from(feedback)
      .where(eq(feedback.analysisId, aliceAnalysisId));
    for (const r of aliceRows) {
      expect(r.userId).toBe(alice.id);
    }
  });
});

describe("GET /admin/feedback", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await request(app).get("/api/admin/feedback");
    expect(res.status).toBe(401);
  });

  it("returns 401 with a bogus bearer token", async () => {
    const res = await request(app)
      .get("/api/admin/feedback")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a regular (role=user) caller", async () => {
    const res = await request(app)
      .get("/api/admin/feedback")
      .set(...authHeader(alice));
    expect(res.status).toBe(403);
  });

  it("returns 200 for an admin caller", async () => {
    const res = await request(app)
      .get("/api/admin/feedback")
      .set(...authHeader(adminUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.feedback)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
  });

  it("returns 200 for a super_admin caller", async () => {
    const res = await request(app)
      .get("/api/admin/feedback")
      .set(...authHeader(superAdminUser));
    expect(res.status).toBe(200);
  });

  it("includes the user email and instrument joined onto each feedback row", async () => {
    const res = await request(app)
      .get("/api/admin/feedback?limit=200")
      .set(...authHeader(adminUser));
    expect(res.status).toBe(200);

    // The earlier "happy path" tests already created feedback for our two
    // seeded analyses. Find ours and confirm the join columns are present.
    const ours = res.body.feedback.filter(
      (f: { analysisId: number }) =>
        f.analysisId === aliceAnalysisId || f.analysisId === bobAnalysisId,
    );
    expect(ours.length).toBeGreaterThanOrEqual(2);
    for (const row of ours) {
      expect(typeof row.userEmail).toBe("string");
      expect(row.userEmail).toMatch(/@example\.test$/);
      expect(typeof row.instrument).toBe("string");
      expect(row.instrument.startsWith(INSTRUMENT_PREFIX)).toBe(true);
    }
  });

  it("orders rows by createdAt DESC (most recent first)", async () => {
    const res = await request(app)
      .get("/api/admin/feedback?limit=200")
      .set(...authHeader(adminUser));
    expect(res.status).toBe(200);
    const ts = res.body.feedback.map((f: { createdAt: string }) =>
      new Date(f.createdAt).getTime(),
    );
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i]);
    }
  });

  it("filters by feedbackType server-side (only matching reactions are returned, total reflects the filter)", async () => {
    const onlyUseful = await request(app)
      .get("/api/admin/feedback?feedbackType=useful&limit=200")
      .set(...authHeader(adminUser));
    expect(onlyUseful.status).toBe(200);
    const usefulOurs = onlyUseful.body.feedback.filter(
      (f: { analysisId: number }) =>
        f.analysisId === aliceAnalysisId || f.analysisId === bobAnalysisId,
    );
    // Bob's row is the only one of ours that's still "useful" after the
    // happy-path block updated alice's row to "not_useful".
    expect(usefulOurs.length).toBeGreaterThanOrEqual(1);
    for (const row of onlyUseful.body.feedback) {
      expect(row.feedbackType).toBe("useful");
    }

    const onlyNotUseful = await request(app)
      .get("/api/admin/feedback?feedbackType=not_useful&limit=200")
      .set(...authHeader(adminUser));
    expect(onlyNotUseful.status).toBe(200);
    for (const row of onlyNotUseful.body.feedback) {
      expect(row.feedbackType).toBe("not_useful");
    }

    // Bogus enum values must be ignored, not 500 — the route falls back to
    // "no feedbackType filter".
    const garbage = await request(app)
      .get("/api/admin/feedback?feedbackType=amazing&limit=200")
      .set(...authHeader(adminUser));
    expect(garbage.status).toBe(200);
    expect(garbage.body.total).toBeGreaterThanOrEqual(onlyUseful.body.total);
  });

  it("free-text search ILIKEs over user email AND analysis instrument", async () => {
    // Search by alice's email — must include alice's row, exclude bob's.
    const byEmail = await request(app)
      .get(`/api/admin/feedback?search=${encodeURIComponent(alice.email)}&limit=200`)
      .set(...authHeader(adminUser));
    expect(byEmail.status).toBe(200);
    expect(
      byEmail.body.feedback.some(
        (f: { analysisId: number }) => f.analysisId === aliceAnalysisId,
      ),
    ).toBe(true);
    expect(
      byEmail.body.feedback.every(
        (f: { userEmail: string; instrument: string }) =>
          f.userEmail.includes(alice.email) ||
          f.instrument.toLowerCase().includes(alice.email.toLowerCase()),
      ),
    ).toBe(true);

    // Search by the shared instrument prefix — must match BOTH our analyses.
    const byInstrument = await request(app)
      .get(`/api/admin/feedback?search=${INSTRUMENT_PREFIX}&limit=200`)
      .set(...authHeader(adminUser));
    expect(byInstrument.status).toBe(200);
    const ours = byInstrument.body.feedback.filter(
      (f: { analysisId: number }) =>
        f.analysisId === aliceAnalysisId || f.analysisId === bobAnalysisId,
    );
    expect(ours.length).toBeGreaterThanOrEqual(2);

    // Total in the response must reflect the filter, not the unfiltered count.
    expect(byInstrument.body.total).toBeGreaterThanOrEqual(ours.length);
    expect(byInstrument.body.total).toBeLessThanOrEqual(
      byInstrument.body.feedback.length + 1,
    );

    // A search that can't possibly match returns an empty page.
    const miss = await request(app)
      .get(
        `/api/admin/feedback?search=${encodeURIComponent("zzz-no-such-thing-" + RUN_ID)}&limit=200`,
      )
      .set(...authHeader(adminUser));
    expect(miss.status).toBe(200);
    expect(miss.body.feedback.length).toBe(0);
    expect(miss.body.total).toBe(0);
  });

  it("date range from/to is inclusive end-of-day and excludes feedback outside the window", async () => {
    // All seeded rows were created during this test run, so a future "from"
    // must yield zero rows for them.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const future = await request(app)
      .get(`/api/admin/feedback?from=${tomorrow}&search=${INSTRUMENT_PREFIX}&limit=200`)
      .set(...authHeader(adminUser));
    expect(future.status).toBe(200);
    expect(future.body.total).toBe(0);
    expect(future.body.feedback.length).toBe(0);

    // A "to" of yesterday excludes today's seeded rows too.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const past = await request(app)
      .get(`/api/admin/feedback?to=${yesterday}&search=${INSTRUMENT_PREFIX}&limit=200`)
      .set(...authHeader(adminUser));
    expect(past.status).toBe(200);
    const oursPast = past.body.feedback.filter(
      (f: { analysisId: number }) =>
        f.analysisId === aliceAnalysisId || f.analysisId === bobAnalysisId,
    );
    expect(oursPast.length).toBe(0);

    // A from..to window covering today is inclusive and matches our rows
    // (proving the end-of-day snap on `to`).
    const today = new Date().toISOString().slice(0, 10);
    const window = await request(app)
      .get(
        `/api/admin/feedback?from=${today}&to=${today}&search=${INSTRUMENT_PREFIX}&limit=200`,
      )
      .set(...authHeader(adminUser));
    expect(window.status).toBe(200);
    const oursWindow = window.body.feedback.filter(
      (f: { analysisId: number }) =>
        f.analysisId === aliceAnalysisId || f.analysisId === bobAnalysisId,
    );
    expect(oursWindow.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores malformed date params instead of crashing", async () => {
    const res = await request(app)
      .get("/api/admin/feedback?from=not-a-date&to=also-not&limit=200")
      .set(...authHeader(adminUser));
    expect(res.status).toBe(200);
    // With both dates ignored, total should equal the unfiltered total.
    const baseline = await request(app)
      .get("/api/admin/feedback?limit=200")
      .set(...authHeader(adminUser));
    expect(res.body.total).toBe(baseline.body.total);
  });

  it("filters compose: search + feedbackType + date range together", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(
        `/api/admin/feedback?search=${INSTRUMENT_PREFIX}&feedbackType=useful&from=${today}&to=${today}&limit=200`,
      )
      .set(...authHeader(adminUser));
    expect(res.status).toBe(200);
    for (const row of res.body.feedback) {
      expect(row.feedbackType).toBe("useful");
      expect(row.instrument.startsWith(INSTRUMENT_PREFIX)).toBe(true);
    }
  });

  it("clamps page and limit just like /superadmin/users (page>=1, limit 1..200)", async () => {
    const negPage = await request(app)
      .get("/api/admin/feedback?page=-5&limit=20")
      .set(...authHeader(adminUser));
    expect(negPage.status).toBe(200);
    expect(negPage.body.page).toBe(1);
    expect(negPage.body.limit).toBe(20);

    const zeroLimit = await request(app)
      .get("/api/admin/feedback?page=1&limit=0")
      .set(...authHeader(adminUser));
    expect(zeroLimit.status).toBe(200);
    expect(zeroLimit.body.limit).toBe(1);

    const hugeLimit = await request(app)
      .get("/api/admin/feedback?page=1&limit=999999")
      .set(...authHeader(adminUser));
    expect(hugeLimit.status).toBe(200);
    expect(hugeLimit.body.limit).toBe(200);

    const garbage = await request(app)
      .get("/api/admin/feedback?page=abc&limit=xyz")
      .set(...authHeader(adminUser));
    expect(garbage.status).toBe(200);
    expect(garbage.body.page).toBe(1);
    expect(garbage.body.limit).toBe(50);
  });
});
