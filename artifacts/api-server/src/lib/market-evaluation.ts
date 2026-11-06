import { parseLevelPrice, validateTradePlanQuality, type TradePlan } from "./openai";
import type { IndicatorTimeframe } from "./historical";

export interface MarketSnapshot {
  instrument: string;
  timeframe: IndicatorTimeframe;
  source: string;
  observedAt: string;
  quote: number;
  low: number;
  high: number;
  changePct: number;
  bars: number;
}

export interface MarketEvaluation {
  instrument: string;
  timeframe: string;
  observedAt: string;
  source: string;
  quote: number;
  changePct: number;
  preferredSide: TradePlan["preferredSide"];
  preferredReason: string;
  oppositeReason: string;
  timeframeDifference: string;
  levels: Record<"buy" | "sell", Record<"entry" | "stop" | "tp1" | "tp2", number | null>>;
  maxDistancePct: number | null;
  completeBothSides: boolean;
  productionValidation: { ok: boolean; reason?: string };
  anomalies: string[];
}

// Evaluation thresholds intentionally stricter than the production validator:
// the latter guards absurd prices, not whether a setup is useful near a real
// snapshot. A flagged plan needs human review; it is not a profit prediction.
const entryDistanceLimit: Record<string, number> = {
  "1m": 0.5, "5m": 1, "15m": 2, "30m": 3,
  "1h": 5, "4h": 8, "1D": 15, "1W": 25,
};

export function evaluateMarketPlan(
  sample: MarketSnapshot,
  plan: TradePlan,
  comparison?: MarketSnapshot,
): MarketEvaluation {
  const anomalies: string[] = [];
  const levels = {} as MarketEvaluation["levels"];
  let maxDistancePct: number | null = null;
  for (const direction of ["buy", "sell"] as const) {
    const side = plan[direction];
    const prices = {
      entry: parseLevelPrice(side.entryZone),
      stop: parseLevelPrice(side.stopLoss),
      tp1: parseLevelPrice(side.takeProfit1),
      tp2: parseLevelPrice(side.takeProfit2),
    };
    levels[direction] = prices;
    for (const [key, price] of Object.entries(prices)) {
      if (price === null) continue;
      const distance = Math.abs(price / sample.quote - 1) * 100;
      maxDistancePct = Math.max(maxDistancePct ?? 0, distance);
      if (key === "entry" && distance > entryDistanceLimit[sample.timeframe]!) {
        anomalies.push(`${direction} entry ${distance.toFixed(2)}% from quote (limit ${entryDistanceLimit[sample.timeframe]}%)`);
      }
    }
    if (prices.entry !== null) {
      const rangePct = Math.max((sample.high - sample.low) / sample.quote * 100, 0.1);
      const entryToRangePct = prices.entry < sample.low
        ? (sample.low - prices.entry) / sample.quote * 100
        : prices.entry > sample.high ? (prices.entry - sample.high) / sample.quote * 100 : 0;
      if (entryToRangePct > Math.max(rangePct, entryDistanceLimit[sample.timeframe]! / 2)) {
        anomalies.push(`${direction} entry outside observed ${sample.timeframe} range by ${entryToRangePct.toFixed(2)}%`);
      }
    }
    // Reason must reference observable technical evidence, not just claim an
    // equally likely opposite or repeat the side label.
    if (!/support|resistan|break|swing|momentum|rsi|macd|trend|candle|range|high|low|rejection/i.test(side.rationale)) {
      anomalies.push(`${direction} rationale lacks technical evidence`);
    }
  }
  const completeBothSides = (["buy", "sell"] as const).every(
    (dir) => Object.values(levels[dir]).every((price) => price !== null) &&
      Boolean(plan[dir].rationale.trim()),
  );
  if (!completeBothSides) anomalies.push("buy/sell numeric levels or rationale incomplete");
  const check = validateTradePlanQuality(plan, sample.quote, sample.timeframe, sample.instrument);
  if (!check.ok) anomalies.push(`production validator: ${check.reason}`);
  const preferredReason = plan.preferredSide === "wait"
    ? `wait: ${plan.buy.rationale} | ${plan.sell.rationale}`
    : plan[plan.preferredSide].rationale;
  const oppositeReason = plan.preferredSide === "buy" ? plan.sell.rationale
    : plan.preferredSide === "sell" ? plan.buy.rationale : "both conditional";
  const difference = comparison
    ? `${comparison.timeframe} ${comparison.changePct >= 0 ? "+" : ""}${comparison.changePct}% vs ${sample.timeframe} ${sample.changePct >= 0 ? "+" : ""}${sample.changePct}%`
    : "no adjacent snapshot";
  if (comparison && sample.changePct * comparison.changePct < 0 &&
      !/konflik|berbeda|berlawanan|divergen|sementara|meski|walau|sedangkan|namun|tetapi|higher|timeframe/i.test(
        `${preferredReason} ${oppositeReason}`,
      )) {
    anomalies.push("opposing adjacent timeframe momentum not acknowledged in rationale");
  }
  return {
    instrument: sample.instrument, timeframe: sample.timeframe,
    observedAt: sample.observedAt, source: sample.source,
    quote: sample.quote, changePct: sample.changePct,
    preferredSide: plan.preferredSide, preferredReason, oppositeReason,
    timeframeDifference: difference, levels, maxDistancePct,
    completeBothSides, productionValidation: check, anomalies,
  };
}