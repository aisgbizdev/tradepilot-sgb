import { Router } from "express";
import { computePerformanceSummary, type PerformanceWindow } from "../lib/performance";
import { performanceLimiter } from "../middleware/rate-limit";

const router = Router();

// GET /api/performance/summary?window=30|90 — anonymous, aggregated,
// public AI track record. No per-user data: this is *the AI's* record.
router.get("/performance/summary", performanceLimiter, async (req, res) => {
  const raw = String(req.query.window ?? "30");
  const windowDays: PerformanceWindow = raw === "90" ? 90 : 30;
  const summary = await computePerformanceSummary(windowDays);
  // Allow shared cache (CDN / browser) for 60s. The aggregator is
  // pure read-only over a 30-90d window so a minute of staleness is
  // fine and shields the DB from spike traffic.
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
  res.json(summary);
});

export default router;
