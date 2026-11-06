// Tier 1 push dispatchers (task #140): high-impact news for watchlist
// instruments, and 30-min-out reminders for high-impact calendar
// events relevant to those instruments. Every send goes through the
// shared anti-annoyance guards in `lib/notification-guards.ts`.

import { db } from "./db";
import { users, watchlistItems } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { getRelevantNews, type NewsItem } from "./news";
import { getAllCalendarThisWeek, type CalendarEvent } from "./calendar";
import {
  alreadyDelivered,
  batchSimilar,
  respectFrequencyCap,
  withinQuietHours,
} from "./notification-guards";

const NEWS_CATEGORY = "market_news";
const CALENDAR_CATEGORY = "calendar_event";

const NEWS_PER_DAY_CAP = 5;
const CALENDAR_PER_DAY_CAP = 3;

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const BATCH_WINDOW_MS = 10 * 60 * 1000;

// Reuse the same macro pattern news.ts already trusts as the
// "market-moving" filter. Keeping it in sync via a re-import would
// require exporting it; mirroring it here is fine — both files cite
// each other so any future widening stays close together.
const HIGH_IMPACT_PATTERN =
  /\b(fomc|fed\b|federal\s+reserve|cpi|nfp|non[\s-]?farm|inflation|inflasi|rate\s+(?:cut|hike|decision)|interest\s+rate|payroll|gdp|ppi|ecb|boj|bank\s+of\s+japan|opec|geopolitik|geopolitical|war|perang|sanctions|sanksi)\b/i;

interface WatchlistUser {
  id: number;
  pushMarketNews: boolean;
  pushCalendarEvents: boolean;
  dailySummaryTimezone: string | null;
  instruments: string[];
}

async function loadWatchlistUsers(): Promise<WatchlistUser[]> {
  const items = await db
    .select({
      userId: watchlistItems.userId,
      instrument: watchlistItems.instrument,
    })
    .from(watchlistItems);
  if (items.length === 0) return [];

  const byUser = new Map<number, string[]>();
  for (const it of items) {
    const list = byUser.get(it.userId) ?? [];
    list.push(it.instrument);
    byUser.set(it.userId, list);
  }

  const userIds = Array.from(byUser.keys());
  const prefs = await db
    .select({
      id: users.id,
      pushMarketNews: users.pushMarketNews,
      pushCalendarEvents: users.pushCalendarEvents,
      dailySummaryTimezone: users.dailySummaryTimezone,
    })
    .from(users)
    .where(inArray(users.id, userIds));

  return prefs.map((u) => ({
    id: u.id,
    pushMarketNews: u.pushMarketNews,
    pushCalendarEvents: u.pushCalendarEvents,
    dailySummaryTimezone: u.dailySummaryTimezone ?? null,
    instruments: byUser.get(u.id) ?? [],
  }));
}

/**
 * Pure helper exported for tests: a news item is "high-impact" when
 * the title (or summary) hits the macro keyword pattern. Yahoo's RSS
 * doesn't carry an explicit impact field; we rely on the keyword
 * heuristic until upstream gives us something better.
 */
export function isHighImpactNews(item: NewsItem): boolean {
  return HIGH_IMPACT_PATTERN.test(`${item.title} ${item.summary}`);
}

/**
 * Pure helper exported for tests: is this calendar event a 3-star,
 * 25–35-minute-out release relative to `now`? Returns the parsed
 * release timestamp on success so the caller can include it in the
 * dedupe key, or null when the event doesn't qualify.
 */
export function calendarReminderTimestamp(
  event: CalendarEvent,
  now: Date = new Date(),
): number | null {
  if (event.impact !== "★★★") return null;
  if (!event.date || !event.time) return null;
  // Use the absolute UTC instant the normalizer attached so this
  // matches the pre-trade-warning chip on the Analyze page and is
  // independent of `process.env.TZ`.
  const ts = event.epochMs;
  if (ts === null || !Number.isFinite(ts)) return null;
  const diff = ts - now.getTime();
  // 25–35-minute window. Tight enough that we don't fire repeatedly
  // for the same event across multiple ticks, wide enough that a 5-min
  // job cadence catches it at least once.
  if (diff < 25 * 60 * 1000 || diff > 35 * 60 * 1000) return null;
  return ts;
}

interface DispatchStats {
  candidates: number;
  sent: number;
  suppressedQuiet: number;
  suppressedCap: number;
  suppressedDedupe: number;
  suppressedOptOut: number;
}

function emptyStats(): DispatchStats {
  return {
    candidates: 0,
    sent: 0,
    suppressedQuiet: 0,
    suppressedCap: 0,
    suppressedDedupe: 0,
    suppressedOptOut: 0,
  };
}

export async function dispatchWatchlistNewsAlerts(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats = emptyStats();
  try {
    const watchUsers = await loadWatchlistUsers();
    if (watchUsers.length === 0) return stats;

    // Collect the union of instruments across all users so we fetch
    // each upstream feed once per tick instead of once per user.
    const allInstruments = new Set<string>();
    for (const u of watchUsers) for (const sym of u.instruments) allInstruments.add(sym);

    const newsByInstrument = new Map<string, NewsItem[]>();
    await Promise.all(
      Array.from(allInstruments).map(async (sym) => {
        try {
          const items = await getRelevantNews(sym, 8);
          newsByInstrument.set(sym, items.filter(isHighImpactNews));
        } catch (err) {
          logger.warn({ err, instrument: sym }, "news fetch failed for watchlist alert");
        }
      }),
    );

    for (const user of watchUsers) {
      if (!user.pushMarketNews) {
        stats.suppressedOptOut += 1;
        continue;
      }
      if (withinQuietHours(user, now)) {
        stats.suppressedQuiet += 1;
        continue;
      }

      // Outer guard: per-user daily cap so a user with 10 watchlist
      // symbols can't blow past 5 news pings in a day.
      // Inner guard: per-instrument hourly cap is enforced atomically
      // via dedupeKey `news:<userId>:<instrument>:<hourBucket>` — the
      // unique index on notifications.dedupeKey makes a second insert
      // within the same hour bucket a no-op, so we never need a
      // separate counter row that would leak to the user's inbox.
      const hourBucket = Math.floor(now.getTime() / ONE_HOUR_MS);
      for (const instrument of user.instruments) {
        const items = newsByInstrument.get(instrument) ?? [];
        if (items.length === 0) continue;
        stats.candidates += items.length;

        const daily = await respectFrequencyCap(
          user.id,
          NEWS_CATEGORY,
          ONE_DAY_MS,
          NEWS_PER_DAY_CAP,
        );
        if (!daily.allowed) {
          stats.suppressedCap += 1;
          break; // No more news today, no point checking other symbols.
        }

        // Batch near-duplicate items (same instrument, within 10 min)
        // so a burst of related headlines becomes one push.
        const groups = batchSimilar(
          items.map((it) => ({
            key: instrument,
            timestamp: new Date(it.publishedAt).getTime(),
            payload: it,
          })),
          BATCH_WINDOW_MS,
        );
        // Pick the freshest group, then the freshest item inside it as
        // the headline; if the group has >1 item we render a summary.
        const sorted = groups
          .map((g) => ({
            items: (g.items as { payload: NewsItem }[])
              .map((x) => x.payload)
              .sort(
                (a, b) =>
                  new Date(b.publishedAt).getTime() -
                  new Date(a.publishedAt).getTime(),
              ),
          }))
          .sort(
            (a, b) =>
              new Date(b.items[0]!.publishedAt).getTime() -
              new Date(a.items[0]!.publishedAt).getTime(),
          );
        const group = sorted[0]!;
        const lead = group.items[0]!;
        const headline =
          lead.title.length > 110 ? `${lead.title.slice(0, 107)}…` : lead.title;
        const message =
          group.items.length > 1
            ? `${group.items.length} berita high-impact untuk ${instrument} — ${headline}`
            : headline;

        const dedupeKey = `news:${user.id}:${instrument}:${hourBucket}`;
        if (await alreadyDelivered(dedupeKey)) {
          stats.suppressedDedupe += 1;
          continue;
        }

        const created = await createNotification(
          user.id,
          {
            title: `📰 ${instrument}`,
            message,
            type: "info",
            category: NEWS_CATEGORY,
            dedupeKey,
          },
          {
            title: `📰 ${instrument}`,
            body: message,
            url: `/analyze?instrument=${encodeURIComponent(instrument)}`,
            tag: `market-news-${instrument}`,
          },
        );
        if (created) stats.sent += 1;
        else stats.suppressedDedupe += 1;
      }
    }

    logger.info(stats, "dispatchWatchlistNewsAlerts tick");
    return stats;
  } catch (err) {
    logger.error(err, "dispatchWatchlistNewsAlerts failed");
    return stats;
  }
}

const CALENDAR_INSTRUMENT_CURRENCIES: Record<string, string[]> = {
  "XAU/USD": ["USD", "GOLD"],
  "BRENT": ["USD", "OIL", "OPEC"],
  "EUR/USD": ["EUR", "USD"],
  "GBP/USD": ["GBP", "USD"],
  "USD/JPY": ["JPY", "USD"],
  "USD/IDR": ["IDR", "USD"],
  "DXY": ["USD"],
  "AUD/USD": ["AUD", "USD"],
  "USD/CHF": ["CHF", "USD"],
  "HSI": ["CHN", "HKD"],
};

function watchlistMatchesEvent(
  instruments: string[],
  event: CalendarEvent,
): boolean {
  for (const sym of instruments) {
    const ccys = CALENDAR_INSTRUMENT_CURRENCIES[sym];
    if (ccys?.includes(event.currency)) return true;
  }
  return false;
}

export async function dispatchCalendarReminders(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats = emptyStats();
  try {
    const watchUsers = await loadWatchlistUsers();
    if (watchUsers.length === 0) return stats;

    let allEvents: CalendarEvent[] = [];
    try {
      allEvents = await getAllCalendarThisWeek();
    } catch (err) {
      logger.warn({ err }, "calendar fetch failed for reminders");
      return stats;
    }

    type ReminderCandidate = { event: CalendarEvent; ts: number };
    const candidates: ReminderCandidate[] = [];
    for (const e of allEvents) {
      const ts = calendarReminderTimestamp(e, now);
      if (ts !== null) candidates.push({ event: e, ts });
    }
    stats.candidates = candidates.length;
    if (candidates.length === 0) return stats;

    for (const user of watchUsers) {
      if (!user.pushCalendarEvents) {
        stats.suppressedOptOut += 1;
        continue;
      }
      if (withinQuietHours(user, now)) {
        stats.suppressedQuiet += 1;
        continue;
      }

      for (const { event, ts } of candidates) {
        if (!watchlistMatchesEvent(user.instruments, event)) continue;

        const daily = await respectFrequencyCap(
          user.id,
          CALENDAR_CATEGORY,
          ONE_DAY_MS,
          CALENDAR_PER_DAY_CAP,
        );
        if (!daily.allowed) {
          stats.suppressedCap += 1;
          break;
        }

        const dedupeKey = `calendar:${user.id}:${event.currency}:${event.event}:${ts}`;
        if (await alreadyDelivered(dedupeKey)) {
          stats.suppressedDedupe += 1;
          continue;
        }

        const forecastBit = event.forecast ? ` — prakiraan: ${event.forecast}` : "";
        const body = `${event.event} (${event.currency}) rilis ~30 menit lagi${forecastBit}.`;
        const created = await createNotification(
          user.id,
          {
            title: `⏰ ${event.event}`,
            message: body,
            type: "info",
            category: CALENDAR_CATEGORY,
            dedupeKey,
          },
          {
            title: `⏰ ${event.event}`,
            body,
            url: "/",
            tag: `calendar-${event.currency}-${event.event}`,
          },
        );
        if (created) stats.sent += 1;
        else stats.suppressedDedupe += 1;
      }
    }

    logger.info(stats, "dispatchCalendarReminders tick");
    return stats;
  } catch (err) {
    logger.error(err, "dispatchCalendarReminders failed");
    return stats;
  }
}
