// Personal Trader Mirror — weekly report dispatcher (task #162).
// Fires Sunday 20:00 user-local (one hour after the existing weekly
// market-recap so the two don't collide in the user's notification
// shade). Body is the top behavioural highlight; tap opens /mirror.
//
// Gated by the existing `pushWeeklyRecap` opt-out toggle — both jobs
// are "weekly summary push" preferences and we don't want to surface a
// separate switch in this iteration. Hard-capped to 1 delivery per ISO
// week via the dedupe key, same backstop pattern as weekly-recap.ts.

import { db } from "./db";
import { users } from "@workspace/db/schema";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { alreadyDelivered, withinQuietHours } from "./notification-guards";
import {
  localPartsInTimezone,
  isoWeekKey,
} from "./weekly-recap";
import { buildHighlights, computeTraderMirror, type Highlight } from "./trader-mirror";

const CATEGORY = "trader_mirror_report";
const DEFAULT_TIMEZONE = "Asia/Jakarta";

interface ReportUser {
  id: number;
  pushWeeklyRecap: boolean;
  dailySummaryTimezone: string | null;
  lang: string;
}

async function loadCandidates(): Promise<ReportUser[]> {
  const rows = await db
    .select({
      id: users.id,
      pushWeeklyRecap: users.pushWeeklyRecap,
      dailySummaryTimezone: users.dailySummaryTimezone,
      lang: users.lang,
    })
    .from(users);
  return rows.map((r) => ({
    id: r.id,
    pushWeeklyRecap: r.pushWeeklyRecap,
    dailySummaryTimezone: r.dailySummaryTimezone ?? null,
    lang: r.lang ?? "en",
  }));
}

export interface ReportBody {
  title: { en: string; id: string };
  body: { en: string; id: string };
  highlights: Highlight[];
}

export function buildReportMessage(highlights: Highlight[]): ReportBody | null {
  if (highlights.length === 0) return null;
  const top = highlights.slice(0, 3);
  return {
    title: {
      en: "🪞 Your weekly trader mirror",
      id: "🪞 Cermin trader mingguan kamu",
    },
    body: {
      en: top.map((h) => `• ${h.en}`).join("\n"),
      id: top.map((h) => `• ${h.id_}`).join("\n"),
    },
    highlights: top,
  };
}

interface DispatchStats {
  candidates: number;
  sent: number;
  suppressedOptOut: number;
  suppressedNoInsights: number;
  suppressedNotWindow: number;
  suppressedQuiet: number;
  suppressedDedupe: number;
}

function emptyStats(): DispatchStats {
  return {
    candidates: 0,
    sent: 0,
    suppressedOptOut: 0,
    suppressedNoInsights: 0,
    suppressedNotWindow: 0,
    suppressedQuiet: 0,
    suppressedDedupe: 0,
  };
}

export async function dispatchTraderMirrorReport(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats = emptyStats();
  try {
    const candidates = await loadCandidates();
    stats.candidates = candidates.length;

    for (const user of candidates) {
      if (!user.pushWeeklyRecap) {
        stats.suppressedOptOut += 1;
        continue;
      }
      const tz = user.dailySummaryTimezone || DEFAULT_TIMEZONE;
      const local = localPartsInTimezone(now, tz);
      // Sunday = 0, target hour = 20 (8pm local).
      if (local.weekday !== 0 || local.hour !== 20) {
        stats.suppressedNotWindow += 1;
        continue;
      }
      if (
        withinQuietHours({ dailySummaryTimezone: user.dailySummaryTimezone }, now)
      ) {
        stats.suppressedQuiet += 1;
        continue;
      }
      const weekKey = isoWeekKey(local);
      const dedupeKey = `trader_mirror_report:${user.id}:${weekKey}`;
      if (await alreadyDelivered(dedupeKey)) {
        stats.suppressedDedupe += 1;
        continue;
      }

      // 7-day window matches the "weekly trader report" framing — we
      // want this Sunday-evening push to reflect *this week's*
      // behaviour, not a rolling month average. The dashboard's
      // /mirror/insights endpoint still uses the all-time window.
      const insights = await computeTraderMirror(user.id, tz, { windowDays: 7, now });
      const highlights = buildHighlights(insights);
      const msg = buildReportMessage(highlights);
      if (!msg) {
        stats.suppressedNoInsights += 1;
        continue;
      }

      // Honour the user's chosen UI language (`users.lang`) for both
      // the in-app notification row and the push payload. Defaults to
      // EN when unset; the schema default is "en".
      const useId = user.lang === "id";
      const title = useId ? msg.title.id : msg.title.en;
      const body = useId ? msg.body.id : msg.body.en;
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
          url: "/mirror",
          tag: `trader-mirror-${weekKey}`,
        },
      );
      if (created) stats.sent += 1;
      else stats.suppressedDedupe += 1;
    }

    if (stats.sent > 0 || stats.candidates > 0) {
      logger.info(stats, "dispatchTraderMirrorReport tick");
    }
    return stats;
  } catch (err) {
    logger.error(err, "dispatchTraderMirrorReport failed");
    return stats;
  }
}
