// Tier 3 push (task #142 B): soft "we miss you" nudge after ≥7 days
// of inactivity. Opt-in only (`pushDormancyNudge` defaults to false).
// Hard caps: max one nudge per ISO week per user, and auto-pause the
// toggle after 3 consecutive unanswered nudges so we stop spamming
// dead accounts.

import { db } from "./db";
import { users, analyses } from "@workspace/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { alreadyDelivered, withinQuietHours } from "./notification-guards";
import { localPartsInTimezone } from "./weekly-recap";

const CATEGORY = "dormancy_nudge";
const DEFAULT_TIMEZONE = "Asia/Jakarta";
const NUDGE_HOUR_LOCAL = 10; // fire at 10:00 user-local
const INACTIVE_DAYS = 7;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INACTIVE_MS = INACTIVE_DAYS * 24 * 60 * 60 * 1000;
const AUTO_PAUSE_AFTER_STREAK = 3;

interface DispatchStats {
  candidates: number;
  sent: number;
  suppressedOptOut: number;
  suppressedNotWindow: number;
  suppressedQuiet: number;
  suppressedRecentActivity: number;
  suppressedRecentNudge: number;
  autoPaused: number;
}

/**
 * Build a soft nudge message. Plain copy + an optional micro-stat the
 * caller can mix in (e.g. "3 high-impact items today"). Pure helper so
 * the dispatcher can stay short.
 */
export function buildDormancyMessage(microStat?: string | null): { title: string; body: string } {
  const title = "Kangen TradePilot.id? 👀";
  const body = microStat
    ? `Pasar minggu ini lagi rame — ${microStat}`
    : "Pasar minggu ini lagi rame — cek analisa terbaru kamu.";
  return { title, body };
}

interface DormancyUser {
  id: number;
  pushDormancyNudge: boolean;
  dailySummaryTimezone: string | null;
  dormancyNudgeStreak: number;
  dormancyLastNudgeAt: Date | null;
}

async function loadDormancyCandidates(): Promise<DormancyUser[]> {
  const rows = await db
    .select({
      id: users.id,
      pushDormancyNudge: users.pushDormancyNudge,
      dailySummaryTimezone: users.dailySummaryTimezone,
      dormancyNudgeStreak: users.dormancyNudgeStreak,
      dormancyLastNudgeAt: users.dormancyLastNudgeAt,
    })
    .from(users);
  return rows;
}

async function hasRecentAnalysis(userId: number, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.userId, userId), gte(analyses.createdAt, since)))
    .orderBy(desc(analyses.createdAt))
    .limit(1);
  return Boolean(row);
}

/**
 * Compute a real micro-stat to mix into the nudge body. Today it's
 * "X hari sejak analisa terakhir" (X days since last analysis) — the
 * most relevant nudge for a dormant user. Returns null when we have
 * nothing concrete to say (brand-new user with zero analyses ever).
 */
export async function computeDormancyMicroStat(
  userId: number,
  now: Date = new Date(),
): Promise<string | null> {
  const [row] = await db
    .select({ createdAt: analyses.createdAt })
    .from(analyses)
    .where(eq(analyses.userId, userId))
    .orderBy(desc(analyses.createdAt))
    .limit(1);
  if (!row) return null;
  const days = Math.max(1, Math.floor((now.getTime() - row.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
  return `${days} hari sejak analisa terakhirmu`;
}

/**
 * Once-daily tick at 10:00 user-local. Per-user steps:
 *  1. Bail if opt-out.
 *  2. Bail if local hour ≠ 10 (jobs ticks every minute or so).
 *  3. Bail if user has an analysis in the last 7 days (= still active).
 *  4. Bail if a nudge already went out in the last 7 days.
 *  5. Send nudge, bump `dormancyNudgeStreak`, stamp `dormancyLastNudgeAt`.
 *  6. If streak hits AUTO_PAUSE_AFTER_STREAK, flip `pushDormancyNudge`
 *     to false (the user clearly stopped caring; stop sending forever
 *     until they re-opt-in).
 *
 * `dormancyNudgeStreak` is reset to 0 elsewhere when the user creates
 * a new analysis (`routes/analyses.ts`).
 */
export async function dispatchDormancyNudge(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats: DispatchStats = {
    candidates: 0,
    sent: 0,
    suppressedOptOut: 0,
    suppressedNotWindow: 0,
    suppressedQuiet: 0,
    suppressedRecentActivity: 0,
    suppressedRecentNudge: 0,
    autoPaused: 0,
  };
  try {
    const candidates = await loadDormancyCandidates();
    stats.candidates = candidates.length;
    const inactiveSince = new Date(now.getTime() - INACTIVE_MS);
    const lastNudgeFloor = new Date(now.getTime() - WEEK_MS);

    for (const user of candidates) {
      if (!user.pushDormancyNudge) {
        stats.suppressedOptOut += 1;
        continue;
      }
      const tz = user.dailySummaryTimezone || DEFAULT_TIMEZONE;
      const local = localPartsInTimezone(now, tz);
      if (local.hour !== NUDGE_HOUR_LOCAL) {
        stats.suppressedNotWindow += 1;
        continue;
      }
      if (
        withinQuietHours({ dailySummaryTimezone: user.dailySummaryTimezone }, now)
      ) {
        stats.suppressedQuiet += 1;
        continue;
      }
      if (user.dormancyLastNudgeAt && user.dormancyLastNudgeAt >= lastNudgeFloor) {
        stats.suppressedRecentNudge += 1;
        continue;
      }
      if (await hasRecentAnalysis(user.id, inactiveSince)) {
        // User came back since the last nudge — reset the streak now
        // (also reset on the analyses POST path, but doing it here too
        // keeps the counter honest if that hook ever misses).
        if (user.dormancyNudgeStreak > 0) {
          await db
            .update(users)
            .set({ dormancyNudgeStreak: 0, updatedAt: new Date() })
            .where(eq(users.id, user.id));
        }
        stats.suppressedRecentActivity += 1;
        continue;
      }

      const dedupeKey = `dormancy_nudge:${user.id}:${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
      if (await alreadyDelivered(dedupeKey)) {
        stats.suppressedRecentNudge += 1;
        continue;
      }

      const microStat = await computeDormancyMicroStat(user.id, now);
      const { title, body } = buildDormancyMessage(microStat);
      const created = await createNotification(
        user.id,
        { title, message: body, type: "info", category: CATEGORY, dedupeKey },
        { title, body, url: "/", tag: `dormancy-nudge-${user.id}` },
      );
      if (!created) {
        stats.suppressedRecentNudge += 1;
        continue;
      }

      const newStreak = user.dormancyNudgeStreak + 1;
      const shouldPause = newStreak >= AUTO_PAUSE_AFTER_STREAK;
      await db
        .update(users)
        .set({
          dormancyNudgeStreak: newStreak,
          dormancyLastNudgeAt: now,
          ...(shouldPause ? { pushDormancyNudge: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      stats.sent += 1;
      if (shouldPause) stats.autoPaused += 1;
    }

    if (stats.sent > 0 || stats.autoPaused > 0) {
      logger.info(stats, "dispatchDormancyNudge tick");
    }
    return stats;
  } catch (err) {
    logger.error(err, "dispatchDormancyNudge failed");
    return stats;
  }
}

/** Called from POST /api/analyses to reset the streak when a user returns. */
export async function resetDormancyStreak(userId: number): Promise<void> {
  try {
    await db
      .update(users)
      .set({ dormancyNudgeStreak: 0, updatedAt: new Date() })
      .where(eq(users.id, userId));
  } catch (err) {
    logger.warn({ err, userId }, "resetDormancyStreak failed");
  }
}
