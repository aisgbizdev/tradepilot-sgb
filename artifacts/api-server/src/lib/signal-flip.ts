// Tier 2 push (task #141 C): when the user re-runs analysis on the
// same (instrument, timeframe) and the AI's recommended side changes
// in a meaningful way, ping them. Event-driven — wired into the
// /api/analyses POST handler, not a polling job.

import { db } from "./db";
import { users, analyses, type TradePlanShape } from "@workspace/db/schema";
import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import {
  alreadyDelivered,
  respectFrequencyCap,
  withinQuietHours,
} from "./notification-guards";

const CATEGORY = "signal_flip";
const PER_DAY_CAP = 3;
const PER_INSTRUMENT_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CONFIDENCE_DIFF_THRESHOLD = 20;

export type SignalAction = "buy" | "sell" | "wait";

export interface SignalSnapshot {
  action: SignalAction;
  confidence: number; // midpoint 0-100
}

export interface FlipResult {
  flipped: boolean;
  reason?: "buy_sell_swap" | "to_wait" | "from_wait";
  confidenceDiff: number;
}

/**
 * Pure helper: decide whether `next` represents a meaningful flip
 * vs `prev`. Returns `flipped:false` for same-side renewals and for
 * small-confidence-delta same-side updates.
 */
export function compareSignals(
  prev: SignalSnapshot,
  next: SignalSnapshot,
): FlipResult {
  const diff = Math.abs(next.confidence - prev.confidence);
  if (prev.action === next.action) {
    return { flipped: false, confidenceDiff: diff };
  }
  // Side actually changed. We additionally require the confidence
  // delta to clear the threshold so a tiny "buy 50% → wait 48%"
  // shuffle doesn't pop a push.
  if (diff <= CONFIDENCE_DIFF_THRESHOLD) {
    return { flipped: false, confidenceDiff: diff };
  }
  const isBuySellSwap =
    (prev.action === "buy" && next.action === "sell") ||
    (prev.action === "sell" && next.action === "buy");
  if (isBuySellSwap) {
    return { flipped: true, reason: "buy_sell_swap", confidenceDiff: diff };
  }
  if (next.action === "wait") {
    return { flipped: true, reason: "to_wait", confidenceDiff: diff };
  }
  if (prev.action === "wait") {
    return { flipped: true, reason: "from_wait", confidenceDiff: diff };
  }
  return { flipped: false, confidenceDiff: diff };
}

function snapshotFromAnalysisRow(row: {
  tradePlan: TradePlanShape | null;
  confidenceMin: number;
  confidenceMax: number;
}): SignalSnapshot | null {
  const side = row.tradePlan?.preferredSide;
  if (side !== "buy" && side !== "sell" && side !== "wait") return null;
  const mid = Math.round((row.confidenceMin + row.confidenceMax) / 2);
  return { action: side, confidence: mid };
}

const ACTION_LABEL: Record<SignalAction, string> = {
  buy: "BUY",
  sell: "SELL",
  wait: "WAIT",
};

/**
 * Look up the most recent analysis for (user, instrument, timeframe)
 * inside the last 7 days *excluding* the row just inserted, then
 * decide whether the new analysis represents a flip and dispatch the
 * push if so. Best-effort — failures are logged but never bubble back
 * to the analyses POST handler, which already returned 201.
 */
export async function maybeDispatchSignalFlip(input: {
  userId: number;
  newAnalysisId: number;
  instrument: string;
  timeframe: string;
  tradePlan: TradePlanShape | null;
  confidenceMin: number;
  confidenceMax: number;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const nextSnap = snapshotFromAnalysisRow({
      tradePlan: input.tradePlan,
      confidenceMin: input.confidenceMin,
      confidenceMax: input.confidenceMax,
    });
    if (!nextSnap) return;

    const since = new Date(now.getTime() - LOOKBACK_MS);
    const [prevRow] = await db
      .select({
        id: analyses.id,
        tradePlan: analyses.tradePlan,
        confidenceMin: analyses.confidenceMin,
        confidenceMax: analyses.confidenceMax,
      })
      .from(analyses)
      .where(
        and(
          eq(analyses.userId, input.userId),
          eq(analyses.instrument, input.instrument),
          eq(analyses.timeframe, input.timeframe),
          gte(analyses.createdAt, since),
          lt(analyses.createdAt, now),
          ne(analyses.id, input.newAnalysisId),
        ),
      )
      .orderBy(desc(analyses.createdAt))
      .limit(1);

    if (!prevRow) return;
    const prevSnap = snapshotFromAnalysisRow(prevRow);
    if (!prevSnap) return;

    const verdict = compareSignals(prevSnap, nextSnap);
    if (!verdict.flipped) return;

    const [prefs] = await db
      .select({
        pushSignalFlip: users.pushSignalFlip,
        dailySummaryTimezone: users.dailySummaryTimezone,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!prefs?.pushSignalFlip) return;
    if (withinQuietHours({ dailySummaryTimezone: prefs.dailySummaryTimezone }, now)) {
      return;
    }

    const daily = await respectFrequencyCap(
      input.userId,
      CATEGORY,
      ONE_DAY_MS,
      PER_DAY_CAP,
    );
    if (!daily.allowed) return;

    const bucket = Math.floor(now.getTime() / PER_INSTRUMENT_WINDOW_MS);
    const dedupeKey = `signal_flip:${input.userId}:${input.instrument}:${input.timeframe}:${bucket}`;
    if (await alreadyDelivered(dedupeKey)) return;

    const newConfPct = nextSnap.confidence;
    const title = `🔄 Sinyal ${input.instrument} ${input.timeframe} berubah`;
    const body = `${ACTION_LABEL[prevSnap.action]} → ${ACTION_LABEL[nextSnap.action]} (confidence ${newConfPct}%)`;
    await createNotification(
      input.userId,
      {
        title,
        message: body,
        type: "info",
        category: CATEGORY,
        dedupeKey,
        actionType: "open_analysis",
        actionId: String(input.newAnalysisId),
      },
      {
        title,
        body,
        url: `/analyses/${input.newAnalysisId}`,
        tag: `signal-flip-${input.instrument}-${input.timeframe}`,
      },
    );
  } catch (err) {
    logger.warn({ err, analysisId: input.newAnalysisId }, "signal-flip dispatch failed");
  }
}
