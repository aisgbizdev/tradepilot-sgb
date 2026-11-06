import { Router } from "express";
import { db } from "../lib/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { journalReadLimiter } from "../middleware/rate-limit";
import { buildHighlights, computeTraderMirror } from "../lib/trader-mirror";

const router = Router();

// GET /api/mirror/insights — personal trader mirror (task #162).
// Reads the caller's journal + analyses and returns a bundle of
// behavioural insights about them as a trader. Every category is
// gated on a minimum sample size; below threshold we return
// `{ gated: true, ... }` so the UI shows a "need more data" placeholder
// instead of confidently extrapolating from 3 entries.
router.get(
  "/mirror/insights",
  requireAuth,
  journalReadLimiter,
  async (req: AuthRequest, res) => {
    const [u] = await db
      .select({ tz: users.dailySummaryTimezone })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1);
    const timezone = u?.tz || "Asia/Jakarta";
    const insights = await computeTraderMirror(req.userId!, timezone);
    const highlights = buildHighlights(insights).map((h) => ({
      id: h.id,
      en: h.en,
      idText: h.id_,
    }));
    res.json({ insights, highlights, timezone });
  },
);

export default router;
