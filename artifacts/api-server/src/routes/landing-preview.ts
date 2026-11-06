import { Router } from "express";
import { getLandingPreviewSnapshot } from "../lib/landing-preview";
import { landingPreviewLimiter } from "../middleware/rate-limit";

const router = Router();

// Anonymous, public-safe marketing snapshot. The server-side cache prevents
// each landing visitor from triggering a new AI analysis.
router.get("/landing/preview", landingPreviewLimiter, async (_req, res) => {
  try {
    const snapshot = await getLandingPreviewSnapshot();
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.json(snapshot);
  } catch {
    return res.status(503).json({
      error: "Live landing preview is temporarily unavailable",
    });
  }
});

export default router;