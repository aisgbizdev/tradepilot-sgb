import { db } from "./db";
import {
  analyses,
  type TradePlanShape,
  type TradeSideShape,
} from "@workspace/db/schema";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  getCandles,
  isSupportedIndicatorTimeframe,
  type IndicatorTimeframe,
} from "./historical";

// How many pending analyses to resolve per tick. The resolver runs every
// few minutes and each row triggers (at most) a single upstream OHLC
// fetch, so this caps both DB and network pressure per pass.
const BATCH_LIMIT = 50;

export type ResolvedOutcome =
  | "tp1_hit"
  | "tp2_hit"
  | "sl_hit"
  | "expired"
  | "invalidated";

interface ResolutionResult {
  status: ResolvedOutcome | "pending";
  // Bar timestamp the trigger fired on, or validUntil for "expired". `null`
  // when the row stays pending (no trigger touched yet).
  resolvedAt: Date | null;
}

interface BarLike {
  date: string;
  high: number;
  low: number;
}

/**
 * Pull a single price level out of one of the AI's plan strings. The AI
 * returns numbers as either a single value ("1.0857") or a range
 * ("1.0850-1.0860"), and may interleave commentary or units. We extract
 * up to the first two numeric tokens and take their midpoint for ranges
 * so SL/TP detection is anchored to the centre of the band.
 *
 * Returns null when the string contains no parseable number — the caller
 * treats that as "invalidated" since we can't honestly evaluate whether
 * price touched the level.
 */
export function parsePlanLevel(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // Numbers in trade-plan strings are always non-negative (prices). The
  // tricky bit is hyphen-separated ranges like "1.0850-1.0860" — a naive
  // /-?\d+/ pattern would consume the dash as a sign on the second token
  // and turn it into a midpoint of (1.0850 + -1.0860)/2 ≈ -0.0005. So we
  // match positive numeric tokens only and let separators ("-", "to",
  // "–", whitespace, etc.) sit between them.
  const matches = raw.match(/\d+(?:[.,]\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const nums = matches
    .map((m) => Number(m.replace(",", ".")))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  return (nums[0] + nums[1]) / 2;
}

/**
 * Walk the post-creation candles in chronological order and decide what
 * happened to the AI's preferred trade side.
 *
 * Rules:
 *   • SL touched → resolve as `sl_hit` immediately (worst case for the trader).
 *   • TP2 touched → resolve as `tp2_hit` immediately.
 *   • TP1 touched → remember it, but keep scanning so a later TP2 still wins.
 *   • If the validity window has passed and only TP1 was hit → `tp1_hit`.
 *   • If the validity window has passed with nothing hit → `expired`.
 *   • Otherwise stay `pending` until the next resolver tick.
 *
 * When both SL and a TP touch on the same bar we conservatively call it
 * `sl_hit` because the bar's OHLC doesn't tell us which printed first
 * and the trader's downside is the more honest assumption.
 */
export function evaluateOutcome(
  side: "buy" | "sell",
  plan: TradeSideShape,
  candles: BarLike[],
  startTs: number,
  validUntilTs: number,
  nowTs: number,
): ResolutionResult {
  const sl = parsePlanLevel(plan.stopLoss);
  const tp1 = parsePlanLevel(plan.takeProfit1);
  const tp2 = parsePlanLevel(plan.takeProfit2);
  if (sl == null || (tp1 == null && tp2 == null)) {
    return { status: "invalidated", resolvedAt: new Date(nowTs) };
  }
  // SL must sit on the correct side of the entry zone (below for buy,
  // above for sell). When it doesn't, the plan is internally inconsistent
  // and we mark it `invalidated` rather than scoring it.
  const entry = parsePlanLevel(plan.entryZone);
  if (entry != null) {
    if (side === "buy" && sl >= entry) {
      return { status: "invalidated", resolvedAt: new Date(nowTs) };
    }
    if (side === "sell" && sl <= entry) {
      return { status: "invalidated", resolvedAt: new Date(nowTs) };
    }
  }

  let intermediate: "tp1_hit" | null = null;
  let intermediateAt: number | null = null;

  // Only price action that printed *inside* the validity window can decide
  // an outcome — a TP/SL hit after the plan expired is not something the
  // trader could have acted on, so we cap the scan at validUntilTs (and
  // also at nowTs in case validity stretches into the future).
  const scanUntil = Math.min(nowTs, validUntilTs);
  for (const c of candles) {
    const ts = new Date(c.date).getTime();
    if (!Number.isFinite(ts) || ts <= startTs) continue;
    if (ts > scanUntil) break;
    const { high, low } = c;
    if (side === "buy") {
      if (low <= sl) {
        return { status: "sl_hit", resolvedAt: new Date(ts) };
      }
      if (tp2 != null && high >= tp2) {
        return { status: "tp2_hit", resolvedAt: new Date(ts) };
      }
      if (tp1 != null && intermediate == null && high >= tp1) {
        intermediate = "tp1_hit";
        intermediateAt = ts;
      }
    } else {
      if (high >= sl) {
        return { status: "sl_hit", resolvedAt: new Date(ts) };
      }
      if (tp2 != null && low <= tp2) {
        return { status: "tp2_hit", resolvedAt: new Date(ts) };
      }
      if (tp1 != null && intermediate == null && low <= tp1) {
        intermediate = "tp1_hit";
        intermediateAt = ts;
      }
    }
  }

  if (intermediate === "tp1_hit") {
    if (nowTs >= validUntilTs) {
      return { status: "tp1_hit", resolvedAt: new Date(intermediateAt!) };
    }
    // Still inside the validity window — keep scanning for TP2 on the
    // next tick.
    return { status: "pending", resolvedAt: null };
  }
  if (nowTs >= validUntilTs) {
    return { status: "expired", resolvedAt: new Date(validUntilTs) };
  }
  return { status: "pending", resolvedAt: null };
}

/**
 * Background tick: pick up to `BATCH_LIMIT` analyses that still have a
 * pending outcome and a tradeable plan, fetch each one's candles via
 * the same upstream the chart overlay uses, and write the resolved
 * status back. Always records `outcomeCheckedAt` so we can see the
 * resolver is alive even when nothing flips.
 */
export async function resolvePendingOutcomes(): Promise<void> {
  const rows = await db
    .select({
      id: analyses.id,
      instrument: analyses.instrument,
      timeframe: analyses.timeframe,
      tradePlan: analyses.tradePlan,
      createdAt: analyses.createdAt,
      validUntil: analyses.validUntil,
    })
    .from(analyses)
    .where(
      and(
        eq(analyses.outcomeStatus, "pending"),
        isNotNull(analyses.tradePlan),
        sql`${analyses.tradePlan}->>'preferredSide' IN ('buy', 'sell')`,
      ),
    )
    // Without an explicit order, Postgres's row order for this query is
    // unspecified — in production it settled into repeatedly re-selecting
    // the same small pool of (mostly recent) rows every tick, starving the
    // rest of the backlog completely (7555 of 7690 pending rows had never
    // been checked even once). Oldest-first guarantees every row eventually
    // gets a turn and prioritizes the most-overdue analyses first.
    .orderBy(asc(analyses.createdAt))
    .limit(BATCH_LIMIT);

  if (rows.length === 0) return;

  const nowTs = Date.now();
  // Cache candle fetches per (instrument, timeframe) so a batch with
  // many rows on the same pair only hits Yahoo once.
  const candleCache = new Map<string, BarLike[] | null>();

  // Structurally malformed/unresolvable rows (bad JSON, unsupported legacy
  // timeframe, missing side plan) can never become resolvable no matter how
  // many times they're re-checked. Marking them `invalidated` immediately —
  // instead of a bare `continue` that writes nothing — is what makes that
  // permanent, so they stop occupying a batch slot on every future tick.
  const markInvalidated = (id: number) =>
    db
      .update(analyses)
      .set({ outcomeStatus: "invalidated", outcomeResolvedAt: new Date(nowTs), outcomeCheckedAt: new Date(nowTs) })
      .where(eq(analyses.id, id));

  for (const row of rows) {
    try {
      const plan = row.tradePlan as TradePlanShape | null;
      if (!plan) { await markInvalidated(row.id); continue; }
      const side = plan.preferredSide;
      if (side !== "buy" && side !== "sell") { await markInvalidated(row.id); continue; }
      const tf = row.timeframe;
      if (!isSupportedIndicatorTimeframe(tf)) { await markInvalidated(row.id); continue; }
      const sidePlan = plan[side];
      if (!sidePlan) { await markInvalidated(row.id); continue; }

      const key = `${row.instrument}|${tf}`;
      if (!candleCache.has(key)) {
        const candles = await getCandles(
          row.instrument,
          tf as IndicatorTimeframe,
        );
        candleCache.set(key, candles ?? null);
      }
      const candles = candleCache.get(key) ?? null;
      if (!candles || candles.length === 0) {
        await db
          .update(analyses)
          .set({ outcomeCheckedAt: new Date(nowTs) })
          .where(eq(analyses.id, row.id));
        continue;
      }

      const result = evaluateOutcome(
        side,
        sidePlan,
        candles,
        new Date(row.createdAt).getTime(),
        new Date(row.validUntil).getTime(),
        nowTs,
      );

      if (result.status === "pending") {
        await db
          .update(analyses)
          .set({ outcomeCheckedAt: new Date(nowTs) })
          .where(eq(analyses.id, row.id));
      } else {
        await db
          .update(analyses)
          .set({
            outcomeStatus: result.status,
            outcomeResolvedAt: result.resolvedAt,
            outcomeCheckedAt: new Date(nowTs),
          })
          .where(eq(analyses.id, row.id));
        logger.info(
          {
            analysisId: row.id,
            instrument: row.instrument,
            timeframe: row.timeframe,
            outcome: result.status,
          },
          "Resolved analysis outcome",
        );
      }
    } catch (err) {
      logger.error(
        { err, analysisId: row.id },
        "Failed to resolve analysis outcome",
      );
    }
  }
}
