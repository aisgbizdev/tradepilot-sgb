import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateAnalysis: vi.fn(),
}));

vi.mock("../historical.js", () => ({
  getIndicators: vi.fn(async () => null),
  formatIndicatorsForPrompt: vi.fn(() => ""),
}));
vi.mock("../news.js", () => ({
  getRelevantNews: vi.fn(async () => []),
  formatNewsForPrompt: vi.fn(() => ""),
}));
vi.mock("../calendar.js", () => ({
  getRelevantCalendar: vi.fn(async () => []),
  formatCalendarForPrompt: vi.fn(() => ""),
}));
vi.mock("../live-prices.js", () => ({
  getLivePriceFor: vi.fn(async () => 4_400),
}));
vi.mock("../openai.js", () => ({
  generateAnalysis: mocks.generateAnalysis,
}));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import {
  _resetLandingPreviewCache,
  getLandingPreviewSnapshot,
} from "../landing-preview.js";

function analysisOutput(overrides: Record<string, unknown> = {}) {
  const side = {
    entryZone: "4,390 – 4,400",
    stopLoss: "4,370",
    takeProfit1: "4,430",
    takeProfit2: "4,460",
    riskRewardRatio: "1:1.5",
    rationale: "Test-only rationale",
  };
  return {
    output: {
      marketCondition: "trending_up",
      tradingBias: "bullish",
      confidenceMin: 55,
      confidenceMax: 70,
      tradePlan: {
        preferredSide: "buy",
        buy: side,
        sell: {
          ...side,
          entryZone: "4,420 – 4,430",
        },
      },
      ...overrides,
    },
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      callCount: 1,
    },
    model: "test",
  };
}

describe("public landing preview snapshot", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetLandingPreviewCache();
    mocks.generateAnalysis.mockReset();
    mocks.generateAnalysis.mockResolvedValue(analysisOutput());
  });

  it("deduplicates concurrent generation and exposes only selected card levels", async () => {
    const [first, second] = await Promise.all([
      getLandingPreviewSnapshot(),
      getLandingPreviewSnapshot(),
    ]);

    expect(mocks.generateAnalysis).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.instrument).toBe("XAU/USD");
    expect(first.timeframe).toBe("1D");
    expect(first.levels).toEqual({
      entryZone: "4,390 – 4,400",
      stopLoss: "4,370",
      takeProfit1: "4,430",
      takeProfit2: "4,460",
      riskRewardRatio: "1:1.5",
    });
    expect(JSON.stringify(first)).not.toContain("rationale");
  });

  it("backs off failed refreshes while serving the last stale snapshot", async () => {
    const baseTime = new Date("2026-08-31T04:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    await getLandingPreviewSnapshot();

    vi.setSystemTime(new Date(baseTime.getTime() + 15 * 60 * 1000 + 1));
    mocks.generateAnalysis.mockRejectedValue(new Error("upstream unavailable"));

    const stale = await getLandingPreviewSnapshot();
    const staleAgain = await getLandingPreviewSnapshot();

    expect(stale.isStale).toBe(true);
    expect(staleAgain.isStale).toBe(true);
    expect(mocks.generateAnalysis).toHaveBeenCalledTimes(2);
  });

  it("normalizes contradictory model side and confidence fields", async () => {
    mocks.generateAnalysis.mockResolvedValue(
      analysisOutput({
        tradingBias: "bullish_strong",
        confidenceMin: 65,
        confidenceMax: 20,
        tradePlan: {
          preferredSide: "sell",
          buy: {
            entryZone: "4,390 – 4,400",
            stopLoss: "4,370",
            takeProfit1: "4,430",
            takeProfit2: "4,460",
            riskRewardRatio: "1:1.5",
            rationale: "Buy side",
          },
          sell: {
            entryZone: "4,420 – 4,430",
            stopLoss: "4,450",
            takeProfit1: "4,380",
            takeProfit2: "4,350",
            riskRewardRatio: "1:1.4",
            rationale: "Sell side",
          },
        },
      }),
    );

    const snapshot = await getLandingPreviewSnapshot();

    expect(snapshot.preferredSide).toBe("buy");
    expect(snapshot.confidenceMin).toBe(65);
    expect(snapshot.confidenceMax).toBe(75);
    expect(snapshot.levels?.entryZone).toBe("4,390 – 4,400");
  });
});