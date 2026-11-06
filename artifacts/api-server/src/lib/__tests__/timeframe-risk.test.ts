import { describe, expect, it } from "vitest";
import type { TechnicalIndicators } from "../indicators";
import {
  isRiskMapInstrument,
  mapWithConcurrency,
  scoreTimeframeRisk,
} from "../timeframe-risk";

const indicator = (overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators => ({
  symbol: "EUR/USD", dataPoints: 200, lastClose: 100, lastDate: new Date().toISOString(),
  change1d: 0, change1dPct: 0, change5d: 0, change5dPct: 1, change20d: 2, change20dPct: 2,
  rsi14: { name: "RSI(14)", value: 52, signal: "Neutral" },
  macd: { macd: 1, signal: 0, histogram: 1, action: "Buy" },
  stochastic: { k: 50, d: 50, signal: "Neutral" },
  bollinger: { upper: 102, middle: 100, lower: 98, signal: "Neutral" },
  movingAverages: [],
  oscillatorSummary: { buy: 1, sell: 0, neutral: 3 },
  maSummary: { buy: 4, sell: 0, neutral: 0 },
  overallSummary: { buy: 5, sell: 0, neutral: 3, signal: "Buy" },
  ...overrides,
});

describe("timeframe risk model", () => {
  it("limits the map to its explicitly supported instruments", () => {
    expect(isRiskMapInstrument("XAU/USD")).toBe(true);
    expect(isRiskMapInstrument("BRENT")).toBe(true);
    expect(isRiskMapInstrument("HSI")).toBe(true);
    expect(isRiskMapInstrument("NIKKEI")).toBe(true);
    for (const instrument of ["EUR/USD", "GBP/USD", "AUD/USD", "USD/JPY"]) {
      expect(isRiskMapInstrument(instrument)).toBe(true);
    }
    expect(isRiskMapInstrument("CUSTOM")).toBe(false);
  });

  it("does not misrepresent unavailable or stale data as low risk", () => {
    expect(scoreTimeframeRisk("1h", null)).toMatchObject({
      status: "unavailable", riskScore: null, riskCategory: "unavailable", dataQuality: "unavailable",
    });
    const stale = indicator({ lastDate: new Date(Date.now() - 4 * 60 * 60_000).toISOString() });
    expect(scoreTimeframeRisk("1h", stale)).toMatchObject({
      status: "insufficient", riskScore: null, reasonCodes: ["DATA_STALE"], dataQuality: "stale",
    });
  });

  it("fails closed for malformed or future indicator inputs", () => {
    const future = indicator({ lastDate: new Date(Date.now() + 60_000).toISOString() });
    expect(scoreTimeframeRisk("1h", future)).toMatchObject({
      status: "insufficient", riskScore: null, riskCategory: "unavailable",
      reasonCodes: ["FUTURE_TIMESTAMP"], recommendation: "wait",
    });
    const malformed = indicator({
      lastClose: Number.NaN,
      change20dPct: Number.POSITIVE_INFINITY,
      rsi14: { name: "RSI(14)", value: 101, signal: "Sell" },
      bollinger: { upper: 90, middle: 100, lower: 110, signal: "Sell" },
      overallSummary: { buy: -1, sell: Number.NaN, neutral: 0, signal: "Neutral" },
    });
    expect(scoreTimeframeRisk("1h", malformed)).toMatchObject({
      status: "insufficient", riskScore: null, riskCategory: "unavailable",
      dataQuality: "unavailable", recommendation: "wait",
    });
    expect(scoreTimeframeRisk("1h", malformed).reasonCodes).toEqual(expect.arrayContaining([
      "INVALID_LAST_CLOSE", "INVALID_BOLLINGER_BANDS", "INVALID_SIGNAL_COUNTS",
      "INVALID_RSI", "INVALID_CHANGE_20_PCT",
    ]));
  });

  it("raises risk for conflicted, extended and volatile indicators", () => {
    const calm = scoreTimeframeRisk("1h", indicator());
    const stressed = scoreTimeframeRisk("1h", indicator({
      change20dPct: 15,
      rsi14: { name: "RSI(14)", value: 78, signal: "Sell" },
      bollinger: { upper: 110, middle: 100, lower: 90, signal: "Sell" },
      overallSummary: { buy: 4, sell: 4, neutral: 0, signal: "Neutral" },
    }));
    expect(calm.riskScore).not.toBeNull();
    expect(stressed.riskScore!).toBeGreaterThan(calm.riskScore!);
    expect(stressed.reasonCodes).toEqual(expect.arrayContaining(["SIGNAL_CONFLICT", "RSI_EXTREME", "HIGH_VOLATILITY"]));
  });

  it("bounds work concurrency while retaining input order", async () => {
    let active = 0;
    let peak = 0;
    const values = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value * 2;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(values).toEqual([2, 4, 6, 8]);
  });
});