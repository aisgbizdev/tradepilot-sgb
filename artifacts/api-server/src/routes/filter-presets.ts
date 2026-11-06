import { Router } from "express";
import { db } from "../lib/db";
import { filterPresets } from "@workspace/db/schema";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

const router = Router();

const MAX_NAME_LEN = 40;
const MAX_PRESETS_PER_USER = 20;
const MAX_MULTI = 50;
const MAX_FILTER_ITEM_LEN = 32;
const MAX_SEARCH_LEN = 100;
const ALLOWED_MODES = new Set(["beginner", "pro", ""]);
// Dedicated advisory-lock namespace so the per-user cap enforcement here
// can't collide with the analyses-quota lock in routes/analyses.ts.
const PRESET_LOCK_NAMESPACE = 4243;

type FilterShape = {
  mode: "beginner" | "pro" | "";
  instruments: string[];
  timeframes: string[];
  from: string;
  to: string;
  q: string;
};

// Normalise a name the same way for create and rename so the unique
// (userId, name) constraint sees a consistent value and the UI can't
// trick the user into saving "  XAU  " as a separate preset from "XAU".
function normaliseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NAME_LEN);
}

// Normalise the incoming filters payload to the exact shape the history
// page consumes. We deliberately *drop* unknown keys instead of
// preserving them so a forward-compat client cannot smuggle arbitrary
// JSON into the column. Length-cap every text field so a malicious
// caller cannot bloat the row.
function normaliseFilters(raw: unknown): FilterShape | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode =
    typeof r["mode"] === "string" && ALLOWED_MODES.has(r["mode"] as string)
      ? (r["mode"] as "beginner" | "pro" | "")
      : "";
  const toStrArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of v) {
      if (typeof item !== "string") continue;
      // Cap per-item length BEFORE dedupe so an attacker can't bypass
      // MAX_MULTI by smuggling oversized strings into the row.
      const t = item.trim().slice(0, MAX_FILTER_ITEM_LEN);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_MULTI) break;
    }
    return out;
  };
  const toShortStr = (v: unknown, max: number): string => {
    if (typeof v !== "string") return "";
    return v.trim().slice(0, max);
  };
  return {
    mode,
    instruments: toStrArray(r["instruments"]),
    timeframes: toStrArray(r["timeframes"]),
    from: toShortStr(r["from"], 10),
    to: toShortStr(r["to"], 10),
    q: toShortStr(r["q"], MAX_SEARCH_LEN),
  };
}

router.get("/filter-presets", requireAuth, async (req: AuthRequest, res) => {
  const rows = await db
    .select()
    .from(filterPresets)
    .where(eq(filterPresets.userId, req.userId!))
    .orderBy(asc(filterPresets.createdAt));
  res.json({ presets: rows });
});

router.post("/filter-presets", requireAuth, async (req: AuthRequest, res) => {
  const name = normaliseName(req.body?.name);
  const filters = normaliseFilters(req.body?.filters);
  if (!name) {
    res.status(400).json({ error: "Nama preset wajib diisi" });
    return;
  }
  if (!filters) {
    res.status(400).json({ error: "Filter preset tidak valid" });
    return;
  }

  // Atomically count + insert inside a transaction guarded by a
  // per-user advisory lock so two concurrent saves at the cap boundary
  // can't both pass the count check and overshoot the cap. The lock is
  // xact-scoped — it releases on COMMIT/ROLLBACK automatically.
  try {
    const result = await db.transaction<
      | { kind: "ok"; row: typeof filterPresets.$inferSelect }
      | { kind: "cap" }
    >(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${PRESET_LOCK_NAMESPACE}::int, ${req.userId!}::int)`,
      );
      const [tally] = await tx
        .select({ c: count(filterPresets.id) })
        .from(filterPresets)
        .where(eq(filterPresets.userId, req.userId!));
      if (Number(tally?.c ?? 0) >= MAX_PRESETS_PER_USER) {
        return { kind: "cap" };
      }
      const [row] = await tx
        .insert(filterPresets)
        .values({ userId: req.userId!, name, filters })
        .returning();
      return { kind: "ok", row };
    });
    if (result.kind === "cap") {
      res
        .status(409)
        .json({ error: `Maksimal ${MAX_PRESETS_PER_USER} preset per pengguna` });
      return;
    }
    res.status(201).json(result.row);
  } catch (err) {
    // Duplicate (userId, name) — surface a clear 409 instead of a
    // generic 500 so the UI can show "name already used".
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "Nama preset sudah digunakan" });
      return;
    }
    logger.error({ err }, "filter-presets: insert failed");
    res.status(500).json({ error: "Gagal menyimpan preset" });
  }
});

router.patch("/filter-presets/:id", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "ID preset tidak valid" });
    return;
  }
  const name = normaliseName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "Nama preset wajib diisi" });
    return;
  }
  try {
    const [row] = await db
      .update(filterPresets)
      .set({ name, updatedAt: new Date() })
      .where(
        and(eq(filterPresets.id, id), eq(filterPresets.userId, req.userId!)),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Preset tidak ditemukan" });
      return;
    }
    res.json(row);
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "Nama preset sudah digunakan" });
      return;
    }
    logger.error({ err }, "filter-presets: rename failed");
    res.status(500).json({ error: "Gagal mengubah nama preset" });
  }
});

router.delete("/filter-presets/:id", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "ID preset tidak valid" });
    return;
  }
  const [row] = await db
    .delete(filterPresets)
    .where(
      and(eq(filterPresets.id, id), eq(filterPresets.userId, req.userId!)),
    )
    .returning({ id: filterPresets.id });
  if (!row) {
    res.status(404).json({ error: "Preset tidak ditemukan" });
    return;
  }
  res.status(204).end();
});

export default router;
