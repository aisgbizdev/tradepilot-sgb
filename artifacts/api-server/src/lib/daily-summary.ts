import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  analyses,
  dailyDigests,
  users,
  aiTokenUsage,
  type Analysis,
  type DailyDigest,
} from "@workspace/db/schema";
import { db } from "./db";
import { logger } from "./logger";
import { generateAnalysis, getValidUntil, type ProAIOutput } from "./openai";
import { estimateCostUsd } from "./model-pricing";
import { createNotification } from "./create-notification";

// Default instrument basket used when the user has no watchlist (or the
// watchlist table hasn't shipped yet). Picked for breadth: a major FX
// pair, a precious metal, and a high-vol crypto so any trader gets
// something relevant in the morning digest. Order matters — it's the
// order they appear in the push + landing page.
const DEFAULT_INSTRUMENTS = ["XAU/USD", "EUR/USD", "BTC/USD"] as const;

// Timeframe + mode the scheduler uses when it has to GENERATE a fresh
// analysis (vs. reusing a recent one). `1h` is the sweet spot for a
// once-a-day morning read — long enough to outlive the morning session,
// short enough to surface intraday setups. Mode selection was retired
// app-wide in favor of pro-only.
const DIGEST_TIMEFRAME = "1h";
const DIGEST_MODE: "beginner" | "pro" = "pro";

// Re-use any same-instrument analysis the user already has within the
// last N hours instead of burning quota on a fresh one. Chosen to be
// long enough to span a typical overnight gap but short enough that
// the levels still resemble live price action.
const REUSE_WINDOW_MS = 6 * 60 * 60 * 1000;

// Hard cap matching the AI quota wired into POST /analyses (see the naming
// drift note there — this is now a one-time LIFETIME allowance, never a
// recurring window, despite the name). Defined locally rather than
// imported so a future change to the analyses route's per-call limits
// doesn't silently change digest semantics — but see chat (2026-09-30):
// this had drifted from the real quota anyway (still a rolling 24h check
// against a hardcoded 20, while the real quota had its own
// admin-configurable value), which meant this digest was generating real,
// uncapped, uncounted AI analyses for every instrument in every user's
// daily summary regardless of their actual quota state — a real hidden
// cost source. Kept in sync with the same default (5) so it can no longer
// drift silently like that again.
const ANALYSIS_QUOTA_PER_DAY = Number(process.env["ANALYSIS_QUOTA_PER_DAY"] ?? 5);

export type DigestKind = "full" | "quota_only";

export interface DailySummarySettings {
  enabled: boolean;
  time: string;
  timezone: string;
  pushDailySummary: boolean;
}

// Format a Date into YYYY-MM-DD + HH:MM in the given IANA timezone.
// Uses Intl.DateTimeFormat so we don't pull in a heavy date lib and
// don't have to think about DST edge cases ourselves. Returns null if
// the timezone string is invalid (defensive — settings are validated on
// write but legacy rows or a bad migration shouldn't crash the worker).
export function getLocalDateTime(
  now: Date,
  timezone: string,
): { date: string; hhmm: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    // `en-CA` returns hour as "24" at midnight in some runtimes; normalise.
    const rawHour = get("hour") === "24" ? "00" : get("hour");
    const hhmm = `${rawHour}:${get("minute")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
    return { date, hhmm };
  } catch {
    return null;
  }
}

// True when the user's local time has reached (or passed) their
// scheduled HH:MM AND we haven't already sent a digest today. The "or
// passed" half lets the scheduler catch up if the worker was down at
// the exact minute the digest was supposed to fire.
function shouldDispatchNow(
  scheduled: string,
  local: { date: string; hhmm: string },
  lastSentDate: string | null,
): boolean {
  if (lastSentDate === local.date) return false;
  return local.hhmm >= scheduled;
}

// Quota check matching POST /analyses' rules. We do this OUTSIDE the
// per-user transaction so we can decide between `full` and `quota_only`
// digests without holding any locks. Lifetime count, no time window — the
// free allowance is a one-time cap, not a recurring one (see the note on
// ANALYSIS_QUOTA_PER_DAY above).
async function hasQuotaLeft(userId: number): Promise<boolean> {
  const [usage] = await db
    .select({ daily: count() })
    .from(analyses)
    .where(eq(analyses.userId, userId));
  const daily = Number(usage?.daily ?? 0);
  return daily < ANALYSIS_QUOTA_PER_DAY;
}

// Pick the analysis to surface for one instrument. Reuse a recent one
// if we have it; otherwise generate (when allowed). Returns null when
// neither reuse nor generation succeeded — the caller drops the
// instrument from the digest rather than surfacing a stale weeks-old
// row.
async function resolveAnalysisForInstrument(
  userId: number,
  instrument: string,
  canGenerate: boolean,
): Promise<Analysis | null> {
  const cutoff = new Date(Date.now() - REUSE_WINDOW_MS);
  const [recent] = await db
    .select()
    .from(analyses)
    .where(
      and(
        eq(analyses.userId, userId),
        eq(analyses.instrument, instrument),
        gte(analyses.createdAt, cutoff),
      ),
    )
    .orderBy(desc(analyses.createdAt))
    .limit(1);
  if (recent) return recent;

  if (!canGenerate) {
    // Quota exhausted — fall back to the absolute newest analysis the
    // user has for this instrument, even if it's older than the reuse
    // window. Better to show "this is what you last got" than nothing
    // at all for a quota-only digest.
    const [anyExisting] = await db
      .select()
      .from(analyses)
      .where(and(eq(analyses.userId, userId), eq(analyses.instrument, instrument)))
      .orderBy(desc(analyses.createdAt))
      .limit(1);
    return anyExisting ?? null;
  }

  try {
    const { output: aiResult, usage: tokenUsage, model: usedModel } = await generateAnalysis(
      instrument,
      DIGEST_TIMEFRAME,
      DIGEST_MODE,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // selectedTimeframePrice — digest doesn't capture a candle snapshot
      "free", // digest generations never consume a credit — pure giveaway cost.
    );
    const validUntil = getValidUntil(DIGEST_TIMEFRAME);
    const [inserted] = await db
      .insert(analyses)
      .values({
        userId,
        instrument,
        timeframe: DIGEST_TIMEFRAME,
        mode: DIGEST_MODE,
        userInputContext: null,
        rawAiOutput: JSON.stringify(aiResult),
        validUntil,
        marketCondition: aiResult.marketCondition,
        riskLevel: aiResult.riskLevel,
        confidenceMin: aiResult.confidenceMin,
        confidenceMax: aiResult.confidenceMax,
        tradingBias: aiResult.tradingBias,
        opportunity: aiResult.opportunity,
        risk: aiResult.risk,
        tradePlan: aiResult.tradePlan ?? null,
        // Pro-mode narrative fields — matches what POST /analyses does
        // for the same shape.
        baseCase: (aiResult as ProAIOutput).baseCase,
        bullishScenario: (aiResult as ProAIOutput).bullishScenario,
        bearishScenario: (aiResult as ProAIOutput).bearishScenario,
        keyDriversTechnical: (aiResult as ProAIOutput).keyDriversTechnical,
        keyDriversFundamental: (aiResult as ProAIOutput).keyDriversFundamental,
        marketContext: (aiResult as ProAIOutput).marketContext,
        invalidationConditions: (aiResult as ProAIOutput).invalidationConditions,
        uncertaintyNotes: (aiResult as ProAIOutput).uncertaintyNotes,
      })
      .returning();
    await db.insert(aiTokenUsage).values({
      userId,
      analysisId: inserted.id,
      model: usedModel,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      totalTokens: tokenUsage.totalTokens,
      callCount: tokenUsage.callCount,
      estimatedCostUsd: estimateCostUsd(usedModel, tokenUsage.promptTokens, tokenUsage.completionTokens).toFixed(6),
      instrument,
      timeframe: DIGEST_TIMEFRAME,
    }).catch((err) => {
      logger.warn({ err }, "[daily-summary] failed to record AI token usage");
    });
    return inserted;
  } catch (err) {
    logger.warn({ err, userId, instrument }, "Daily digest analysis generation failed");
    return null;
  }
}

// Compact one-line bias hint per instrument for the push body. Trade
// bias enum values come straight from the AI; "wait" / no plan rows
// fall back to bias alone.
function instrumentBlurb(a: Analysis): string {
  const bias = a.tradingBias ?? "neutral";
  const side = (a.tradePlan as { preferredSide?: string } | null)?.preferredSide;
  if (side === "wait" || !side) return `${a.instrument}: ${bias}`;
  return `${a.instrument}: ${bias} (${side})`;
}

// Resolve the digest for one user. Idempotent on (userId, localDate)
// via the unique index on `daily_digests`. Returns the persisted row,
// or null when we skipped (already sent / nothing to send).
export async function dispatchDigestForUser(
  user: {
    id: number;
    dailySummaryTime: string;
    dailySummaryTimezone: string;
    dailySummaryLastSentDate: string | null;
    pushDailySummary: boolean;
  },
  now: Date = new Date(),
): Promise<DailyDigest | null> {
  const local = getLocalDateTime(now, user.dailySummaryTimezone);
  if (!local) {
    logger.warn(
      { userId: user.id, tz: user.dailySummaryTimezone },
      "Daily summary: invalid timezone, skipping",
    );
    return null;
  }
  if (!shouldDispatchNow(user.dailySummaryTime, local, user.dailySummaryLastSentDate)) {
    return null;
  }

  // Watchlist hook — when the watchlist table lands (task #109) we'll
  // swap in user-specific instruments here. Defaults until then.
  const instruments = DEFAULT_INSTRUMENTS.slice();

  const canGenerate = await hasQuotaLeft(user.id);
  const kind: DigestKind = canGenerate ? "full" : "quota_only";

  const resolved: { instrument: string; analysis: Analysis }[] = [];
  for (const instrument of instruments) {
    const a = await resolveAnalysisForInstrument(user.id, instrument, canGenerate);
    if (a) resolved.push({ instrument, analysis: a });
  }

  if (resolved.length === 0) {
    // Nothing to send — don't write a digest row so we'll retry on the
    // next scheduler tick (still bounded by `shouldDispatchNow`'s
    // "today already done" guard via lastSentDate; we only set that
    // once we have something to send).
    logger.info({ userId: user.id }, "Daily summary: no analyses available, skipping");
    return null;
  }

  const summary = resolved.map((r) => instrumentBlurb(r.analysis)).join(" • ");

  // Insert + last-sent stamp in a single transaction so a crash between
  // the two can't double-send. The unique index also catches any race
  // between two scheduler ticks landing the same minute.
  try {
    const digest = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(dailyDigests)
        .values({
          userId: user.id,
          digestDate: local.date,
          kind,
          instruments: resolved.map((r) => r.instrument),
          analysisIds: resolved.map((r) => r.analysis.id),
          summary,
        })
        .returning();
      await tx
        .update(users)
        .set({ dailySummaryLastSentDate: local.date, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      return row;
    });

    // Send push + in-app notification. Honors the alert-type opt-out:
    // when `pushDailySummary` is false the OS push is suppressed but
    // the in-app notification still lands so the user can see today's
    // digest on next app open. `/daily-summary` is the deep-link target.
    const title =
      kind === "quota_only"
        ? "Ringkasan Harian (kuota habis)"
        : "Ringkasan Harian TradePilot.id";
    await createNotification(
      user.id,
      { title, message: summary, type: "info" },
      user.pushDailySummary
        ? {
            title: "Ringkasan Harian ☀️",
            body: summary,
            url: "/daily-summary",
            tag: `daily-summary-${local.date}`,
          }
        : null,
    );

    logger.info(
      { userId: user.id, digestDate: local.date, kind, count: resolved.length },
      "Daily summary digest sent",
    );
    return digest;
  } catch (err) {
    // Unique-violation is benign: another tick beat us to it. Anything
    // else is a real error worth logging.
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      logger.debug({ userId: user.id, digestDate: local.date }, "Daily summary already sent (race)");
      return null;
    }
    logger.error({ err, userId: user.id }, "Failed to persist daily digest");
    return null;
  }
}

// Top-level scheduler entry. Walks every user with the daily summary
// enabled and dispatches when their local time has reached the
// scheduled minute. Kept sequential so a slow OpenAI call for one user
// doesn't stack up parallel requests against the AI rate limit.
export async function dispatchDailySummaries(): Promise<void> {
  const candidates = await db
    .select({
      id: users.id,
      dailySummaryTime: users.dailySummaryTime,
      dailySummaryTimezone: users.dailySummaryTimezone,
      dailySummaryLastSentDate: users.dailySummaryLastSentDate,
      pushDailySummary: users.pushDailySummary,
    })
    .from(users)
    .where(eq(users.dailySummaryEnabled, true));

  if (candidates.length === 0) return;
  const now = new Date();
  for (const u of candidates) {
    try {
      await dispatchDigestForUser(u, now);
    } catch (err) {
      logger.error({ err, userId: u.id }, "Daily summary dispatch failed for user");
    }
  }
}

export async function getTodayDigest(
  userId: number,
  timezone: string,
): Promise<{ digest: DailyDigest | null; analyses: Analysis[] }> {
  const local = getLocalDateTime(new Date(), timezone);
  if (!local) return { digest: null, analyses: [] };
  const [digest] = await db
    .select()
    .from(dailyDigests)
    .where(and(eq(dailyDigests.userId, userId), eq(dailyDigests.digestDate, local.date)))
    .limit(1);
  if (!digest) return { digest: null, analyses: [] };
  const ids = digest.analysisIds ?? [];
  if (ids.length === 0) return { digest, analyses: [] };
  const rows = await db
    .select()
    .from(analyses)
    .where(and(eq(analyses.userId, userId), inArray(analyses.id, ids)));
  // Preserve digest's instrument-order rather than DB return order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((a): a is Analysis => !!a);
  return { digest, analyses: ordered };
}
