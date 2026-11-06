import { Router, type IRouter } from "express";
import { db } from "../lib/db";
import { instrumentRequests } from "@workspace/db/schema";
import { eq, sql, desc } from "drizzle-orm";
import { requireAuth, requireAdmin, type AuthRequest } from "../middleware/auth";
import { SubmitInstrumentRequestBody, SubmitInstrumentRequestResponse, GetAdminInstrumentRequestsResponse } from "@workspace/api-zod";
import { VERIFIED_ANALYSIS_INSTRUMENTS } from "../lib/verified-instruments";

const router: IRouter = Router();
const CODE_FORMAT = /^[A-Z0-9]{2,12}(?:[/.:-][A-Z0-9]{1,12})?$/;

router.post("/instrument-requests", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const parsed = SubmitInstrumentRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Kode instrumen tidak valid" });
    return;
  }
  const code = parsed.data.code.trim().toUpperCase();
  if (code.length > 25 || !CODE_FORMAT.test(code) ||
      VERIFIED_ANALYSIS_INSTRUMENTS.has(code) || ["BCO", "UKOIL", "UK-OIL"].includes(code)) {
    res.status(400).json({ error: "Kode instrumen tidak valid atau sudah tersedia" });
    return;
  }
  // Unique (user, code) prevents repeats from inflating demand; update only
  // the latest timestamp. Bound submissions per account to limit abuse.
  const [usage] = await db.select({ total: sql<number>`count(*)` })
    .from(instrumentRequests).where(eq(instrumentRequests.userId, req.userId!));
  const existing = await db.select({ id: instrumentRequests.id }).from(instrumentRequests)
    .where(sql`${instrumentRequests.userId} = ${req.userId!} AND ${instrumentRequests.code} = ${code}`).limit(1);
  if (Number(usage?.total ?? 0) >= 30 && !existing.length) {
    res.status(429).json({ error: "Batas permintaan kode tercapai" });
    return;
  }
  await db.insert(instrumentRequests).values({ userId: req.userId!, code })
    .onConflictDoUpdate({
      target: [instrumentRequests.userId, instrumentRequests.code],
      set: { lastRequestedAt: new Date() },
    });
  res.status(201).json(SubmitInstrumentRequestResponse.parse({ code, recorded: true }));
});

router.get("/admin/instrument-requests", requireAdmin, async (_req: AuthRequest, res): Promise<void> => {
  const ranked = await db.select({
    code: instrumentRequests.code,
    interestedUsers: sql<number>`count(*)::int`,
    lastRequestedAt: sql<string>`max(${instrumentRequests.lastRequestedAt})`,
  }).from(instrumentRequests).groupBy(instrumentRequests.code)
    .orderBy(desc(sql`count(*)`), desc(sql`max(${instrumentRequests.lastRequestedAt})`), instrumentRequests.code);
  res.json(GetAdminInstrumentRequestsResponse.parse({ requests: ranked }));
});

export default router;