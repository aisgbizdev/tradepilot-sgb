import { describe, it, expect } from "vitest";

import { calculateIndicators } from "../indicators.js";

// Build N synthetic hourly candles. Enough points (>=200) so every MA period
// in both intraday and daily ladders has data.
function buildCandles(n = 250) {
  const start = Date.UTC(2026, 0, 1);
  const out = [] as Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }>;
  for (let i = 0; i < n; i++) {
    const base = 100 + Math.sin(i / 7) * 3 + i * 0.05;
    out.push({
      date: new Date(start + i * 3600_000).toISOString(),
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base + (i % 2 === 0 ? 0.1 : -0.1),
    });
  }
  return out;
}

describe("calculateIndicators – timeframe-aware MA period selection", () => {
  const candles = buildCandles();

  it("uses the long daily ladder when no timeframe is supplied (back-compat)", () => {
    const result = calculateIndicators("EUR/USD", candles);
    const smaPeriods = result.movingAverages
      .filter((m) => m.type === "SMA")
      .map((m) => m.period)
      .sort((a, b) => a - b);
    const emaPeriods = result.movingAverages
      .filter((m) => m.type === "EMA")
      .map((m) => m.period)
      .sort((a, b) => a - b);
    expect(smaPeriods).toEqual([5, 10, 20, 50, 100, 200]);
    expect(emaPeriods).toEqual([10, 20, 50]);
  });

  it("uses the long daily ladder for explicit '1D' / '1W'", () => {
    for (const tf of ["1D", "1W"] as const) {
      const result = calculateIndicators("EUR/USD", candles, tf);
      const smas = result.movingAverages
        .filter((m) => m.type === "SMA")
        .map((m) => m.period)
        .sort((a, b) => a - b);
      expect(smas, `failed for ${tf}`).toEqual([5, 10, 20, 50, 100, 200]);
    }
  });

  it("uses the shorter intraday ladder for 1m/5m/15m/30m/1h/4h", () => {
    for (const tf of ["1m", "5m", "15m", "30m", "1h", "4h"] as const) {
      const result = calculateIndicators("EUR/USD", candles, tf);
      const smas = result.movingAverages
        .filter((m) => m.type === "SMA")
        .map((m) => m.period)
        .sort((a, b) => a - b);
      const emas = result.movingAverages
        .filter((m) => m.type === "EMA")
        .map((m) => m.period)
        .sort((a, b) => a - b);
      expect(smas, `SMA failed for ${tf}`).toEqual([10, 20, 50, 100]);
      expect(emas, `EMA failed for ${tf}`).toEqual([9, 21, 50]);
      // No 200-period MA on intraday — that's the entire point of the change.
      expect(smas).not.toContain(200);
    }
  });

  it("intraday MA tally has fewer slots than daily, so the overall summary is not dominated by long-horizon trend", () => {
    const intra = calculateIndicators("EUR/USD", candles, "4h");
    const daily = calculateIndicators("EUR/USD", candles, "1D");
    const intraMaCount = intra.movingAverages.length;
    const dailyMaCount = daily.movingAverages.length;
    expect(intraMaCount).toBe(7); // 4 SMA + 3 EMA
    expect(dailyMaCount).toBe(9); // 6 SMA + 3 EMA
    expect(intraMaCount).toBeLessThan(dailyMaCount);
  });
});
