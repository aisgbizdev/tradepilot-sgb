/**
 * GET /admin/analytics/tokens — the `bySegment` breakdown (token usage +
 * analysis count per cost/revenue segment; see lib/user-segment.ts).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users, sessions, analyses, aiTokenUsage } from "@workspace/db/schema";
import { applyCreditLedgerEntry } from "../../lib/credits";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `admin-analytics-tokens-test-${RUN_ID}`;
const INSTRUMENT_PREFIX = `AATOK-${RUN_ID}`;
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
      displayName: `Admin Analytics Tokens Test ${RUN_ID}`,
      role,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `aatok-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
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
  return row!.id;
}

async function seedTokenUsage(userId: number, analysisId: number, totalTokens: number): Promise<void> {
  await db.insert(aiTokenUsage).values({
    userId,
    analysisId,
    model: "gpt-4o-mock",
    promptTokens: Math.floor(totalTokens / 2),
    completionTokens: Math.ceil(totalTokens / 2),
    totalTokens,
    callCount: 1,
    estimatedCostUsd: "0.001000",
    instrument: `${INSTRUMENT_PREFIX}-seed`,
  });
}

afterAll(async () => {
  await db.delete(analyses).where(like(analyses.instrument, `${INSTRUMENT_PREFIX}%`));
  if (seededUserIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("GET /admin/analytics/tokens — bySegment", () => {
  it("always returns exactly 3 entries (free, paid, dev), zero-filled where there's no activity", async () => {
    const superAdmin = await createUser("super_admin");
    const res = await request(app)
      .get("/api/admin/analytics/tokens")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.bySegment)).toBe(true);
    expect(res.body.bySegment).toHaveLength(3);
    const segments = res.body.bySegment.map((r: { segment: string }) => r.segment).sort();
    expect(segments).toEqual(["dev", "free", "paid"]);
  });

  it("attributes token usage and analysis count to the free segment for a plain user", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/analytics/tokens")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const freeBefore = before.body.bySegment.find((r: { segment: string }) => r.segment === "free");

    const freeUser = await createUser();
    const analysisId = await seedAnalysis(freeUser.id);
    await seedTokenUsage(freeUser.id, analysisId, 500);

    const after = await request(app)
      .get("/api/admin/analytics/tokens")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const freeAfter = after.body.bySegment.find((r: { segment: string }) => r.segment === "free");
    expect(freeAfter.totalTokens).toBe(freeBefore.totalTokens + 500);
    expect(freeAfter.analysisCount).toBe(freeBefore.analysisCount + 1);
  });

  it("attributes token usage to the paid segment for a user with a lifetime top-up", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/analytics/tokens")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const paidBefore = before.body.bySegment.find((r: { segment: string }) => r.segment === "paid");

    const paidUser = await createUser();
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: paidUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `tok-seg-paid-${RUN_ID}`,
      });
    });
    const analysisId = await seedAnalysis(paidUser.id);
    await seedTokenUsage(paidUser.id, analysisId, 777);

    const after = await request(app)
      .get("/api/admin/analytics/tokens")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const paidAfter = after.body.bySegment.find((r: { segment: string }) => r.segment === "paid");
    expect(paidAfter.totalTokens).toBe(paidBefore.totalTokens + 777);
    expect(paidAfter.analysisCount).toBe(paidBefore.analysisCount + 1);
  });

  it("attributes token usage to the dev segment for a user with a quota override, even if they also topped up", async () => {
    const superAdmin = await createUser("super_admin");
    const before = await request(app)
      .get("/api/admin/analytics/tokens")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const devBefore = before.body.bySegment.find((r: { segment: string }) => r.segment === "dev");
    const paidBefore = before.body.bySegment.find((r: { segment: string }) => r.segment === "paid");

    const devUser = await createUser();
    await db.transaction(async (tx) => {
      await applyCreditLedgerEntry(tx, {
        userId: devUser.id,
        amount: 15,
        source: "topup_approval",
        sourceEventId: `tok-seg-dev-${RUN_ID}`,
      });
    });
    await db.update(users).set({ customQuotaPerDay: 100 }).where(eq(users.id, devUser.id));
    const analysisId = await seedAnalysis(devUser.id);
    await seedTokenUsage(devUser.id, analysisId, 999);

    const after = await request(app)
      .get("/api/admin/analytics/tokens")
      .set("Authorization", `Bearer ${superAdmin.token}`);
    const devAfter = after.body.bySegment.find((r: { segment: string }) => r.segment === "dev");
    const paidAfter = after.body.bySegment.find((r: { segment: string }) => r.segment === "paid");
    expect(devAfter.totalTokens).toBe(devBefore.totalTokens + 999);
    expect(devAfter.analysisCount).toBe(devBefore.analysisCount + 1);
    // Dev wins over paid despite the real top-up on record.
    expect(paidAfter.totalTokens).toBe(paidBefore.totalTokens);
  });
});
