import { Router } from "express";
import { getLiveQuotes } from "../lib/live-prices";

const router = Router();

router.get("/quotes/live", async (_req, res) => {
  try {
    const result = await getLiveQuotes();
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: "Gagal mengambil data harga live", detail: msg });
  }
});

export default router;
