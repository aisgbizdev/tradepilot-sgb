import { describe, it, expect, beforeEach } from "vitest";
import {
  detectAnomaly,
  recordSnapshot,
  pctChangeAcross,
  fiveMinuteThresholdFor,
  thirtyMinAnomalyThresholdPct,
  computeStddevPct,
  _clearSnapshots,
  _clearStddevCache,
} from "../price-anomaly";

describe("price-anomaly: pure helpers", () => {
  beforeEach(() => {
    _clearSnapshots();
    _clearStddevCache();
  });

  it("fiveMinuteThresholdFor distinguishes FX vs commodity vs unknown", () => {
    expect(fiveMinuteThresholdFor("EUR/USD")).toBe(0.5);
    expect(fiveMinuteThresholdFor("XAU/USD")).toBe(1.0);
    expect(fiveMinuteThresholdFor("BRENT")).toBe(1.0);
    // Unknown defaults to the stricter FX threshold (safer = fewer pings).
    expect(fiveMinuteThresholdFor("ZZZ/ZZZ")).toBe(0.5);
  });

  it("computeStddevPct: too-few points returns null", () => {
    expect(computeStddevPct([100, 101])).toBeNull();
    expect(computeStddevPct([])).toBeNull();
  });

  it("computeStddevPct: ignores non-finite / non-positive entries", () => {
    const flat = [100, 100, 100, 100, 100, 100];
    expect(computeStddevPct(flat)).toBeNull();
    const withNoise = [100, 101, 102, 101, 100, 103, 104, 102];
    const sd = computeStddevPct(withNoise);
    expect(sd).not.toBeNull();
    expect(sd!).toBeGreaterThan(0);
  });

  it("thirtyMinAnomalyThresholdPct scales daily stddev down to a 30m slice", () => {
    // 30m / 1440m ≈ 0.0208; sqrt ≈ 0.144; × 3 ≈ 0.433 of daily stddev.
    const thr = thirtyMinAnomalyThresholdPct(2.0);
    expect(thr).toBeGreaterThan(0.8);
    expect(thr).toBeLessThan(1.0);
  });

  it("pctChangeAcross returns null on cold start, and value within tolerance otherwise", () => {
    const now = 1_700_000_000_000;
    expect(pctChangeAcross("EUR/USD", 1.1, now, 5 * 60_000)).toBeNull();
    recordSnapshot("EUR/USD", 1.1, now - 5 * 60_000);
    const out = pctChangeAcross("EUR/USD", 1.111, now, 5 * 60_000);
    expect(out).not.toBeNull();
    expect(out!).toBeCloseTo(1.0, 1);
  });

  it("pctChangeAcross drops a snapshot that falls outside the 20% tolerance window", () => {
    const now = 1_700_000_000_000;
    // Snapshot is 9 minutes old, but we're asking for the 5-min window.
    // Tolerance is 20% of 5min = 1min — 9min is way outside.
    recordSnapshot("EUR/USD", 1.1, now - 9 * 60_000);
    expect(pctChangeAcross("EUR/USD", 1.2, now, 5 * 60_000)).toBeNull();
  });
});

describe("price-anomaly: detectAnomaly", () => {
  beforeEach(() => {
    _clearSnapshots();
  });

  it("fires for a clear FX 5m move above threshold", () => {
    const now = 1_700_000_000_000;
    recordSnapshot("EUR/USD", 1.1000, now - 5 * 60_000);
    const sig = detectAnomaly({
      instrument: "EUR/USD",
      nowPrice: 1.1077, // ~0.7% move
      now,
      dailyStddevPct: null,
    });
    expect(sig).not.toBeNull();
    expect(sig!.reason).toBe("5m_threshold");
    expect(sig!.windowMinutes).toBe(5);
  });

  it("does not fire when 5m move is below FX threshold and stddev unknown", () => {
    const now = 1_700_000_000_000;
    recordSnapshot("EUR/USD", 1.1000, now - 5 * 60_000);
    const sig = detectAnomaly({
      instrument: "EUR/USD",
      nowPrice: 1.1022, // ~0.2% — under 0.5% FX threshold
      now,
      dailyStddevPct: null,
    });
    expect(sig).toBeNull();
  });

  it("fires on 30m vs daily stddev × scaled × 3", () => {
    const now = 1_700_000_000_000;
    recordSnapshot("XAU/USD", 2000, now - 30 * 60_000);
    // Daily stddev 2%; 30m threshold ≈ 0.87% (2 × 0.144 × 3).
    const sig = detectAnomaly({
      instrument: "XAU/USD",
      // 30m move = +1.5% — clears the 30m threshold but not the 1% 5m
      // threshold (no 5m snapshot anyway, so 5m branch returns null).
      nowPrice: 2030,
      now,
      dailyStddevPct: 2.0,
    });
    expect(sig).not.toBeNull();
    expect(sig!.reason).toBe("30m_stddev");
    expect(sig!.windowMinutes).toBe(30);
  });

  it("commodity needs a bigger 5m move than FX to fire", () => {
    const now = 1_700_000_000_000;
    recordSnapshot("XAU/USD", 2000, now - 5 * 60_000);
    // 0.6% would fire on EUR/USD but not on XAU/USD.
    const sig = detectAnomaly({
      instrument: "XAU/USD",
      nowPrice: 2012,
      now,
      dailyStddevPct: null,
    });
    expect(sig).toBeNull();
  });
});
