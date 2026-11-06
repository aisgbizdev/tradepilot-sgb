import { describe, it, expect } from "vitest";

import {
  INTRADAY_TIMEFRAMES,
  SUPPORTED_INDICATOR_TIMEFRAMES,
  isSupportedIndicatorTimeframe,
  indicatorsCacheTtlSeconds,
} from "../historical.js";
import { getValidUntil } from "../openai.js";

describe("30-minute timeframe is wired end-to-end", () => {
  it("registers '30m' as a supported intraday timeframe", () => {
    expect(INTRADAY_TIMEFRAMES).toContain("30m");
    expect(SUPPORTED_INDICATOR_TIMEFRAMES).toContain("30m");
    expect(isSupportedIndicatorTimeframe("30m")).toBe(true);
  });

  it("places the 30m cache TTL between the 15m and 1h buckets", () => {
    const ttl15 = indicatorsCacheTtlSeconds("15m");
    const ttl30 = indicatorsCacheTtlSeconds("30m");
    const ttl1h = indicatorsCacheTtlSeconds("1h");
    expect(ttl30).toBeGreaterThanOrEqual(ttl15);
    expect(ttl30).toBeLessThanOrEqual(ttl1h);
  });

  it("places the 30m analysis validity between the 15m and 1h buckets", () => {
    const now = Date.now();
    const validity = (tf: string) => getValidUntil(tf).getTime() - now;
    expect(validity("30m")).toBeGreaterThan(validity("15m"));
    expect(validity("30m")).toBeLessThan(validity("1h"));
  });
});
