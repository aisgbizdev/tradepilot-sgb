import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../live-prices.js", () => ({ getLivePriceFor: vi.fn(async () => null) }));
import { getLivePriceFor } from "../live-prices.js";
import { clearIndicatorsCache, getCandleSnapshot, getCandles, getIndicators, YAHOO_RETRY_CONFIG } from "../historical.js";
import { checkAdaptiveReadiness } from "../adaptive-readiness.js";

function yahoo(barTime: number): Response {
  return new Response(JSON.stringify({
    chart: { result: [{
      timestamp: [Math.floor(barTime / 1000)],
      indicators: { quote: [{ open: [100], high: [101], low: [99], close: [100] }] },
    }], error: null },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("candle source snapshot", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    clearIndicatorsCache();
    YAHOO_RETRY_CONFIG.backoffMs = 1;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.mocked(getLivePriceFor).mockResolvedValue(null);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
    clearIndicatorsCache();
    YAHOO_RETRY_CONFIG.backoffMs = 500;
  });

  it("keeps the upstream fetch time through a cache hit, including a market-closed bar", async () => {
    fetchSpy.mockResolvedValue(yahoo(now - 2 * 24 * 60 * 60_000));
    const first = await getCandleSnapshot("BTC/USD", "1D");
    vi.mocked(Date.now).mockReturnValue(now + 10 * 60_000);
    const second = await getCandleSnapshot("BTC/USD", "1D");
    expect(second).toEqual(first);
    expect(second?.sourceFetchedAt).toBe(new Date(now).toISOString());
    expect(second?.isStale).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("labels a bounded fallback on feed failure, preserving its actual fetch time", async () => {
    fetchSpy.mockResolvedValueOnce(yahoo(now - 60_000))
      .mockResolvedValueOnce(new Response("down", { status: 404 }));
    await getCandleSnapshot("EUR/USD", "1h");
    vi.mocked(Date.now).mockReturnValue(now + 6 * 60_000);
    const fallback = await getCandleSnapshot("EUR/USD", "1h");
    expect(fallback).toMatchObject({
      sourceFetchedAt: new Date(now).toISOString(), isStale: true,
      staleReason: "feed_unavailable", sourceMaxAgeMs: 5 * 60_000,
    });
  });

  it("re-anchors a cached daily OHLC snapshot as the live spot price moves", async () => {
    fetchSpy.mockResolvedValue(yahoo(now - 2 * 24 * 60 * 60_000));
    vi.mocked(getLivePriceFor).mockResolvedValueOnce(101).mockResolvedValueOnce(102);
    const first = await getCandleSnapshot("BTC/USD", "1D");
    vi.mocked(Date.now).mockReturnValue(now + 10 * 60_000);
    const second = await getCandleSnapshot("BTC/USD", "1D");
    expect(first?.candles[0].close).toBe(101);
    expect(second?.candles[0].close).toBe(102);
    expect(second?.sourceFetchedAt).toBe(first?.sourceFetchedAt);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not present an expired fallback as current when the feed fails", async () => {
    fetchSpy.mockResolvedValueOnce(yahoo(now - 60_000))
      .mockResolvedValueOnce(new Response("down", { status: 404 }));
    await getCandleSnapshot("EUR/USD", "1h");
    vi.mocked(Date.now).mockReturnValue(now + 31 * 60_000);
    await expect(getCandleSnapshot("EUR/USD", "1h")).rejects.toThrow();
  });

  it("keeps the legacy empty-array result for internal candle consumers", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      chart: { result: [], error: null },
    }), { status: 200 }));
    expect(await getCandles("BTC/USD", "1h")).toEqual([]);
  });

  it("coalesces concurrent candle and indicator requests to one upstream fetch", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const first = getCandleSnapshot("EUR/USD", "1h");
    const second = getCandleSnapshot("EUR/USD", "1h");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch(yahoo(now - 60_000));
    expect(await second).toEqual(await first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses the preflight candle source for indicator context without another upstream call", async () => {
    fetchSpy.mockResolvedValue(yahoo(now - 60_000));
    expect(await checkAdaptiveReadiness("XAU/USD", "1h")).toBe("ready");
    await getIndicators("XAU/USD", "1h");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not pass a fresh retrieval of market-closed bars as ready", async () => {
    fetchSpy.mockResolvedValue(yahoo(now - 13 * 3_600_000));
    expect(await checkAdaptiveReadiness("XAU/USD", "1h")).toBe("bar_old");
  });

  it("limits retries during a failed feed but recovers without relabelling stale candles", async () => {
    fetchSpy.mockResolvedValueOnce(yahoo(now - 60_000))
      .mockResolvedValueOnce(new Response("down", { status: 404 }))
      .mockResolvedValueOnce(yahoo(now + 6 * 60_000));
    await getCandleSnapshot("EUR/USD", "1h");
    vi.mocked(Date.now).mockReturnValue(now + 6 * 60_000);
    expect((await getCandleSnapshot("EUR/USD", "1h"))?.isStale).toBe(true);
    expect((await getCandleSnapshot("EUR/USD", "1h"))?.isStale).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(now + 6 * 60_000 + 3_001);
    const recovered = await getCandleSnapshot("EUR/USD", "1h");
    expect(recovered?.isStale).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("limits a full outage to one fetch per cooldown even with concurrent callers", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("down", { status: 404 }))
      .mockResolvedValueOnce(yahoo(now - 60_000));
    const results = await Promise.allSettled(Array.from({ length: 8 },
      () => getCandleSnapshot("XAU/USD", "1h")));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(getCandleSnapshot("XAU/USD", "1h")).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + 3_001);
    expect((await getCandleSnapshot("XAU/USD", "1h"))?.isStale).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});