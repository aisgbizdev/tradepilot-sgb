import { getCandleSnapshot, type IndicatorTimeframe } from "./historical.js";
import { STANDARD_TRADING_RULES } from "./standard-trading-rules.js";

const RULE_CODES: Record<string, string> = {
  "XAU/USD": "XUL10",
  BRENT: "BCO10_BBJ",
  HSI: "HKK50_BBJ",
  NIKKEI: "JPK50_BBJ",
};

// Match the client-side Adaptive freshness limits; do not accept the historical
// endpoint's stale-display fallback as an input to a new trading recommendation.
const BAR_MAX_AGE_MS: Record<IndicatorTimeframe, number> = {
  "1m": 6 * 3_600_000, "5m": 6 * 3_600_000,
  "15m": 6 * 3_600_000, "30m": 8 * 3_600_000,
  "1h": 12 * 3_600_000, "4h": 36 * 3_600_000,
  "1D": 4 * 86_400_000, "1W": 14 * 86_400_000,
};
const SOURCE_MAX_AGE_MS: Record<IndicatorTimeframe, number> = {
  "1m": 30_000, "5m": 60_000, "15m": 180_000, "30m": 240_000,
  "1h": 300_000, "4h": 900_000, "1D": 3_600_000, "1W": 3_600_000,
};

export function offersAdaptive(instrument: string): boolean {
  return Object.hasOwn(RULE_CODES, instrument);
}

export async function checkAdaptiveReadiness(
  instrument: string,
  timeframe: IndicatorTimeframe,
): Promise<"ready" | "rules_unavailable" | "feed_unavailable" | "source_old" | "bar_old"> {
  if (!STANDARD_TRADING_RULES.instruments.some((rule) => rule.code === RULE_CODES[instrument])) {
    return "rules_unavailable";
  }
  try {
    const snapshot = await getCandleSnapshot(instrument, timeframe);
    if (!snapshot || snapshot.isStale || snapshot.staleReason != null) return "feed_unavailable";
    const now = Date.now();
    const sourceTime = Date.parse(snapshot.sourceFetchedAt);
    if (!Number.isFinite(sourceTime) || sourceTime > now + 60_000 ||
        !Number.isFinite(snapshot.sourceMaxAgeMs) || snapshot.sourceMaxAgeMs <= 0 ||
        sourceTime + Math.min(snapshot.sourceMaxAgeMs, SOURCE_MAX_AGE_MS[timeframe]) <= now) {
      return "source_old";
    }
    const lastBar = Math.max(...snapshot.candles.map((candle) => Date.parse(candle.date)));
    if (!Number.isFinite(lastBar) || lastBar > now + 60_000 ||
        lastBar + BAR_MAX_AGE_MS[timeframe] <= now) {
      return "bar_old";
    }
    return "ready";
  } catch {
    return "feed_unavailable";
  }
}