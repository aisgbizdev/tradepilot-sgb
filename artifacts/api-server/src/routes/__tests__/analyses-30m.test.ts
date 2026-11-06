import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

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
        opportunity: "Tunggu konfirmasi.",
        risk: "Sinyal palsu di sideways.",
        mainScenario: "Sideways menuju resistance.",
        alternativeScenario: "Breakdown ke support.",
        whyReason: "Likuiditas tipis, range jelas.",
        failureConditions: "Close di luar range.",
        tradePlan: {
          preferredSide: "wait" as const,
          buy: {
            entryZone: "1.0840 - 1.0848",
            stopLoss: "1.0820",
            takeProfit1: "1.0880",
            takeProfit2: "1.0905",
            riskRewardRatio: "1:2",
            rationale: "Buy hanya kalau breakout di atas 1.0860 dengan volume.",
          },
          sell: {
            entryZone: "1.0895 - 1.0905",
            stopLoss: "1.0925",
            takeProfit1: "1.0860",
            takeProfit2: "1.0830",
            riskRewardRatio: "1:2",
            rationale: "Sell di area resistance kalau muncul rejection candle.",
          },
        },
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 1 },
      model: "gpt-4o-mock",
    })),
  };
});

vi.mock("../../lib/historical", async () => {
  const actual = await vi.importActual<typeof import("../../lib/historical")>("../../lib/historical");
  return {
    ...actual,
    getCandleSnapshot: vi.fn(async () => ({
      candles: [{
        date: "2026-04-29T10:00:00.000Z",
        open: 1.085,
        high: 1.087,
        low: 1.084,
        close: 1.086,
      }],
      sourceFetchedAt: "2026-04-29T10:00:00.000Z",
      sourceMaxAgeMs: 4 * 60 * 1000,
      isStale: false,
      staleReason: null,
    })),
    getIndicators: vi.fn(async (symbol: string) => ({
      symbol,
      lastClose: 1.0852,
      lastDate: "2026-04-29",
      change1dPct: 0.12,
      change5dPct: 0.45,
      change20dPct: 0.85,
      dataPoints: 240,
      rsi14: { value: 54.3, signal: "Neutral" as const },
      macd: { macd: 0.0012, signal: 0.0008, histogram: 0.0004, action: "Buy" as const },
      stochastic: { k: 62.1, d: 58.4, signal: "Buy" as const },
      bollinger: { upper: 1.09, middle: 1.085, lower: 1.08, signal: "Neutral" as const },
      movingAverages: [
        { type: "SMA" as const, period: 5, value: 1.0848, signal: "Buy" as const },
        { type: "SMA" as const, period: 10, value: 1.0845, signal: "Buy" as const },
      ],
      overallSummary: { buy: 6, sell: 2, neutral: 4, signal: "Buy" as const },
      oscillatorSummary: { buy: 2, sell: 0, neutral: 2 },
      maSummary: { buy: 4, sell: 2, neutral: 2 },
    })),
  };
});

vi.mock("../../lib/news", async () => {
  const actual = await vi.importActual<typeof import("../../lib/news")>("../../lib/news");
  return {
    ...actual,
    getRelevantNews: vi.fn(async () => [
      {
        id: "yahoo-test-1",
        title: "EUR rises on dovish ECB minutes",
        summary: "Euro climbed against the dollar after minutes signaled a dovish tilt.",
        source: "Yahoo Finance",
        url: "https://finance.yahoo.com/news/eur-rises",
        publishedAt: "2026-04-29T10:00:00.000Z",
      },
    ]),
  };
});

vi.mock("../../lib/calendar", async () => {
  const actual = await vi.importActual<typeof import("../../lib/calendar")>("../../lib/calendar");
  return {
    ...actual,
    getRelevantCalendar: vi.fn(async () => [
      {
        date: "2026-04-30",
        time: "19:30",
        currency: "USD",
        event: "FOMC Rate Decision",
        impact: "★★★",
        actual: null,
        forecast: "5.25%",
        previous: "5.50%",
      },
    ]),
  };
});

const request = (await import("supertest")).default;
const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, analyses, creditLedger } = await import("@workspace/db/schema");
const { generateAnalysis } = await import("../../lib/openai");
const { getCandleSnapshot, getIndicators } = await import("../../lib/historical");

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `analyses-30m-test-${RUN_ID}`;
const INSTRUMENT = "XAU/USD";

interface SeedUser {
  id: number;
  token: string;
}

const seededUserIds: number[] = [];
let alice: SeedUser;

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
      displayName: `30m Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
      role: "admin",
    })
    .returning({ id: users.id });

  const token = `analyses-30m-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, token };
}

beforeAll(async () => {
  alice = await createUser();
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(analyses).where(inArray(analyses.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  // The broad instrument-prefix sweep below can catch rows left by another
  // test file that also uses the bare "XAU/USD" instrument (e.g.
  // analyses-refresh-fundamentals.test.ts) — clear any credit_ledger rows
  // referencing them first, or the FK constraint rejects the delete.
  const staleAnalysisIds = db
    .select({ id: analyses.id })
    .from(analyses)
    .where(like(analyses.instrument, `${INSTRUMENT}%`));
  await db.delete(creditLedger).where(inArray(creditLedger.analysisId, staleAnalysisIds));
  await db.delete(analyses).where(like(analyses.instrument, `${INSTRUMENT}%`));
});

describe("POST /api/analyses with timeframe 30m", () => {
  it("accepts the 30m timeframe, fetches 30m indicators, and stores the analysis with that timeframe", async () => {
    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${alice.token}`)
      .send({
        instrument: INSTRUMENT,
        timeframe: "30m",
        mode: "beginner",
      });

    expect(res.status).toBe(201);
    expect(res.body.timeframe).toBe("30m");
    expect(res.body.instrument).toBe(INSTRUMENT);
    expect(res.body.mode).toBe("beginner");
    expect(res.body.marketSnapshot).toMatchObject({
      instrument: INSTRUMENT,
      timeframe: "30m",
      sourceFetchedAt: "2026-04-29T10:00:00.000Z",
      candles: [{ close: 1.086 }],
      priceAtAnalysis: 1.086,
      sourceStatus: "fresh",
    });
    // Indicator snapshot from the mocked getIndicators flows through into
    // the saved row so the saved analysis page can render the same gauge.
    expect(res.body.techBuyCount).toBe(6);
    expect(res.body.techSellCount).toBe(2);
    expect(res.body.techNeutralCount).toBe(4);

    expect(res.body.tradePlan).toMatchObject({
      preferredSide: "wait",
      buy: { entryZone: expect.any(String), stopLoss: expect.any(String) },
      sell: { entryZone: expect.any(String), stopLoss: expect.any(String) },
    });

    expect(getIndicators).toHaveBeenCalledWith(INSTRUMENT, "30m");
    expect(getCandleSnapshot).toHaveBeenCalledWith(INSTRUMENT, "30m");
    // Sixth arg is the fundamental snapshot passed for citation grounding —
    // assert its shape rather than identity so future field tweaks don't
    // turn this into a brittle test.
    expect(generateAnalysis).toHaveBeenCalledWith(
      INSTRUMENT,
      "30m",
      "beginner",
      undefined,
      expect.any(String),
      expect.objectContaining({
        newsItems: expect.arrayContaining([
          expect.objectContaining({ source: "Yahoo Finance" }),
        ]),
        calendarEvents: expect.arrayContaining([
          expect.objectContaining({ event: "FOMC Rate Decision" }),
        ]),
      }),
      // The selected candle's close is both the AI anchor (7th arg) and
      // the value persisted into marketSnapshot — the fresh candle
      // snapshot's close overrides the (unmocked, null) live feed.
      1.086,
      1.086,
      // Ninth arg is the AI cost-attribution tier — this test's user is
      // privileged (admin/super_admin), which always maps to "dev".
      "dev",
    );

    const detail = await request(app)
      .get(`/api/analyses/${res.body.id}`)
      .set("Authorization", `Bearer ${alice.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.marketSnapshot).toEqual(res.body.marketSnapshot);

    // The persisted snapshot is also returned in the response so the
    // saved-analysis page can render the same fundamental context the
    // model saw, without re-fetching live data that may have moved on.
    expect(res.body.fundamentalContext).toMatchObject({
      newsItems: expect.arrayContaining([
        expect.objectContaining({
          title: "EUR rises on dovish ECB minutes",
          source: "Yahoo Finance",
        }),
      ]),
      calendarEvents: expect.arrayContaining([
        expect.objectContaining({
          event: "FOMC Rate Decision",
          impact: "★★★",
        }),
      ]),
    });

    const [stored] = await db
      .select()
      .from(analyses)
      .where(eq(analyses.id, res.body.id));
    expect(stored).toBeDefined();
    expect(stored.timeframe).toBe("30m");
    expect(stored.fundamentalContext).toMatchObject({
      newsItems: expect.any(Array),
      calendarEvents: expect.any(Array),
    });
  });
});
