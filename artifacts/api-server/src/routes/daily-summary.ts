import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { users } from "@workspace/db/schema";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { getTodayDigest } from "../lib/daily-summary";

const router = Router();

// Conservative IANA timezone validator: must be Region/City or
// Region/City/Locality with reasonable lengths. The real test is
// Intl.DateTimeFormat — if it can't format with this TZ we reject so
// the scheduler never sees an unusable string.
function isValidTimezone(tz: string): boolean {
  if (tz.length < 3 || tz.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  // HH:MM 24h. Validated tighter than just regex so the scheduler's
  // string-compare on `hhmm >= scheduled` never misbehaves.
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Time must be HH:MM in 24h format")
    .optional(),
  timezone: z
    .string()
    .refine(isValidTimezone, { message: "Invalid IANA timezone" })
    .optional(),
});

router.get("/me/daily-summary", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const [row] = await db
    .select({
      enabled: users.dailySummaryEnabled,
      time: users.dailySummaryTime,
      timezone: users.dailySummaryTimezone,
      lastSentDate: users.dailySummaryLastSentDate,
      pushDailySummary: users.pushDailySummary,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "User tidak ditemukan" });
    return;
  }
  const { digest, analyses: digestAnalyses } = await getTodayDigest(userId, row.timezone);
  res.json({
    settings: {
      enabled: row.enabled,
      time: row.time,
      timezone: row.timezone,
      pushDailySummary: row.pushDailySummary,
      lastSentDate: row.lastSentDate,
    },
    today: digest
      ? {
          digestDate: digest.digestDate,
          kind: digest.kind,
          instruments: digest.instruments,
          summary: digest.summary,
          createdAt: digest.createdAt.toISOString(),
          analyses: digestAnalyses.map((a) => ({
            id: a.id,
            instrument: a.instrument,
            timeframe: a.timeframe,
            tradingBias: a.tradingBias,
            confidenceMin: a.confidenceMin,
            confidenceMax: a.confidenceMax,
            preferredSide:
              (a.tradePlan as { preferredSide?: string } | null)?.preferredSide ?? null,
            mainScenario: a.mainScenario,
            createdAt: a.createdAt.toISOString(),
          })),
        }
      : null,
  });
});

router.put("/me/daily-summary", requireAuth, async (req: AuthRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Pengaturan ringkasan harian tidak valid",
      details: parsed.error.flatten(),
    });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (typeof parsed.data.enabled === "boolean") {
    updates["dailySummaryEnabled"] = parsed.data.enabled;
  }
  if (typeof parsed.data.time === "string") {
    updates["dailySummaryTime"] = parsed.data.time;
  }
  if (typeof parsed.data.timezone === "string") {
    updates["dailySummaryTimezone"] = parsed.data.timezone;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Tidak ada perubahan" });
    return;
  }
  // When the user CHANGES their time/timezone we clear lastSentDate so
  // a new schedule that falls later today can still fire today. Without
  // this, "I missed it, let me set it 30 min later" would silently skip
  // until tomorrow.
  if ("dailySummaryTime" in updates || "dailySummaryTimezone" in updates) {
    updates["dailySummaryLastSentDate"] = null;
  }
  updates["updatedAt"] = new Date();
  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, req.userId!))
    .returning({
      enabled: users.dailySummaryEnabled,
      time: users.dailySummaryTime,
      timezone: users.dailySummaryTimezone,
      pushDailySummary: users.pushDailySummary,
      lastSentDate: users.dailySummaryLastSentDate,
    });
  res.json(updated);
});

export default router;
