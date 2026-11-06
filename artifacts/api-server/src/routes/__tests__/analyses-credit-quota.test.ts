import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

// Same mock shape as analyses-push.test.ts — no real OpenAI call, just a
// fixed beginner-mode output so the route can proceed past generateAnalysis.
vi.mock("../../lib/openai", async () => {
  const actual = await vi.importActual<typeof import("../../lib/openai")>("../../lib/openai");
  return {
    ...actual,
    generateAnalysis: vi.fn(async () => ({
      output: {
        marketCondition: "ranging" as const,
        riskLevel: "low" as const,
        confidenceMin: 55,
        confidenceMax: 70,
        tradingBias: "neutral" as const,
        opportunity: "Tunggu breakout struktur untuk konfirmasi.",
        risk: "Sideways panjang bisa kasih sinyal palsu.",
        mainScenario: "Sideways menuju resistance.",
        alternativeScenario: "Breakdown ke support.",
        whyReason: "Likuiditas tipis, range jelas.",
        failureConditions: "Close di luar range.",
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 1 },
      model: "gpt-4o-mock",
    })),
  };
});

vi.mock("../../lib/webpush", async () => {
  const actual = await vi.importActual<typeof import("../../lib/webpush")>("../../lib/webpush");
  return { ...actual, sendPushToUser: vi.fn(async () => 0) };
});

vi.mock("../../lib/adaptive-readiness", async () => {
  const actual = await vi.importActual<typeof import("../../lib/adaptive-readiness")>("../../lib/adaptive-readiness");
  return { ...actual, checkAdaptiveReadiness: vi.fn(async () => "ready" as const) };
});

const request = (await import("supertest")).default;
const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, analyses, notifications, creditBalances, creditLedger } = await import(
  "@workspace/db/schema"
);
const { applyCreditLedgerEntry } = await import("../../lib/credits");
const { checkAdaptiveReadiness } = await import("../../lib/adaptive-readiness");
const { generateAnalysis } = await import("../../lib/openai");

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `analyses-credit-test-${RUN_ID}`;

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const seededUserIds: number[] = [];

// customQuotaPerDay = 0 makes the very first analysis request already
// "over quota" (dailyCount 0 >= perDay 0), without needing to seed a pile
// of prior analyses just to exhaust the default 20/day limit.
async function createZeroQuotaUser(): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Credit Quota Test ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash,
      customQuotaPerDay: 0,
    })
    .returning({ id: users.id });

  const token = `credit-quota-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

async function seedCredits(userId: number, amount: number): Promise<void> {
  await db.transaction(async (tx) => {
    await applyCreditLedgerEntry(tx, {
      userId,
      amount,
      source: "test_seed",
      sourceEventId: `seed-${randomBytes(4).toString("hex")}`,
    });
  });
}

afterAll(async () => {
  if (seededUserIds.length) {
    // creditLedger.analysisId FK-restricts deleting analyses, so the ledger
    // must go first.
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, seededUserIds));
    await db.delete(creditBalances).where(inArray(creditBalances.userId, seededUserIds));
    await db.delete(analyses).where(inArray(analyses.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("POST /analyses credit fallback", () => {
  it("still delivers the core analysis when optional Adaptive candles are unavailable", async () => {
    const user = await createZeroQuotaUser();
    await seedCredits(user.id, 2);
    vi.mocked(checkAdaptiveReadiness).mockResolvedValueOnce("feed_unavailable");
    const aiCallsBefore = vi.mocked(generateAnalysis).mock.calls.length;

    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ instrument: "XAU/USD", timeframe: "1h", mode: "beginner" });

    expect(res.status).toBe(201);
    expect(res.body.creditConsumed).toBe(true);
    expect(vi.mocked(generateAnalysis).mock.calls.length).toBe(aiCallsBefore + 1);
    const [balance] = await db.select().from(creditBalances).where(eq(creditBalances.userId, user.id));
    expect(balance?.balance).toBe(1);
    expect(await db.select().from(analyses).where(eq(analyses.userId, user.id))).toHaveLength(1);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, user.id))).toHaveLength(2);
  });

  it("charges once when Adaptive inputs are ready, without repeating the preflight on a saved result", async () => {
    const user = await createZeroQuotaUser();
    await seedCredits(user.id, 2);
    const aiCallsBefore = vi.mocked(generateAnalysis).mock.calls.length;
    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ instrument: "XAU/USD", timeframe: "1h", mode: "beginner" });
    expect(res.status).toBe(201);
    expect(res.body.creditConsumed).toBe(true);
    expect(res.body.creditBalance).toBe(1);
    expect(vi.mocked(generateAnalysis).mock.calls.length).toBe(aiCallsBefore + 1);
    const saved = await request(app).get(`/api/analyses/${res.body.id}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(saved.status).toBe(200);
    expect(vi.mocked(generateAnalysis).mock.calls.length).toBe(aiCallsBefore + 1);
  });

  it("still 429s exactly as before when the user has zero credits", async () => {
    const user = await createZeroQuotaUser();
    const instrument = "XAU/USD";
    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ instrument, timeframe: "1h", mode: "beginner" });

    expect(res.status).toBe(429);
    expect(res.body.quota).toMatchObject({ scope: "day" });
    expect(res.body.creditConsumed).toBeUndefined();
  });

  it("consumes exactly 1 credit and lets the analysis through when balance is positive", async () => {
    const user = await createZeroQuotaUser();
    await seedCredits(user.id, 3);

    const instrument = "XAU/USD";
    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ instrument, timeframe: "1h", mode: "beginner" });

    expect(res.status).toBe(201);
    expect(res.body.creditConsumed).toBe(true);
    expect(res.body.creditBalance).toBe(2);

    const [balanceRow] = await db
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.userId, user.id))
      .limit(1);
    expect(balanceRow?.balance).toBe(2);

    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, user.id));
    const consumption = ledgerRows.find((r) => r.source === "analysis_consumption");
    expect(consumption?.amount).toBe(-1);
    expect(consumption?.analysisId).toBe(res.body.id);
  });

  it("does not spend a credit when the AI call fails", async () => {
    const { generateAnalysis } = await import("../../lib/openai");
    vi.mocked(generateAnalysis).mockRejectedValueOnce(new Error("boom"));

    const user = await createZeroQuotaUser();
    await seedCredits(user.id, 2);

    const instrument = "XAU/USD";
    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ instrument, timeframe: "1h", mode: "beginner" });

    expect(res.status).toBe(502);

    const [balanceRow] = await db
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.userId, user.id))
      .limit(1);
    expect(balanceRow?.balance).toBe(2);
  });

  it("reports the balance in GET /analyses/quota", async () => {
    const user = await createZeroQuotaUser();
    await seedCredits(user.id, 5);

    const res = await request(app)
      .get("/api/analyses/quota")
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body.credits).toMatchObject({ balance: 5 });
  });
});
