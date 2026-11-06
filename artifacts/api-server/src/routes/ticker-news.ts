import { Router } from "express";
import { getTickerNews } from "../lib/news";

const router = Router();

router.get("/ticker-news", async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 6;

  try {
    const items = await getTickerNews(limit);
    return res.json({
      status: "success",
      total: items.length,
      articles: items.map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        category: "GLOBAL",
        date: item.publishedAt,
        publishedAt: item.publishedAt,
        sourceName: item.source,
        link: item.url,
        image: "",
      })),
    });
  } catch (err: any) {
    return res.status(502).json({
      error: "Gagal mengambil breaking news",
      detail: err?.message ?? "Upstream news unavailable",
    });
  }
});

export default router;