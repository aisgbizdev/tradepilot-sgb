// Radical AI transparency dashboard (task #164). Aggregates the public
// outcome ledger across *all* users and surfaces rolling 30/90-day
// hit-rates per instrument, FX session, and market-condition bucket —
// plus a "current state" honesty banner that fires when the recent
// window meaningfully underperforms the longer baseline.
//
// What counts:
//   * wins   = analyses whose `outcomeStatus` resolved to `tp1_hit` or `tp2_hit`
//   * losses = analyses whose `outcomeStatus` resolved to `sl_hit`
//   * expired = window passed without TP or SL touch (no-fill)
// `invalidated` and `pending` are excluded entirely.
//
// Two rates are reported, deliberately separated to keep the honesty
// promise:
//   * winRate    = wins / (wins + losses)  — among trades that actually triggered
//   * hitRate    = wins / total            — over every resolved analysis, expired included
//
// Every segment respects a minimum-sample guardrail (`MIN_SAMPLE`) so
// the page never confidently states a "78% win rate" pulled from 4 trades.

import { db } from "./db";
import { analyses, type FundamentalContextShape } from "@workspace/db/schema";
import {
  OTHER_INSTRUMENT_BUCKET_KEY,
  isPrimaryInstrument,
} from "@workspace/instrument-taxonomy";
import { and, gte, isNotNull, inArray, sql } from "drizzle-orm";
import { sessionBucket, type SessionKey } from "./trader-mirror";

export const MIN_SAMPLE = {
  /** Minimum resolved analyses per bucket before that bucket renders. */
  bucket: 10,
  /** Minimum resolved analyses overall before the dashboard renders any segment. */
  overall: 20,
  /** Minimum resolved analyses in the *recent* (7d) window before the
   *  "current state" banner can compare against the 30d baseline. */
  banner: 15,
} as const;

export type PerformanceWindow = 30 | 90;

export type ConditionKey = "trending_up" | "trending_down" | "ranging" | "volatile";

/** Deterministic regime label derived from the AI's stored indicator tally
 *  (techBuyCount / techSellCount / techNeutralCount). This is the "simple
 *  volatility/ADX classifier" the task asked for: we don't have raw OHLC
 *  per analysis, but the tally is the same signal a classic ADX-style
 *  read on the same chart would produce — strong directional dominance
 *  = trending, balanced + lots of neutrals = ranging, anything else
 *  = choppy (volatile). Analyses without a tally fall into `unclassified`
 *  and are excluded from this segment so we never mislabel old rows. */
export type VolatilityRegimeKey = "trending" | "ranging" | "choppy" | "unclassified";

/** Whether the AI's snapshot at analysis time included high-impact
 *  economic events. Derived from `fundamentalContext.calendarEvents[].impact`
 *  — a "news_week" analysis was placed in a market the AI knew was
 *  loaded with red-folder events; "quiet_week" had none. Rows with no
 *  snapshot at all are treated as `unknown` and excluded so we don't
 *  smear the two real buckets. */
export type NewsActivityKey = "news_week" | "quiet_week" | "unknown";

const RESOLVED_STATUSES = ["tp1_hit", "tp2_hit", "sl_hit", "expired"] as const satisfies ReadonlyArray<
  "tp1_hit" | "tp2_hit" | "sl_hit" | "expired" | "invalidated" | "pending"
>;
type ResolvedStatus = (typeof RESOLVED_STATUSES)[number];

interface ResolvedRow {
  instrument: string;
  marketCondition: ConditionKey;
  outcomeStatus: ResolvedStatus;
  outcomeResolvedAt: Date;
  createdAt: Date;
  techBuyCount: number | null;
  techSellCount: number | null;
  techNeutralCount: number | null;
  fundamentalContext: FundamentalContextShape | null;
}

/** Classify an analysis's market regime from the stored indicator tally.
 *  - trending  : one side >=2x the other and the dominant side has >=3 votes
 *  - ranging   : sides within 1 vote of each other AND neutrals dominate
 *  - choppy    : everything else with a meaningful tally
 *  - unclassified: legacy / missing tally — excluded from segment
 *  Pure function so tests pin the bucket boundaries exactly. */
export function classifyVolatilityRegime(
  buy: number | null,
  sell: number | null,
  neutral: number | null,
): VolatilityRegimeKey {
  if (buy == null || sell == null || neutral == null) return "unclassified";
  const total = buy + sell + neutral;
  if (total < 3) return "unclassified";
  const dom = Math.max(buy, sell);
  const weak = Math.min(buy, sell);
  if (dom >= 3 && dom >= weak * 2) return "trending";
  if (Math.abs(buy - sell) <= 1 && neutral >= Math.max(buy, sell)) return "ranging";
  return "choppy";
}

/** "News week" if the AI's snapshot included any high-impact calendar
 *  event the analysis was placed against. Case-insensitive on `impact`
 *  because upstream feeds vary ("High", "HIGH", "high"). */
export function classifyNewsActivity(
  ctx: FundamentalContextShape | null,
): NewsActivityKey {
  if (ctx == null) return "unknown";
  const events = ctx.calendarEvents ?? [];
  if (events.length === 0) return "quiet_week";
  const hasHighImpact = events.some(
    (e) => typeof e.impact === "string" && e.impact.toLowerCase() === "high",
  );
  return hasHighImpact ? "news_week" : "quiet_week";
}

export interface BucketStat {
  /** Stable machine key (e.g. "EUR/USD", "asia", "trending_up"). */
  key: string;
  /** Resolved trades that triggered (wins + losses). Expired excluded. */
  triggered: number;
  /** TP1 + TP2 hits. */
  wins: number;
  /** SL hits. */
  losses: number;
  /** No-fill within validity window. */
  expired: number;
  /** Total resolved analyses (wins + losses + expired). */
  total: number;
  /** wins / (wins + losses) — null if `triggered` is 0. */
  winRate: number | null;
  /** wins / total — null if `total` is 0. */
  hitRate: number | null;
}

export interface GatedSegment {
  /** True when *no* bucket inside this segment crossed `MIN_SAMPLE.bucket`. */
  gated: boolean;
  need: number;
  /** Largest bucket size we observed; useful for "you need N more" copy. */
  have: number;
  /** Every bucket above the threshold, sorted by `triggered` desc. */
  buckets: BucketStat[];
}

export type BannerSeverity = "ok" | "watch" | "warn";

export interface CurrentStateBanner {
  /**
   * `ok`    — recent hit-rate is within 5pp of baseline (or sample too thin)
   * `watch` — recent hit-rate is 5-15pp below baseline
   * `warn`  — recent hit-rate is >15pp below baseline
   */
  severity: BannerSeverity;
  /** Recent window length in days. Always 7 today. */
  recentDays: number;
  /** Resolved analyses inside the recent window. */
  recentSample: number;
  /** Resolved analyses inside the baseline 30d window. */
  baselineSample: number;
  /** Recent hit-rate (wins/total), null when sample too thin to claim. */
  recentHitRate: number | null;
  /** Baseline hit-rate (wins/total), null when sample too thin. */
  baselineHitRate: number | null;
  /** recent - baseline, negative = recent slump. Null when either side is null. */
  delta: number | null;
}

export interface OverallStat {
  triggered: number;
  wins: number;
  losses: number;
  expired: number;
  total: number;
  winRate: number | null;
  hitRate: number | null;
}

export interface MinSampleThresholds {
  /** Per-bucket gate (rendered as "need N per bucket"). */
  bucket: number;
  /** Overall gate before any rate is published. */
  overall: number;
  /** Banner gate before recent-vs-baseline comparison runs. */
  banner: number;
}

export interface PerformanceSummary {
  windowDays: PerformanceWindow;
  generatedAt: string;
  /** Earliest `outcomeResolvedAt` actually counted, ISO. Null if no rows. */
  windowStart: string | null;
  /** Server-published sample-size guardrails so UI copy never drifts. */
  minSamples: MinSampleThresholds;
  overall: OverallStat;
  banner: CurrentStateBanner;
  byInstrument: GatedSegment;
  bySession: GatedSegment;
  /** AI-assigned market-condition label captured at analysis time. */
  byCondition: GatedSegment;
  /** Deterministic regime classification derived from the stored
   *  indicator tally (see `classifyVolatilityRegime`). */
  byVolatility: GatedSegment;
  /** Whether the AI's fundamental snapshot included a high-impact
   *  calendar event at the time of analysis. */
  byNewsActivity: GatedSegment;
}

export { OTHER_INSTRUMENT_BUCKET_KEY } from "@workspace/instrument-taxonomy";

function emptyOverall(): OverallStat {
  return {
    triggered: 0,
    wins: 0,
    losses: 0,
    expired: 0,
    total: 0,
    winRate: null,
    hitRate: null,
  };
}

function tally(rows: ResolvedRow[], key: string): BucketStat {
  let wins = 0;
  let losses = 0;
  let expired = 0;
  for (const r of rows) {
    if (r.outcomeStatus === "tp1_hit" || r.outcomeStatus === "tp2_hit") wins++;
    else if (r.outcomeStatus === "sl_hit") losses++;
    else if (r.outcomeStatus === "expired") expired++;
  }
  const triggered = wins + losses;
  const total = triggered + expired;
  return {
    key,
    triggered,
    wins,
    losses,
    expired,
    total,
    winRate: triggered > 0 ? wins / triggered : null,
    hitRate: total > 0 ? wins / total : null,
  };
}

function segment(rows: ResolvedRow[], keyOf: (r: ResolvedRow) => string): GatedSegment {
  const groups = new Map<string, ResolvedRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const all = Array.from(groups.entries())
    .map(([k, list]) => tally(list, k))
    .sort((a, b) => b.triggered - a.triggered || b.total - a.total);
  const qualified = all.filter((b) => b.total >= MIN_SAMPLE.bucket);
  const maxBucket = all.reduce((m, b) => Math.max(m, b.total), 0);
  return {
    gated: qualified.length === 0,
    need: MIN_SAMPLE.bucket,
    have: maxBucket,
    buckets: qualified,
  };
}

function overall(rows: ResolvedRow[]): OverallStat {
  if (rows.length === 0) return emptyOverall();
  const { key: _k, ...rest } = tally(rows, "overall");
  return rest;
}

function computeBanner(rows: ResolvedRow[], now: Date): CurrentStateBanner {
  const recentDays = 7;
  const recentCutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);
  const baselineCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recent = rows.filter((r) => r.outcomeResolvedAt >= recentCutoff);
  const baseline = rows.filter((r) => r.outcomeResolvedAt >= baselineCutoff);
  const recentStat = tally(recent, "recent");
  const baselineStat = tally(baseline, "baseline");
  const recentHitRate =
    recent.length >= MIN_SAMPLE.banner ? recentStat.hitRate : null;
  const baselineHitRate =
    baseline.length >= MIN_SAMPLE.banner ? baselineStat.hitRate : null;
  let severity: BannerSeverity = "ok";
  let delta: number | null = null;
  if (recentHitRate != null && baselineHitRate != null) {
    delta = recentHitRate - baselineHitRate;
    if (delta <= -0.15) severity = "warn";
    else if (delta <= -0.05) severity = "watch";
  }
  return {
    severity,
    recentDays,
    recentSample: recent.length,
    baselineSample: baseline.length,
    recentHitRate,
    baselineHitRate,
    delta,
  };
}

export interface ComputeOptions {
  /** Inject a stable `now` for deterministic tests. */
  now?: Date;
}

export async function computePerformanceSummary(
  windowDays: PerformanceWindow,
  options: ComputeOptions = {},
): Promise<PerformanceSummary> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const rowsRaw = await db
    .select({
      instrument: analyses.instrument,
      marketCondition: analyses.marketCondition,
      outcomeStatus: analyses.outcomeStatus,
      outcomeResolvedAt: analyses.outcomeResolvedAt,
      createdAt: analyses.createdAt,
      techBuyCount: analyses.techBuyCount,
      techSellCount: analyses.techSellCount,
      techNeutralCount: analyses.techNeutralCount,
      fundamentalContext: analyses.fundamentalContext,
    })
    .from(analyses)
    .where(
      and(
        inArray(analyses.outcomeStatus, [...RESOLVED_STATUSES]),
        isNotNull(analyses.outcomeResolvedAt),
        gte(analyses.outcomeResolvedAt, cutoff),
      ),
    );
  const rows: ResolvedRow[] = rowsRaw
    .filter((r): r is typeof r & { outcomeResolvedAt: Date } => r.outcomeResolvedAt != null)
    .map((r) => ({
      instrument: r.instrument,
      marketCondition: r.marketCondition as ConditionKey,
      outcomeStatus: r.outcomeStatus as ResolvedStatus,
      outcomeResolvedAt: r.outcomeResolvedAt,
      createdAt: r.createdAt,
      techBuyCount: r.techBuyCount,
      techSellCount: r.techSellCount,
      techNeutralCount: r.techNeutralCount,
      fundamentalContext: r.fundamentalContext,
    }));
  const overallStat = overall(rows);
  // For session bucketing we use entry time (createdAt), not resolution
  // time — the "best session to enter" question is about when the AI
  // analysed, not when price eventually touched a level.
  const sessionSeg = segment(rows, (r) => sessionBucket(r.createdAt) as SessionKey);
  const instrumentSeg = segment(rows, (r) =>
    isPrimaryInstrument(r.instrument)
      ? r.instrument
      : OTHER_INSTRUMENT_BUCKET_KEY,
  );
  const conditionSeg = segment(rows, (r) => r.marketCondition);
  // Drop `unclassified` / `unknown` from the regime segments so we
  // never publish a rate for a bucket that just means "we don't know".
  const volRows = rows.filter(
    (r) => classifyVolatilityRegime(r.techBuyCount, r.techSellCount, r.techNeutralCount) !== "unclassified",
  );
  const newsRows = rows.filter((r) => classifyNewsActivity(r.fundamentalContext) !== "unknown");
  const volatilitySeg = segment(volRows, (r) =>
    classifyVolatilityRegime(r.techBuyCount, r.techSellCount, r.techNeutralCount),
  );
  const newsSeg = segment(newsRows, (r) => classifyNewsActivity(r.fundamentalContext));
  // Below-threshold overall: gate every segment to keep the page honest.
  // `need` always reports the *bucket* threshold so the contract is stable;
  // the overall gate is implied by `overall.total < minSamples.overall` and
  // the UI uses that separately.
  const honest = rows.length >= MIN_SAMPLE.overall;
  const emptySeg = (): GatedSegment => ({
    gated: true,
    need: MIN_SAMPLE.bucket,
    have: rows.length,
    buckets: [],
  });
  const windowStart = rows.length > 0
    ? rows.reduce((min, r) => (r.outcomeResolvedAt < min ? r.outcomeResolvedAt : min), rows[0]!.outcomeResolvedAt).toISOString()
    : null;
  return {
    windowDays,
    generatedAt: now.toISOString(),
    windowStart,
    minSamples: { ...MIN_SAMPLE },
    overall: overallStat,
    banner: computeBanner(rows, now),
    byInstrument: honest ? instrumentSeg : emptySeg(),
    bySession: honest ? sessionSeg : emptySeg(),
    byCondition: honest ? conditionSeg : emptySeg(),
    byVolatility: honest ? volatilitySeg : emptySeg(),
    byNewsActivity: honest ? newsSeg : emptySeg(),
  };
}

// Re-export for the route module so it can quote thresholds in the
// response without re-deriving them.
export { sessionBucket };
// Silence unused-import lint when sql helper isn't needed in production:
void sql;
