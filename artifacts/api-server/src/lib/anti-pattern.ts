import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "./db";
import { analyses, tradeJournal, users } from "@workspace/db/schema";
import { getRelevantCalendar, type CalendarEvent } from "./calendar";

// Anti-pattern guardrail detection (task #163). Pure read-only helpers
// invoked by GET /api/analyses/guardrails. Each helper returns either
// the signal payload to render or null when nothing is wrong.
//
// Design choices:
//   * Soft only — every signal is informational. No endpoint here
//     blocks an action; the analyse endpoint is untouched. The UI is
//     responsible for surfacing the warning and letting the user click
//     "Analyse anyway".
//   * Defaults vs personalised — overtrading limits and the
//     "unusual hour" baseline both have hard defaults for new users
//     and graduate to personalised values once the user has enough
//     history. `personalized: true` on the signal lets the UI tell the
//     user "based on your own data".
//   * Cooling-off is opt-in. When the user opts in we read their most
//     recent journal entry; if it was a loss above the threshold within
//     the cool-off window we report `coolingOff.active = true` and let
//     the UI render a countdown. We never persist a "blocked until"
//     timestamp — the source of truth is the journal row itself.

const REVENGE_WINDOW_MIN = 5;
const OVERTRADING_DEFAULT_PER_HOUR = 5;
const OVERTRADING_DEFAULT_PER_DAY = 10;
const OVERTRADING_HISTORY_DAYS = 30;
const OVERTRADING_HISTORY_MIN = 30; // need ≥30 past analyses to personalise
const HIGH_RISK_EVENT_MIN = 30;
const COOLING_OFF_WINDOW_MIN = 30;
const COOLING_OFF_DEFAULT_LOSS_PCT = 1;
const UNUSUAL_HOUR_LOOKBACK_DAYS = 30;
const UNUSUAL_HOUR_HISTORY_MIN = 30;
const UNUSUAL_HOUR_FREQ_THRESHOLD = 0.03; // <3% of the user's past hours

export type GuardrailKind =
  | "revenge"
  | "overtrading"
  | "high_risk_window"
  | "unusual_hour"
  | "cooling_off";

export interface RevengeSignal {
  kind: "revenge";
  instrument: string;
  minutesSinceLoss: number;
  lossPnlPercent: string | null;
}

export interface OvertradingSignal {
  kind: "overtrading";
  scope: "hour" | "day";
  count: number;
  limit: number;
  /** True once the user has enough history for a personalised cap. */
  personalized: boolean;
}

export interface HighRiskSignal {
  kind: "high_risk_window";
  event: {
    name: string;
    currency: string;
    impact: string | null;
    epochMs: number;
  };
  minutesUntil: number;
}

export interface UnusualHourSignal {
  kind: "unusual_hour";
  hourUtc: number;
  pastFrequencyPct: number;
  sampleSize: number;
}

export interface CoolingOffSignal {
  kind: "cooling_off";
  untilEpochMs: number;
  minutesRemaining: number;
  lossPnlPercent: string | null;
  thresholdPct: number;
}

export type GuardrailSignal =
  | RevengeSignal
  | OvertradingSignal
  | HighRiskSignal
  | UnusualHourSignal
  | CoolingOffSignal;

export interface GuardrailPrefs {
  revenge: boolean;
  overtrading: boolean;
  highRisk: boolean;
  coolingOff: boolean;
}

export interface GuardrailDetectionResult {
  signals: GuardrailSignal[];
  prefs: GuardrailPrefs;
}

interface DetectOpts {
  now?: number;
}

async function loadPrefs(userId: number): Promise<GuardrailPrefs | null> {
  const [row] = await db
    .select({
      revenge: users.guardrailRevenge,
      overtrading: users.guardrailOvertrading,
      highRisk: users.guardrailHighRisk,
      coolingOff: users.coolingOffEnabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

async function detectRevenge(
  userId: number,
  instrument: string,
  now: number,
): Promise<RevengeSignal | null> {
  // A loss on the same instrument within the last N minutes is the
  // tightest, most defensible revenge signal. We deliberately scope to
  // the instrument so a loss on EUR/USD doesn't keep nagging the user
  // away from a planned XAU/USD setup.
  const cutoff = new Date(now - REVENGE_WINDOW_MIN * 60_000);
  const [row] = await db
    .select({
      tradedAt: tradeJournal.tradedAt,
      pnlPercent: tradeJournal.pnlPercent,
    })
    .from(tradeJournal)
    .where(
      and(
        eq(tradeJournal.userId, userId),
        eq(tradeJournal.instrument, instrument),
        eq(tradeJournal.outcome, "loss"),
        gte(tradeJournal.tradedAt, cutoff),
      ),
    )
    .orderBy(desc(tradeJournal.tradedAt))
    .limit(1);
  if (!row) return null;
  const minutesSinceLoss = Math.max(
    0,
    Math.floor((now - row.tradedAt.getTime()) / 60_000),
  );
  return {
    kind: "revenge",
    instrument,
    minutesSinceLoss,
    lossPnlPercent: row.pnlPercent ?? null,
  };
}

interface PersonalCaps {
  perHour: number;
  perDay: number;
  personalized: boolean;
}

/**
 * Personalise overtrading thresholds from the user's own last 30 days.
 * Rule: cap = max(default, ceil(avg-active-bucket × 2)). For low-history
 * users we keep the default. This gives habitual high-frequency users a
 * higher tolerance instead of nagging them every session, while still
 * flagging when *they* spike well above *their own* baseline.
 */
async function computeOvertradingCaps(
  userId: number,
  now: number,
): Promise<PersonalCaps> {
  const since = new Date(now - OVERTRADING_HISTORY_DAYS * 24 * 60 * 60_000);
  const rows = await db
    .select({ createdAt: analyses.createdAt })
    .from(analyses)
    .where(and(eq(analyses.userId, userId), gte(analyses.createdAt, since)));
  if (rows.length < OVERTRADING_HISTORY_MIN) {
    return {
      perHour: OVERTRADING_DEFAULT_PER_HOUR,
      perDay: OVERTRADING_DEFAULT_PER_DAY,
      personalized: false,
    };
  }
  const hourBuckets = new Map<string, number>();
  const dayBuckets = new Map<string, number>();
  for (const r of rows) {
    const ms = r.createdAt.getTime();
    const dayKey = String(Math.floor(ms / (24 * 60 * 60_000)));
    const hourKey = String(Math.floor(ms / (60 * 60_000)));
    dayBuckets.set(dayKey, (dayBuckets.get(dayKey) ?? 0) + 1);
    hourBuckets.set(hourKey, (hourBuckets.get(hourKey) ?? 0) + 1);
  }
  const avgPerActiveHour =
    [...hourBuckets.values()].reduce((a, b) => a + b, 0) /
    Math.max(1, hourBuckets.size);
  const avgPerActiveDay =
    [...dayBuckets.values()].reduce((a, b) => a + b, 0) /
    Math.max(1, dayBuckets.size);
  return {
    perHour: Math.max(OVERTRADING_DEFAULT_PER_HOUR, Math.ceil(avgPerActiveHour * 2)),
    perDay: Math.max(OVERTRADING_DEFAULT_PER_DAY, Math.ceil(avgPerActiveDay * 1.5)),
    personalized: true,
  };
}

async function detectOvertrading(
  userId: number,
  now: number,
): Promise<OvertradingSignal | null> {
  // Count *analyses* (not journal entries) so the signal fires for
  // habitual chart-reload users even if they don't always log a trade.
  const caps = await computeOvertradingCaps(userId, now);
  const hourAgo = new Date(now - 60 * 60_000);
  const dayAgo = new Date(now - 24 * 60 * 60_000);
  const [row] = await db
    .select({
      hourly: sql<number>`sum(case when ${analyses.createdAt} >= ${hourAgo} then 1 else 0 end)`,
      daily: sql<number>`sum(case when ${analyses.createdAt} >= ${dayAgo} then 1 else 0 end)`,
    })
    .from(analyses)
    .where(and(eq(analyses.userId, userId), gte(analyses.createdAt, dayAgo)));
  const hourlyCount = Number(row?.hourly ?? 0);
  const dailyCount = Number(row?.daily ?? 0);
  if (hourlyCount >= caps.perHour) {
    return {
      kind: "overtrading",
      scope: "hour",
      count: hourlyCount,
      limit: caps.perHour,
      personalized: caps.personalized,
    };
  }
  if (dailyCount >= caps.perDay) {
    return {
      kind: "overtrading",
      scope: "day",
      count: dailyCount,
      limit: caps.perDay,
      personalized: caps.personalized,
    };
  }
  return null;
}

async function detectHighRiskWindow(
  instrument: string,
  now: number,
): Promise<HighRiskSignal | null> {
  // Re-use the existing relevance filter so the warning lines up with
  // the events the pre-trade warning chip is already showing. We only
  // care about ★★★ items that have *not* yet printed (actual empty)
  // and whose absolute epoch is within HIGH_RISK_EVENT_MIN minutes.
  let events: CalendarEvent[] = [];
  try {
    events = await getRelevantCalendar(instrument, { maxItems: 12 });
  } catch {
    // Calendar lookups are best-effort. A flaky upstream feed should
    // never block the guardrails endpoint from returning the other
    // signals.
    return null;
  }
  const windowEnd = now + HIGH_RISK_EVENT_MIN * 60_000;
  const imminent = events
    .filter(
      (e) =>
        e.impact === "★★★" &&
        e.epochMs !== null &&
        !e.actual &&
        e.epochMs >= now &&
        e.epochMs <= windowEnd,
    )
    .sort((a, b) => (a.epochMs ?? 0) - (b.epochMs ?? 0));
  const first = imminent[0];
  if (!first || first.epochMs === null) return null;
  return {
    kind: "high_risk_window",
    event: {
      name: first.event,
      currency: first.currency,
      impact: first.impact,
      epochMs: first.epochMs,
    },
    minutesUntil: Math.max(0, Math.floor((first.epochMs - now) / 60_000)),
  };
}

/**
 * Fires when the user is analysing at a UTC hour they almost never
 * touch — proxy for "far outside their usual trading hours". Only runs
 * once the user has ≥30 historical analyses; new users get nothing
 * here. Gated behind the same `highRisk` pref as the event detector
 * since both answer the same user intent ("warn me about risky
 * windows").
 */
async function detectUnusualHour(
  userId: number,
  now: number,
): Promise<UnusualHourSignal | null> {
  const since = new Date(now - UNUSUAL_HOUR_LOOKBACK_DAYS * 24 * 60 * 60_000);
  const rows = await db
    .select({ createdAt: analyses.createdAt })
    .from(analyses)
    .where(and(eq(analyses.userId, userId), gte(analyses.createdAt, since)));
  if (rows.length < UNUSUAL_HOUR_HISTORY_MIN) return null;
  const counts = new Array<number>(24).fill(0);
  for (const r of rows) counts[r.createdAt.getUTCHours()]++;
  const currentHour = new Date(now).getUTCHours();
  const freq = counts[currentHour] / rows.length;
  if (freq >= UNUSUAL_HOUR_FREQ_THRESHOLD) return null;
  return {
    kind: "unusual_hour",
    hourUtc: currentHour,
    pastFrequencyPct: Math.round(freq * 1000) / 10, // one decimal
    sampleSize: rows.length,
  };
}

async function detectCoolingOff(
  userId: number,
  now: number,
): Promise<CoolingOffSignal | null> {
  // Cooling-off looks at the user's *most recent* journal entry across
  // any instrument. If that entry is a loss above the configured
  // threshold and happened within the cooling-off window, the user
  // sees a non-blocking countdown until the window expires.
  const [row] = await db
    .select({
      tradedAt: tradeJournal.tradedAt,
      outcome: tradeJournal.outcome,
      pnlPercent: tradeJournal.pnlPercent,
    })
    .from(tradeJournal)
    .where(eq(tradeJournal.userId, userId))
    .orderBy(desc(tradeJournal.tradedAt))
    .limit(1);
  if (!row || row.outcome !== "loss" || !row.pnlPercent) return null;
  // pnlPercent is stored as text; the user may type "1.5" or "-1.5"
  // depending on whether they treat losses as signed. Take the absolute
  // value of the numeric portion to be safe.
  const numeric = Math.abs(Number.parseFloat(row.pnlPercent));
  if (!Number.isFinite(numeric)) return null;
  if (numeric < COOLING_OFF_DEFAULT_LOSS_PCT) return null;
  const lossEpoch = row.tradedAt.getTime();
  const untilEpochMs = lossEpoch + COOLING_OFF_WINDOW_MIN * 60_000;
  if (untilEpochMs <= now) return null;
  return {
    kind: "cooling_off",
    untilEpochMs,
    minutesRemaining: Math.max(0, Math.ceil((untilEpochMs - now) / 60_000)),
    lossPnlPercent: row.pnlPercent,
    thresholdPct: COOLING_OFF_DEFAULT_LOSS_PCT,
  };
}

export async function detectGuardrailSignals(
  userId: number,
  instrument: string,
  opts: DetectOpts = {},
): Promise<GuardrailDetectionResult | null> {
  const prefs = await loadPrefs(userId);
  if (!prefs) return null;
  const now = opts.now ?? Date.now();
  const signals: GuardrailSignal[] = [];

  // Each detector only runs when the corresponding opt-in is true. We
  // *do* still surface cooling-off telemetry through the existing
  // analyse flow even when the toggle is off; the toggle just controls
  // whether the countdown is shown here.
  const [revenge, overtrading, highRisk, unusualHour, coolingOff] =
    await Promise.all([
      prefs.revenge ? detectRevenge(userId, instrument, now) : Promise.resolve(null),
      prefs.overtrading ? detectOvertrading(userId, now) : Promise.resolve(null),
      prefs.highRisk ? detectHighRiskWindow(instrument, now) : Promise.resolve(null),
      prefs.highRisk ? detectUnusualHour(userId, now) : Promise.resolve(null),
      prefs.coolingOff ? detectCoolingOff(userId, now) : Promise.resolve(null),
    ]);
  if (revenge) signals.push(revenge);
  if (overtrading) signals.push(overtrading);
  if (highRisk) signals.push(highRisk);
  if (unusualHour) signals.push(unusualHour);
  if (coolingOff) signals.push(coolingOff);

  return { signals, prefs };
}

export const GUARDRAIL_KINDS: readonly GuardrailKind[] = [
  "revenge",
  "overtrading",
  "high_risk_window",
  "unusual_hour",
  "cooling_off",
] as const;
