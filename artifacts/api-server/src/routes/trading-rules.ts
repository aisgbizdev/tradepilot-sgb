import { Router } from "express";
import { STANDARD_TRADING_RULES } from "../lib/standard-trading-rules";

const router = Router();

// Public, read-only disclosure. There is intentionally no broker parameter:
// this is one fixed TP ruleset, not a multi-broker selector.
router.get("/trading-rules/standard", (_req, res) => {
  res.json(STANDARD_TRADING_RULES);
});

export default router;