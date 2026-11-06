import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TechnicalIndicators } from "../../lib/indicators";

const getIndicators = vi.fn();

vi.mock("../../middleware/auth", () => ({
  requireAuth: (req: { userId?: number }, _res: unknown, next: () => void) => {
    req.userId = 1;
    next();
  },
}));

vi.mock("../../lib/historical", () => ({
  getIndicators,
}));

const { default: timeframeRiskRouter } = await import("../timeframe-risk");
const app = express();
app.use("/api", timeframeRiskRouter);

const indicator = (symbol: string, timeframe: string): TechnicalIndicators => ({
  symbol,
  dataPoints: 200,
  lastClose: 100,
  lastDate: new Date().toISOString(),
  change1d: 0,
  change1dPct: 0,
  change5d: 0,
  change5dPct: 0,
  change20d: 2,
  change20dPct: 2,
  rsi14: { name: "RSI(14)", value: 52, signal: "Neutral" },
  macd: { macd: 1, signal: 0, histogram: 1, action: "Buy" },
  stochastic: { k: 50, d: 50, signal: "Neutral" },
  bollinger: { upper: 102, middle: 100, lower: 98, signal: "Neutral" },
  movingAverages: [],
  oscillatorSummary: { buy: 1, sell: 0, neutral: 3 },
  maSummary: { buy: 4, sell: 0, neutral: 0 },
  overallSummary: { buy: 5, sell: 0, neutral: 3, signal: "Buy" },
});

describe("GET /api/risk-map/timeframes", () => {
  it("returns all five supported timeframes for an authenticated valid instrument", async () => {
    getIndicators.mockImplementation(async (symbol: string, timeframe: string) =>
      indicator(symbol, timeframe));

    const response = await request(app).get("/api/risk-map/timeframes?instrument=XAU%2FUSD");

    expect(response.status).toBe(200);
    expect(response.body.instrument).toBe("XAU/USD");
    expect(response.body.timeframes).toHaveLength(5);
    expect(response.body.timeframes.map((item: { timeframe: string }) => item.timeframe))
      .toEqual(["15m", "1h", "4h", "1D", "1W"]);
    expect(getIndicators).toHaveBeenCalledTimes(5);
  });

  it.each(["EUR/USD", "GBP/USD", "AUD/USD", "USD/JPY"])("provides the same comparison for %s", async (instrument) => {
    getIndicators.mockClear();
    getIndicators.mockImplementation(async (symbol: string, timeframe: string) =>
      indicator(symbol, timeframe));
    const response = await request(app).get(`/api/risk-map/timeframes?instrument=${encodeURIComponent(instrument)}`);
    expect(response.status).toBe(200);
    expect(response.body.instrument).toBe(instrument);
    expect(response.body.timeframes).toHaveLength(5);
    expect(getIndicators).toHaveBeenCalledTimes(5);
  });

  it("rejects an authenticated unsupported instrument before indicator work", async () => {
    getIndicators.mockClear();

    const response = await request(app).get("/api/risk-map/timeframes?instrument=UNKNOWN");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("XAU/USD, BRENT, HSI, NIKKEI");
    expect(getIndicators).not.toHaveBeenCalled();
  });

  it("has no direct DB, AI, quota, or analysis-history route dependencies", () => {
    const source = readFileSync(fileURLToPath(new URL("../timeframe-risk.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:\/db|openai|analyses)["']/);
    expect(source).not.toMatch(/\b(?:quota|generateAnalysis|db\.)\b/);
  });
});