import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { getRelevantCalendar, _clearCalendarCache } from "../calendar.js";
import { getRelevantNews } from "../news.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rssResponse(items: { title: string; pubDate?: string }[]): Response {
  const xml = [
    `<?xml version="1.0"?><rss><channel>`,
    ...items.map(
      (i) =>
        `<item><title>${i.title}</title><link>https://example.com/${encodeURIComponent(i.title)}</link><pubDate>${i.pubDate ?? new Date().toUTCString()}</pubDate><description>${i.title}</description></item>`,
    ),
    `</channel></rss>`,
  ].join("");
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "application/rss+xml" },
  });
}

describe("crypto calendar — curated events merge in for crypto pairs only", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _clearCalendarCache();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // Upstream macro feed returns nothing — isolates the crypto path.
    fetchSpy.mockResolvedValue(jsonResponse({ data: [] }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("surfaces the Bitcoin halving entry for BTC/USD", async () => {
    const events = await getRelevantCalendar("BTC/USD", { lookbackHours: 24 });
    const halving = events.find((e) => /halving/i.test(e.event));
    expect(halving).toBeDefined();
    expect(halving?.currency).toBe("BTC");
  });

  it("surfaces an Ethereum upgrade entry for ETH/USD", async () => {
    const events = await getRelevantCalendar("ETH/USD", { lookbackHours: 24 });
    expect(events.some((e) => /pectra|fusaka|upgrade/i.test(e.event))).toBe(true);
  });

  it("includes market-wide (CRYPTO) events on any crypto pair", async () => {
    const events = await getRelevantCalendar("SOL/USD", { lookbackHours: 24 });
    expect(events.some((e) => e.currency === "CRYPTO")).toBe(true);
  });

  it("does NOT surface crypto events on forex pairs", async () => {
    const events = await getRelevantCalendar("EUR/USD", { lookbackHours: 24 });
    expect(events.some((e) => /halving|pectra/i.test(e.event))).toBe(false);
    expect(events.some((e) => e.currency === "CRYPTO")).toBe(false);
  });
});

describe("crypto news — Yahoo per-symbol + crypto macro fallback", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("pulls Yahoo BTC-USD headlines and accepts crypto-macro titles for BTC/USD", async () => {
    // First call: Newsmaker (returns crypto-macro headline, no "bitcoin" keyword in title).
    // Second call: Yahoo per-symbol RSS for BTC-USD.
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 1,
              title: "Crypto spot ETF approval lifts digital asset prices",
              summary: "Investors cheer the green light",
              url: "https://news.example/etf",
              published_at: new Date().toISOString(),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(rssResponse([{ title: "Bitcoin breaks fresh ATH" }]));

    const items = await getRelevantNews("BTC/USD", 5);
    expect(items.length).toBeGreaterThan(0);
    // The Yahoo BTC-USD headline must come through.
    expect(items.some((i) => /bitcoin/i.test(i.title))).toBe(true);
    // The crypto-macro fallback retains a clearly crypto-linked ETF headline
    // even though it never says "bitcoin".
    expect(items.some((i) => /spot etf/i.test(i.title))).toBe(true);
  });
});
