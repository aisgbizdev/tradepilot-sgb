import { Router } from "express";
import { db } from "../lib/db";
import { analyses, feedback, users, aiTokenUsage } from "@workspace/db/schema";
import { eq, and, or, desc, count, sql, gte, lte, ilike, inArray, notInArray } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";
import {
  generateAnalysis,
  getValidUntil,
  citationMatchesAny,
  type AIOutput,
  type BeginnerAIOutput,
  type ProAIOutput,
  type FundamentalSnapshot,
  type AnalysisTokenUsage,
} from "../lib/openai";
import {
  OTHER_INSTRUMENT_BUCKET_KEY,
  PRIMARY_INSTRUMENTS,
} from "@workspace/instrument-taxonomy";
import { estimateCostUsd } from "../lib/model-pricing";
import { getCandleSnapshot, getIndicators, formatIndicatorsForPrompt, isSupportedIndicatorTimeframe, type IndicatorTimeframe } from "../lib/historical";
import { getLivePriceFor } from "../lib/live-prices";
import { VERIFIED_ANALYSIS_INSTRUMENTS, VERIFIED_OTHER_INSTRUMENTS } from "../lib/verified-instruments";
import {
  getRelevantNews,
  formatNewsForPrompt,
  type NewsItem,
  _clearNewsmakerCache,
} from "../lib/news";
import { _clearYahooCache } from "../lib/news-yahoo";
import {
  getRelevantCalendar,
  formatCalendarForPrompt,
  type CalendarEvent,
  _clearCalendarCache,
} from "../lib/calendar";
import { createNotification, createNotificationsForUsers } from "../lib/create-notification";
import { logger } from "../lib/logger";
import {
  armAlertsForAnalysis,
  cancelAlertsForAnalysis,
  getAlertStatusForAnalysis,
  userHasPushSubscription,
} from "../lib/price-alerts";
import { maybeDispatchSignalFlip } from "../lib/signal-flip";
import { resetDormancyStreak } from "../lib/dormancy";
import { detectGuardrailSignals, GUARDRAIL_KINDS, type GuardrailKind } from "../lib/anti-pattern";
import { guardrailEvents } from "@workspace/db/schema";
import { z } from "zod";
// XP policy (see chat 2026-09-30): always award on feedback, no minimum
// note-length gate, no revoke-on-downgrade — merged in from devv-psr.
import { awardProgression, riskWaitSourceEventId } from "../lib/progression";
// The free-timeframe-switch credit bonus stays reverted (explicit prior
// decision, see chat) — consumeFreeTimeframeSwitch/isEligibleForFreeTimeframeSwitch
// deliberately not re-imported even though devv-psr still has them.
import { applyCreditLedgerEntry, CREDIT_BALANCE_LOCK_NAMESPACE, getCreditBalanceForUser } from "../lib/credits";

let aiErrorCount = 0;
let aiErrorWindowStart = Date.now();
const AI_ERROR_THRESHOLD = 3;
const AI_ERROR_WINDOW_MS = 60 * 60 * 1000;

async function trackAiError(): Promise<void> {
  const now = Date.now();
  if (now - aiErrorWindowStart > AI_ERROR_WINDOW_MS) {
    aiErrorCount = 0;
    aiErrorWindowStart = now;
  }
  aiErrorCount += 1;
  if (aiErrorCount >= AI_ERROR_THRESHOLD) {
    aiErrorCount = 0;
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.role} IN ('admin', 'super_admin')`);
    if (admins.length > 0) {
      const errorTitle = "Peringatan: Error AI Berulang";
      const errorMessage = `Lebih dari ${AI_ERROR_THRESHOLD} kegagalan analisis AI terjadi dalam 1 jam terakhir. Periksa koneksi dan konfigurasi AI.`;
      await createNotificationsForUsers(
        admins.map((a) => a.id),
        { title: errorTitle, message: errorMessage, type: "error" },
        { url: "/notifications", tag: "ai-error-alert" },
      );
    }
  }
}

const router = Router();

router.get("/analyses/summary", requireAuth, async (req: AuthRequest, res) => {
  const [result] = await db
    .select({
      total: count(analyses.id),
      beginnerCount: sql<number>`sum(case when ${analyses.mode} = 'beginner' then 1 else 0 end)`,
      proCount: sql<number>`sum(case when ${analyses.mode} = 'pro' then 1 else 0 end)`,
      avgConfidenceMin: sql<number>`avg(${analyses.confidenceMin})`,
      avgConfidenceMax: sql<number>`avg(${analyses.confidenceMax})`,
    })
    .from(analyses)
    .where(eq(analyses.userId, req.userId!));

  res.json({
    totalAnalyses: Number(result.total),
    beginnerCount: Number(result.beginnerCount ?? 0),
    proCount: Number(result.proCount ?? 0),
    avgConfidenceMin: result.avgConfidenceMin ? Number(result.avgConfidenceMin) : null,
    avgConfidenceMax: result.avgConfidenceMax ? Number(result.avgConfidenceMax) : null,
    recentAnalyses: [],
  });
});

router.get("/analyses/outcomes-summary", requireAuth, async (req: AuthRequest, res) => {
  // Roll-up of the background outcome resolver over the last 30 days.
  // Drives the "AI accuracy" card on the dashboard so the user can see
  // how often the AI's plans actually reached TP vs got stopped out.
  // We deliberately count `invalidated` separately (unparseable / broken
  // plans) so an unreliable-input row doesn't pollute the accuracy %.
  const RANGE_DAYS = 30;
  const since = new Date(Date.now() - RANGE_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      total: count(analyses.id),
      pending: sql<number>`sum(case when ${analyses.outcomeStatus} = 'pending' then 1 else 0 end)`,
      tp1: sql<number>`sum(case when ${analyses.outcomeStatus} = 'tp1_hit' then 1 else 0 end)`,
      tp2: sql<number>`sum(case when ${analyses.outcomeStatus} = 'tp2_hit' then 1 else 0 end)`,
      sl: sql<number>`sum(case when ${analyses.outcomeStatus} = 'sl_hit' then 1 else 0 end)`,
      expired: sql<number>`sum(case when ${analyses.outcomeStatus} = 'expired' then 1 else 0 end)`,
      invalidated: sql<number>`sum(case when ${analyses.outcomeStatus} = 'invalidated' then 1 else 0 end)`,
    })
    .from(analyses)
    .where(
      and(
        eq(analyses.userId, req.userId!),
        gte(analyses.createdAt, since),
      ),
    );

  const total = Number(row?.total ?? 0);
  const pending = Number(row?.pending ?? 0);
  const tp1 = Number(row?.tp1 ?? 0);
  const tp2 = Number(row?.tp2 ?? 0);
  const sl = Number(row?.sl ?? 0);
  const expired = Number(row?.expired ?? 0);
  const invalidated = Number(row?.invalidated ?? 0);
  // Accuracy denominator: only resolved + scorable rows. Excludes pending
  // (not yet known) and invalidated (plan was unparseable, AI's fault but
  // not a directional miss).
  const scored = tp1 + tp2 + sl + expired;
  const tpHitRate = scored > 0 ? (tp1 + tp2) / scored : null;
  const slHitRate = scored > 0 ? sl / scored : null;

  res.json({
    rangeDays: RANGE_DAYS,
    total,
    pending,
    tp1Hit: tp1,
    tp2Hit: tp2,
    slHit: sl,
    expired,
    invalidated,
    scored,
    tpHitRate,
    slHitRate,
  });
});

router.get("/analyses/history-summary", requireAuth, async (req: AuthRequest, res) => {
  const rangeRaw = String(req.query["range"] ?? "30");
  const rangeDays = rangeRaw === "all" ? null : ([7, 30, 90].includes(Number(rangeRaw)) ? Number(rangeRaw) : 30);
  const toValues = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value == null ? [] : [value])
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 50);
  const instruments = [...new Set(toValues(req.query["instruments"]))];
  const includeOtherInstruments = instruments.includes(OTHER_INSTRUMENT_BUCKET_KEY);
  const exactInstruments = instruments.filter((item) => item !== OTHER_INSTRUMENT_BUCKET_KEY);
  const timeframes = [...new Set(toValues(req.query["timeframes"]))];
  const conditions = [eq(analyses.userId, req.userId!)];
  if (rangeDays != null) {
    conditions.push(sql`${analyses.createdAt} >= now() - (${rangeDays} * interval '1 day')`);
  }
  if (includeOtherInstruments && exactInstruments.length > 0) {
    conditions.push(or(
      inArray(analyses.instrument, exactInstruments),
      notInArray(analyses.instrument, [...PRIMARY_INSTRUMENTS]),
    )!);
  } else if (includeOtherInstruments) {
    conditions.push(notInArray(analyses.instrument, [...PRIMARY_INSTRUMENTS]));
  } else if (exactInstruments.length) {
    conditions.push(inArray(analyses.instrument, exactInstruments));
  }
  if (timeframes.length) conditions.push(inArray(analyses.timeframe, timeframes));

  const rows = await db
    .select({
      instrument: analyses.instrument,
      timeframe: analyses.timeframe,
      outcomeStatus: analyses.outcomeStatus,
      validUntil: analyses.validUntil,
    })
    .from(analyses)
    .where(and(...conditions));

  type Tally = {
    total: number; pending: number; activeValid: number; tp1Hit: number;
    tp2Hit: number; slHit: number; expired: number; invalidated: number;
  };
  const empty = (): Tally => ({
    total: 0, pending: 0, activeValid: 0, tp1Hit: 0,
    tp2Hit: 0, slHit: 0, expired: 0, invalidated: 0,
  });
  const now = Date.now();
  const add = (tally: Tally, row: typeof rows[number]) => {
    tally.total++;
    if (row.outcomeStatus === "pending") {
      tally.pending++;
      if (new Date(row.validUntil).getTime() > now) tally.activeValid++;
    } else if (row.outcomeStatus === "tp1_hit") tally.tp1Hit++;
    else if (row.outcomeStatus === "tp2_hit") tally.tp2Hit++;
    else if (row.outcomeStatus === "sl_hit") tally.slHit++;
    else if (row.outcomeStatus === "expired") tally.expired++;
    else if (row.outcomeStatus === "invalidated") tally.invalidated++;
  };
  const overall = empty();
  const timeframeBuckets = new Map<string, Tally>();
  const instrumentBuckets = new Map<string, { tally: Tally; timeframes: Map<string, Tally> }>();
  for (const row of rows) {
    add(overall, row);
    const timeframeBucket = timeframeBuckets.get(row.timeframe) ?? empty();
    add(timeframeBucket, row);
    timeframeBuckets.set(row.timeframe, timeframeBucket);

    const instrumentBucket = instrumentBuckets.get(row.instrument) ?? {
      tally: empty(),
      timeframes: new Map<string, Tally>(),
    };
    add(instrumentBucket.tally, row);
    const instrumentTimeframe = instrumentBucket.timeframes.get(row.timeframe) ?? empty();
    add(instrumentTimeframe, row);
    instrumentBucket.timeframes.set(row.timeframe, instrumentTimeframe);
    instrumentBuckets.set(row.instrument, instrumentBucket);
  }
  const rates = (tally: Tally) => {
    const wins = tally.tp1Hit + tally.tp2Hit;
    const triggered = wins + tally.slHit;
    const scorable = triggered + tally.expired;
    return {
      ...tally,
      winRate: triggered ? wins / triggered : null,
      completionRate: scorable ? wins / scorable : null,
    };
  };
  res.json({
    range: rangeDays == null ? "all" : String(rangeDays),
    minSamples: 10,
    overall: rates(overall),
    byInstrument: [...instrumentBuckets.entries()]
      .map(([instrument, bucket]) => ({
        instrument,
        ...rates(bucket.tally),
        byTimeframe: [...bucket.timeframes.entries()]
          .map(([timeframe, tally]) => ({ timeframe, ...rates(tally) }))
          .sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => b.total - a.total),
    byTimeframe: [...timeframeBuckets.entries()]
      .map(([timeframe, tally]) => ({ timeframe, ...rates(tally) }))
      .sort((a, b) => b.total - a.total),
  });
});

router.get("/analyses/recent-instruments", requireAuth, async (req: AuthRequest, res) => {
  const rows = await db
    .selectDistinct({
      instrument: analyses.instrument,
      createdAt: analyses.createdAt,
      mode: analyses.mode,
    })
    .from(analyses)
    .where(eq(analyses.userId, req.userId!))
    .orderBy(desc(analyses.createdAt))
    .limit(10);

  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (seen.has(r.instrument)) return false;
    seen.add(r.instrument);
    return true;
  }).slice(0, 3);

  res.json({
    instruments: unique.map((r) => ({
      instrument: r.instrument,
      lastAnalyzedAt: r.createdAt.toISOString(),
      mode: r.mode,
    })),
  });
});

// Anti-pattern guardrails (task #163). Read endpoint returns the
// active soft warnings for the requested instrument so the analyse
// page can render an inline card. Telemetry endpoint logs (kind,
// proceeded) so the Mirror digest and analytics can show how often
// each warning is shown / overridden. Both routes deliberately stay
// non-blocking — the analyse POST is untouched.
router.get("/analyses/guardrails", requireAuth, async (req: AuthRequest, res) => {
  const instrument = String(req.query["instrument"] ?? "").trim();
  if (!instrument) {
    res.status(400).json({ error: "instrument is required" });
    return;
  }
  const result = await detectGuardrailSignals(req.userId!, instrument);
  if (!result) {
    res.status(404).json({ error: "User tidak ditemukan" });
    return;
  }
  res.json(result);
});

const guardrailTelemetrySchema = z.object({
  kind: z.enum(GUARDRAIL_KINDS as readonly [GuardrailKind, ...GuardrailKind[]]),
  instrument: z.string().trim().max(32).optional(),
  proceeded: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

router.post("/analyses/guardrails/telemetry", requireAuth, async (req: AuthRequest, res) => {
  const parsed = guardrailTelemetrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Telemetri tidak valid" });
    return;
  }
  const { kind, instrument, proceeded, metadata } = parsed.data;
  const [event] = await db.insert(guardrailEvents).values({
    userId: req.userId!,
    kind,
    instrument: instrument ?? null,
    proceeded: proceeded === true,
    metadata: metadata ?? {},
  }).returning({ id: guardrailEvents.id });
  // Telemetry is an impression/proceed record only. It never grants XP;
  // the dedicated /wait action below is the sole safe-wait award path.
  res.status(201).json({ ok: true, id: event!.id });
});

// Dedicated user action, separate from passive impression telemetry. This is
// the only endpoint that can record an explicit decision to wait.
router.post("/analyses/guardrails/:id/wait", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "ID peringatan tidak valid" }); return; }
  const [warning] = await db.select({ id: guardrailEvents.id, kind: guardrailEvents.kind, instrument: guardrailEvents.instrument, firedAt: guardrailEvents.firedAt }).from(guardrailEvents)
    .where(and(eq(guardrailEvents.id, id), eq(guardrailEvents.userId, req.userId!))).limit(1);
  if (!warning) { res.status(404).json({ error: "Peringatan tidak ditemukan" }); return; }
  // Only the independently re-checkable calendar risk signal is eligible.
  // Impression telemetry kinds such as unusual-hour are deliberately excluded.
  if (warning.kind !== "high_risk_window" || !warning.instrument || Date.now() - warning.firedAt.getTime() > 15 * 60_000) {
    res.status(400).json({ error: "Peringatan tidak memenuhi syarat safe-wait" }); return;
  }
  const active = await detectGuardrailSignals(req.userId!, warning.instrument);
  const signal = active?.signals.find((candidate) => candidate.kind === "high_risk_window");
  if (!signal || signal.kind !== "high_risk_window") {
    res.status(400).json({ error: "Peringatan risiko tidak lagi aktif" }); return;
  }
  // Dedupe by independently detected economic event identity, never by the
  // caller-created impression row. Forging many impressions cannot multiply XP.
  const sourceEventId = riskWaitSourceEventId(warning.instrument, signal.event);
  const result = await awardProgression({ userId: req.userId!, source: "risk_warning_wait", sourceEventId, qualityScore: 100, metadata: { guardrailEventId: warning.id, eventIdentity: sourceEventId, explicitWait: true } });
  res.status(result.awarded ? 201 : 200).json(result);
});

router.get("/analyses/quota", requireAuth, async (req: AuthRequest, res) => {
  const isPrivilegedRole = req.userRole === "admin" || req.userRole === "super_admin";
  const { perDay } = await getEffectiveQuota(req.userId!);
  const creditBalance = await getCreditBalanceForUser(req.userId!);
  if (isPrivilegedRole) {
    res.json({
      unlimited: true,
      daily: { limit: perDay, used: 0, remaining: perDay },
      credits: { balance: creditBalance },
    });
    return;
  }

  // Lifetime count — no time window at all (see chat 2026-09-30: the free
  // quota is a one-time allowance, not a recurring monthly/daily one).
  const [usage] = await db
    .select({ daily: count() })
    .from(analyses)
    .where(eq(analyses.userId, req.userId!));

  const dailyUsed = Number(usage?.daily ?? 0);

  res.json({
    unlimited: false,
    daily: {
      limit: perDay,
      used: dailyUsed,
      remaining: Math.max(0, perDay - dailyUsed),
    },
    credits: { balance: creditBalance },
  });
});

router.get("/analyses/personal-analytics", requireAuth, async (req: AuthRequest, res) => {
  const all = await db
    .select({
      id: analyses.id,
      mode: analyses.mode,
      instrument: analyses.instrument,
      createdAt: analyses.createdAt,
    })
    .from(analyses)
    .where(eq(analyses.userId, req.userId!))
    .orderBy(desc(analyses.createdAt));

  const now = new Date();
  const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const total = all.length;
  const thisMonth = all.filter((a) => new Date(a.createdAt) >= thisMonthStart).length;
  const thisWeek = all.filter((a) => new Date(a.createdAt) >= thisWeekStart).length;

  const instrumentCount: Record<string, number> = {};
  const modeCount: Record<string, number> = {};

  for (const a of all) {
    instrumentCount[a.instrument] = (instrumentCount[a.instrument] ?? 0) + 1;
    modeCount[a.mode] = (modeCount[a.mode] ?? 0) + 1;
  }

  const topInstruments = Object.entries(instrumentCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([instrument, count]) => ({ instrument, count }));

  const dominantMode =
    (modeCount["pro"] ?? 0) > (modeCount["beginner"] ?? 0) ? "pro" : "beginner";

  const feedbackRows = await db
    .select({ feedbackType: feedback.feedbackType, outcome: feedback.outcome })
    .from(feedback)
    .where(eq(feedback.userId, req.userId!));

  const totalFeedback = feedbackRows.length;
  const correctCount = feedbackRows.filter((f) => f.outcome === "correct").length;
  const accuracyRate =
    totalFeedback > 0 ? Math.round((correctCount / totalFeedback) * 100) : null;

  const rangeRaw = typeof req.query["range"] === "string" ? req.query["range"] : "weekly";
  const range: "daily" | "weekly" | "monthly" =
    rangeRaw === "daily" || rangeRaw === "monthly" ? rangeRaw : "weekly";

  const weekly: { week: string; count: number }[] = [];

  if (range === "daily") {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(startOfToday.getTime() - i * 24 * 60 * 60 * 1000);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const c = all.filter(
        (a) => new Date(a.createdAt) >= dayStart && new Date(a.createdAt) < dayEnd,
      ).length;
      weekly.push({
        week: dayStart.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }),
        count: c,
      });
    }
  } else if (range === "monthly") {
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const c = all.filter(
        (a) => new Date(a.createdAt) >= monthStart && new Date(a.createdAt) < monthEnd,
      ).length;
      weekly.push({
        week: monthStart.toLocaleDateString("id-ID", { month: "short", year: "2-digit" }),
        count: c,
      });
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const weekStart = new Date(now.getTime() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
      const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
      const c = all.filter(
        (a) => new Date(a.createdAt) >= weekStart && new Date(a.createdAt) < weekEnd,
      ).length;
      weekly.push({
        week: weekStart.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }),
        count: c,
      });
    }
  }

  res.json({
    totalAllTime: total,
    totalThisMonth: thisMonth,
    totalThisWeek: thisWeek,
    topInstruments,
    dominantMode,
    accuracyRate,
    feedbackCount: totalFeedback,
    weeklyData: weekly,
  });
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Naming drift (see chat, 2026-09-30): the free quota is now a one-time
// LIFETIME allowance (never resets), not a recurring daily/monthly one —
// but the env var, this variable, the DB column (users.customQuotaPerDay),
// and the API field names below all still say "Day"/"daily" to avoid a
// schema migration and a breaking API-shape rename (mobile client +
// generated types all read `daily`). Read every "Day"/"daily" identifier
// from here down as "the free lifetime allowance" now, not a time window
// at all. Default cut from 20/day to 5 lifetime — AI spend was ~$36/2
// days, almost entirely free-tier usage; past this, a purchased credit is
// required for every analysis, forever.
let ANALYSIS_QUOTA_PER_DAY = parsePositiveInt(process.env["ANALYSIS_QUOTA_PER_DAY"], 5);
const ANALYSIS_LOCK_NAMESPACE = 4242;

export function getAnalysisQuotaConfig(): { perDay: number } {
  return { perDay: ANALYSIS_QUOTA_PER_DAY };
}

export function setAnalysisQuotaConfig(perDay: number): void {
  ANALYSIS_QUOTA_PER_DAY = parsePositiveInt(String(perDay), ANALYSIS_QUOTA_PER_DAY);
}

// Per-user quota, falling back to the global admin-configured default when
// the user doesn't have a custom override set (admin dashboard →
// RecentSignupsPanel → UserQuotaEditor).
async function getEffectiveQuota(userId: number): Promise<{ perDay: number }> {
  const [row] = await db
    .select({
      customQuotaPerDay: users.customQuotaPerDay,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const globalCfg = getAnalysisQuotaConfig();
  return {
    perDay: row?.customQuotaPerDay ?? globalCfg.perDay,
  };
}

// The AI output shape (kept as its own alias rather than deriving from
// `generateAnalysis`'s return type, since that now also carries token
// usage/model metadata — see `AnalysisTokenUsage` for that half).
type AIResult = AIOutput;
type AnalysisRow = typeof analyses.$inferSelect;
type QuotaOutcome =
  | { kind: "ok"; analysis: AnalysisRow; creditConsumed: boolean; creditBalance?: number }
  | { kind: "busy" }
  | { kind: "day"; used: number; limit: number }
  | { kind: "aiError" };

router.post("/analyses", requireAuth, async (req: AuthRequest, res) => {
  const { instrument, timeframe, mode, userInputContext } = req.body;

  if (!instrument || !timeframe || !mode) {
    res.status(400).json({ error: "Instrumen, timeframe, dan mode wajib diisi" });
    return;
  }

  if (!["beginner", "pro"].includes(mode)) {
    res.status(400).json({ error: "Mode tidak valid" });
    return;
  }
  if (typeof instrument !== "string" || !VERIFIED_ANALYSIS_INSTRUMENTS.has(instrument)) {
    res.status(400).json({ error: "Kode instrumen belum didukung atau harga belum terverifikasi di aplikasi." });
    return;
  }
  if (!isSupportedIndicatorTimeframe(timeframe)) {
    res.status(400).json({ error: "Timeframe tidak valid" });
    return;
  }

  const userId = req.userId!;
  const typedMode = mode as "beginner" | "pro";
  const isPrivilegedRole = req.userRole === "admin" || req.userRole === "super_admin";
  const isFastIntraday = timeframe === "1m" || timeframe === "5m";

  // External context fetches are pure HTTP — do them outside any transaction.
  // Indicators only support daily/weekly today; skip them for intraday timeframes
  // so the AI is not fed stale daily data labelled as e.g. "1h".
  const indicatorTf = isSupportedIndicatorTimeframe(timeframe) ? timeframe : null;
  const timeframeOrder: IndicatorTimeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W"];
  const selectedIndex = indicatorTf ? timeframeOrder.indexOf(indicatorTf) : -1;
  const comparisonTimeframes = selectedIndex < 0
    ? []
    : [timeframeOrder[selectedIndex - 1], timeframeOrder[selectedIndex + 1]]
        .filter((tf): tf is IndicatorTimeframe => tf !== undefined);
  // Comparisons are advisory context, not a substitute for the selected
  // timeframe's actual execution levels. Keep optional feeds bounded so they
  // cannot indefinitely delay a paid user's answer.
  const boundedIndicators = (tf: IndicatorTimeframe) => Promise.race([
    getIndicators(instrument, tf),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  const contextParts: string[] = [];
  // Snapshot the overall buy/sell/neutral tally that drives the Market Context
  // Summary card on the Analyze tab so the saved analysis page can render the
  // same card later. Stays null when indicators were unavailable.
  let techCounts: { buy: number; sell: number; neutral: number } | null = null;
  // Captured from the news / calendar fetches below so we can both
  // (a) hand them to generateAnalysis for citation grounding, and
  // (b) persist them on the analyses row so the saved-analysis page
  //     renders the SAME fundamental context the model was shown.
  let fetchedNews: NewsItem[] = [];
  let fetchedCalendar: CalendarEvent[] = [];
  // Live mid-price anchor for the AI's trade plan. Independent of the
  // best-effort indicator fetch below — when indicators are missing this is
  // the only price the model gets, so it can still emit concrete entry/SL/TP
  // instead of falling back to a descriptive "wait" plan. Null when the feed
  // doesn't cover this instrument (futures-only); the model then anchors to
  // the indicator block's last close as before.
  let livePrice: number | null = null;
  // Close from the user's selected timeframe only. Comparison timeframe
  // summaries are context, never an execution-price anchor.
  let selectedTimeframePrice: number | null = null;
  // Bound the live-price lookup: the upstream forex fetch has no timeout of
  // its own, so without this a stalled feed could hang the whole analysis.
  // Best-effort — null just means "no live anchor", same as no coverage.
  const livePriceAnchor = Promise.race([
    getLivePriceFor(instrument),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);
  const candleSnapshotRequest: Promise<Awaited<ReturnType<typeof getCandleSnapshot>>> =
    indicatorTf
      ? new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(null), 5500);
          getCandleSnapshot(instrument, indicatorTf).then(
            (snapshot) => {
              clearTimeout(timeout);
              resolve(snapshot);
            },
            (err) => {
              clearTimeout(timeout);
              logger.warn({ err, instrument, timeframe }, "[analyses] Selected-timeframe candle snapshot unavailable");
              resolve(null);
            },
          );
        })
      : Promise.resolve(null);
  await Promise.allSettled([
    candleSnapshotRequest,
    livePriceAnchor.then((p) => {
      livePrice = p;
    }),
    indicatorTf
      ? boundedIndicators(indicatorTf).then((ind) => {
          if (ind) {
            selectedTimeframePrice =
              Number.isFinite(ind.lastClose) && ind.lastClose > 0
                ? ind.lastClose
                : null;
            contextParts.push(formatIndicatorsForPrompt(ind, indicatorTf));
            techCounts = {
              buy: ind.overallSummary.buy,
              sell: ind.overallSummary.sell,
              neutral: ind.overallSummary.neutral,
            };
          }
        })
      : Promise.resolve(),
    Promise.all(comparisonTimeframes.map(async (tf) => {
      const ind = await boundedIndicators(tf).catch(() => null);
      return ind ? formatIndicatorsForPrompt(ind, tf) : null;
    })).then((comparisons) => {
      const available = comparisons.filter((item): item is string => item !== null);
      if (available.length) {
        contextParts.push(
          `TIMEFRAME PEMBANDING (untuk menilai arah dan timing; level entry/SL/TP harus sesuai timeframe utama ${timeframe}):\n${available.join("\n")}`,
        );
      }
    }),
    isFastIntraday
      ? Promise.resolve()
      : getRelevantNews(instrument).then((news) => {
          fetchedNews = news;
          if (news.length) contextParts.push(formatNewsForPrompt(news, instrument));
        }),
    isFastIntraday
      ? Promise.resolve()
      : getRelevantCalendar(instrument).then((events) => {
          fetchedCalendar = events;
          if (events.length) contextParts.push(formatCalendarForPrompt(events, instrument));
        }),
  ]);
  const candleSnapshot = await candleSnapshotRequest;
  if (VERIFIED_OTHER_INSTRUMENTS.has(instrument)) {
    const last = candleSnapshot?.candles.at(-1);
    const lastCandleTime = last ? Date.parse(last.date) : NaN;
    const maxCandleAge = timeframe === "1W" ? 11 * 86400000 : timeframe === "1D" ? 5 * 86400000 : 3 * 86400000;
    if (!candleSnapshot || candleSnapshot.isStale || candleSnapshot.candles.length < 20 ||
        !last || !Number.isFinite(last.close) || last.close <= 0 ||
        !Number.isFinite(lastCandleTime) || lastCandleTime > Date.now() + 86400000 ||
        Date.now() - lastCandleTime > maxCandleAge ||
        !Number.isFinite(last.low) || !Number.isFinite(last.high) ||
        last.low <= 0 || last.high < last.low) {
      res.status(503).json({ error: "Data harga untuk timeframe ini belum terverifikasi saat ini. Analisis tidak dijalankan dan kredit tidak dipakai." });
      return;
    }
    // The two independently sourced spot prices must agree. A feed-scale
    // mismatch would otherwise create plausible-looking but unsafe levels.
    if (livePrice !== null &&
        (!Number.isFinite(livePrice) || livePrice <= 0 ||
         Math.abs(livePrice - last.close) / last.close > 0.01)) {
      res.status(503).json({ error: "Sumber harga tidak selaras. Analisis tidak dijalankan dan kredit tidak dipakai." });
      return;
    }
  }
  // The exact same selected-timeframe price anchor is persisted with the bars.
  // Prefer the close from the captured snapshot when its upstream retrieval is
  // fresh; stale cached candles remain explicitly stale and do not override an
  // independent live quote.
  if (candleSnapshot && !candleSnapshot.isStale) {
    const capturedClose = candleSnapshot.candles.at(-1)?.close;
    if (typeof capturedClose === "number" && Number.isFinite(capturedClose) && capturedClose > 0) {
      livePrice = capturedClose;
      selectedTimeframePrice = capturedClose;
    }
  }
  const priceAtAnalysis =
    typeof livePrice === "number" && Number.isFinite(livePrice) && livePrice > 0
      ? livePrice
      : typeof selectedTimeframePrice === "number" &&
          Number.isFinite(selectedTimeframePrice) &&
          selectedTimeframePrice > 0
        ? selectedTimeframePrice
        : null;
  const marketSnapshot = indicatorTf
    ? {
        instrument,
        timeframe,
        capturedAt: new Date().toISOString(),
        sourceFetchedAt: candleSnapshot?.sourceFetchedAt ?? null,
        // Retain a bounded recent history for Adaptive without persisting the
        // full upstream multi-year response.
        candles: candleSnapshot?.candles.slice(-300) ?? [],
        priceAtAnalysis,
        sourceStatus: candleSnapshot
          ? candleSnapshot.isStale
            ? candleSnapshot.staleReason === "source_age"
              ? "stale_source_age"
              : "stale_feed_unavailable"
            : "fresh"
          : "feed_unavailable",
      }
    : null;
  const indicatorContext = contextParts.length ? contextParts.join("\n") : undefined;
  // Always persist as `{ newsItems: [], calendarEvents: [] }` (never
  // null) so the saved-analysis page renders an honest empty-state
  // when both feeds were empty, not a silently-hidden card.
  const fundamentalSnapshot: FundamentalSnapshot = {
    newsItems: fetchedNews,
    calendarEvents: fetchedCalendar,
  };

  const validUntil = getValidUntil(timeframe);

  const buildInsertValues = (aiResult: AIResult) => {
    const modeSpecificFields =
      typedMode === "beginner"
        ? {
            mainScenario: (aiResult as BeginnerAIOutput).mainScenario,
            alternativeScenario: (aiResult as BeginnerAIOutput).alternativeScenario,
            whyReason: (aiResult as BeginnerAIOutput).whyReason,
            failureConditions: (aiResult as BeginnerAIOutput).failureConditions,
          }
        : {
            baseCase: (aiResult as ProAIOutput).baseCase,
            bullishScenario: (aiResult as ProAIOutput).bullishScenario,
            bearishScenario: (aiResult as ProAIOutput).bearishScenario,
            keyDriversTechnical: (aiResult as ProAIOutput).keyDriversTechnical,
            keyDriversFundamental: (aiResult as ProAIOutput).keyDriversFundamental,
            marketContext: (aiResult as ProAIOutput).marketContext,
            invalidationConditions: (aiResult as ProAIOutput).invalidationConditions,
            uncertaintyNotes: (aiResult as ProAIOutput).uncertaintyNotes,
          };
    return {
      userId,
      instrument,
      timeframe,
      mode: typedMode,
      userInputContext: userInputContext ?? null,
      rawAiOutput: JSON.stringify(aiResult),
      validUntil,
      marketCondition: aiResult.marketCondition,
      riskLevel: aiResult.riskLevel,
      confidenceMin: aiResult.confidenceMin,
      confidenceMax: aiResult.confidenceMax,
      tradingBias: aiResult.tradingBias,
      opportunity: aiResult.opportunity,
      risk: aiResult.risk,
      techBuyCount: techCounts?.buy ?? null,
      techSellCount: techCounts?.sell ?? null,
      techNeutralCount: techCounts?.neutral ?? null,
      tradePlan: aiResult.tradePlan ?? null,
      marketSnapshot,
      fundamentalContext: fundamentalSnapshot,
      // Provenance trail emitted by the AI: which news titles + event
      // names from `fundamentalSnapshot` it actually cited in the
      // narrative. Drives the inline source chips on the saved-analysis
      // page (task #89). Persist `null` when the AI didn't return one
      // (legacy / no fundamental input cases) so the UI can fall back
      // to rendering the narrative without chips.
      fundamentalCitations: aiResult.fundamentalCitations ?? null,
      ...modeSpecificFields,
    };
  };

  let outcome: QuotaOutcome;

  if (isPrivilegedRole) {
    let aiResult: AIResult;
    let tokenUsage: AnalysisTokenUsage;
    let usedModel: string;
    try {
      ({ output: aiResult, usage: tokenUsage, model: usedModel } = await generateAnalysis(
        instrument,
        timeframe,
        typedMode,
        userInputContext,
        indicatorContext,
        fundamentalSnapshot,
        livePrice,
        selectedTimeframePrice,
        "dev",
      ));
    } catch (aiErr) {
      logger.error(
        { err: aiErr, userId, instrument, timeframe, mode: typedMode },
        "[analyses] AI generation failed (privileged path)",
      );
      void trackAiError();
      res.status(502).json({ error: "Layanan AI sedang tidak tersedia. Silakan coba lagi dalam beberapa saat." });
      return;
    }
    const [analysis] = await db.insert(analyses).values(buildInsertValues(aiResult)).returning();
    await db.insert(aiTokenUsage).values({
      userId,
      analysisId: analysis.id,
      model: usedModel,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      totalTokens: tokenUsage.totalTokens,
      callCount: tokenUsage.callCount,
      estimatedCostUsd: estimateCostUsd(usedModel, tokenUsage.promptTokens, tokenUsage.completionTokens).toFixed(6),
      instrument,
      timeframe,
    }).catch((err) => {
      logger.warn({ err }, "[analyses] failed to record AI token usage");
    });
    outcome = { kind: "ok", analysis, creditConsumed: false };
  } else {
    // Atomically: take a per-user xact-scoped advisory lock, count usage,
    // call AI, and insert. The lock auto-releases on COMMIT/ROLLBACK so
    // concurrent requests for the same user cannot bypass the quota.
    const { perDay } = await getEffectiveQuota(userId);
    outcome = await db.transaction<QuotaOutcome>(async (tx) => {
      const lockRow = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(${ANALYSIS_LOCK_NAMESPACE}::int, ${userId}::int) AS acquired`
      );
      const acquired = (lockRow.rows?.[0] as { acquired?: boolean } | undefined)?.acquired === true;
      if (!acquired) return { kind: "busy" };

      // Lifetime count — see the identical comment on GET /analyses/quota
      // above. Runs inside the xact-locked transaction (unlike the GET
      // route's read-only check) so a burst of concurrent requests can't
      // all read the same pre-increment count and all slip through.
      const [usage] = await tx
        .select({ daily: count() })
        .from(analyses)
        .where(eq(analyses.userId, userId));

      const dailyCount = Number(usage?.daily ?? 0);

      // Only decide WHETHER a credit will be needed here — the actual
      // ledger deduction happens after generateAnalysis() succeeds (see
      // below), same as the free quota itself only ever "counts" a
      // successful, inserted analysis. Deducting up front would charge
      // the user for analyses that fail at the AI step.
      let willConsumeCredit = false;
      if (dailyCount >= perDay) {
        const balance = await getCreditBalanceForUser(userId);
        if (balance <= 0) {
          // Unchanged existing behavior: no credits, block exactly as before.
          return { kind: "day", used: dailyCount, limit: perDay };
        }
        willConsumeCredit = true;
      }

      let aiResult: AIResult;
      let tokenUsage: AnalysisTokenUsage;
      let usedModel: string;
      try {
        ({ output: aiResult, usage: tokenUsage, model: usedModel } = await generateAnalysis(
          instrument,
          timeframe,
          typedMode,
          userInputContext,
          indicatorContext,
          fundamentalSnapshot,
          livePrice,
          selectedTimeframePrice,
          willConsumeCredit ? "paid" : "free",
        ));
      } catch (aiErr) {
        logger.error(
          { err: aiErr, userId, instrument, timeframe, mode: typedMode },
          "[analyses] AI generation failed",
        );
        return { kind: "aiError" };
      }

      const [analysis] = await tx.insert(analyses).values(buildInsertValues(aiResult)).returning();
      await tx.insert(aiTokenUsage).values({
        userId,
        analysisId: analysis.id,
        model: usedModel,
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        totalTokens: tokenUsage.totalTokens,
        callCount: tokenUsage.callCount,
        estimatedCostUsd: estimateCostUsd(usedModel, tokenUsage.promptTokens, tokenUsage.completionTokens).toFixed(6),
        instrument,
        timeframe,
      }).catch((err) => {
        logger.warn({ err }, "[analyses] failed to record AI token usage");
      });

      let creditBalanceAfter: number | undefined;
      if (willConsumeCredit) {
        // Same advisory-lock namespace topups.ts uses for approval grants,
        // so a concurrent top-up approval for this user can't race this
        // spend into a lost balance update. A purchased credit bypasses
        // the daily cap — "one more analysis, whenever," not a pacing
        // extension.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${CREDIT_BALANCE_LOCK_NAMESPACE}::int, ${userId}::int)`);
        creditBalanceAfter = await applyCreditLedgerEntry(tx, {
          userId,
          amount: -1,
          source: "analysis_consumption",
          sourceEventId: `analysis:${analysis.id}`,
          analysisId: analysis.id,
        });
      }
      return { kind: "ok", analysis, creditConsumed: willConsumeCredit, creditBalance: creditBalanceAfter };
    });
  }

  if (outcome.kind === "busy") {
    res.status(429).set("Retry-After", "5").json({
      error: "Permintaan analisis sebelumnya masih diproses. Mohon tunggu sebentar.",
      quota: { scope: "concurrent" },
    });
    return;
  }
  if (outcome.kind === "day") {
    // No Retry-After here — the free allowance is a one-time lifetime cap
    // that never resets, so there's no future instant at which a retry
    // would succeed on its own; only a purchased credit unblocks this.
    res.status(429).json({
      error: `Batas analisis gratis tercapai (${outcome.limit} analisis). Top up kredit untuk lanjut analisis.`,
      quota: { scope: "day", limit: outcome.limit, used: outcome.used },
    });
    return;
  }
  if (outcome.kind === "aiError") {
    void trackAiError();
    res.status(502).json({ error: "Layanan AI sedang tidak tersedia. Silakan coba lagi dalam beberapa saat." });
    return;
  }

  const analysis = outcome.analysis;

  const completeTitle = "Analisis Selesai";
  const completeMessage = `Analisis ${instrument} (${timeframe}, ${typedMode === "beginner" ? "Pemula" : "Pro"}) telah selesai diproses.`;
  try {
    await createNotification(
      req.userId!,
      {
        title: completeTitle,
        message: completeMessage,
        type: "info",
        // Tapping the notification opens this saved analysis.
        actionType: "open_analysis",
        actionId: String(analysis.id),
      },
      {
        title: "Analisis Selesai ✅",
        body: `${instrument} (${timeframe}) — buka TradePilot untuk lihat hasilnya.`,
        url: `/analyses/${analysis.id}`,
        tag: `analysis-${analysis.id}`,
      },
    );
  } catch (err) {
    logger.warn({ err, analysisId: analysis.id }, "Analysis saved but completion notification failed");
  }

  // Auto-arm price alerts for the AI's trade plan when the user already
  // has push enabled — they shouldn't need a second tap to opt in for
  // a feature that's clearly useful and that they've already accepted
  // the OS-level prompt for. Best-effort: failures are logged inside
  // armAlertsForAnalysis and never block the analysis response.
  try {
    const hasPush = await userHasPushSubscription(req.userId!);
    if (hasPush) {
      await armAlertsForAnalysis(analysis.id);
    }
  } catch (err) {
    logger.warn({ err, analysisId: analysis.id }, "Auto-arm price alerts failed");
  }

  // Tier 2 push (task #141 C). Compare this new analysis with the
  // user's previous same-(instrument,timeframe) call inside the last
  // 7 days; fire a push when the AI's recommended side flipped
  // meaningfully (BUY↔SELL or to/from WAIT with confidence Δ > 20).
  // Fire-and-forget — never blocks the analyses response.
  void maybeDispatchSignalFlip({
    userId: req.userId!,
    newAnalysisId: analysis.id,
    instrument: analysis.instrument,
    timeframe: analysis.timeframe,
    tradePlan: analysis.tradePlan,
    confidenceMin: analysis.confidenceMin,
    confidenceMax: analysis.confidenceMax,
  });

  // Tier 3 push (task #142 B). User created a new analysis → they
  // came back, so clear the dormancy-nudge backoff counter so the
  // next idle streak starts fresh from zero.
  void resetDormancyStreak(req.userId!);

  res.status(201).json({
    ...analysis,
    creditConsumed: outcome.creditConsumed,
    ...(outcome.creditBalance !== undefined ? { creditBalance: outcome.creditBalance } : {}),
  });
});

router.get("/analyses", requireAuth, async (req: AuthRequest, res) => {
  // Clamp pagination so a malicious or malformed `page` / `limit` (negative,
  // huge, NaN) cannot crash the query, blow up memory, or generate negative
  // OFFSETs. Mirrors the clamp pattern used by GET /superadmin/users.
  const rawPage = Number(req.query["page"] ?? 1);
  const rawLimit = Number(req.query["limit"] ?? 20);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
    : 20;
  const offset = (page - 1) * limit;
  const filterMode = req.query["mode"] as string | undefined;
  const filterInstrument = req.query["instrument"] as string | undefined;
  const filterFrom = req.query["from"] as string | undefined;
  const filterTo = req.query["to"] as string | undefined;

  // Multi-select filters. Express normalises `?instruments=A&instruments=B`
  // into a string[], but a single occurrence stays a string — coerce both
  // into a deduped, trimmed, non-empty array and cap at MAX_MULTI_FILTER
  // so a malicious caller cannot DOS the query with a huge IN list.
  const MAX_MULTI_FILTER = 50;
  const toArray = (v: unknown): string[] => {
    const raw = Array.isArray(v) ? v : v != null ? [v] : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== "string") continue;
      // Older generated clients serialize unknown array params as a
      // comma-separated value. Accept both that form and repeated params.
      for (const value of item.split(",")) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= MAX_MULTI_FILTER) break;
      }
      if (out.length >= MAX_MULTI_FILTER) break;
    }
    return out;
  };
  const filterInstruments = toArray(req.query["instruments"]);
  const includeOtherInstruments = filterInstruments.includes(OTHER_INSTRUMENT_BUCKET_KEY);
  const exactFilterInstruments = filterInstruments.filter(
    (item) => item !== OTHER_INSTRUMENT_BUCKET_KEY,
  );
  const filterTimeframes = toArray(req.query["timeframes"]);
  const filterOutcomes = toArray(req.query["outcomes"]).filter((value) =>
    ["pending", "tp1_hit", "tp2_hit", "sl_hit", "expired", "invalidated"].includes(value),
  );

  // Free-text search. Runs a parameterised ILIKE across the columns the
  // user is likely to recall by — the instrument label, their own
  // private note, the user-supplied prompt context, and the AI's short
  // opportunity/risk headline + the longer narrative blocks (so a
  // search for e.g. "FOMC" or "breakout retest" finds analyses where
  // those words appear anywhere in the body). The raw value is escaped
  // for LIKE wildcards so a user typing "50%" doesn't accidentally
  // match everything; length-capped to keep the query payload bounded.
  const MAX_SEARCH_LEN = 100;
  const rawSearch = typeof req.query["q"] === "string" ? req.query["q"] : "";
  const trimmedSearch = rawSearch.trim().slice(0, MAX_SEARCH_LEN);
  const searchPattern = trimmedSearch
    ? `%${trimmedSearch.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`
    : null;

  const conditions = [eq(analyses.userId, req.userId!)];
  if (filterMode === "beginner" || filterMode === "pro") {
    conditions.push(eq(analyses.mode, filterMode));
  }
  // Multi-select instruments wins over the legacy single `instrument`
  // param; the UI sends one or the other, never both.
  if (includeOtherInstruments && exactFilterInstruments.length > 0) {
    conditions.push(or(
      inArray(analyses.instrument, exactFilterInstruments),
      notInArray(analyses.instrument, [...PRIMARY_INSTRUMENTS]),
    )!);
  } else if (includeOtherInstruments) {
    conditions.push(notInArray(analyses.instrument, [...PRIMARY_INSTRUMENTS]));
  } else if (exactFilterInstruments.length > 0) {
    conditions.push(inArray(analyses.instrument, exactFilterInstruments));
  } else if (filterInstrument) {
    conditions.push(ilike(analyses.instrument, `%${filterInstrument}%`));
  }
  if (filterTimeframes.length > 0) {
    conditions.push(inArray(analyses.timeframe, filterTimeframes));
  }
  if (filterOutcomes.length > 0) {
    conditions.push(inArray(analyses.outcomeStatus, filterOutcomes as Array<typeof analyses.outcomeStatus.enumValues[number]>));
  }
  if (filterFrom) {
    conditions.push(gte(analyses.createdAt, new Date(filterFrom)));
  }
  if (filterTo) {
    const toDate = new Date(filterTo);
    toDate.setHours(23, 59, 59, 999);
    conditions.push(lte(analyses.createdAt, toDate));
  }
  if (searchPattern) {
    const orClauses = or(
      ilike(analyses.instrument, searchPattern),
      ilike(analyses.userNote, searchPattern),
      ilike(analyses.userInputContext, searchPattern),
      ilike(analyses.opportunity, searchPattern),
      ilike(analyses.risk, searchPattern),
      ilike(analyses.whyReason, searchPattern),
      ilike(analyses.mainScenario, searchPattern),
      ilike(analyses.alternativeScenario, searchPattern),
      ilike(analyses.baseCase, searchPattern),
      ilike(analyses.bullishScenario, searchPattern),
      ilike(analyses.bearishScenario, searchPattern),
      ilike(analyses.marketContext, searchPattern),
    );
    if (orClauses) conditions.push(orClauses);
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select()
    .from(analyses)
    .where(whereClause)
    .orderBy(desc(analyses.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db
    .select({ count: count(analyses.id) })
    .from(analyses)
    .where(whereClause);

  // Project `hasNote` (computed, not the note body itself) so the history
  // page can render the "journaled" icon without paying for the full note
  // text on every row. The body lives only on the detail-page GET.
  const projected = rows.map(({ userNote, ...rest }) => ({
    ...rest,
    hasNote: !!(userNote && userNote.trim().length > 0),
  }));

  res.json({
    analyses: projected,
    total: Number(total.count),
    page,
    limit,
  });
});

router.get("/analyses/:id", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);

  const [analysis] = await db
    .select()
    .from(analyses)
    .where(and(eq(analyses.id, id), eq(analyses.userId, req.userId!)))
    .limit(1);

  if (!analysis) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }

  const [fb] = await db
    .select()
    .from(feedback)
    .where(
      and(eq(feedback.analysisId, id), eq(feedback.userId, req.userId!))
    )
    .limit(1);

  res.json({ ...analysis, feedback: fb ?? null });
});

// Per-analysis private trading journal note (task #111). Keyed by the
// owning user — ownership is enforced by `analyses.userId`, so there is
// no separate join table. Body is plain text only and is NEVER fed into
// the AI prompt. A blank string clears the note (sets the column back to
// NULL) so the history "has note" indicator can hide the icon.
const MAX_USER_NOTE_LEN = 5000;
router.put("/analyses/:id/note", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }

  const rawNote = (req.body as { note?: unknown } | undefined)?.note;
  if (typeof rawNote !== "string") {
    res.status(400).json({ error: "Catatan tidak valid" });
    return;
  }
  if (rawNote.length > MAX_USER_NOTE_LEN) {
    res.status(400).json({
      error: `Catatan terlalu panjang (maks ${MAX_USER_NOTE_LEN} karakter)`,
    });
    return;
  }

  const trimmed = rawNote.trim();
  // Persist the trimmed value (not the raw) so leading/trailing
  // whitespace never lands in the DB; blank/whitespace-only collapses
  // to NULL so `hasNote` accurately reflects "user actually wrote
  // something."
  const noteForDb: string | null = trimmed.length === 0 ? null : trimmed;
  const updatedAt = new Date();

  const result = await db
    .update(analyses)
    .set({ userNote: noteForDb, userNoteUpdatedAt: noteForDb ? updatedAt : null })
    .where(and(eq(analyses.id, id), eq(analyses.userId, req.userId!)))
    .returning({ id: analyses.id });

  if (result.length === 0) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }

  res.json({
    note: noteForDb,
    updatedAt: noteForDb ? updatedAt.toISOString() : null,
  });
});

// Re-fetch news + calendar for an existing analysis WITHOUT re-running the
// AI. Returns the fresh snapshot plus a "drift" report: which of the
// citations the AI originally relied on no longer match anything in the
// fresh window. Lets the user sanity-check whether the saved AI thesis
// still rests on a valid fundamental base. Persists the new snapshot on
// the row so the audit view (Fundamental Context card) reflects it.
router.post(
  "/analyses/:id/refresh-fundamentals",
  requireAuth,
  async (req: AuthRequest, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: "Analisis tidak ditemukan" });
      return;
    }

    const [analysis] = await db
      .select()
      .from(analyses)
      .where(and(eq(analyses.id, id), eq(analyses.userId, req.userId!)))
      .limit(1);

    if (!analysis) {
      res.status(404).json({ error: "Analisis tidak ditemukan" });
      return;
    }

    // Pull the citations the AI emitted at analysis time. They live inside
    // the rawAiOutput JSON blob (the same payload generateAnalysis returned).
    // Defensively parse — older rows may lack the field, and a malformed blob
    // must not crash the refresh route.
    let originalCitations: { newsTitles: string[]; calendarEvents: string[] } = {
      newsTitles: [],
      calendarEvents: [],
    };
    try {
      // rawAiOutput is nullable on the schema (legacy rows + future
      // safety) — treat null as "no citations to drift against".
      const rawText = analysis.rawAiOutput;
      const raw = rawText ? (JSON.parse(rawText) as unknown) : null;
      if (raw && typeof raw === "object" && "fundamentalCitations" in raw) {
        const fc = (raw as { fundamentalCitations?: unknown }).fundamentalCitations;
        if (fc && typeof fc === "object") {
          const nt = (fc as { newsTitles?: unknown }).newsTitles;
          const ce = (fc as { calendarEvents?: unknown }).calendarEvents;
          originalCitations = {
            newsTitles: Array.isArray(nt) ? nt.filter((x): x is string => typeof x === "string") : [],
            calendarEvents: Array.isArray(ce) ? ce.filter((x): x is string => typeof x === "string") : [],
          };
        }
      }
    } catch {
      // Leave originalCitations as empty — we'll just report zero drift.
    }

    // The aggregator caches upstream feeds for 10–30 min. On an explicit
    // "Refresh fundamentals" the user expects an actual re-fetch, not a
    // re-run against the same cached snapshot — so bust the upstream
    // caches before refetching. Cache busts are global (per-process),
    // which is fine: the next caller that wants news/calendar will just
    // refill from upstream.
    _clearNewsmakerCache();
    _clearYahooCache();
    _clearCalendarCache();

    // Re-fetch news + calendar — never throw on upstream failure (mirrors the
    // create-analysis path). Either feed coming back empty is treated as
    // "nothing relevant in the window", not as an error to the user.
    let freshNews: NewsItem[] = [];
    let freshCalendar: CalendarEvent[] = [];
    await Promise.allSettled([
      getRelevantNews(analysis.instrument).then((news) => {
        freshNews = news;
      }),
      getRelevantCalendar(analysis.instrument).then((events) => {
        freshCalendar = events;
      }),
    ]);

    const freshSnapshot: FundamentalSnapshot = {
      newsItems: freshNews,
      calendarEvents: freshCalendar,
    };

    // Compute drift using the SAME matching logic that grounds the model's
    // citations at generation time, so an item that would have been
    // "grounded" originally is treated as still-grounded after refresh.
    const realNews = freshSnapshot.newsItems.map((n) => n.title);
    const realEvents = freshSnapshot.calendarEvents.map(
      (e) => `${e.event} ${e.currency}`,
    );
    const missingCitations: { kind: "news" | "calendar"; label: string }[] = [];
    for (const t of originalCitations.newsTitles) {
      if (!citationMatchesAny(t, realNews)) {
        missingCitations.push({ kind: "news", label: t });
      }
    }
    for (const e of originalCitations.calendarEvents) {
      if (!citationMatchesAny(e, realEvents)) {
        missingCitations.push({ kind: "calendar", label: e });
      }
    }
    const totalCitations =
      originalCitations.newsTitles.length +
      originalCitations.calendarEvents.length;

    const refreshedAt = new Date();
    await db
      .update(analyses)
      .set({ fundamentalContext: freshSnapshot })
      .where(eq(analyses.id, id));

    res.json({
      fundamentalContext: freshSnapshot,
      refreshedAt: refreshedAt.toISOString(),
      drift: {
        totalCitations,
        missingCitations,
      },
    });
  },
);

// Price-alerts routes for task #110. The detail page's "Notify me when
// price hits these levels" toggle drives POST (arm) / DELETE (cancel).
// GET returns the current armed/triggered state so the detail page can
// render the "Alerts: ON · N levels armed" indicator.
router.get("/analyses/:id/alerts", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }
  const [own] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.id, id), eq(analyses.userId, req.userId!)))
    .limit(1);
  if (!own) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }
  const status = await getAlertStatusForAnalysis(id);
  res.json(status);
});

router.post("/analyses/:id/alerts", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }
  const [own] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.id, id), eq(analyses.userId, req.userId!)))
    .limit(1);
  if (!own) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }
  let armed: number;
  try {
    armed = await armAlertsForAnalysis(id);
  } catch (err) {
    req.log.warn({ err, analysisId: id }, "Price alert live feed unavailable");
    res.status(503).json({ error: "Layanan harga live sedang tidak tersedia. Coba lagi nanti." });
    return;
  }
  if (armed === 0) {
    // Most common cause: instrument isn't covered by the live-quotes
    // upstream (e.g. NIKKEI variants we don't map). Surface a 422 so
    // the UI can toast a real reason rather than silently flipping
    // the toggle back off.
    res.status(422).json({
      error: "Tidak bisa menyalakan alert: instrumen ini belum didukung oleh data harga live, atau analisis tidak memiliki trade plan.",
    });
    return;
  }
  const status = await getAlertStatusForAnalysis(id);
  res.status(201).json(status);
});

router.delete("/analyses/:id/alerts", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }
  const [own] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.id, id), eq(analyses.userId, req.userId!)))
    .limit(1);
  if (!own) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }
  await cancelAlertsForAnalysis(id);
  const status = await getAlertStatusForAnalysis(id);
  res.json(status);
});

router.post("/analyses/:id/feedback", requireAuth, async (req: AuthRequest, res) => {
  const analysisId = Number(req.params["id"]);
  const { feedbackType, outcome, note } = req.body;

  if (!feedbackType || !["useful", "not_useful"].includes(feedbackType)) {
    res.status(400).json({ error: "Feedback type tidak valid" });
    return;
  }

  const [analysis] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(and(eq(analyses.id, analysisId), eq(analyses.userId, req.userId!)))
    .limit(1);

  if (!analysis) {
    res.status(404).json({ error: "Analisis tidak ditemukan" });
    return;
  }

  const existing = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(
      and(
        eq(feedback.analysisId, analysisId),
        eq(feedback.userId, req.userId!)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const [updated] = await db
      .update(feedback)
      .set({ feedbackType, outcome: outcome ?? null, note: note ?? null })
      .where(eq(feedback.id, existing[0].id))
      .returning();
    await awardProgression({ userId: req.userId!, source: "analysis_evaluation", sourceEventId: String(updated.id), qualityScore: 100, metadata: { analysisId, feedbackId: updated.id } });
    res.json(updated);
    return;
  }

  const [newFeedback] = await db
    .insert(feedback)
    .values({
      analysisId,
      userId: req.userId!,
      feedbackType,
      outcome: outcome ?? null,
      note: note ?? null,
    })
    .returning();
  await awardProgression({ userId: req.userId!, source: "analysis_evaluation", sourceEventId: String(newFeedback.id), qualityScore: 100, metadata: { analysisId, feedbackId: newFeedback.id } });
  res.status(201).json(newFeedback);
});

export default router;
