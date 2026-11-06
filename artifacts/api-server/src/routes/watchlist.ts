import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { watchlistItems, analyses } from "@workspace/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

const addSchema = z.object({
  instrument: z.string().trim().min(1).max(64),
});

// GET /watchlist — list the user's starred instruments, joined to the
// most recent analysis (id + createdAt) per instrument so the dashboard
// card can deep-link straight to it.
router.get("/watchlist", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const items = await db
    .select({
      instrument: watchlistItems.instrument,
      addedAt: watchlistItems.createdAt,
    })
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, userId))
    .orderBy(watchlistItems.createdAt);

  if (items.length === 0) {
    res.json({ items: [] });
    return;
  }

  // Pull every analysis for the starred instruments, newest first, then
  // dedupe to the first (= newest) per instrument in JS. Keeps the query
  // simple and avoids a per-instrument round trip.
  const latestRows = await db
    .select({
      instrument: analyses.instrument,
      id: analyses.id,
      createdAt: analyses.createdAt,
    })
    .from(analyses)
    .where(
      and(
        eq(analyses.userId, userId),
        inArray(
          analyses.instrument,
          items.map((i) => i.instrument),
        ),
      ),
    )
    .orderBy(desc(analyses.createdAt));

  const latestByInstrument = new Map<string, { id: number; createdAt: Date }>();
  for (const row of latestRows) {
    if (!latestByInstrument.has(row.instrument)) {
      latestByInstrument.set(row.instrument, {
        id: row.id,
        createdAt: row.createdAt,
      });
    }
  }

  res.json({
    items: items.map((it) => {
      const latest = latestByInstrument.get(it.instrument);
      return {
        instrument: it.instrument,
        addedAt: it.addedAt.toISOString(),
        mostRecentAnalysisId: latest?.id ?? null,
        mostRecentAnalysisAt: latest?.createdAt.toISOString() ?? null,
      };
    }),
  });
});

// POST /watchlist — idempotent star. Conflict on (userId, instrument)
// is a no-op so a double-tap can't 500.
router.post("/watchlist", requireAuth, async (req: AuthRequest, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Instrumen tidak valid" });
    return;
  }
  const instrument = parsed.data.instrument;
  const userId = req.userId!;

  const [row] = await db
    .insert(watchlistItems)
    .values({ userId, instrument })
    .onConflictDoUpdate({
      target: [watchlistItems.userId, watchlistItems.instrument],
      // Touch a no-op so RETURNING gives back the existing row's createdAt.
      set: { instrument: sql`${watchlistItems.instrument}` },
    })
    .returning({
      instrument: watchlistItems.instrument,
      addedAt: watchlistItems.createdAt,
    });

  res.status(201).json({
    instrument: row.instrument,
    addedAt: row.addedAt.toISOString(),
    mostRecentAnalysisId: null,
    mostRecentAnalysisAt: null,
  });
});

// DELETE /watchlist/:instrument — idempotent unstar. Returns 200 even
// when no row matched so the UI can fire-and-forget without distinguishing
// "already removed" from "never starred".
router.delete("/watchlist/:instrument", requireAuth, async (req: AuthRequest, res) => {
  const instrument = String(req.params["instrument"] ?? "").trim();
  if (!instrument) {
    res.status(400).json({ error: "Instrumen tidak valid" });
    return;
  }
  await db
    .delete(watchlistItems)
    .where(
      and(
        eq(watchlistItems.userId, req.userId!),
        eq(watchlistItems.instrument, instrument),
      ),
    );
  res.json({ message: "Watchlist diperbarui" });
});

export default router;
