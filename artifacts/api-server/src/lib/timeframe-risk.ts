import type { IndicatorTimeframe } from "./historical";
import type { TechnicalIndicators } from "./indicators";

export const RISK_MAP_TIMEFRAMES: readonly IndicatorTimeframe[] = ["15m", "1h", "4h", "1D", "1W"];
export const RISK_MAP_INSTRUMENTS = [
  "XAU/USD", "BRENT", "HSI", "NIKKEI",
  "EUR/USD", "GBP/USD", "AUD/USD", "USD/JPY",
] as const;
export type RiskMapInstrument = typeof RISK_MAP_INSTRUMENTS[number];

export function isRiskMapInstrument(instrument: string): instrument is RiskMapInstrument {
  return (RISK_MAP_INSTRUMENTS as readonly string[]).includes(instrument);
}

const MIN_DATA_POINTS = 50;
const MAX_ABSOLUTE_CHANGE_PCT = 1_000;
const MAX_AGE_MS: Record<IndicatorTimeframe, number> = {
  "1m": 5 * 60_000, "5m": 15 * 60_000, "15m": 45 * 60_000, "30m": 90 * 60_000,
  "1h": 3 * 60 * 60_000, "4h": 12 * 60 * 60_000, "1D": 5 * 24 * 60 * 60_000,
  "1W": 21 * 24 * 60 * 60_000,
};

export type TimeframeRisk = {
  timeframe: IndicatorTimeframe;
  status: "available" | "unavailable" | "insufficient";
  riskScore: number | null;
  riskCategory: "low" | "moderate" | "high" | "unavailable";
  reasonCodes: string[];
  metrics: { buySignals: number; sellSignals: number; neutralSignals: number; rsi14: number; change20Pct: number; bollingerWidthPct: number } | null;
  dataQuality: "good" | "limited" | "stale" | "unavailable";
  confidence: "low" | "medium" | "high";
  recommendation: "eligible" | "caution" | "wait";
};

function insufficient(
  timeframe: IndicatorTimeframe,
  reasonCodes: string[],
  dataQuality: "limited" | "stale" | "unavailable" = "unavailable",
): TimeframeRisk {
  return {
    timeframe, status: "insufficient", riskScore: null, riskCategory: "unavailable",
    reasonCodes, metrics: null, dataQuality, confidence: "low", recommendation: "wait",
  };
}

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function scoreTimeframeRisk(
  timeframe: IndicatorTimeframe,
  ind: TechnicalIndicators | null,
  now = Date.now(),
): TimeframeRisk {
  if (!ind) {
    return { timeframe, status: "unavailable", riskScore: null, riskCategory: "unavailable", reasonCodes: ["DATA_UNAVAILABLE"], metrics: null, dataQuality: "unavailable", confidence: "low", recommendation: "wait" };
  }
  if (typeof ind.lastDate !== "string") {
    return insufficient(timeframe, ["INVALID_TIMESTAMP"]);
  }
  const timestamp = Date.parse(ind.lastDate);
  if (!Number.isFinite(timestamp)) {
    return insufficient(timeframe, ["INVALID_TIMESTAMP"]);
  }
  if (timestamp > now) {
    return insufficient(timeframe, ["FUTURE_TIMESTAMP"]);
  }
  const age = now - timestamp;
  if (age > MAX_AGE_MS[timeframe]) {
    return { timeframe, status: "insufficient", riskScore: null, riskCategory: "unavailable", reasonCodes: ["DATA_STALE"], metrics: null, dataQuality: "stale", confidence: "low", recommendation: "wait" };
  }

  const summary = ind.overallSummary;
  const bollinger = ind.bollinger;
  const rsi14 = ind.rsi14;
  const malformed: string[] = [];
  if (!isFiniteNonNegativeInteger(ind.dataPoints)) malformed.push("INVALID_DATA_POINTS");
  if (!Number.isFinite(ind.lastClose) || ind.lastClose <= 0) malformed.push("INVALID_LAST_CLOSE");
  if (!summary) malformed.push("INVALID_SIGNAL_COUNTS");
  if (!bollinger) malformed.push("INVALID_BOLLINGER_BANDS");
  if (!rsi14) malformed.push("INVALID_RSI");
  if (!summary || !bollinger || !rsi14) return insufficient(timeframe, malformed);

  const { buy, sell, neutral } = summary;
  const { upper, middle, lower } = bollinger;
  if (
    !Number.isFinite(upper) || !Number.isFinite(middle) || !Number.isFinite(lower) ||
    lower <= 0 || middle <= 0 || upper <= 0 || lower >= upper || middle < lower || middle > upper
  ) malformed.push("INVALID_BOLLINGER_BANDS");
  if (![buy, sell, neutral].every(isFiniteNonNegativeInteger) || buy + sell + neutral <= 0) {
    malformed.push("INVALID_SIGNAL_COUNTS");
  }
  if (!Number.isFinite(rsi14.value) || rsi14.value < 0 || rsi14.value > 100) {
    malformed.push("INVALID_RSI");
  }
  if (
    !Number.isFinite(ind.change20dPct) ||
    Math.abs(ind.change20dPct) > MAX_ABSOLUTE_CHANGE_PCT
  ) malformed.push("INVALID_CHANGE_20_PCT");
  if (malformed.length) return insufficient(timeframe, malformed);
  if (ind.dataPoints < MIN_DATA_POINTS) {
    return insufficient(timeframe, ["INSUFFICIENT_HISTORY"], "limited");
  }

  const total = buy + sell + neutral;
  const disagreement = Math.min(buy, sell) / total;
  const rsi = rsi14.value;
  const momentum = Math.abs(ind.change20dPct);
  const width = Math.abs(upper - lower) / ind.lastClose * 100;
  // Risk is deliberately directional-neutral: conflicting signals, stretched
  // momentum, RSI extremes, and unusually wide bands increase execution risk.
  const score = Math.round(Math.min(100, disagreement * 70 + Math.min(20, momentum) * 1.25 + Math.max(0, Math.abs(rsi - 50) - 20) * 0.75 + Math.min(20, width) * 1.25));
  const reasons: string[] = [];
  if (disagreement >= 0.2) reasons.push("SIGNAL_CONFLICT");
  if (momentum >= 8) reasons.push("EXTENDED_MOMENTUM");
  if (rsi <= 30 || rsi >= 70) reasons.push("RSI_EXTREME");
  if (width >= 5) reasons.push("HIGH_VOLATILITY");
  if (!reasons.length) reasons.push("SIGNALS_RELATIVELY_ALIGNED");
  const riskCategory = score <= 33 ? "low" : score <= 66 ? "moderate" : "high";
  const alignment = Math.abs(buy - sell) / total;
  const confidence = alignment >= 0.5 && ind.dataPoints >= 100 ? "high" : alignment >= 0.25 ? "medium" : "low";
  return {
    timeframe, status: "available", riskScore: score, riskCategory, reasonCodes: reasons,
    metrics: { buySignals: buy, sellSignals: sell, neutralSignals: neutral, rsi14: rsi, change20Pct: ind.change20dPct, bollingerWidthPct: Number(width.toFixed(3)) },
    dataQuality: ind.dataPoints >= 100 ? "good" : "limited",
    confidence,
    recommendation: riskCategory === "high" || confidence === "low" ? "wait" : riskCategory === "moderate" ? "caution" : "eligible",
  };
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}