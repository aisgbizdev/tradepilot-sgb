import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LIVE_FEED_SPOT_INSTRUMENTS,
  LIVE_PRICE_FUTURES_ONLY,
  SUPPORTED_INSTRUMENTS,
  getLiveQuotes,
  getLivePriceFor,
} from "../live-prices";
import { BINANCE_SYMBOL_MAP, CRYPTO_INSTRUMENTS } from "../crypto-instruments";

// Smoke-checks that protect the "analysis price matches dashboard ticker"
// invariant for every instrument the app exposes. The dashboard ticker is
// fed by `/api/quotes/live` (→ `getLiveQuotes`), and the saved-analysis
// price is anchored to the same live feed via `anchorCandlesToLivePrice`
// (→ `getLivePriceFor`). If a supported instrument lacks a live mapping,
// the anchor silently no-ops and the displayed price drifts off the
// ticker — so we assert coverage here.

describe("live-feed coverage for supported instruments", () => {
  it("every supported instrument is either spot-mapped, crypto-mapped, or documented as futures-only", () => {
    const cryptoSet = new Set<string>(CRYPTO_INSTRUMENTS);
    const missing: string[] = [];
    for (const instrument of SUPPORTED_INSTRUMENTS) {
      const hasSpot = LIVE_FEED_SPOT_INSTRUMENTS.has(instrument);
      const hasCrypto = cryptoSet.has(instrument);
      const isFuturesOnly = LIVE_PRICE_FUTURES_ONLY.has(instrument);
      if (!hasSpot && !hasCrypto && !isFuturesOnly) {
        missing.push(instrument);
      }
    }
    expect(
      missing,
      `Add a SYMBOL_MAP entry in live-prices.ts or list these in LIVE_PRICE_FUTURES_ONLY: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("LIVE_PRICE_FUTURES_ONLY entries are all in the supported list (no stale docs)", () => {
    const supported = new Set(SUPPORTED_INSTRUMENTS);
    for (const inst of LIVE_PRICE_FUTURES_ONLY) {
      expect(supported.has(inst), `${inst} is futures-only but not in SUPPORTED_INSTRUMENTS`).toBe(true);
    }
  });

  it("futures-only and spot-mapped sets are disjoint", () => {
    for (const inst of LIVE_PRICE_FUTURES_ONLY) {
      expect(LIVE_FEED_SPOT_INSTRUMENTS.has(inst), `${inst} is both futures-only and spot-mapped`).toBe(false);
    }
  });

  it("HSI is mapped from the upstream HK50 alias so the canonical instrument resolves", () => {
    expect(LIVE_FEED_SPOT_INSTRUMENTS.has("HSI")).toBe(true);
  });

  it("every crypto instrument has a Binance ticker symbol", () => {
    for (const inst of CRYPTO_INSTRUMENTS) {
      expect(BINANCE_SYMBOL_MAP[inst], `${inst} missing Binance symbol`).toBeTruthy();
    }
  });
});

describe("getLiveQuotes returns prices that match getLivePriceFor for every spot-mapped instrument", () => {
  // Cache module to clear in-memory state between tests via a fresh import.
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  // Build a fake upstream payload that emits a row for every upstream
  // symbol code we map. Prices are deterministic and unique per symbol
  // so we can assert exact matches across both endpoints.
  const UPSTREAM_FIXTURE = [
    { symbol: "XUL10", price: 2350.5 },
    { symbol: "BCO10_BBJ", price: 82.34 },
    { symbol: "EU10F_BBJ", price: 1.0875 },
    { symbol: "GU10F_BBJ", price: 1.2645 },
    { symbol: "UJ10F_BBJ", price: 156.42 },
    { symbol: "UI10F_BBJ", price: 16250.0 },
    { symbol: "DX10F_BBJ", price: 104.55 },
    { symbol: "AU10F_BBJ", price: 0.6612 },
    { symbol: "HKK50_BBJ", price: 18432.1 },
    { symbol: "JPK50_BBJ", price: 38901.2 },
  ];

  const BINANCE_FIXTURE = [
    { symbol: "BTCUSDT", price: 67234.5 },
    { symbol: "ETHUSDT", price: 3421.7 },
    { symbol: "SOLUSDT", price: 156.32 },
    { symbol: "BNBUSDT", price: 612.45 },
    { symbol: "XRPUSDT", price: 0.5234 },
  ];

  beforeEach(async () => {
    // Reset the in-memory 15s cache so each test fetches fresh.
    const mod = await import("../live-prices");
    // No public clear — instead, advance fake timers past TTL by stubbing fetch.
    // We isolate by re-mocking fetch per test; the cache survives but
    // is overwritten by the next miss when we force time forward.
    // Simpler: rely on first call priming, and assert against that snapshot.
    void mod;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("live-quotes")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: UPSTREAM_FIXTURE.map((r) => ({
                symbol: r.symbol,
                price: r.price,
                buy: r.price,
                sell: r.price,
                "change%": "+0.10%",
              })),
              updatedAt: "2026-05-28T00:00:00Z",
              serverTime: "2026-05-28T00:00:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url.includes("binance.com")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              BINANCE_FIXTURE.map((r) => ({
                symbol: r.symbol,
                lastPrice: String(r.price),
                priceChangePercent: "0.10",
                highPrice: String(r.price),
                lowPrice: String(r.price),
                openPrice: String(r.price),
                bidPrice: String(r.price),
                askPrice: String(r.price),
              })),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }) as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("dashboard ticker price equals per-instrument anchor price within tolerance", async () => {
    const payload = await getLiveQuotes();
    const tickerPriceByInstrument = new Map<string, number>();
    for (const q of payload.data) {
      const n = typeof q.price === "number" ? q.price : Number(q.price);
      tickerPriceByInstrument.set(q.instrument, n);
    }

    // For every instrument the analysis flow will try to anchor against,
    // the per-instrument lookup must return the same number the ticker
    // shows (this IS what the analyze flow uses to anchor candles).
    const TOLERANCE = 1e-6;
    for (const instrument of SUPPORTED_INSTRUMENTS) {
      if (LIVE_PRICE_FUTURES_ONLY.has(instrument)) {
        // Documented no-op — getLivePriceFor returns null and the
        // displayed price stays on the Yahoo futures last-close.
        const lookup = await getLivePriceFor(instrument);
        expect(lookup, `${instrument} is futures-only — expected null lookup`).toBeNull();
        continue;
      }
      const tickerPrice = tickerPriceByInstrument.get(instrument);
      expect(tickerPrice, `${instrument} missing from dashboard ticker payload`).toBeDefined();
      const lookup = await getLivePriceFor(instrument);
      expect(lookup, `${instrument} lookup returned null but is not futures-only`).not.toBeNull();
      expect(Math.abs((lookup as number) - (tickerPrice as number))).toBeLessThan(TOLERANCE);
    }
  });

  it("HK50 legacy alias resolves to the same price as HSI", async () => {
    const payload = await getLiveQuotes();
    const hsi = payload.data.find((q) => q.instrument === "HSI");
    const hk50 = payload.data.find((q) => q.instrument === "HK50");
    expect(hsi).toBeDefined();
    expect(hk50).toBeDefined();
    expect(Number(hk50!.price)).toBe(Number(hsi!.price));
  });
});
