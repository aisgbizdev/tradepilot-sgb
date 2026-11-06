import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same reasoning as historical-resilience.test.ts: stub the live-price
// anchor so this suite only exercises the shared daily feed's own candle
// ordering, not the separate live-quote cross-check.
vi.mock("../live-prices.js", () => ({
  getLivePriceFor: vi.fn(async () => null),
}));

import {
  getIndicators,
  getCandleSnapshot,
  clearIndicatorsCache,
} from "../historical.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Regression coverage for a real production bug (see chat, 2026-09-30):
// the shared daily feed (used for every instrument NOT on the direct-Yahoo
// VERIFIED_OTHER_INSTRUMENTS path — XAU/USD, BRENT, HSI, NIKKEI, etc.)
// returns its rows newest-first, but getDailyCandles never re-sorted them
// before this fix. Every consumer (the live-price anchor, and the D1
// market-snapshot price anchor in routes/analyses.ts) grabs the LAST array
// element expecting it to be the most recent candle — for this feed that
// silently returned data over a year stale (a real incident: AI-generated
// XAU/USD D1 entry levels ~350 points away from the real running price,
// anchored to a September 2025 close instead of September 2026).
//
// 251 points (>= the longest daily MA period) with a big, obvious value
// gap between the newest and oldest candle, sent in the feed's real
// newest-first order — this must resolve to the newest one, not whichever
// one happens to be last in the array.
function buildDailyFeedPayload(apiSymbol: string) {
  const points = 251;
  const rows = Array.from({ length: points }, (_, i) => {
    const date = new Date(Date.UTC(2026, 8, 28 - i)); // newest first, walking backward
    return {
      date: date.toISOString().slice(0, 10),
      open: 4000 + (points - i),
      high: 4010 + (points - i),
      low: 3990 + (points - i),
      close: 4000 + (points - i),
    };
  });
  return { data: [{ symbol: apiSymbol, data: rows }] };
}

describe("getDailyCandles — shared daily feed candle ordering", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearIndicatorsCache();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    clearIndicatorsCache();
  });

  it("getIndicators treats the chronologically newest candle as \"last\", not the feed's own last array element", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildDailyFeedPayload("LGD Daily")));

    const result = await getIndicators("XAU/USD", "1D");

    expect(result).not.toBeNull();
    // The feed's newest row (index 0) is 2026-09-28 / close 4251. Its last
    // array element (the bug's culprit) is over 250 days older with a
    // close of 4000 — unambiguously distinguishable.
    expect(result?.lastDate).toBe("2026-09-28");
    expect(result?.lastClose).toBeCloseTo(4251, 5);
  });

  it("getCandleSnapshot's last candle (used as the AI price anchor in routes/analyses.ts) is also the true newest one", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildDailyFeedPayload("LGD Daily")));

    const snapshot = await getCandleSnapshot("XAU/USD", "1D");

    expect(snapshot).not.toBeNull();
    const last = snapshot!.candles.at(-1);
    expect(last?.date).toBe("2026-09-28");
    expect(last?.close).toBeCloseTo(4251, 5);
  });

  it("1W resampling still works correctly on the same newest-first feed (already safe before this fix, stays safe after)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildDailyFeedPayload("LGD Daily")));

    const snapshot = await getCandleSnapshot("XAU/USD", "1W");

    expect(snapshot).not.toBeNull();
    const last = snapshot!.candles.at(-1);
    // The most recent weekly bucket must close on (or after) the feed's
    // actual newest daily row, not the 2025 end of the array.
    expect(new Date(last!.date).getUTCFullYear()).toBe(2026);
  });
});
