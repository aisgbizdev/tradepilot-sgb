// Coverage for POST /api/analyses/:id/refresh-fundamentals.
//
// The route re-fetches news + calendar without re-running the AI, persists
// the fresh snapshot on the analyses row, and returns a "drift" report
// against the citations the AI originally emitted. This file exercises:
//   - 401 when unauthenticated.
//   - 404 when the analysis exists but belongs to a different user.
//   - 200 happy path: persistence + correct drift accounting (originally
//     cited news + calendar items that no longer match the fresh window
//     show up in `missingCitations`; ones that still match do not).
//   - The OpenAI client is NEVER invoked during refresh.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

// Mock the AI module so we can both (a) provide deterministic
// `fundamentalCitations` for the seed analyses and (b) assert that the
// refresh route never calls into generateAnalysis.
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
        // Both citations are "real" against the initial news/calendar
        // mocks below — drift against fresh data is what we test.
        fundamentalCitations: {
          newsTitles: ["EUR rises on dovish ECB minutes"],
          calendarEvents: ["FOMC Rate Decision USD"],
        },
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 1 },
      model: "gpt-4o-mock",
    })),
  };
});

// Indicators are stubbed because the create-analysis path calls them; the
// refresh route itself does not — we just need a deterministic seed row.
vi.mock("../../lib/historical", async () => {
  const actual = await vi.importActual<typeof import("../../lib/historical")>("../../lib/historical");
  return {
    ...actual,
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
      movingAverages: [],
      overallSummary: { buy: 6, sell: 2, neutral: 4, signal: "Buy" as const },
      oscillatorSummary: { buy: 2, sell: 0, neutral: 2 },
      maSummary: { buy: 4, sell: 2, neutral: 2 },
    })),
  };
});

// News + calendar are mocked with mutable refs so we can swap the return
// value between the create-analysis call and the refresh call to simulate
// the upstream window moving on.
const newsRef = { current: [] as Array<{ id: string; title: string; summary: string; source: string; url: string; publishedAt: string }> };
const calendarRef = { current: [] as Array<{ date: string; time: string; currency: string; event: string; impact: string; actual: string | null; forecast: string | null; previous: string | null }> };

vi.mock("../../lib/news", async () => {
  const actual = await vi.importActual<typeof import("../../lib/news")>("../../lib/news");
  return {
    ...actual,
    getRelevantNews: vi.fn(async () => newsRef.current),
  };
});

vi.mock("../../lib/calendar", async () => {
  const actual = await vi.importActual<typeof import("../../lib/calendar")>("../../lib/calendar");
  return {
    ...actual,
    getRelevantCalendar: vi.fn(async () => calendarRef.current),
  };
});

const request = (await import("supertest")).default;
const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, analyses, creditLedger } = await import("@workspace/db/schema");
const { generateAnalysis } = await import("../../lib/openai");
const { getRelevantNews } = await import("../../lib/news");
const { getRelevantCalendar } = await import("../../lib/calendar");

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `analyses-refresh-fund-${RUN_ID}`;
const INSTRUMENT = "XAU/USD";

interface SeedUser {
  id: number;
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
      displayName: `Refresh Fund Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
      role: "admin",
    })
    .returning({ id: users.id });

  const token = `analyses-refresh-fund-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, token };
}

async function seedAnalysis(userToken: string, instrument: string): Promise<number> {
  // Initial news + calendar that the AI mock will be "shown" — and that
  // the AI mock's `fundamentalCitations` already cite. This lets the
  // create path persist a row whose rawAiOutput points at REAL items.
  newsRef.current = [
    {
      id: "yahoo-test-1",
      title: "EUR rises on dovish ECB minutes",
      summary: "Euro climbed against the dollar after minutes signaled a dovish tilt.",
      source: "Yahoo Finance",
      url: "https://finance.yahoo.com/news/eur-rises",
      publishedAt: "2026-04-29T10:00:00.000Z",
    },
  ];
  calendarRef.current = [
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
  ];
  const res = await request(app)
    .post("/api/analyses")
    .set("Authorization", `Bearer ${userToken}`)
    .send({ instrument, timeframe: "1h", mode: "beginner" });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(analyses).where(inArray(analyses.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  // The broad instrument-prefix sweep below can catch rows left by another
  // test file that also uses the bare "XAU/USD" instrument (e.g.
  // analyses-30m.test.ts) — clear any credit_ledger rows referencing them
  // first, or the FK constraint rejects the delete.
  const staleAnalysisIds = db
    .select({ id: analyses.id })
    .from(analyses)
    .where(like(analyses.instrument, `${INSTRUMENT}%`));
  await db.delete(creditLedger).where(inArray(creditLedger.analysisId, staleAnalysisIds));
  await db.delete(analyses).where(like(analyses.instrument, `${INSTRUMENT}%`));
});

describe("POST /api/analyses/:id/refresh-fundamentals", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    const id = await seedAnalysis(alice.token, INSTRUMENT);
    const res = await request(app).post(`/api/analyses/${id}/refresh-fundamentals`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when the analysis is owned by a different user", async () => {
    const id = await seedAnalysis(alice.token, INSTRUMENT);
    const res = await request(app)
      .post(`/api/analyses/${id}/refresh-fundamentals`)
      .set("Authorization", `Bearer ${bob.token}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the analysis id does not exist at all", async () => {
    const res = await request(app)
      .post(`/api/analyses/9999999/refresh-fundamentals`)
      .set("Authorization", `Bearer ${alice.token}`);
    expect(res.status).toBe(404);
  });

  it(
    "re-fetches news + calendar, persists the fresh snapshot, reports drift, and never calls the AI",
    async () => {
      const id = await seedAnalysis(alice.token, INSTRUMENT);

      // Reset the AI mock's call count so we can prove the refresh route
      // never invokes it. (Seed already triggered the AI once.)
      const generateAnalysisMock = vi.mocked(generateAnalysis);
      const aiCallsBefore = generateAnalysisMock.mock.calls.length;

      // Move the upstream window: drop the original cited news, add an
      // unrelated headline. Keep the original calendar event so we can
      // assert it counts as still-grounded.
      newsRef.current = [
        {
          id: "yahoo-test-2",
          title: "USD weakens on weak retail sales",
          summary: "Dollar dipped after retail sales missed estimates.",
          source: "Yahoo Finance",
          url: "https://finance.yahoo.com/news/usd-weak",
          publishedAt: "2026-04-30T10:00:00.000Z",
        },
      ];
      // Calendar event still present — ensures it's NOT counted as drift.
      calendarRef.current = [
        {
          date: "2026-04-30",
          time: "19:30",
          currency: "USD",
          event: "FOMC Rate Decision",
          impact: "★★★",
          actual: "5.25%",
          forecast: "5.25%",
          previous: "5.50%",
        },
      ];

      const res = await request(app)
        .post(`/api/analyses/${id}/refresh-fundamentals`)
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);

      // Fresh snapshot reflects the NEW upstream data, not the seed data.
      expect(res.body.fundamentalContext.newsItems).toHaveLength(1);
      expect(res.body.fundamentalContext.newsItems[0].title).toBe(
        "USD weakens on weak retail sales",
      );
      expect(res.body.fundamentalContext.calendarEvents).toHaveLength(1);
      expect(res.body.fundamentalContext.calendarEvents[0].event).toBe(
        "FOMC Rate Decision",
      );

      // Drift accounting: the AI cited 1 news + 1 calendar item (2 total).
      // The news headline is gone from the fresh window, the calendar
      // event is still present — so exactly ONE missing citation, of
      // kind "news".
      expect(res.body.drift.totalCitations).toBe(2);
      expect(res.body.drift.missingCitations).toEqual([
        { kind: "news", label: "EUR rises on dovish ECB minutes" },
      ]);

      // Server-issued ISO timestamp.
      expect(typeof res.body.refreshedAt).toBe("string");
      expect(Number.isNaN(Date.parse(res.body.refreshedAt))).toBe(false);

      // Persisted on the row so the audit card re-renders the new data.
      const [stored] = await db
        .select()
        .from(analyses)
        .where(eq(analyses.id, id));
      expect(stored.fundamentalContext).toMatchObject({
        newsItems: [
          expect.objectContaining({ title: "USD weakens on weak retail sales" }),
        ],
        calendarEvents: [
          expect.objectContaining({ event: "FOMC Rate Decision" }),
        ],
      });

      // Refresh route uses the live news/calendar fetchers but NEVER
      // invokes the AI — that's the whole point of the endpoint.
      expect(getRelevantNews).toHaveBeenCalled();
      expect(getRelevantCalendar).toHaveBeenCalled();
      expect(generateAnalysisMock.mock.calls.length).toBe(aiCallsBefore);
    },
  );

  it("treats a malformed rawAiOutput as zero original citations and still succeeds", async () => {
    const id = await seedAnalysis(alice.token, INSTRUMENT);
    // Corrupt the persisted rawAiOutput so JSON.parse will throw inside
    // the refresh route — defensive parsing must keep the response alive
    // and report `totalCitations: 0` instead of 5xx-ing the user.
    await db
      .update(analyses)
      .set({ rawAiOutput: "{not valid json" })
      .where(eq(analyses.id, id));

    const res = await request(app)
      .post(`/api/analyses/${id}/refresh-fundamentals`)
      .set("Authorization", `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.drift.totalCitations).toBe(0);
    expect(res.body.drift.missingCitations).toEqual([]);
  });

  it("returns zero drift when the fresh window still contains every cited item", async () => {
    const id = await seedAnalysis(alice.token, INSTRUMENT);
    // Leave the upstream data exactly as the seed left it — every
    // original citation should still match.
    const res = await request(app)
      .post(`/api/analyses/${id}/refresh-fundamentals`)
      .set("Authorization", `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.drift.totalCitations).toBe(2);
    expect(res.body.drift.missingCitations).toEqual([]);
  });
});
