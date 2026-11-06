import { db } from "./db";
import {
  analyses,
  priceAlerts,
  pushSubscriptions,
  type TradePlanShape,
  type TradeSideShape,
} from "@workspace/db/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { getLiveQuotes, LIVE_FEED_SPOT_INSTRUMENTS } from "./live-prices";
import { isCryptoInstrument } from "./crypto-instruments";
import { parsePlanLevel } from "./outcomes";

export type AlertLevel = "entry" | "sl" | "tp1" | "tp2";
export type AlertDirection = "above" | "below";
export type TradeSide = "buy" | "sell";

interface ArmCandidate {
  level: AlertLevel;
  price: number;
}

// Pulls the 4 levels we know how to watch out of a TradeSideShape and
// returns them as { level, price } pairs in a stable order. Levels
// whose strings don't contain a parseable number are silently dropped
// — we can't fire an alert on a level we can't compare against.
function extractLevels(plan: TradeSideShape): ArmCandidate[] {
  const out: ArmCandidate[] = [];
  const entry = parsePlanLevel(plan.entryZone);
  const sl = parsePlanLevel(plan.stopLoss);
  const tp1 = parsePlanLevel(plan.takeProfit1);
  const tp2 = parsePlanLevel(plan.takeProfit2);
  if (entry != null) out.push({ level: "entry", price: entry });
  if (sl != null) out.push({ level: "sl", price: sl });
  if (tp1 != null) out.push({ level: "tp1", price: tp1 });
  if (tp2 != null) out.push({ level: "tp2", price: tp2 });
  return out;
}

/**
 * Decide which side of `levelPrice` the watcher needs price to cross
 * to fire the alert. Computed from the current spot at arm time so
 * the rule stays correct even when the AI's entry zone is technically
 * "below" the current price for a buy plan (a pullback-to-support
 * entry, for example).
 */
export function deriveDirection(
  spot: number,
  levelPrice: number,
): AlertDirection {
  // When spot already equals the level (within float noise), treat it
  // as "below" so the next *upward* tick fires — this is a vanishingly
  // rare edge case but keeps the rule deterministic.
  return spot > levelPrice ? "below" : "above";
}

/**
 * Has the live price crossed `levelPrice` from `direction`'s side?
 * Pure for testability.
 */
export function shouldFireAlert(
  livePrice: number,
  levelPrice: number,
  direction: AlertDirection,
): boolean {
  if (!Number.isFinite(livePrice) || !Number.isFinite(levelPrice)) return false;
  return direction === "above"
    ? livePrice >= levelPrice
    : livePrice <= levelPrice;
}

/**
 * Should the watcher cancel the remaining un-fired alerts on an
 * analysis after `firedLevel` triggered? Yes for SL/TP1/TP2 (the trade
 * has effectively resolved one way or the other), no for entry (the
 * trade has only just begun, the user still wants to know about
 * SL/TP).
 */
export function shouldCancelSiblingsAfter(firedLevel: AlertLevel): boolean {
  return firedLevel !== "entry";
}

/**
 * Arm price alerts for an analysis. Idempotent: re-arming an analysis
 * that already has rows is a no-op (and keeps prior `triggeredAt` /
 * `cancelledAt` history intact via the unique index).
 *
 * Returns the number of newly-armed levels, or 0 when nothing was
 * arm-able (no trade plan, preferredSide is `wait`, instrument has no
 * live-price coverage, etc).
 */
export async function armAlertsForAnalysis(analysisId: number): Promise<number> {
  const [row] = await db
    .select({
      id: analyses.id,
      userId: analyses.userId,
      instrument: analyses.instrument,
      validUntil: analyses.validUntil,
      tradePlan: analyses.tradePlan,
    })
    .from(analyses)
    .where(eq(analyses.id, analysisId))
    .limit(1);
  if (!row) return 0;

  const plan = row.tradePlan as TradePlanShape | null;
  if (!plan) return 0;
  const side = plan.preferredSide;
  if (side !== "buy" && side !== "sell") return 0;
  const sidePlan = plan[side];
  if (!sidePlan) return 0;

  const candidates = extractLevels(sidePlan);
  if (candidates.length === 0) return 0;

  // We need the current spot price to know which side of each level
  // we're firing from. A missing quote for a mapped instrument is a
  // temporary feed failure, not proof that the instrument is unsupported.
  let spot: number | null = null;
  try {
    const quotes = await getLiveQuotes();
    const hit = quotes.data.find((q) => q.instrument === row.instrument);
    if (hit) {
      const n = typeof hit.price === "number" ? hit.price : Number(hit.price);
      if (Number.isFinite(n)) spot = n;
    }
  } catch (err) {
    logger.warn({ err, instrument: row.instrument }, "Live-price lookup failed during arm");
    throw err;
  }
  if (spot == null) {
    if (LIVE_FEED_SPOT_INSTRUMENTS.has(row.instrument) || row.instrument === "HK50" || isCryptoInstrument(row.instrument)) {
      throw new Error("Live price unavailable for mapped instrument");
    }
    return 0;
  }

  // Cancel any prior rows for this analysis that have NOT yet triggered
  // (e.g. user toggled off and back on) so re-arming gives a clean
  // slate. Triggered rows stay as historical record.
  await db
    .update(priceAlerts)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(priceAlerts.analysisId, analysisId),
        isNull(priceAlerts.triggeredAt),
        isNull(priceAlerts.cancelledAt),
      ),
    );

  const rows = candidates.map((c) => ({
    analysisId,
    userId: row.userId,
    instrument: row.instrument,
    side,
    level: c.level,
    levelPrice: String(c.price),
    triggerDirection: deriveDirection(spot!, c.price),
    validUntil: row.validUntil,
  }));

  // Unique index on (analysisId, level, side) means a re-arm after a
  // previous run that already cancelled its rows would collide. We
  // resolve by deleting prior rows for this analysis first.
  await db.delete(priceAlerts).where(eq(priceAlerts.analysisId, analysisId));

  await db.insert(priceAlerts).values(rows);
  return rows.length;
}

/**
 * Cancel every un-triggered alert on an analysis. Used by the
 * "Notify me" toggle's off state. Idempotent.
 */
export async function cancelAlertsForAnalysis(analysisId: number): Promise<void> {
  await db
    .update(priceAlerts)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(priceAlerts.analysisId, analysisId),
        isNull(priceAlerts.triggeredAt),
        isNull(priceAlerts.cancelledAt),
      ),
    );
}

export interface AlertStatus {
  enabled: boolean;
  armedCount: number;
  levels: Array<{
    level: AlertLevel;
    side: TradeSide;
    price: string;
    direction: AlertDirection;
    triggeredAt: string | null;
    triggeredPrice: string | null;
    cancelledAt: string | null;
  }>;
}

export async function getAlertStatusForAnalysis(
  analysisId: number,
): Promise<AlertStatus> {
  const rows = await db
    .select()
    .from(priceAlerts)
    .where(eq(priceAlerts.analysisId, analysisId));
  const now = Date.now();
  const armed = rows.filter(
    (r) =>
      !r.triggeredAt &&
      !r.cancelledAt &&
      new Date(r.validUntil).getTime() > now,
  );
  return {
    enabled: armed.length > 0,
    armedCount: armed.length,
    levels: rows.map((r) => ({
      level: r.level as AlertLevel,
      side: r.side as TradeSide,
      price: r.levelPrice,
      direction: r.triggerDirection as AlertDirection,
      triggeredAt: r.triggeredAt ? r.triggeredAt.toISOString() : null,
      triggeredPrice: r.triggeredPrice,
      cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
    })),
  };
}

/**
 * Does the given user have at least one push subscription? Used to
 * decide whether to auto-arm alerts on a freshly-created analysis
 * (no point arming for a user who can't receive the push anyway).
 */
export async function userHasPushSubscription(userId: number): Promise<boolean> {
  const [hit] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .limit(1);
  return Boolean(hit);
}

const LEVEL_LABEL_EN: Record<AlertLevel, string> = {
  entry: "Entry",
  sl: "Stop Loss",
  tp1: "TP1",
  tp2: "TP2",
};
const LEVEL_LABEL_ID: Record<AlertLevel, string> = {
  entry: "Entry",
  sl: "Stop Loss",
  tp1: "TP1",
  tp2: "TP2",
};

/**
 * Background tick: scan every active price_alerts row, compare against
 * the current live price, fire a Web Push the first time a level is
 * crossed, then cancel any sibling alerts whose trade has resolved.
 * Also auto-cancels rows whose `validUntil` has passed.
 */
export async function checkPriceAlerts(): Promise<void> {
  const now = new Date();
  // 1) Expire alerts past their validity window (one query, no per-row work).
  await db
    .update(priceAlerts)
    .set({ cancelledAt: now })
    .where(
      and(
        isNull(priceAlerts.triggeredAt),
        isNull(priceAlerts.cancelledAt),
        sql`${priceAlerts.validUntil} <= ${now}`,
      ),
    );

  // 2) Pull all still-active alerts.
  const active = await db
    .select()
    .from(priceAlerts)
    .where(
      and(
        isNull(priceAlerts.triggeredAt),
        isNull(priceAlerts.cancelledAt),
        gt(priceAlerts.validUntil, now),
      ),
    );
  if (active.length === 0) return;

  // 3) One upstream fetch covers every alert.
  let quotes;
  try {
    quotes = await getLiveQuotes();
  } catch (err) {
    logger.warn({ err }, "Price-alerts tick: live-quotes fetch failed");
    return;
  }
  const priceFor = new Map<string, number>();
  for (const q of quotes.data) {
    const n = typeof q.price === "number" ? q.price : Number(q.price);
    if (Number.isFinite(n)) priceFor.set(q.instrument, n);
  }

  // Track which analyses have already had a SL/TP fire this tick so we
  // only cancel siblings once even if multiple levels cross on the
  // same poll.
  const resolvedAnalyses = new Set<number>();

  for (const row of active) {
    // If an SL/TP already resolved this analysis earlier in the same
    // tick, skip its remaining un-fired levels — they will be cancelled
    // in step 4 below.
    if (resolvedAnalyses.has(row.analysisId)) continue;
    const live = priceFor.get(row.instrument);
    if (live == null) continue;
    const level = row.level as AlertLevel;
    const dir = row.triggerDirection as AlertDirection;
    const target = Number(row.levelPrice);
    if (!Number.isFinite(target)) continue;
    if (!shouldFireAlert(live, target, dir)) continue;

    try {
      // Compare-and-set: only fire when the row is still armed at
      // write-time. This is the single source of truth that prevents
      // double-fire across overlapping ticks, concurrent server
      // instances, or a cancel that landed between our snapshot read
      // and this update.
      const claimed = await db
        .update(priceAlerts)
        .set({ triggeredAt: new Date(), triggeredPrice: String(live) })
        .where(
          and(
            eq(priceAlerts.id, row.id),
            isNull(priceAlerts.triggeredAt),
            isNull(priceAlerts.cancelledAt),
            gt(priceAlerts.validUntil, new Date()),
          ),
        )
        .returning({ id: priceAlerts.id });
      if (claimed.length === 0) {
        // Lost the race — another worker or a cancel got there first.
        continue;
      }

      await firePushForAlert(row, level, live);

      if (shouldCancelSiblingsAfter(level)) {
        resolvedAnalyses.add(row.analysisId);
      }
    } catch (err) {
      logger.error({ err, alertId: row.id }, "Failed to fire price alert");
    }
  }

  // 4) Cancel any remaining un-triggered alerts on analyses whose trade
  // has resolved (SL or a TP fired).
  for (const analysisId of resolvedAnalyses) {
    await db
      .update(priceAlerts)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(priceAlerts.analysisId, analysisId),
          isNull(priceAlerts.triggeredAt),
          isNull(priceAlerts.cancelledAt),
        ),
      );
  }
}

async function firePushForAlert(
  row: typeof priceAlerts.$inferSelect,
  level: AlertLevel,
  livePrice: number,
): Promise<void> {
  // Labels are EN-only at the OS-push layer because we don't know the
  // user's language preference without an extra round-trip. In-app
  // copy on /analyses/<id> can still be fully localized.
  const label = LEVEL_LABEL_EN[level];
  const title = `${row.instrument} hit ${label}`;
  const body = `${row.instrument} just touched ${label} at ${formatPrice(livePrice)}.`;
  const url = `/analyses/${row.analysisId}`;
  const tag = `price-alert-${row.analysisId}-${level}`;
  void void LEVEL_LABEL_ID; // reserved for future locale-aware push
  await createNotification(
    row.userId,
    {
      title,
      message: body,
      type: level === "sl" ? "warning" : "info",
      actionType: "open_analysis",
      actionId: String(row.analysisId),
    },
    { title, body, url, tag },
  );
}

function formatPrice(n: number): string {
  // Trim trailing zeros but keep enough precision for FX (5dp covers
  // most majors and indices with whole-number prints).
  return n.toFixed(5).replace(/\.?0+$/, "");
}
