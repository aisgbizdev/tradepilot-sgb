// Tier 3 push (task #142 A): 5-min pre-open reminder for the FX
// sessions the user has explicitly opted in to. Opt-in only — the
// `marketOpenSessions` column defaults to an empty array, so users
// never get this ping until they pick a session in Settings.

import { db } from "./db";
import { users } from "@workspace/db/schema";
import { gt, sql } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { alreadyDelivered, withinQuietHours } from "./notification-guards";

const CATEGORY = "market_open";

export type MarketSession = "tokyo" | "london" | "newyork";

// Session open times expressed as UTC hour:minute. We use the FX-trader
// convention rather than the equities open: Tokyo cash session ≈ 00:00
// UTC, London cash ≈ 08:00 UTC, NY cash ≈ 13:00 UTC. The reminder fires
// 5 minutes before, so any minute inside the closed-open window
// `[open-5min, open)` qualifies for that session.
const SESSION_OPEN_UTC: Record<MarketSession, { hour: number; minute: number; label: string }> = {
  tokyo: { hour: 0, minute: 0, label: "Tokyo" },
  london: { hour: 8, minute: 0, label: "London" },
  newyork: { hour: 13, minute: 0, label: "New York" },
};

const REMINDER_LEAD_MIN = 5;

export function isValidSession(value: string): value is MarketSession {
  return value === "tokyo" || value === "london" || value === "newyork";
}

interface DispatchStats {
  candidates: number;
  sent: number;
  suppressedOptOut: number;
  suppressedWeekend: number;
  suppressedNotWindow: number;
  suppressedQuiet: number;
  suppressedDedupe: number;
}

/**
 * Returns the session whose open is within `REMINDER_LEAD_MIN` minutes
 * of `now` (UTC), or `null` if `now` is not in any pre-open window.
 * Pure / unit-testable.
 */
export function sessionDueAt(now: Date): MarketSession | null {
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  for (const [name, cfg] of Object.entries(SESSION_OPEN_UTC) as Array<
    [MarketSession, (typeof SESSION_OPEN_UTC)[MarketSession]]
  >) {
    // Convert "now" and "open" to minute-of-day in UTC, then compute
    // the signed gap. Reminder is due when 0 < gap <= LEAD.
    const nowMin = utcHour * 60 + utcMin;
    const openMin = cfg.hour * 60 + cfg.minute;
    let gap = openMin - nowMin;
    if (gap < 0) gap += 24 * 60; // session opens later today/tomorrow
    if (gap > 0 && gap <= REMINDER_LEAD_MIN) return name;
  }
  return null;
}

/**
 * Skip Sat/Sun in UTC. Approximation — Sydney opens Sunday evening UTC
 * for instance — but for the three sessions we cover (Tokyo/London/NY),
 * weekends in UTC line up with "no FX cash trading" closely enough.
 */
export function isWeekendUtc(now: Date): boolean {
  const d = now.getUTCDay();
  return d === 0 || d === 6;
}

/**
 * True if the *target session open* (not `now`) falls on a weekend in
 * UTC. We gate on this rather than on `now` because Tokyo opens at
 * 00:00 UTC — the Monday-Tokyo reminder fires at Sunday 23:55 UTC,
 * which would be wrongly weekend-blocked if we checked `now`.
 */
export function isSessionWeekend(now: Date, session: MarketSession): boolean {
  const cfg = SESSION_OPEN_UTC[session];
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const openMin = cfg.hour * 60 + cfg.minute;
  let gap = openMin - nowMin;
  if (gap < 0) gap += 24 * 60;
  const openTs = now.getTime() + gap * 60 * 1000;
  const openDay = new Date(openTs).getUTCDay();
  return openDay === 0 || openDay === 6;
}

export function utcDayKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * One tick of the 5-min scheduler. Loads users who opted into at least
 * one session, figures out which session (if any) is currently in its
 * 5-min pre-open window, and pushes the reminder per user via the
 * shared anti-annoyance guards (quiet hours + per-day-per-session
 * dedupe key).
 */
export async function dispatchMarketOpenReminders(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats: DispatchStats = {
    candidates: 0,
    sent: 0,
    suppressedOptOut: 0,
    suppressedWeekend: 0,
    suppressedNotWindow: 0,
    suppressedQuiet: 0,
    suppressedDedupe: 0,
  };
  try {
    const due = sessionDueAt(now);
    if (!due) {
      stats.suppressedNotWindow = 1;
      return stats;
    }
    // Gate on the *target session open* weekday, not `now`. Tokyo
    // opens at 00:00 UTC so the Monday reminder fires at Sun 23:55
    // UTC — a naive `isWeekendUtc(now)` check would wrongly suppress
    // it. By contrast, a Sunday LSE/NY reminder is correctly weekend-
    // blocked because the open itself falls on Sunday UTC.
    if (isSessionWeekend(now, due)) {
      stats.suppressedWeekend = 1;
      return stats;
    }

    // Only load users that opted into at least one session. Drizzle has
    // no first-class jsonb-length operator on this version, so we lean
    // on raw SQL — Postgres' jsonb_array_length on a non-array would
    // throw, but the column has a non-null default of `[]` so every row
    // is a valid jsonb array.
    const candidates = await db
      .select({
        id: users.id,
        marketOpenSessions: users.marketOpenSessions,
        dailySummaryTimezone: users.dailySummaryTimezone,
      })
      .from(users)
      .where(gt(sql`jsonb_array_length(${users.marketOpenSessions})`, 0));
    stats.candidates = candidates.length;

    const dayKey = utcDayKey(now);
    const sessionLabel = SESSION_OPEN_UTC[due].label;

    for (const user of candidates) {
      const opted = Array.isArray(user.marketOpenSessions) ? user.marketOpenSessions : [];
      if (!opted.includes(due)) {
        stats.suppressedOptOut += 1;
        continue;
      }
      if (
        withinQuietHours(
          { dailySummaryTimezone: user.dailySummaryTimezone },
          now,
        )
      ) {
        stats.suppressedQuiet += 1;
        continue;
      }
      const dedupeKey = `market_open:${user.id}:${due}:${dayKey}`;
      if (await alreadyDelivered(dedupeKey)) {
        stats.suppressedDedupe += 1;
        continue;
      }
      const title = `🔔 ${sessionLabel} open in ${REMINDER_LEAD_MIN} minutes`;
      const body = `Sesi ${sessionLabel} buka sebentar lagi — cek analisa kamu.`;
      const created = await createNotification(
        user.id,
        { title, message: body, type: "info", category: CATEGORY, dedupeKey },
        { title, body, url: "/", tag: `market-open-${due}-${dayKey}` },
      );
      if (created) stats.sent += 1;
      else stats.suppressedDedupe += 1;
    }
    if (stats.sent > 0 || stats.candidates > 0) {
      logger.info({ ...stats, due }, "dispatchMarketOpenReminders tick");
    }
    return stats;
  } catch (err) {
    logger.error(err, "dispatchMarketOpenReminders failed");
    return stats;
  }
}
