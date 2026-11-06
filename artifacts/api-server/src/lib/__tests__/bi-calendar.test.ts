// Regression guard for the curated Bank Indonesia / BPS calendar
// pool: USD/IDR must see at least one ★★★ BI 7DRR meeting and one
// CPI release after the merged feed dedupe, while pairs that don't
// touch IDR (DXY, EUR/USD) must NOT see any region:"ID" rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _clearCalendarCache,
  getRelevantCalendar,
} from "../calendar";

const realFetch = globalThis.fetch;

beforeEach(() => {
  _clearCalendarCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function emptyCalendar(): Response {
  return new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("BI calendar merge", () => {
  it("surfaces a BI 7DRR rate decision on USD/IDR with region tag", async () => {
    // Pin "now" before the earliest curated 2026-06-18 BI meeting so
    // the lookback filter keeps it in scope.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    globalThis.fetch = vi.fn(async () => emptyCalendar()) as unknown as typeof fetch;

    const events = await getRelevantCalendar("USD/IDR", { maxItems: 50 });
    const bi = events.find((e) => e.event.startsWith("BI 7DRR"));
    expect(bi).toBeDefined();
    expect(bi?.region).toBe("ID");
    expect(bi?.currency).toBe("IDR");
    expect(bi?.impact).toBe("★★★");
  });

  it("surfaces an Indonesia CPI release on USD/IDR", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    globalThis.fetch = vi.fn(async () => emptyCalendar()) as unknown as typeof fetch;

    const events = await getRelevantCalendar("USD/IDR", { maxItems: 50 });
    const cpi = events.find((e) => e.event.includes("Indonesia CPI"));
    expect(cpi).toBeDefined();
    expect(cpi?.region).toBe("ID");
  });

  it("does NOT surface BI events on pairs without IDR exposure (DXY, EUR/USD)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    globalThis.fetch = vi.fn(async () => emptyCalendar()) as unknown as typeof fetch;

    const dxyEvents = await getRelevantCalendar("DXY", { maxItems: 50 });
    expect(dxyEvents.some((e) => e.region === "ID")).toBe(false);
    expect(dxyEvents.some((e) => e.event.startsWith("BI 7DRR"))).toBe(false);

    const eurUsdEvents = await getRelevantCalendar("EUR/USD", { maxItems: 50 });
    expect(eurUsdEvents.some((e) => e.region === "ID")).toBe(false);
  });

  it("orders a same-impact, same-day region:ID event above a generic IDR event", async () => {
    // Stub upstream so it returns a competing ★★★ IDR-currency event
    // on the same day as the curated BI 7DRR meeting. The curated
    // (region:"ID") entry must sort first via the new tie-break.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00Z"));
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              date: "2026-06-18",
              time: "2026-06-18 06:00",
              currency: "IDR",
              event: "Generic upstream IDR item",
              impact: "★★★",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const events = await getRelevantCalendar("USD/IDR", { maxItems: 50 });
    const idxBi = events.findIndex((e) => e.event.startsWith("BI 7DRR"));
    const idxGeneric = events.findIndex((e) => e.event === "Generic upstream IDR item");
    expect(idxBi).toBeGreaterThanOrEqual(0);
    expect(idxGeneric).toBeGreaterThanOrEqual(0);
    expect(idxBi).toBeLessThan(idxGeneric);
  });
});
