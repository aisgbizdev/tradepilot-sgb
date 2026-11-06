// Personal Trader Mirror (task #162). Reads the user's journal +
// analysis history and surfaces behavioural patterns about *them as a
// trader*, not about the market. Every insight is computed on demand
// (no persistent aggregate table) — journal volume per user is small
// enough (a few hundred rows worst case) that the JS-side aggregation
// cost stays under a few ms per request.
//
// Every category respects a minimum-sample threshold and returns
// `{ gated: true, reason: 'need_more_data', need, have }` when the
// cohort is too thin — so the UI never confidently states a "70% win
// rate" derived from 3 trades.

import { db } from "./db";
import { tradeJournal, analyses } from "@workspace/db/schema";
import { and, eq, desc, gte } from "drizzle-orm";
import type { TradePlanShape } from "@workspace/db/schema";

const DEFAULT_TIMEZONE = "Asia/Jakarta";

// Minimum-sample thresholds. Tuned conservatively: a single category
// only becomes visible after the user has *meaningfully* used it.
// Re-exported so the test suite can assert against the same numbers
// the production engine uses.
export const MIN_SAMPLE = {
  /** Entries-per-session for "best session" to render. */
  session: 5,
  /** Entries-per-instrument for "best/worst instrument" to render. */
  instrument: 5,
  /** Entries-per-time-bucket for "best/worst time of day" to render. */
  timing: 5,
  /** Resolved trades following a prior loss before "post-loss" appears. */
  postLoss: 5,
  /** Linked (journal⇄analysis) closed trades before exit-discipline appears. */
  exitDiscipline: 5,
  /** Overall resolved trades before *any* category can render. */
  overall: 5,
} as const;

type Outcome = "win" | "loss" | "breakeven" | "open" | "skipped";

interface JournalRow {
  id: number;
  analysisId: number | null;
  instrument: string;
  side: "buy" | "sell";
  entryPrice: string | null;
  exitPrice: string | null;
  pnlPercent: string | null;
  outcome: Outcome;
  tradedAt: Date;
}

interface AnalysisRow {
  id: number;
  tradePlan: TradePlanShape | null;
}

// FX-session bucketing by UTC hour. Matches the convention used by
// /journal/stats so the Mirror "best session" insight lines up with
// the existing journal stats panel. Asia covers the Tokyo session,
// London the European session, NY the American session.
export type SessionKey = "asia" | "london" | "newyork" | "off";

export function sessionBucket(d: Date): SessionKey {
  const h = d.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 13) return "london";
  if (h >= 13 && h < 21) return "newyork";
  return "off";
}

// Hour-of-day bucket in the user's local timezone. Coarser than per-
// hour to keep sample size workable: morning 06-11, midday 11-16,
// afternoon 16-21, late 21-06. Hour boundaries are inclusive of the
// lower edge.
export type TimeBucket = "morning" | "midday" | "afternoon" | "late";

export function timeBucket(d: Date, timezone: string): TimeBucket {
  let hour: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const h = parts.find((p) => p.type === "hour")?.value ?? "";
    const parsed = parseInt(h, 10);
    hour = Number.isFinite(parsed) ? (parsed === 24 ? 0 : parsed) : d.getUTCHours();
  } catch {
    hour = d.getUTCHours();
  }
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "midday";
  if (hour >= 16 && hour < 21) return "afternoon";
  return "late";
}

export interface GroupStat {
  key: string;
  total: number;
  wins: number;
  winRate: number;
  avgPnlPercent: number | null;
}

export interface GatedInsight<T> {
  gated: boolean;
  /** Why we're suppressing (only meaningful when gated=true). */
  reason?: "need_more_data";
  need?: number;
  have?: number;
  data?: T;
}

export interface SessionInsight {
  best: GroupStat | null;
  worst: GroupStat | null;
  all: GroupStat[];
}

export interface InstrumentInsight {
  best: GroupStat | null;
  worst: GroupStat | null;
  top: GroupStat[];
}

export interface TimingInsight {
  best: GroupStat | null;
  worst: GroupStat | null;
  all: GroupStat[];
}

export interface PostLossInsight {
  /** Win rate of the *next* trade after a prior loss. */
  afterLossWinRate: number;
  /** Baseline overall win rate for comparison. */
  baselineWinRate: number;
  /** Difference (after-loss minus baseline), negative = tilt. */
  delta: number;
  sample: number;
}

export interface ExitDisciplineInsight {
  /** Average AI-projected favourable move, in % from entry to TP1. */
  avgProjectedPct: number;
  /** Average actual captured move, in % (absolute pnlPercent on wins). */
  avgCapturedPct: number;
  /** captured / projected, e.g. 0.4 = "you take ~40% of the AI's projection". */
  captureRatio: number;
  sample: number;
}

export interface TraderMirrorInsights {
  /** Window the insights were computed over (days). null = all-time. */
  windowDays: number | null;
  /** Total resolved trades inside the window. */
  totalResolved: number;
  /** True when even the overall threshold isn't met yet. */
  overallGated: boolean;
  sessions: GatedInsight<SessionInsight>;
  instruments: GatedInsight<InstrumentInsight>;
  timing: GatedInsight<TimingInsight>;
  postLoss: GatedInsight<PostLossInsight>;
  exitDiscipline: GatedInsight<ExitDisciplineInsight>;
}

function isResolved(o: Outcome): boolean {
  return o === "win" || o === "loss" || o === "breakeven";
}

function buildGroup(
  key: string,
  rows: JournalRow[],
): GroupStat {
  const total = rows.length;
  const wins = rows.filter((r) => r.outcome === "win").length;
  const pctValues = rows
    .map((r) => (r.pnlPercent != null ? Number(r.pnlPercent) : NaN))
    .filter((n) => Number.isFinite(n));
  const avgPnlPercent =
    pctValues.length > 0
      ? pctValues.reduce((a, b) => a + b, 0) / pctValues.length
      : null;
  return {
    key,
    total,
    wins,
    winRate: total > 0 ? wins / total : 0,
    avgPnlPercent,
  };
}

function rankGroups(groups: GroupStat[], minSample: number) {
  const qualified = groups.filter((g) => g.total >= minSample);
  if (qualified.length === 0) return { best: null, worst: null, all: groups };
  // Sort by avgPnlPercent when available, else by winRate. Higher is
  // better — same convention as /journal/stats.
  const sorted = [...qualified].sort((a, b) => {
    const av = a.avgPnlPercent ?? a.winRate * 100;
    const bv = b.avgPnlPercent ?? b.winRate * 100;
    return bv - av;
  });
  return {
    best: sorted[0] ?? null,
    worst: sorted.length > 1 ? sorted[sorted.length - 1]! : null,
    all: groups,
  };
}

function computeSessions(rows: JournalRow[]): GatedInsight<SessionInsight> {
  const buckets = new Map<SessionKey, JournalRow[]>();
  for (const r of rows) {
    if (!isResolved(r.outcome)) continue;
    const k = sessionBucket(r.tradedAt);
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  }
  const groups: GroupStat[] = Array.from(buckets.entries()).map(([k, list]) =>
    buildGroup(k, list),
  );
  const maxBucket = groups.reduce((m, g) => Math.max(m, g.total), 0);
  if (maxBucket < MIN_SAMPLE.session) {
    return {
      gated: true,
      reason: "need_more_data",
      need: MIN_SAMPLE.session,
      have: maxBucket,
    };
  }
  const ranked = rankGroups(groups, MIN_SAMPLE.session);
  return { gated: false, data: ranked };
}

function computeInstruments(
  rows: JournalRow[],
): GatedInsight<InstrumentInsight> {
  const buckets = new Map<string, JournalRow[]>();
  for (const r of rows) {
    if (!isResolved(r.outcome)) continue;
    const list = buckets.get(r.instrument) ?? [];
    list.push(r);
    buckets.set(r.instrument, list);
  }
  const groups: GroupStat[] = Array.from(buckets.entries()).map(([k, list]) =>
    buildGroup(k, list),
  );
  const maxBucket = groups.reduce((m, g) => Math.max(m, g.total), 0);
  if (maxBucket < MIN_SAMPLE.instrument) {
    return {
      gated: true,
      reason: "need_more_data",
      need: MIN_SAMPLE.instrument,
      have: maxBucket,
    };
  }
  const ranked = rankGroups(groups, MIN_SAMPLE.instrument);
  // Top-by-volume for the dashboard tile — separate from best/worst
  // so a high-volume instrument the user is *losing* on still shows up.
  const top = [...groups].sort((a, b) => b.total - a.total).slice(0, 5);
  return {
    gated: false,
    data: { best: ranked.best, worst: ranked.worst, top },
  };
}

function computeTiming(
  rows: JournalRow[],
  timezone: string,
): GatedInsight<TimingInsight> {
  const buckets = new Map<TimeBucket, JournalRow[]>();
  for (const r of rows) {
    if (!isResolved(r.outcome)) continue;
    const k = timeBucket(r.tradedAt, timezone);
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  }
  const groups: GroupStat[] = Array.from(buckets.entries()).map(([k, list]) =>
    buildGroup(k, list),
  );
  const maxBucket = groups.reduce((m, g) => Math.max(m, g.total), 0);
  if (maxBucket < MIN_SAMPLE.timing) {
    return {
      gated: true,
      reason: "need_more_data",
      need: MIN_SAMPLE.timing,
      have: maxBucket,
    };
  }
  const ranked = rankGroups(groups, MIN_SAMPLE.timing);
  return { gated: false, data: ranked };
}

function computePostLoss(rows: JournalRow[]): GatedInsight<PostLossInsight> {
  // Walk the user's trades in chronological order. Whenever a loss is
  // immediately followed (per-instrument-agnostic) by a resolved
  // trade, count the follow-up's outcome. Skipped/open trades are
  // ignored — they're not a "next trade" event the user can tilt on.
  const ordered = rows
    .filter((r) => isResolved(r.outcome))
    .sort((a, b) => a.tradedAt.getTime() - b.tradedAt.getTime());
  let postLossSample = 0;
  let postLossWins = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    if (prev.outcome !== "loss") continue;
    postLossSample += 1;
    if (curr.outcome === "win") postLossWins += 1;
  }
  if (postLossSample < MIN_SAMPLE.postLoss) {
    return {
      gated: true,
      reason: "need_more_data",
      need: MIN_SAMPLE.postLoss,
      have: postLossSample,
    };
  }
  const baselineWins = ordered.filter((r) => r.outcome === "win").length;
  const baselineWinRate = ordered.length > 0 ? baselineWins / ordered.length : 0;
  const afterLossWinRate = postLossWins / postLossSample;
  return {
    gated: false,
    data: {
      afterLossWinRate,
      baselineWinRate,
      delta: afterLossWinRate - baselineWinRate,
      sample: postLossSample,
    },
  };
}

function computeExitDiscipline(
  journal: JournalRow[],
  analysesById: Map<number, AnalysisRow>,
): GatedInsight<ExitDisciplineInsight> {
  // "Exit too early" = user repeatedly closes for less than the AI
  // projected. Compare:
  //   projected = |TP1 - entryAnchor| / entryAnchor   (from the saved tradePlan)
  //   captured  = |pnlPercent|                        (from the journal)
  // …on closed trades that have both pieces of data.
  let projectedSum = 0;
  let capturedSum = 0;
  let sample = 0;
  for (const r of journal) {
    if (r.outcome !== "win") continue; // partial-capture only meaningful on wins
    if (r.analysisId == null) continue;
    if (r.pnlPercent == null) continue;
    const a = analysesById.get(r.analysisId);
    if (!a || !a.tradePlan) continue;
    const plan = a.tradePlan;
    const side = plan.preferredSide === "sell" ? plan.sell : plan.buy;
    const entry = Number(parseFirstNumber(side.entryZone));
    const tp1 = Number(side.takeProfit1);
    if (!Number.isFinite(entry) || !Number.isFinite(tp1) || entry <= 0) continue;
    const projectedPct = (Math.abs(tp1 - entry) / entry) * 100;
    const capturedPct = Math.abs(Number(r.pnlPercent));
    if (!Number.isFinite(capturedPct) || projectedPct <= 0) continue;
    projectedSum += projectedPct;
    capturedSum += capturedPct;
    sample += 1;
  }
  if (sample < MIN_SAMPLE.exitDiscipline) {
    return {
      gated: true,
      reason: "need_more_data",
      need: MIN_SAMPLE.exitDiscipline,
      have: sample,
    };
  }
  const avgProjectedPct = projectedSum / sample;
  const avgCapturedPct = capturedSum / sample;
  return {
    gated: false,
    data: {
      avgProjectedPct,
      avgCapturedPct,
      captureRatio: avgProjectedPct > 0 ? avgCapturedPct / avgProjectedPct : 0,
      sample,
    },
  };
}

// `entryZone` is a free-form string from the AI (e.g. "1.0850-1.0875"
// or "1.0860"). Parse the first numeric token as the anchor — good
// enough for an average-of-averages exit-discipline metric.
function parseFirstNumber(s: string): string {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : "";
}

export async function computeTraderMirror(
  userId: number,
  timezone: string = DEFAULT_TIMEZONE,
  opts: { windowDays?: number | null; now?: Date } = {},
): Promise<TraderMirrorInsights> {
  const windowDays = opts.windowDays ?? null;
  const now = opts.now ?? new Date();
  const conditions = [eq(tradeJournal.userId, userId)];
  if (windowDays != null) {
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    conditions.push(gte(tradeJournal.tradedAt, since));
  }
  const journalRows = await db
    .select({
      id: tradeJournal.id,
      analysisId: tradeJournal.analysisId,
      instrument: tradeJournal.instrument,
      side: tradeJournal.side,
      entryPrice: tradeJournal.entryPrice,
      exitPrice: tradeJournal.exitPrice,
      pnlPercent: tradeJournal.pnlPercent,
      outcome: tradeJournal.outcome,
      tradedAt: tradeJournal.tradedAt,
    })
    .from(tradeJournal)
    .where(and(...conditions))
    .orderBy(desc(tradeJournal.tradedAt));

  const rows: JournalRow[] = journalRows.map((r) => ({
    id: r.id,
    analysisId: r.analysisId,
    instrument: r.instrument,
    side: r.side as "buy" | "sell",
    entryPrice: r.entryPrice,
    exitPrice: r.exitPrice,
    pnlPercent: r.pnlPercent,
    outcome: r.outcome as Outcome,
    tradedAt: r.tradedAt,
  }));

  // Pull the trade plans for the analyses referenced by journal
  // entries — needed for the exit-discipline insight.
  const analysisIds = Array.from(
    new Set(rows.map((r) => r.analysisId).filter((v): v is number => v != null)),
  );
  const analysesById = new Map<number, AnalysisRow>();
  if (analysisIds.length > 0) {
    const aRows = await db
      .select({ id: analyses.id, tradePlan: analyses.tradePlan })
      .from(analyses)
      .where(
        and(
          eq(analyses.userId, userId),
          // Cheap to filter in JS since the set is bounded by the
          // user's journal volume; avoids the inArray import dance.
        ),
      );
    for (const a of aRows) {
      if (analysisIds.includes(a.id)) {
        analysesById.set(a.id, { id: a.id, tradePlan: a.tradePlan });
      }
    }
  }

  const resolvedTotal = rows.filter((r) => isResolved(r.outcome)).length;
  const overallGated = resolvedTotal < MIN_SAMPLE.overall;

  if (overallGated) {
    const need = MIN_SAMPLE.overall;
    return {
      windowDays,
      totalResolved: resolvedTotal,
      overallGated: true,
      sessions: { gated: true, reason: "need_more_data", need, have: resolvedTotal },
      instruments: { gated: true, reason: "need_more_data", need, have: resolvedTotal },
      timing: { gated: true, reason: "need_more_data", need, have: resolvedTotal },
      postLoss: { gated: true, reason: "need_more_data", need, have: resolvedTotal },
      exitDiscipline: { gated: true, reason: "need_more_data", need, have: resolvedTotal },
    };
  }

  return {
    windowDays,
    totalResolved: resolvedTotal,
    overallGated: false,
    sessions: computeSessions(rows),
    instruments: computeInstruments(rows),
    timing: computeTiming(rows, timezone),
    postLoss: computePostLoss(rows),
    exitDiscipline: computeExitDiscipline(rows, analysesById),
  };
}

// Build a short, bilingual list of human-readable highlights drawn
// from the insights bundle. Used both by the Mirror dashboard hero
// strip and by the weekly trader-report push body. Highlights are
// ordered by "punchiness" — concrete numbers first, comparative
// rankings next. Caller picks the top N.
export interface Highlight {
  /** Stable id so the UI can react to "new" highlights week over week. */
  id: string;
  en: string;
  id_: string;
}

export function buildHighlights(insights: TraderMirrorInsights): Highlight[] {
  const out: Highlight[] = [];
  if (!insights.sessions.gated && insights.sessions.data?.best) {
    const b = insights.sessions.data.best;
    const pct = Math.round(b.winRate * 100);
    out.push({
      id: `best-session:${b.key}`,
      en: `Your best session is ${sessionLabelEn(b.key as SessionKey)} — ${pct}% win rate over ${b.total} trades.`,
      id_: `Sesi terbaikmu adalah ${sessionLabelId(b.key as SessionKey)} — win rate ${pct}% dari ${b.total} trade.`,
    });
  }
  if (!insights.instruments.gated && insights.instruments.data?.worst) {
    const w = insights.instruments.data.worst;
    if (w.winRate < 0.4 && w.total >= MIN_SAMPLE.instrument) {
      const pct = Math.round(w.winRate * 100);
      out.push({
        id: `worst-instrument:${w.key}`,
        en: `From your last ${w.total} ${w.key} trades, only ${w.wins} were wins (${pct}%).`,
        id_: `Dari ${w.total} trade ${w.key} terakhirmu, cuma ${w.wins} yang profit (${pct}%).`,
      });
    }
  }
  if (!insights.instruments.gated && insights.instruments.data?.best) {
    const b = insights.instruments.data.best;
    const pct = Math.round(b.winRate * 100);
    out.push({
      id: `best-instrument:${b.key}`,
      en: `${b.key} is your strongest instrument — ${pct}% win rate (${b.wins}/${b.total}).`,
      id_: `${b.key} adalah instrumen terkuatmu — win rate ${pct}% (${b.wins}/${b.total}).`,
    });
  }
  if (!insights.timing.gated && insights.timing.data?.best) {
    const b = insights.timing.data.best;
    out.push({
      id: `best-time:${b.key}`,
      en: `You trade best during the ${timeLabelEn(b.key as TimeBucket)} window — ${Math.round(b.winRate * 100)}% win rate.`,
      id_: `Kamu paling sering profit di ${timeLabelId(b.key as TimeBucket)} — win rate ${Math.round(b.winRate * 100)}%.`,
    });
  }
  if (!insights.postLoss.gated && insights.postLoss.data) {
    const p = insights.postLoss.data;
    if (p.delta <= -0.1) {
      const dropPct = Math.round(Math.abs(p.delta) * 100);
      out.push({
        id: `post-loss-tilt`,
        en: `After a loss, your next-trade win rate drops by ${dropPct} points — watch for revenge trades.`,
        id_: `Setelah loss, win rate trade berikutnyamu turun ${dropPct} poin — hati-hati revenge trade.`,
      });
    } else if (p.delta >= 0.05) {
      out.push({
        id: `post-loss-resilient`,
        en: `You bounce back well — your win rate after a loss is actually higher than your baseline.`,
        id_: `Kamu tahan banting — win rate setelah loss justru lebih tinggi dari rata-rata.`,
      });
    }
  }
  if (!insights.exitDiscipline.gated && insights.exitDiscipline.data) {
    const e = insights.exitDiscipline.data;
    if (e.captureRatio > 0 && e.captureRatio < 0.6) {
      const pct = Math.round(e.captureRatio * 100);
      out.push({
        id: `exit-early`,
        en: `On winning trades you capture only ${pct}% of the AI's projected move — you may be exiting too early.`,
        id_: `Di trade profit, kamu cuma ambil ${pct}% dari proyeksi AI — kemungkinan exit kecepatan.`,
      });
    }
  }
  return out;
}

function sessionLabelEn(k: SessionKey): string {
  return k === "asia" ? "Asia" : k === "london" ? "London" : k === "newyork" ? "New York" : "Off-hours";
}
function sessionLabelId(k: SessionKey): string {
  return k === "asia" ? "sesi Asia" : k === "london" ? "sesi London" : k === "newyork" ? "sesi New York" : "luar jam aktif";
}
function timeLabelEn(k: TimeBucket): string {
  return k === "morning" ? "morning (06–11)" : k === "midday" ? "midday (11–16)" : k === "afternoon" ? "afternoon (16–21)" : "late-night (21–06)";
}
function timeLabelId(k: TimeBucket): string {
  return k === "morning" ? "pagi (06–11)" : k === "midday" ? "siang (11–16)" : k === "afternoon" ? "sore (16–21)" : "tengah malam (21–06)";
}
