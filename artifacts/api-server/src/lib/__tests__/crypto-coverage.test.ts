import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { fetchBinanceCryptoQuotes } from "../live-prices.js";
import {
  isCryptoInstrument,
  BINANCE_SYMBOL_MAP,
  YAHOO_CRYPTO_SYMBOL_MAP,
  CRYPTO_INSTRUMENTS,
} from "../crypto-instruments.js";
import { getCandles, clearIndicatorsCache } from "../historical.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("crypto instruments helper", () => {
  it("recognises the five supported crypto pairs", () => {
    for (const inst of CRYPTO_INSTRUMENTS) {
      expect(isCryptoInstrument(inst)).toBe(true);
    }
  });

  it("rejects forex / commodity instruments", () => {
    expect(isCryptoInstrument("EUR/USD")).toBe(false);
    expect(isCryptoInstrument("XAU/USD")).toBe(false);
    expect(isCryptoInstrument("DJIA")).toBe(false);
  });

  it("normalizes lowercase + surrounding whitespace so user free-text routes to crypto paths", () => {
    expect(isCryptoInstrument(" btc/usd ")).toBe(true);
    expect(isCryptoInstrument("Btc/Usd")).toBe(true);
    expect(isCryptoInstrument("eth/usd")).toBe(true);
  });

  it("maps each crypto pair to a Binance + Yahoo symbol", () => {
    for (const inst of CRYPTO_INSTRUMENTS) {
      expect(BINANCE_SYMBOL_MAP[inst]).toMatch(/USDT$/);
      expect(YAHOO_CRYPTO_SYMBOL_MAP[inst]).toMatch(/^[A-Z]+-USD$/);
    }
  });
});

describe("fetchBinanceCryptoQuotes", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shapes Binance ticker rows into LiveQuote and tags instrument", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([
        {
          symbol: "BTCUSDT",
          lastPrice: "65000.5",
          priceChangePercent: "2.34",
          highPrice: "66000",
          lowPrice: "64000",
          openPrice: "63500",
          bidPrice: "65000.4",
          askPrice: "65000.6",
        },
        {
          symbol: "ETHUSDT",
          lastPrice: "3500.0",
          priceChangePercent: "-1.10",
          highPrice: "3550",
          lowPrice: "3480",
          openPrice: "3540",
          bidPrice: "3499.9",
          askPrice: "3500.1",
        },
      ]),
    );

    const quotes = await fetchBinanceCryptoQuotes();
    const btc = quotes.find((q) => q.instrument === "BTC/USD");
    const eth = quotes.find((q) => q.instrument === "ETH/USD");

    expect(btc).toBeDefined();
    expect(btc?.price).toBe(65000.5);
    expect(btc?.direction).toBe("up");
    expect(btc?.changePercent).toBe("+2.34%");

    expect(eth).toBeDefined();
    expect(eth?.direction).toBe("down");
    expect(eth?.changePercent).toBe("-1.10%");
  });

  it("returns [] (does not throw) when Binance is down so forex feed keeps working", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const quotes = await fetchBinanceCryptoQuotes();
    expect(quotes).toEqual([]);
  });

  it("returns [] on non-2xx Binance response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    const quotes = await fetchBinanceCryptoQuotes();
    expect(quotes).toEqual([]);
  });
});

describe("getCandles — crypto routes through Yahoo", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearIndicatorsCache();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function buildYahooPayload(symbol: string, points = 50) {
    const now = Math.floor(Date.now() / 1000);
    const ts: number[] = [];
    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    for (let i = 0; i < points; i++) {
      ts.push(now - (points - i) * 86_400);
      const base = 60000 + i * 10;
      open.push(base);
      high.push(base + 50);
      low.push(base - 50);
      close.push(base + 5);
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

  it("uses BTC-USD on Yahoo for BTC/USD daily candles", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(buildYahooPayload("BTC-USD")));

    const candles = await getCandles("BTC/USD", "1D");

    expect(candles).not.toBeNull();
    expect(candles!.length).toBeGreaterThan(0);
    const firstUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("BTC-USD");
    expect(firstUrl).toContain("interval=1d");
  });

  it("uses BTC-USD on Yahoo for BTC/USD 1h intraday candles too", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(buildYahooPayload("BTC-USD")));

    const candles = await getCandles("BTC/USD", "1h");

    expect(candles).not.toBeNull();
    const firstUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("BTC-USD");
  });
});
