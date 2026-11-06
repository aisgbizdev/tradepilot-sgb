import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { tradeJournal, analyses } from "@workspace/db/schema";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";
import {
  journalWriteLimiter,
  journalReadLimiter,
} from "../middleware/rate-limit";
import { awardProgression, revokeProgressionEvidence } from "../lib/progression";

const router = Router();

const SIDES = ["buy", "sell"] as const;
const OUTCOMES = ["win", "loss", "breakeven", "open", "skipped"] as const;

// Loose numeric-string parser: accept either a number or a string the
// user typed in the form ("1.0875"). We store as text to preserve the
// exact precision the user typed (mirrors the user_price_alerts
// convention). Rejects NaN / non-finite / non-numeric strings.
const numericText = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
  .refine((s) => s === "" || Number.isFinite(Number(s)), {
    message: "Must be a finite number",
  })
  .transform((s) => (s === "" ? null : s));

const optionalNumericText = numericText.optional().nullable();

const baseSchema = z.object({
  analysisId: z.number().int().positive().optional().nullable(),
  instrument: z.string().trim().min(1).max(64),
  side: z.enum(SIDES),
  entryPrice: optionalNumericText,
  exitPrice: optionalNumericText,
  quantity: optionalNumericText,
  pnlAmount: optionalNumericText,
  pnlPercent: optionalNumericText,
  outcome: z.enum(OUTCOMES).default("open"),
  mood: z.string().trim().max(40).optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
  tradedAt: z.coerce.date().optional(),
});

const createSchema = baseSchema;
const updateSchema = baseSchema.partial();

// Auto-derive pnlAmount + pnlPercent + outcome from entry/exit/side when
// the user didn't provide them explicitly. Keeps the form simple
// ("enter exit price, we'll do the math") while still letting power
// users override with their own broker-reported P/L.
function computeDerived(input: {
  side: "buy" | "sell";
  entryPrice: string | null;
  exitPrice: string | null;
  quantity: string | null;
  pnlAmount: string | null;
  pnlPercent: string | null;
  outcome: (typeof OUTCOMES)[number];
}) {
  const entry = input.entryPrice != null ? Number(input.entryPrice) : null;
  const exit = input.exitPrice != null ? Number(input.exitPrice) : null;
  const qty = input.quantity != null ? Number(input.quantity) : 1;

  let pnlAmount = input.pnlAmount;
  let pnlPercent = input.pnlPercent;
  let outcome = input.outcome;

  if (
    entry != null &&
    exit != null &&
    Number.isFinite(entry) &&
    Number.isFinite(exit) &&
    entry > 0
  ) {
    const direction = input.side === "buy" ? 1 : -1;
    const diff = (exit - entry) * direction;
    if (pnlAmount == null) {
      pnlAmount = String(diff * (Number.isFinite(qty) ? qty : 1));
    }
    if (pnlPercent == null) {
      pnlPercent = String((diff / entry) * 100);
    }
    if (outcome === "open") {
      outcome = diff > 0 ? "win" : diff < 0 ? "loss" : "breakeven";
    }
  }

  return { pnlAmount, pnlPercent, outcome };
}

function serialize(row: typeof tradeJournal.$inferSelect) {
  return {
    id: row.id,
    analysisId: row.analysisId,
    instrument: row.instrument,
    side: row.side as "buy" | "sell",
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    quantity: row.quantity,
    pnlAmount: row.pnlAmount,
    pnlPercent: row.pnlPercent,
    outcome: row.outcome as (typeof OUTCOMES)[number],
    mood: row.mood,
    note: row.note,
    tradedAt: row.tradedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A reflection is deliberately judged only from planning/reflection fields,
// never outcome, P/L, quantity, or trade frequency.
function journalQuality(row: { note: string | null; mood: string | null; entryPrice: string | null }): number {
  return (row.note?.trim().length ?? 0) >= 10 ? 100 : 0;
}

// Normalize a date-only `to` filter ("YYYY-MM-DD" → midnight UTC) so the
// upper bound is inclusive of the entire selected day. Without this the
// raw `lte(tradedAt, to)` excludes nearly every entry on the chosen end
// date because the parsed Date is start-of-day. If the caller already
// passed a time component, leave it untouched.
function normalizeEndOfDay(d: Date): Date {
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    const end = new Date(d);
    end.setUTCHours(23, 59, 59, 999);
    return end;
  }
  return d;
}

// Derive a coarse trading-session bucket from a UTC timestamp. Used by
// the stats endpoint to compute "best/worst session". Approximate by
// UTC hour — good enough for the journal summary; we don't need
// holiday-aware FX-session windows here.
function sessionBucket(d: Date): "asia" | "london" | "newyork" | "off" {
  const h = d.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 13) return "london";
  if (h >= 13 && h < 21) return "newyork";
  return "off";
}

// GET /api/journal — list with optional filters. All filters are
// optional and combine with AND semantics. `outcome` accepts the
// shorthand "win"/"loss" or any of the stored OUTCOMES values.
router.get(
  "/journal",
  requireAuth,
  journalReadLimiter,
  async (req: AuthRequest, res) => {
    const querySchema = z.object({
      instrument: z.string().trim().max(64).optional(),
      outcome: z.enum(OUTCOMES).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid filters" });
      return;
    }
    const { instrument, outcome, from, to, limit } = parsed.data;

    const conditions = [eq(tradeJournal.userId, req.userId!)];
    if (instrument) conditions.push(eq(tradeJournal.instrument, instrument));
    if (outcome) conditions.push(eq(tradeJournal.outcome, outcome));
    if (from) conditions.push(gte(tradeJournal.tradedAt, from));
    if (to) conditions.push(lte(tradeJournal.tradedAt, normalizeEndOfDay(to)));

    const rows = await db
      .select()
      .from(tradeJournal)
      .where(and(...conditions))
      .orderBy(desc(tradeJournal.tradedAt))
      .limit(limit);

    res.json({ entries: rows.map(serialize) });
  },
);

// GET /api/journal/sentiment — anonymised long-vs-short aggregate for
// a single instrument over the last N days, sourced from journal
// entries across ALL users. The point is "67% trader TP Indo lagi
// long XAU/USD" — data nobody else has — without leaking which
// specific user took which side.
//
// Privacy gate: results are only returned when the window contains
// BOTH at least `MIN_ENTRIES` entries AND `MIN_TRADERS` distinct
// userIds. Below either threshold we return `gated: true` and null
// percentages so the UI shows a "not enough data yet" placeholder.
// This prevents re-identification in low-volume buckets (e.g. an
// obscure instrument with two entries from the same trader).
//
// `outcome` is intentionally NOT filtered: a fresh "open" entry is
// still a directional vote. Skipped trades ARE excluded because they
// represent the user deciding NOT to take that direction.
//
// Auth: requires login but is rate-limited via the existing journal
// read limiter — the response carries no PII so all authenticated
// users see the same numbers for the same instrument.
const SENTIMENT_WINDOW_DAYS = 7;
const SENTIMENT_MIN_ENTRIES = 5;
const SENTIMENT_MIN_TRADERS = 3;

router.get(
  "/journal/sentiment",
  requireAuth,
  journalReadLimiter,
  async (req: AuthRequest, res) => {
    const querySchema = z.object({
      instrument: z.string().trim().min(1).max(64),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid instrument" });
      return;
    }
    const { instrument } = parsed.data;
    const windowStart = new Date(
      Date.now() - SENTIMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const rows = await db
      .select({
        userId: tradeJournal.userId,
        side: tradeJournal.side,
        outcome: tradeJournal.outcome,
      })
      .from(tradeJournal)
      .where(
        and(
          eq(tradeJournal.instrument, instrument),
          gte(tradeJournal.tradedAt, windowStart),
        ),
      );

    // Skipped entries represent "decided not to take this trade" — no
    // directional vote — so they're dropped from the sample entirely.
    // Counting them would also inflate `sampleSize` past the privacy
    // gate without contributing any usable signal.
    const directional = rows.filter(
      (r) =>
        (r.side === "buy" || r.side === "sell") && r.outcome !== "skipped",
    );
    const buys = directional.filter((r) => r.side === "buy").length;
    const sells = directional.filter((r) => r.side === "sell").length;
    const distinctTraders = new Set(directional.map((r) => r.userId)).size;
    const sampleSize = directional.length;

    const gated =
      sampleSize < SENTIMENT_MIN_ENTRIES ||
      distinctTraders < SENTIMENT_MIN_TRADERS;

    const buyPct =
      !gated && sampleSize > 0 ? Math.round((buys / sampleSize) * 100) : null;
    const sellPct =
      !gated && sampleSize > 0 ? Math.round((sells / sampleSize) * 100) : null;

    // When the cohort is below either threshold we deliberately suppress
    // `sampleSize` and `distinctTraders` as well — exposing the raw
    // counts would let an attacker repeatedly probe the endpoint and
    // infer whether a specific (small) trader population is active on
    // thin instruments. Below threshold we only confirm that we're
    // gated and echo the thresholds themselves.
    res.json({
      instrument,
      windowDays: SENTIMENT_WINDOW_DAYS,
      minSampleSize: SENTIMENT_MIN_ENTRIES,
      minDistinctTraders: SENTIMENT_MIN_TRADERS,
      sampleSize: gated ? null : sampleSize,
      distinctTraders: gated ? null : distinctTraders,
      gated,
      buyPct,
      sellPct,
    });
  },
);

// GET /api/journal/stats — summary stats across the user's journal
// (win rate, average P/L %, best/worst instrument, best/worst session).
// Computed in JS over the full result set rather than via SQL — journal
// volume per user is tiny (a few hundred rows worst case) so the extra
// query complexity isn't worth it.
router.get(
  "/journal/stats",
  requireAuth,
  journalReadLimiter,
  async (req: AuthRequest, res) => {
    const querySchema = z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid filters" });
      return;
    }
    const { from, to } = parsed.data;

    const conditions = [eq(tradeJournal.userId, req.userId!)];
    if (from) conditions.push(gte(tradeJournal.tradedAt, from));
    if (to) conditions.push(lte(tradeJournal.tradedAt, normalizeEndOfDay(to)));

    const rows = await db
      .select()
      .from(tradeJournal)
      .where(and(...conditions));

    let wins = 0;
    let losses = 0;
    let breakevens = 0;
    let open = 0;
    let skipped = 0;
    let totalPnlPercent = 0;
    let pnlSamples = 0;
    let totalPnlAmount = 0;
    let pnlAmountSamples = 0;

    const perInstrument = new Map<
      string,
      { wins: number; total: number; pnlPercentSum: number; samples: number }
    >();
    const perSession = new Map<
      string,
      { wins: number; total: number; pnlPercentSum: number; samples: number }
    >();

    for (const r of rows) {
      if (r.outcome === "win") wins += 1;
      else if (r.outcome === "loss") losses += 1;
      else if (r.outcome === "breakeven") breakevens += 1;
      else if (r.outcome === "open") open += 1;
      else if (r.outcome === "skipped") skipped += 1;

      const pp = r.pnlPercent != null ? Number(r.pnlPercent) : NaN;
      const pa = r.pnlAmount != null ? Number(r.pnlAmount) : NaN;
      if (Number.isFinite(pp)) {
        totalPnlPercent += pp;
        pnlSamples += 1;
      }
      if (Number.isFinite(pa)) {
        totalPnlAmount += pa;
        pnlAmountSamples += 1;
      }

      // Only resolved trades count toward best/worst groupings — open &
      // skipped have no signal about which instrument/session paid off.
      const resolved =
        r.outcome === "win" || r.outcome === "loss" || r.outcome === "breakeven";
      if (resolved) {
        const inst = perInstrument.get(r.instrument) ?? {
          wins: 0,
          total: 0,
          pnlPercentSum: 0,
          samples: 0,
        };
        inst.total += 1;
        if (r.outcome === "win") inst.wins += 1;
        if (Number.isFinite(pp)) {
          inst.pnlPercentSum += pp;
          inst.samples += 1;
        }
        perInstrument.set(r.instrument, inst);

        const bucket = sessionBucket(r.tradedAt);
        const sess = perSession.get(bucket) ?? {
          wins: 0,
          total: 0,
          pnlPercentSum: 0,
          samples: 0,
        };
        sess.total += 1;
        if (r.outcome === "win") sess.wins += 1;
        if (Number.isFinite(pp)) {
          sess.pnlPercentSum += pp;
          sess.samples += 1;
        }
        perSession.set(bucket, sess);
      }
    }

    const resolvedCount = wins + losses + breakevens;
    const winRate =
      wins + losses > 0 ? wins / (wins + losses) : null;
    const avgPnlPercent = pnlSamples > 0 ? totalPnlPercent / pnlSamples : null;
    const avgPnlAmount =
      pnlAmountSamples > 0 ? totalPnlAmount / pnlAmountSamples : null;

    const rank = (
      m: Map<
        string,
        { wins: number; total: number; pnlPercentSum: number; samples: number }
      >,
    ) => {
      const list = Array.from(m.entries()).map(([key, v]) => ({
        key,
        winRate: v.wins / v.total,
        total: v.total,
        avgPnlPercent: v.samples > 0 ? v.pnlPercentSum / v.samples : null,
      }));
      // Sort by avgPnlPercent when available, else by win rate. Require
      // at least 2 resolved trades to qualify as "best/worst" — a single
      // lucky entry shouldn't be crowned the user's edge.
      const qualified = list.filter((x) => x.total >= 2);
      if (qualified.length === 0) return { best: null, worst: null };
      qualified.sort((a, b) => {
        const av = a.avgPnlPercent ?? a.winRate * 100;
        const bv = b.avgPnlPercent ?? b.winRate * 100;
        return bv - av;
      });
      return {
        best: qualified[0] ?? null,
        worst:
          qualified.length > 1
            ? qualified[qualified.length - 1]!
            : null,
      };
    };

    const inst = rank(perInstrument);
    const sess = rank(perSession);

    res.json({
      totals: {
        entries: rows.length,
        wins,
        losses,
        breakevens,
        open,
        skipped,
        resolved: resolvedCount,
      },
      winRate,
      avgPnlPercent,
      avgPnlAmount,
      bestInstrument: inst.best,
      worstInstrument: inst.worst,
      bestSession: sess.best,
      worstSession: sess.worst,
    });
  },
);

// POST /api/journal — create a new journal entry. If `analysisId` is
// supplied we verify the analysis belongs to the caller so users can't
// attach journal entries to someone else's analysis (which would leak
// "X journaled this trade" hints in the history view).
router.post(
  "/journal",
  requireAuth,
  journalWriteLimiter,
  async (req: AuthRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid journal entry: check side, instrument, and prices",
      });
      return;
    }
    const data = parsed.data;

    if (data.analysisId != null) {
      const owned = await db
        .select({ id: analyses.id })
        .from(analyses)
        .where(
          and(
            eq(analyses.id, data.analysisId),
            eq(analyses.userId, req.userId!),
          ),
        )
        .limit(1);
      if (owned.length === 0) {
        res
          .status(404)
          .json({ error: "Linked analysis not found or not owned by user" });
        return;
      }
    }

    const derived = computeDerived({
      side: data.side,
      entryPrice: data.entryPrice ?? null,
      exitPrice: data.exitPrice ?? null,
      quantity: data.quantity ?? null,
      pnlAmount: data.pnlAmount ?? null,
      pnlPercent: data.pnlPercent ?? null,
      outcome: data.outcome,
    });

    const [row] = await db
      .insert(tradeJournal)
      .values({
        userId: req.userId!,
        analysisId: data.analysisId ?? null,
        instrument: data.instrument,
        side: data.side,
        entryPrice: data.entryPrice ?? null,
        exitPrice: data.exitPrice ?? null,
        quantity: data.quantity ?? null,
        pnlAmount: derived.pnlAmount,
        pnlPercent: derived.pnlPercent,
        outcome: derived.outcome,
        mood: data.mood ?? null,
        note: data.note ?? null,
        tradedAt: data.tradedAt ?? new Date(),
      })
      .returning();
    if (journalQuality(row)) await awardProgression({ userId: req.userId!, source: "quality_journal", sourceEventId: String(row.id), qualityScore: 100, metadata: { journalId: row.id } });
    res.status(201).json(serialize(row));
  },
);

// PATCH /api/journal/:id — partial update (typically used to close out
// an open trade by adding `exitPrice`). Recomputes derived P/L when
// entry/exit/side change and the user didn't override.
router.patch(
  "/journal/:id",
  requireAuth,
  journalWriteLimiter,
  async (req: AuthRequest, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid journal patch" });
      return;
    }

    const [existing] = await db
      .select()
      .from(tradeJournal)
      .where(
        and(eq(tradeJournal.id, id), eq(tradeJournal.userId, req.userId!)),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Journal entry not found" });
      return;
    }

    // Authz: if the patch is (re)linking this entry to an analysis, the
    // analysis must belong to the same user. Without this check a user
    // could craft a PATCH that points their entry at another user's
    // analysisId, leaking cross-user metadata via subsequent reads.
    // `null` means "unlink" and is always allowed.
    if (
      parsed.data.analysisId !== undefined &&
      parsed.data.analysisId !== null &&
      parsed.data.analysisId !== existing.analysisId
    ) {
      const owned = await db
        .select({ id: analyses.id })
        .from(analyses)
        .where(
          and(
            eq(analyses.id, parsed.data.analysisId),
            eq(analyses.userId, req.userId!),
          ),
        )
        .limit(1);
      if (owned.length === 0) {
        res
          .status(404)
          .json({ error: "Linked analysis not found or not owned by user" });
        return;
      }
    }

    const merged = {
      side: parsed.data.side ?? (existing.side as "buy" | "sell"),
      entryPrice:
        parsed.data.entryPrice !== undefined
          ? parsed.data.entryPrice ?? null
          : existing.entryPrice,
      exitPrice:
        parsed.data.exitPrice !== undefined
          ? parsed.data.exitPrice ?? null
          : existing.exitPrice,
      quantity:
        parsed.data.quantity !== undefined
          ? parsed.data.quantity ?? null
          : existing.quantity,
      pnlAmount:
        parsed.data.pnlAmount !== undefined
          ? parsed.data.pnlAmount ?? null
          : null,
      pnlPercent:
        parsed.data.pnlPercent !== undefined
          ? parsed.data.pnlPercent ?? null
          : null,
      outcome:
        parsed.data.outcome ?? (existing.outcome as (typeof OUTCOMES)[number]),
    };
    const derived = computeDerived(merged);

    const [row] = await db
      .update(tradeJournal)
      .set({
        ...(parsed.data.analysisId !== undefined && {
          analysisId: parsed.data.analysisId ?? null,
        }),
        ...(parsed.data.instrument !== undefined && {
          instrument: parsed.data.instrument,
        }),
        ...(parsed.data.side !== undefined && { side: parsed.data.side }),
        ...(parsed.data.entryPrice !== undefined && {
          entryPrice: parsed.data.entryPrice ?? null,
        }),
        ...(parsed.data.exitPrice !== undefined && {
          exitPrice: parsed.data.exitPrice ?? null,
        }),
        ...(parsed.data.quantity !== undefined && {
          quantity: parsed.data.quantity ?? null,
        }),
        pnlAmount: derived.pnlAmount,
        pnlPercent: derived.pnlPercent,
        outcome: derived.outcome,
        ...(parsed.data.mood !== undefined && {
          mood: parsed.data.mood ?? null,
        }),
        ...(parsed.data.note !== undefined && {
          note: parsed.data.note ?? null,
        }),
        ...(parsed.data.tradedAt !== undefined && {
          tradedAt: parsed.data.tradedAt,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(tradeJournal.id, id), eq(tradeJournal.userId, req.userId!)),
      )
      .returning();
    if (journalQuality(row)) await awardProgression({ userId: req.userId!, source: "quality_journal", sourceEventId: String(row.id), qualityScore: 100, metadata: { journalId: row.id } });
    else await revokeProgressionEvidence(req.userId!, "quality_journal", String(row.id), "Journal no longer meets minimum reflection quality");
    res.json(serialize(row));
  },
);

// DELETE /api/journal/:id — hard-delete. The journal is the user's
// own private record so we don't soft-delete; if they remove an entry
// they want it gone.
router.delete(
  "/journal/:id",
  requireAuth,
  journalWriteLimiter,
  async (req: AuthRequest, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const deleted = await db
      .delete(tradeJournal)
      .where(
        and(eq(tradeJournal.id, id), eq(tradeJournal.userId, req.userId!)),
      )
      .returning({ id: tradeJournal.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Journal entry not found" });
      return;
    }
    void revokeProgressionEvidence(req.userId!, "quality_journal", String(id), "Journal entry deleted");
    res.json({ message: "Journal entry deleted" });
  },
);

// GET /api/journal/for-analysis/:analysisId — returns the first journal
// entry the authenticated user linked to a specific analysis. Used by
// the analysis-detail page to check whether a "Catat di Jurnal" entry
// already exists so it can surface a "Sudah dicatat ✓" state instead
// of the empty CTA button. Returns 404 when no entry is found.
router.get(
  "/journal/for-analysis/:analysisId",
  requireAuth,
  journalReadLimiter,
  async (req: AuthRequest, res) => {
    const analysisId = Number(req.params["analysisId"]);
    if (!Number.isFinite(analysisId) || analysisId <= 0) {
      res.status(400).json({ error: "Invalid analysisId" });
      return;
    }
    const [row] = await db
      .select()
      .from(tradeJournal)
      .where(
        and(
          eq(tradeJournal.userId, req.userId!),
          eq(tradeJournal.analysisId, analysisId),
        ),
      )
      .limit(1);
    if (!row) {
      res
        .status(404)
        .json({ error: "No journal entry found for this analysis" });
      return;
    }
    res.json(serialize(row));
  },
);

// Suppress unused-import warning — `sql` is intentionally available
// for future hand-rolled aggregate queries if journal volume grows.
void sql;

export default router;
