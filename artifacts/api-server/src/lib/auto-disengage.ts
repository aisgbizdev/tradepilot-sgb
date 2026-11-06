// Tier 3 push (task #142 E): self-pause categories the user keeps
// ignoring. Once a per-category streak of 3 consecutive
// "unread-after-48h" deliveries lands, flip the matching opt-out
// boolean to false and stamp `disengageNoticeCategory` so the UI can
// render a one-time banner explaining what happened.

import { db } from "./db";
import { users, notifications } from "@workspace/db/schema";
import { and, asc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger";

type UserRow = typeof users.$inferSelect;

// Maps notification.category → the users column to flip when the user
// has clearly stopped reading them. Keep this list in lockstep with
// the categories used in dispatchers (price-anomaly, signal-flip,
// weekly-recap, market-open, dormancy, onboarding, watchlist alerts).
const CATEGORY_TO_TOGGLE: Record<string, keyof typeof users.$inferSelect> = {
  market_news: "pushMarketNews",
  calendar_event: "pushCalendarEvents",
  price_anomaly: "pushPriceAnomaly",
  weekly_recap: "pushWeeklyRecap",
  signal_flip: "pushSignalFlip",
  market_open: "marketOpenSessions" as never, // handled specially — see below
  dormancy_nudge: "pushDormancyNudge",
};

const STREAK_THRESHOLD = 3;
const IGNORE_AGE_MS = 48 * 60 * 60 * 1000; // 48h
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30d window for counting

interface RunStats {
  scanned: number;
  paused: number;
  streakUpdates: number;
}

/**
 * Walk every (user, category) pair with at least one notification in
 * the trailing 30d, count how many of the *most recent* deliveries
 * landed unread past 48h, and use that as the streak. A click (or any
 * read at all) resets the streak to 0 on the user row.
 */
export async function runAutoDisengage(now: Date = new Date()): Promise<RunStats> {
  const stats: RunStats = { scanned: 0, paused: 0, streakUpdates: 0 };
  try {
    const ignoreCutoff = new Date(now.getTime() - IGNORE_AGE_MS);
    const lookbackCutoff = new Date(now.getTime() - LOOKBACK_MS);

    // Pull all relevant notifications in one query and group in JS —
    // simpler than a window-function CTE, and the row count for 30d
    // is bounded.
    const rows = await db
      .select({
        userId: notifications.userId,
        category: notifications.category,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(
          isNotNull(notifications.userId),
          isNotNull(notifications.category),
          gte(notifications.createdAt, lookbackCutoff),
          lte(notifications.createdAt, ignoreCutoff),
        ),
      )
      .orderBy(asc(notifications.userId), asc(notifications.category), asc(notifications.createdAt));

    // Group: (userId, category) → ordered list of {createdAt, readAt}
    const grouped = new Map<
      string,
      { userId: number; category: string; reads: { createdAt: Date; readAt: Date | null }[] }
    >();
    for (const r of rows) {
      if (r.userId == null || r.category == null) continue;
      if (!CATEGORY_TO_TOGGLE[r.category]) continue;
      const key = `${r.userId}:${r.category}`;
      const slot = grouped.get(key) ?? { userId: r.userId, category: r.category, reads: [] };
      slot.reads.push({ createdAt: r.createdAt, readAt: r.readAt ?? null });
      grouped.set(key, slot);
    }
    stats.scanned = grouped.size;

    // Cache user rows we've already loaded to avoid N+1 selects.
    const userCache = new Map<number, UserRow>();
    for (const slot of grouped.values()) {
      let user = userCache.get(slot.userId);
      if (!user) {
        const [row] = await db
          .select()
          .from(users)
          .where(eq(users.id, slot.userId))
          .limit(1);
        if (!row) continue;
        user = row;
        userCache.set(slot.userId, user);
      }

      // Steady-state guard: if the user's toggle for this category is
      // already off (we paused it on a previous tick, or the user
      // opted out manually), there's nothing to do — and crucially,
      // we must NOT re-stamp the banner. Old unread notifications
      // would otherwise produce streak>=3 forever in the 30d lookback.
      if (!isCategoryEnabled(user, slot.category)) {
        continue;
      }

      // Only count notifications newer than the per-category
      // checkpoint. The checkpoint is set when (a) we previously
      // paused this category, or (b) the user re-opted in via PATCH
      // /push/prefs (handled in routes/push.ts). Without it, the same
      // 30d-window history would keep re-triggering.
      const checkpoints = (user.disengageCheckpoints ?? {}) as Record<string, string>;
      const checkpoint = checkpoints[slot.category]
        ? new Date(checkpoints[slot.category])
        : null;

      // Count the trailing streak of unread items: walk from newest to
      // oldest and stop at the first read OR at a notification at/
      // before the checkpoint.
      let streak = 0;
      for (let i = slot.reads.length - 1; i >= 0; i -= 1) {
        const r = slot.reads[i];
        if (checkpoint && r.createdAt <= checkpoint) break;
        if (r.readAt == null) streak += 1;
        else break;
      }

      const currentStreaks = (user.disengageStreaks ?? {}) as Record<string, number>;
      const prev = currentStreaks[slot.category] ?? 0;
      if (streak === prev && streak < STREAK_THRESHOLD) {
        // Nothing changed for this category and we're not at the
        // threshold — skip the write to keep tick cost flat.
        continue;
      }

      if (streak >= STREAK_THRESHOLD) {
        // Stamp a checkpoint at `now` so the next tick's lookback
        // ignores everything we just counted, AND reset the streak.
        // Only set the banner category if none is currently pending
        // (the user hasn't dismissed it yet).
        const nextStreaks = { ...currentStreaks, [slot.category]: 0 };
        const nextCheckpoints = { ...checkpoints, [slot.category]: now.toISOString() };
        const updates: Record<string, unknown> = {
          disengageStreaks: nextStreaks,
          disengageCheckpoints: nextCheckpoints,
          updatedAt: new Date(),
        };
        if (!user.disengageNoticeCategory) {
          updates["disengageNoticeCategory"] = slot.category;
        }
        // Flip the right opt-out. `market_open` opts out by clearing
        // the session array; everything else just flips a boolean.
        if (slot.category === "market_open") {
          updates["marketOpenSessions"] = [];
        } else {
          const col = CATEGORY_TO_TOGGLE[slot.category];
          if (col) updates[col as string] = false;
        }
        await db.update(users).set(updates).where(eq(users.id, slot.userId));
        // Mirror the write into our cache so subsequent slots for the
        // same user see the updated state.
        Object.assign(user, updates);
        stats.paused += 1;
      } else {
        const nextStreaks = { ...currentStreaks, [slot.category]: streak };
        await db
          .update(users)
          .set({ disengageStreaks: nextStreaks, updatedAt: new Date() })
          .where(eq(users.id, slot.userId));
        user.disengageStreaks = nextStreaks;
        stats.streakUpdates += 1;
      }
    }

    if (stats.paused > 0 || stats.streakUpdates > 0) {
      logger.info(stats, "runAutoDisengage tick");
    }
    return stats;
  } catch (err) {
    logger.error(err, "runAutoDisengage failed");
    return stats;
  }
}

/**
 * Reset a (user, category) streak when the user actually reads/clicks a
 * notification of that category. Called from the mark-read route.
 */
export async function resetDisengageStreak(userId: number, category: string): Promise<void> {
  try {
    const [row] = await db
      .select({ disengageStreaks: users.disengageStreaks })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return;
    const streaks = { ...(row.disengageStreaks ?? {}) };
    if (!streaks[category]) return;
    streaks[category] = 0;
    await db
      .update(users)
      .set({ disengageStreaks: streaks, updatedAt: new Date() })
      .where(eq(users.id, userId));
  } catch (err) {
    logger.warn({ err, userId, category }, "resetDisengageStreak failed");
  }
}

/** True if the user currently has the toggle for `category` enabled. */
function isCategoryEnabled(user: UserRow, category: string): boolean {
  if (category === "market_open") {
    return Array.isArray(user.marketOpenSessions) && user.marketOpenSessions.length > 0;
  }
  const col = CATEGORY_TO_TOGGLE[category];
  if (!col) return false;
  return user[col] === true;
}

// Suppress unused-import warning for `sql` (kept for future extensions).
void sql;
