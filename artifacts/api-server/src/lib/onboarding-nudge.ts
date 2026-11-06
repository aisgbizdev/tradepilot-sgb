// Tier 3 push (task #142 C): one-shot, 24h-after-signup nudge that
// invites users who haven't built a watchlist yet to add their first
// instrument. Hard-capped to a single delivery ever per user via the
// `onboardingNudgeSentAt` column (stamped after a successful send).

import { db } from "./db";
import { users, watchlistItems } from "@workspace/db/schema";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { alreadyDelivered, withinQuietHours } from "./notification-guards";

const CATEGORY = "onboarding";
const POST_SIGNUP_DELAY_MS = 24 * 60 * 60 * 1000; // 24h

interface DispatchStats {
  candidates: number;
  sent: number;
  suppressedHasWatchlist: number;
  suppressedQuiet: number;
  suppressedAlready: number;
}

/**
 * One-shot dispatcher. Selects users whose `createdAt` is ≥24h old,
 * who haven't received the onboarding nudge yet (`onboardingNudgeSentAt
 * IS NULL`), who haven't opted out, and who have an empty watchlist.
 * Stamps `onboardingNudgeSentAt` on send so the next tick skips them.
 */
export async function dispatchOnboardingNudges(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats: DispatchStats = {
    candidates: 0,
    sent: 0,
    suppressedHasWatchlist: 0,
    suppressedQuiet: 0,
    suppressedAlready: 0,
  };
  try {
    const cutoff = new Date(now.getTime() - POST_SIGNUP_DELAY_MS);
    const candidates = await db
      .select({
        id: users.id,
        dailySummaryTimezone: users.dailySummaryTimezone,
      })
      .from(users)
      .where(
        and(
          isNull(users.onboardingNudgeSentAt),
          eq(users.pushOnboarding, true),
          lte(users.createdAt, cutoff),
        ),
      );
    stats.candidates = candidates.length;

    for (const user of candidates) {
      // Empty-watchlist check, per user. A small COUNT keeps this
      // cheap even at scale because of the watchlist_items index on
      // (user_id, instrument).
      const [{ c }] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(watchlistItems)
        .where(eq(watchlistItems.userId, user.id));
      if (c > 0) {
        // Treat "has watchlist" as fulfillment of the onboarding goal —
        // stamp so we never try again even if they later clear it.
        await db
          .update(users)
          .set({ onboardingNudgeSentAt: now, updatedAt: new Date() })
          .where(eq(users.id, user.id));
        stats.suppressedHasWatchlist += 1;
        continue;
      }
      if (
        withinQuietHours({ dailySummaryTimezone: user.dailySummaryTimezone }, now)
      ) {
        stats.suppressedQuiet += 1;
        continue;
      }
      const dedupeKey = `onboarding:${user.id}`;
      if (await alreadyDelivered(dedupeKey)) {
        stats.suppressedAlready += 1;
        // Backfill the stamp so we don't keep retrying.
        await db
          .update(users)
          .set({ onboardingNudgeSentAt: now, updatedAt: new Date() })
          .where(eq(users.id, user.id));
        continue;
      }
      const title = "Tambah pair favoritmu 👇";
      const body =
        "Tambahin pair favorit ke watchlist biar TradePilot bisa kirim info pasar yang relevan ke kamu →";
      const created = await createNotification(
        user.id,
        { title, message: body, type: "info", category: CATEGORY, dedupeKey },
        { title, body, url: "/watchlist", tag: `onboarding-${user.id}` },
      );
      if (!created) {
        stats.suppressedAlready += 1;
        continue;
      }
      await db
        .update(users)
        .set({ onboardingNudgeSentAt: now, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      stats.sent += 1;
    }
    if (stats.sent > 0 || stats.candidates > 0) {
      logger.info(stats, "dispatchOnboardingNudges tick");
    }
    return stats;
  } catch (err) {
    logger.error(err, "dispatchOnboardingNudges failed");
    return stats;
  }
}
