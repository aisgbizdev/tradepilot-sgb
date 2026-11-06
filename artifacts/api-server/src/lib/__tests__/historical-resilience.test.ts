import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Stub the live-price anchor so this suite only exercises the Yahoo
// resilience path. `getIndicators` now calls `getLivePriceFor` to
// re-anchor candle prices to the live feed, which would otherwise add
// extra fetch calls and break the fetch-count assertions here.
vi.mock("../live-prices.js", () => ({
  getLivePriceFor: vi.fn(async () => null),
}));

import {
  getIndicators,
  clearIndicatorsCache,
  YAHOO_RETRY_CONFIG,
} from "../historical.js";

// Build a minimal but realistic Yahoo /chart response. We only need enough
// candles for `calculateIndicators` to produce values without throwing — the
// indicator math itself is covered elsewhere. Using a generated 250-point
// series clears the longest period (200) used by the SMA panel.
function buildYahooPayload(symbol: string, points = 250) {
  const now = Math.floor(Date.now() / 1000);
  const ts: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  for (let i = 0; i < points; i++) {
    // Hourly spacing — matches the 1h interval our intraday path requests.
    ts.push(now - (points - i) * 3600);
    const base = 100 + Math.sin(i / 5) * 2 + i * 0.01;
    open.push(base);
    high.push(base + 0.5);
    low.push(base - 0.5);
    close.push(base + (i % 2 === 0 ? 0.1 : -0.1));
  }
  return {
    chart: {
      result: [
        {
          meta: { symbol, exchangeTimezoneName: "UTC" },
          timestamp: ts,
          indicators: { quote: [{ open, high, low, close }] },
        },
      ],
      error: null,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getIndicators – Yahoo Finance resilience", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalBackoff = YAHOO_RETRY_CONFIG.backoffMs;

  beforeEach(() => {
    clearIndicatorsCache();
    // Keep retries fast in tests.
    YAHOO_RETRY_CONFIG.backoffMs = 1;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    YAHOO_RETRY_CONFIG.backoffMs = originalBackoff;
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    clearIndicatorsCache();
  });

  it("returns indicators on a successful first attempt", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildYahooPayload("EURUSD=X")));

    const result = await getIndicators("EUR/USD", "1h");

    expect(result).not.toBeNull();
    expect(result?.symbol).toBe("EUR/USD");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries once on a transient 5xx and then succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("upstream blew up", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(buildYahooPayload("EURUSD=X")));

    const result = await getIndicators("EUR/USD", "1h");

    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries once on a network error and then succeeds", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(buildYahooPayload("EURUSD=X")));

    const result = await getIndicators("EUR/USD", "1h");

    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on a 4xx (treated as terminal)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const result = await getIndicators("EUR/USD", "1h");

    // No prior cache → null surfaces.
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to a recent cached entry when both attempts fail", async () => {
    // Prime the cache with a successful fetch.
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildYahooPayload("EURUSD=X")));
    const primed = await getIndicators("EUR/USD", "1h");
    expect(primed).not.toBeNull();

    // Wait long enough that the TTL has expired (5 min for 1h). We can't
    // actually wait 5 minutes in a test, so we instead use a separate
    // timeframe whose TTL we can blow through quickly: bump the cache's
    // computedAt back in time by mutating Date.now.
    const realNow = Date.now();
    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(realNow + 6 * 60 * 1000); // 6 min later — TTL (5m) expired but well under stale window (30m)

    fetchSpy
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const result = await getIndicators("EUR/USD", "1h");

    expect(result).not.toBeNull();
    expect(result?.symbol).toBe("EUR/USD");
    // 1 prime + 2 retries during failure attempt.
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    dateNowSpy.mockRestore();
  });

  it("returns null when both attempts fail and the stale window has elapsed", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildYahooPayload("EURUSD=X")));
    await getIndicators("EUR/USD", "1h");

    // 1h TTL = 5 min, stale window = 6×TTL = 30 min. Jump 31 min ahead.
    const realNow = Date.now();
    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(realNow + 31 * 60 * 1000);

    fetchSpy
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));

    const result = await getIndicators("EUR/USD", "1h");

    expect(result).toBeNull();

    dateNowSpy.mockRestore();
  });

  it("returns null on first-ever fetch failure when there is no cached entry", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await getIndicators("EUR/USD", "1h");

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
