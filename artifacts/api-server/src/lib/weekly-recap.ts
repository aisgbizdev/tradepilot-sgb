// Tier 2 push (task #141 B): weekly recap of the user's trading
// activity, fired Sunday 19:00 in the user's local timezone. Reuses
// the Tier 1 guards (`notification-guards.ts`) — quiet hours don't
// apply to a recap (19:00 is below the 22:00 default cutoff) but the
// dedupe key gives us a hard "1 per week" backstop.

import { db } from "./db";
import { users, analyses } from "@workspace/db/schema";
import { eq, and, gte } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { alreadyDelivered, withinQuietHours } from "./notification-guards";

const CATEGORY = "weekly_recap";
const DEFAULT_TIMEZONE = "Asia/Jakarta";

// Return YYYY, ISO week number, day-of-week (0=Sun..6=Sat) and hour
// in the given IANA timezone. Uses Intl.DateTimeFormat so we don't
// pull in a tz library.
interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=Sun .. 6=Sat
  hour: number;
}

export function localPartsInTimezone(now: Date, timezone: string): LocalParts {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const year = parseInt(get("year"), 10);
    const month = parseInt(get("month"), 10);
    const day = parseInt(get("day"), 10);
    let hour = parseInt(get("hour"), 10);
    if (hour === 24) hour = 0;
    const wdMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const weekday = wdMap[get("weekday")] ?? 0;
    return { year, month, day, weekday, hour };
  } catch {
    // Invalid timezone — fall back to UTC.
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      weekday: now.getUTCDay(),
      hour: now.getUTCHours(),
    };
  }
}

/**
 * ISO-style week key (e.g. "2026-W21") in the user's local timezone.
 * Used inside the dedupe key so two ticks in the same Sunday hour for
 * the same user collapse to a single delivery, but a new Sunday in
 * the next ISO week is allowed through.
 */
export function isoWeekKey(local: LocalParts): string {
  // Approximate ISO week via the day-of-year / 7 — close enough for a
  // dedupe key (the actual ISO week number isn't important; uniqueness
  // per week is).
  const d = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

interface RecapUser {
  id: number;
  pushWeeklyRecap: boolean;
  dailySummaryTimezone: string | null;
}

async function loadRecapCandidates(): Promise<RecapUser[]> {
  const rows = await db
    .select({
      id: users.id,
      pushWeeklyRecap: users.pushWeeklyRecap,
      dailySummaryTimezone: users.dailySummaryTimezone,
    })
    .from(users);
  return rows.map((r) => ({
    id: r.id,
    pushWeeklyRecap: r.pushWeeklyRecap,
    dailySummaryTimezone: r.dailySummaryTimezone ?? null,
  }));
}

export interface WeeklyStats {
  total: number;
  topInstrument: string | null;
  topInstrumentCount: number;
  peakHourLocal: number | null;
  tpHits: number;
  slHits: number;
  resolved: number;
}

export async function computeWeeklyStats(
  userId: number,
  timezone: string,
  now: Date = new Date(),
): Promise<WeeklyStats> {
  // Look back 7 days from `now`. The exact local-week boundary is
  // unimportant — what matters is that "this week's recap" covers the
  // 7 days leading up to Sunday evening.
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      instrument: analyses.instrument,
      createdAt: analyses.createdAt,
      outcomeStatus: analyses.outcomeStatus,
    })
    .from(analyses)
    .where(and(eq(analyses.userId, userId), gte(analyses.createdAt, since)));

  if (rows.length === 0) {
    return {
      total: 0,
      topInstrument: null,
      topInstrumentCount: 0,
      peakHourLocal: null,
      tpHits: 0,
      slHits: 0,
      resolved: 0,
    };
  }

  const instrumentCount = new Map<string, number>();
  const hourCount = new Map<number, number>();
  let tpHits = 0;
  let slHits = 0;
  let resolved = 0;
  for (const r of rows) {
    instrumentCount.set(r.instrument, (instrumentCount.get(r.instrument) ?? 0) + 1);
    const local = localPartsInTimezone(new Date(r.createdAt), timezone);
    hourCount.set(local.hour, (hourCount.get(local.hour) ?? 0) + 1);
    if (r.outcomeStatus === "tp1_hit" || r.outcomeStatus === "tp2_hit") {
      tpHits += 1;
      resolved += 1;
    } else if (r.outcomeStatus === "sl_hit") {
      slHits += 1;
      resolved += 1;
    } else if (r.outcomeStatus === "expired") {
      resolved += 1;
    }
  }

  let topInstrument: string | null = null;
  let topInstrumentCount = 0;
  for (const [inst, c] of instrumentCount) {
    if (c > topInstrumentCount) {
      topInstrument = inst;
      topInstrumentCount = c;
    }
  }
  let peakHour: number | null = null;
  let peakHourCount = 0;
  for (const [h, c] of hourCount) {
    if (c > peakHourCount) {
      peakHour = h;
      peakHourCount = c;
    }
  }

  return {
    total: rows.length,
    topInstrument,
    topInstrumentCount,
    peakHourLocal: peakHour,
    tpHits,
    slHits,
    resolved,
  };
}

export function buildRecapMessage(stats: WeeklyStats): { title: string; body: string } {
  const title = "📊 Recap mingguan kamu";
  const parts: string[] = [`${stats.total} analisis minggu ini`];
  if (stats.resolved > 0) {
    const winRate = Math.round((stats.tpHits / stats.resolved) * 100);
    parts.push(`win rate ${winRate}% (${stats.tpHits}/${stats.resolved})`);
  }
  if (stats.topInstrument) {
    parts.push(`paling sering: ${stats.topInstrument} (${stats.topInstrumentCount}x)`);
  }
  if (stats.peakHourLocal !== null) {
    const hourLabel = String(stats.peakHourLocal).padStart(2, "0");
    parts.push(`paling aktif jam ${hourLabel}:00`);
  }
  return { title, body: parts.join(" · ") };
}

interface DispatchStats {
  candidates: number;
  sent: number;
  suppressedOptOut: number;
  suppressedNoActivity: number;
  suppressedNotWindow: number;
  suppressedQuiet: number;
  suppressedDedupe: number;
}

function emptyStats(): DispatchStats {
  return {
    candidates: 0,
    sent: 0,
    suppressedOptOut: 0,
    suppressedNoActivity: 0,
    suppressedNotWindow: 0,
    suppressedQuiet: 0,
    suppressedDedupe: 0,
  };
}

/**
 * Fire the Sunday-19:00 recap for every user whose local time is
 * currently inside the 19:00 hour. Designed to be called every minute
 * by jobs.ts — the dedupe key (week-keyed) guarantees at most one
 * delivery per user per ISO week regardless of scheduler jitter.
 */
export async function dispatchWeeklyRecap(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats = emptyStats();
  try {
    const candidates = await loadRecapCandidates();
    stats.candidates = candidates.length;

    for (const user of candidates) {
      if (!user.pushWeeklyRecap) {
        stats.suppressedOptOut += 1;
        continue;
      }
      const tz = user.dailySummaryTimezone || DEFAULT_TIMEZONE;
      const local = localPartsInTimezone(now, tz);
      // Sunday = 0, target hour = 19 (7pm local).
      if (local.weekday !== 0 || local.hour !== 19) {
        stats.suppressedNotWindow += 1;
        continue;
      }
      // Defensive quiet-hours check: 19:00 is below the default 22:00
      // cutoff so this normally passes, but a user with a custom quiet
      // window that covers 19:00 still expects to be respected.
      if (withinQuietHours({ dailySummaryTimezone: user.dailySummaryTimezone }, now)) {
        stats.suppressedQuiet += 1;
        continue;
      }
      // No per-category respectFrequencyCap here on purpose: this job is
      // hard-capped at "1 per ISO week per user" by the dedupe key
      // below, which is a strictly tighter ceiling than any reasonable
      // freq-cap policy could express.
      const weekKey = isoWeekKey(local);
      const dedupeKey = `weekly_recap:${user.id}:${weekKey}`;
      if (await alreadyDelivered(dedupeKey)) {
        stats.suppressedDedupe += 1;
        continue;
      }

      const wstats = await computeWeeklyStats(user.id, tz, now);
      if (wstats.total === 0) {
        stats.suppressedNoActivity += 1;
        continue;
      }

      const { title, body } = buildRecapMessage(wstats);
      const created = await createNotification(
        user.id,
        {
          title,
          message: body,
          type: "info",
          category: CATEGORY,
          dedupeKey,
        },
        {
          title,
          body,
          url: "/analytics",
          tag: `weekly-recap-${weekKey}`,
        },
      );
      if (created) stats.sent += 1;
      else stats.suppressedDedupe += 1;
    }

    if (stats.sent > 0 || stats.candidates > 0) {
      logger.info(stats, "dispatchWeeklyRecap tick");
    }
    return stats;
  } catch (err) {
    logger.error(err, "dispatchWeeklyRecap failed");
    return stats;
  }
}

