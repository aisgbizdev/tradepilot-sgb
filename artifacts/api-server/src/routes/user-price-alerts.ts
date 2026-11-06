import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { userPriceAlerts } from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { getLiveQuotes } from "../lib/live-prices";
import { CRYPTO_INSTRUMENTS } from "../lib/crypto-instruments";
import { logger } from "../lib/logger";

const router = Router();

// Allowlist of instruments price alerts may target. Crypto pairs are
// pulled from the shared crypto registry so a new altcoin added there
// automatically becomes alertable — no second source of drift.
export const KNOWN_INSTRUMENTS = new Set<string>([
  "XAU/USD", "BRENT", "XAG/USD", "HSI", "NIKKEI", "DJIA", "NASDAQ", "DXY",
  "AUD/USD", "EUR/USD", "GBP/USD", "USD/CHF", "USD/JPY", "USD/IDR",
  "HK50",
  ...CRYPTO_INSTRUMENTS,
]);

const createSchema = z.object({
  instrument: z.string().trim().min(1).max(64),
  targetPrice: z.number().finite().positive(),
  triggerDirection: z.enum(["above", "below"]),
  note: z.string().trim().max(200).optional().nullable(),
  lang: z.enum(["en", "id"]).optional(),
});

function serialize(row: typeof userPriceAlerts.$inferSelect) {
  return {
    id: row.id,
    instrument: row.instrument,
    targetPrice: row.targetPrice,
    triggerDirection: row.triggerDirection as "above" | "below",
    note: row.note,
    status: row.status as "active" | "triggered" | "cancelled",
    triggeredAt: row.triggeredAt ? row.triggeredAt.toISOString() : null,
    triggeredPrice: row.triggeredPrice,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/user-price-alerts", requireAuth, async (req: AuthRequest, res) => {
  const rows = await db
    .select()
    .from(userPriceAlerts)
    .where(eq(userPriceAlerts.userId, req.userId!))
    .orderBy(desc(userPriceAlerts.createdAt));
  res.json({ alerts: rows.map(serialize) });
});

router.post("/user-price-alerts", requireAuth, async (req: AuthRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid alert: check instrument, target price, and direction" });
    return;
  }
  const { instrument, targetPrice, triggerDirection, note, lang } = parsed.data;
  if (!KNOWN_INSTRUMENTS.has(instrument)) {
    res.status(400).json({ error: "Instrument not recognized" });
    return;
  }

  // Seed `lastSeenPrice` with the current spot if available so the
  // first checker tick can run the two-tick crossing comparison
  // without false-firing on alerts placed at-the-money or already
  // beyond their target. If live prices are down, leave it null —
  // the checker will populate on its first successful tick.
  let lastSeenPrice: string | null = null;
  try {
    const quotes = await getLiveQuotes();
    const hit = quotes.data.find((q) => q.instrument === instrument);
    if (hit) {
      const n = typeof hit.price === "number" ? hit.price : Number(hit.price);
      if (Number.isFinite(n)) lastSeenPrice = String(n);
    }
  } catch (err) {
    logger.warn({ err, instrument }, "Live-price lookup failed during alert create");
  }

  const [row] = await db
    .insert(userPriceAlerts)
    .values({
      userId: req.userId!,
      instrument,
      targetPrice: String(targetPrice),
      triggerDirection,
      note: note ?? null,
      lang: lang ?? "en",
      lastSeenPrice,
    })
    .returning();

  res.status(201).json(serialize(row));
});

router.delete("/user-price-alerts/:id", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const deleted = await db
    .delete(userPriceAlerts)
    .where(and(eq(userPriceAlerts.id, id), eq(userPriceAlerts.userId, req.userId!)))
    .returning({ id: userPriceAlerts.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  res.json({ message: "Alert deleted" });
});

export default router;
