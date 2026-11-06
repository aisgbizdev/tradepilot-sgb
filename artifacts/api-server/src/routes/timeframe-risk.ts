import { Router } from "express";
import { GetTimeframeRiskMapQueryParams, GetTimeframeRiskMapResponse } from "@workspace/api-zod";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { getIndicators } from "../lib/historical";
import {
  isRiskMapInstrument,
  mapWithConcurrency,
  RISK_MAP_INSTRUMENTS,
  RISK_MAP_TIMEFRAMES,
  scoreTimeframeRisk,
} from "../lib/timeframe-risk";

const router = Router();

router.get("/risk-map/timeframes", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const parsed = GetTimeframeRiskMapQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: `Instrument tidak didukung. Gunakan salah satu: ${RISK_MAP_INSTRUMENTS.join(", ")}.`,
    });
    return;
  }
  const instrument = parsed.data.instrument.trim();
  if (!isRiskMapInstrument(instrument)) {
    res.status(400).json({
      error: `Instrument tidak didukung. Gunakan salah satu: ${RISK_MAP_INSTRUMENTS.join(", ")}.`,
    });
    return;
  }
  const results = await mapWithConcurrency(RISK_MAP_TIMEFRAMES, 3, async (timeframe) => {
    try {
      return scoreTimeframeRisk(timeframe, await getIndicators(instrument, timeframe));
    } catch (err) {
      req.log?.warn({ err, instrument, timeframe }, "Timeframe risk indicator request failed");
      return scoreTimeframeRisk(timeframe, null);
    }
  });
  const usable = results.filter((result) => result.status === "available");
  const allEligible = usable.length >= 3 && usable.every((result) => result.recommendation === "eligible");
  res.setHeader("Cache-Control", "private, max-age=30");
  res.json(GetTimeframeRiskMapResponse.parse({
    instrument,
    generatedAt: new Date().toISOString(),
    timeframes: results,
    overall: {
      state: allEligible ? "no_recommendation" : "wait",
      reasonCode: usable.length < 3 ? "INSUFFICIENT_TIMEFRAME_DATA" : allEligible ? "NO_ACTIONABLE_SIGNAL" : "RISK_OR_CONFLICT_PRESENT",
    },
  }));
});

export default router;