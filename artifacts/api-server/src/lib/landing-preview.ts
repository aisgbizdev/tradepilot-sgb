import {
  formatIndicatorsForPrompt,
  getIndicators,
} from "./historical";
import type { TechnicalIndicators } from "./indicators";
import {
  generateAnalysis,
  type ProAIOutput,
  type FundamentalSnapshot,
} from "./openai";
import {
  formatNewsForPrompt,
  getRelevantNews,
  type NewsItem,
} from "./news";
import {
  formatCalendarForPrompt,
  getRelevantCalendar,
  type CalendarEvent,
} from "./calendar";
import { getLivePriceFor } from "./live-prices";
import { logger } from "./logger";

const PREVIEW_INSTRUMENT = "XAU/USD";
const PREVIEW_TIMEFRAME = "1D";
const FRESH_TTL_MS = 15 * 60 * 1000;
const STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface LandingPreviewSnapshot {
  status: "success";
  instrument: typeof PREVIEW_INSTRUMENT;
  timeframe: typeof PREVIEW_TIMEFRAME;
  generatedAt: string;
  isStale: boolean;
  price: number | null;
  tradingBias: ProAIOutput["tradingBias"];
  confidenceMin: number;
  confidenceMax: number;
  preferredSide: ProAIOutput["tradePlan"]["preferredSide"];
  levels: {
    entryZone: string;
    stopLoss: string;
    takeProfit1: string;
    takeProfit2: string;
    riskRewardRatio: string;
  } | null;
}

type CachedSnapshot = {
  snapshot: LandingPreviewSnapshot;
  generatedAtMs: number;
};

let cachedSnapshot: CachedSnapshot | null = null;
let generationInFlight: Promise<LandingPreviewSnapshot> | null = null;
let refreshBlockedUntilMs = 0;

function getSettledValue<T>(
  result: PromiseSettledResult<T>,
): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

async function createSnapshot(): Promise<LandingPreviewSnapshot> {
  const [livePriceResult, indicatorsResult, newsResult, calendarResult] =
    await Promise.allSettled([
      getLivePriceFor(PREVIEW_INSTRUMENT),
      getIndicators(PREVIEW_INSTRUMENT, PREVIEW_TIMEFRAME),
      getRelevantNews(PREVIEW_INSTRUMENT),
      getRelevantCalendar(PREVIEW_INSTRUMENT),
    ]);

  const livePrice = getSettledValue(livePriceResult);
  const indicators = getSettledValue(indicatorsResult) as TechnicalIndicators | null;
  const newsItems = (getSettledValue(newsResult) ?? []) as NewsItem[];
  const calendarEvents = (getSettledValue(calendarResult) ?? []) as CalendarEvent[];
  const contextParts: string[] = [];

  if (indicators) {
    contextParts.push(formatIndicatorsForPrompt(indicators, PREVIEW_TIMEFRAME));
  }
  if (newsItems.length > 0) {
    contextParts.push(formatNewsForPrompt(newsItems, PREVIEW_INSTRUMENT));
  }
  if (calendarEvents.length > 0) {
    contextParts.push(formatCalendarForPrompt(calendarEvents, PREVIEW_INSTRUMENT));
  }

  const fundamentalSnapshot: FundamentalSnapshot = {
    newsItems,
    calendarEvents,
  };
  const { output } = await generateAnalysis(
    PREVIEW_INSTRUMENT,
    PREVIEW_TIMEFRAME,
    "pro",
    undefined,
    contextParts.length > 0 ? contextParts.join("\n") : undefined,
    fundamentalSnapshot,
    livePrice,
    undefined, // selectedTimeframePrice — no candle-snapshot capture on this path
    "free", // public marketing preview — no signed-in user, no revenue.
  );
  const price =
    typeof livePrice === "number" && Number.isFinite(livePrice)
      ? livePrice
      : indicators?.lastClose ?? null;
  const preferredSide =
    output.marketCondition === "volatile" || output.tradingBias === "neutral"
      ? "wait"
      : output.tradingBias === "bullish" ||
          output.tradingBias === "bullish_strong"
        ? "buy"
        : "sell";
  const selectedPlan =
    preferredSide === "buy"
      ? output.tradePlan.buy
      : preferredSide === "sell"
        ? output.tradePlan.sell
        : null;
  const confidenceMin = Math.max(1, Math.min(70, output.confidenceMin));
  const confidenceMax = Math.max(
    confidenceMin + 10,
    Math.min(80, output.confidenceMax),
  );

  return {
    status: "success",
    instrument: PREVIEW_INSTRUMENT,
    timeframe: PREVIEW_TIMEFRAME,
    generatedAt: new Date().toISOString(),
    isStale: false,
    price,
    tradingBias: output.tradingBias,
    confidenceMin,
    confidenceMax,
    preferredSide,
    levels: selectedPlan
      ? {
          entryZone: selectedPlan.entryZone,
          stopLoss: selectedPlan.stopLoss,
          takeProfit1: selectedPlan.takeProfit1,
          takeProfit2: selectedPlan.takeProfit2,
          riskRewardRatio: selectedPlan.riskRewardRatio,
        }
      : null,
  };
}

/**
 * Returns a server-generated, anonymous-safe snapshot for the marketing card.
 * It is deliberately not persisted to a user analysis row: landing visitors
 * must never see another user's analysis, and a request must not consume a
 * user's quota.
 */
export async function getLandingPreviewSnapshot(): Promise<LandingPreviewSnapshot> {
  const now = Date.now();
  if (
    cachedSnapshot &&
    now - cachedSnapshot.generatedAtMs < FRESH_TTL_MS
  ) {
    return cachedSnapshot.snapshot;
  }

  // A failed upstream/AI refresh must not turn anonymous landing traffic into
  // an expensive retry loop. During backoff, return the last safe snapshot
  // when possible, otherwise fail fast until the next controlled attempt.
  if (now < refreshBlockedUntilMs) {
    if (
      cachedSnapshot &&
      now - cachedSnapshot.generatedAtMs < STALE_MAX_AGE_MS
    ) {
      return {
        ...cachedSnapshot.snapshot,
        isStale: true,
      };
    }
    throw new Error("Landing preview refresh is temporarily backed off");
  }

  if (generationInFlight) return generationInFlight;

  generationInFlight = (async () => {
    try {
      const snapshot = await createSnapshot();
      cachedSnapshot = {
        snapshot,
        generatedAtMs: Date.now(),
      };
      refreshBlockedUntilMs = 0;
      return snapshot;
    } catch (err) {
      refreshBlockedUntilMs = Date.now() + FRESH_TTL_MS;
      logger.warn({ err }, "Landing preview snapshot refresh failed");
      if (
        cachedSnapshot &&
        Date.now() - cachedSnapshot.generatedAtMs < STALE_MAX_AGE_MS
      ) {
        return {
          ...cachedSnapshot.snapshot,
          isStale: true,
        };
      }
      throw err;
    } finally {
      generationInFlight = null;
    }
  })();

  return generationInFlight;
}

export function _resetLandingPreviewCache(): void {
  cachedSnapshot = null;
  generationInFlight = null;
  refreshBlockedUntilMs = 0;
}