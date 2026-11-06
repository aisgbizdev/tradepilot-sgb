import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { pushSubscriptions, users } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { pushTestLimiter } from "../middleware/rate-limit";
import { sendPushToUser } from "../lib/webpush";

const router = Router();

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

router.get("/push/public-key", (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
});

router.post("/push/subscribe", requireAuth, async (req: AuthRequest, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data langganan tidak valid", details: parsed.error.flatten() });
    return;
  }

  const { endpoint, keys } = parsed.data;

  await db
    .insert(pushSubscriptions)
    .values({
      userId: req.userId!,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: req.userId!, p256dh: keys.p256dh, auth: keys.auth },
    });

  res.status(201).json({ message: "Langganan push berhasil disimpan" });
});

router.delete("/push/unsubscribe", requireAuth, async (req: AuthRequest, res) => {
  const parsed = unsubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Endpoint tidak valid" });
    return;
  }

  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, req.userId!),
        eq(pushSubscriptions.endpoint, parsed.data.endpoint)
      )
    );

  res.json({ message: "Langganan push dihapus" });
});

router.get("/push/subscription-status", requireAuth, async (req: AuthRequest, res) => {
  const subs = await db
    .select({ endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, req.userId!));

  res.json({ subscribed: subs.length > 0, count: subs.length });
});

const SESSION_VALUES = ["tokyo", "london", "newyork"] as const;

// "HH:MM" 24h, zero-padded hour/minute (matches the `daily_summary_time`
// convention already used elsewhere on this table).
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidIanaTimezone(tz: string): boolean {
  try {
    // Throws RangeError for an unrecognised zone name — this is the
    // standard, dependency-free way to validate an IANA timezone string.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const prefsSchema = z
  .object({
    pushExpiry: z.boolean().optional(),
    pushBroadcast: z.boolean().optional(),
    pushDailySummary: z.boolean().optional(),
    pushMarketNews: z.boolean().optional(),
    pushCalendarEvents: z.boolean().optional(),
    pushPriceAnomaly: z.boolean().optional(),
    pushWeeklyRecap: z.boolean().optional(),
    pushSignalFlip: z.boolean().optional(),
    marketOpenSessions: z.array(z.enum(SESSION_VALUES)).optional(),
    pushDormancyNudge: z.boolean().optional(),
    pushOnboarding: z.boolean().optional(),
    dismissDisengageNotice: z.boolean().optional(),
    // Anti-pattern guardrail opt-outs (task #163). Co-located on the
    // push-prefs endpoint because the settings UI groups them under the
    // same "what we surface to you" notifications panel.
    guardrailRevenge: z.boolean().optional(),
    guardrailOvertrading: z.boolean().optional(),
    guardrailHighRisk: z.boolean().optional(),
    coolingOffEnabled: z.boolean().optional(),
    // Store-readiness (P2-B4.1).
    pushAnalysisCompleted: z.boolean().optional(),
    pushTpSlHit: z.boolean().optional(),
    pushLoginAlert: z.boolean().optional(),
    nativePushEnabled: z.boolean().optional(),
    webPushEnabled: z.boolean().optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietHoursStart: z
      .string()
      .regex(HH_MM, "Waktu harus berformat HH:MM")
      .optional(),
    quietHoursEnd: z
      .string()
      .regex(HH_MM, "Waktu harus berformat HH:MM")
      .optional(),
    notificationTimezone: z
      .string()
      .refine(isValidIanaTimezone, "Zona waktu tidak valid")
      .optional(),
    progressionNotificationsEnabled: z.boolean().optional(),
  })
  .strict();

const PREF_SELECT = {
  pushExpiry: users.pushExpiry,
  pushBroadcast: users.pushBroadcast,
  pushDailySummary: users.pushDailySummary,
  pushMarketNews: users.pushMarketNews,
  pushCalendarEvents: users.pushCalendarEvents,
  pushPriceAnomaly: users.pushPriceAnomaly,
  pushWeeklyRecap: users.pushWeeklyRecap,
  pushSignalFlip: users.pushSignalFlip,
  marketOpenSessions: users.marketOpenSessions,
  pushDormancyNudge: users.pushDormancyNudge,
  pushOnboarding: users.pushOnboarding,
  disengageNoticeCategory: users.disengageNoticeCategory,
  guardrailRevenge: users.guardrailRevenge,
  guardrailOvertrading: users.guardrailOvertrading,
  guardrailHighRisk: users.guardrailHighRisk,
  coolingOffEnabled: users.coolingOffEnabled,
  pushAnalysisCompleted: users.pushAnalysisCompleted,
  pushTpSlHit: users.pushTpSlHit,
  pushLoginAlert: users.pushLoginAlert,
  nativePushEnabled: users.nativePushEnabled,
  webPushEnabled: users.webPushEnabled,
  quietHoursEnabled: users.quietHoursEnabled,
  quietHoursStart: users.quietHoursStart,
  quietHoursEnd: users.quietHoursEnd,
  notificationTimezone: users.notificationTimezone,
  progressionNotificationsEnabled: users.progressionNotificationsEnabled,
} as const;

router.get("/push/prefs", requireAuth, async (req: AuthRequest, res) => {
  const [row] = await db
    .select(PREF_SELECT)
    .from(users)
    .where(eq(users.id, req.userId!))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "User tidak ditemukan" });
    return;
  }
  res.json(row);
});

// Send a sample notification to the caller's own subscribed devices.
// Auth-required + per-user rate-limited via `pushTestLimiter`.
router.post("/push/test", requireAuth, pushTestLimiter, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (!count || count === 0) {
    res.status(404).json({
      error:
        "Belum ada perangkat yang berlangganan notifikasi. / No subscribed devices yet.",
    });
    return;
  }

  await sendPushToUser(userId, {
    title: "TradePilot.id",
    body: "Notifikasi kamu sudah aktif. / Notifications are working.",
    tag: "trade-pilot-test",
  });

  res.json({ delivered: count });
});

router.patch("/push/prefs", requireAuth, async (req: AuthRequest, res) => {
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Preferensi tidak valid" });
    return;
  }
  const updates: Record<string, unknown> = {};
  const d = parsed.data;
  if (typeof d.pushExpiry === "boolean") updates["pushExpiry"] = d.pushExpiry;
  if (typeof d.pushBroadcast === "boolean") updates["pushBroadcast"] = d.pushBroadcast;
  if (typeof d.pushDailySummary === "boolean") updates["pushDailySummary"] = d.pushDailySummary;
  if (typeof d.pushMarketNews === "boolean") updates["pushMarketNews"] = d.pushMarketNews;
  if (typeof d.pushCalendarEvents === "boolean") updates["pushCalendarEvents"] = d.pushCalendarEvents;
  if (typeof d.pushPriceAnomaly === "boolean") updates["pushPriceAnomaly"] = d.pushPriceAnomaly;
  if (typeof d.pushWeeklyRecap === "boolean") updates["pushWeeklyRecap"] = d.pushWeeklyRecap;
  if (typeof d.pushSignalFlip === "boolean") updates["pushSignalFlip"] = d.pushSignalFlip;
  // Track categories the user just re-enabled so we can checkpoint
  // them — this prevents the auto-disengage worker from re-counting
  // any stale unread notifications that pre-date the re-opt-in.
  const reEnabled: string[] = [];
  // Load current state once so we can detect off→on transitions.
  const [current] = await db
    .select({
      pushMarketNews: users.pushMarketNews,
      pushCalendarEvents: users.pushCalendarEvents,
      pushPriceAnomaly: users.pushPriceAnomaly,
      pushWeeklyRecap: users.pushWeeklyRecap,
      pushSignalFlip: users.pushSignalFlip,
      pushDormancyNudge: users.pushDormancyNudge,
      marketOpenSessions: users.marketOpenSessions,
      disengageCheckpoints: users.disengageCheckpoints,
      disengageStreaks: users.disengageStreaks,
    })
    .from(users)
    .where(eq(users.id, req.userId!))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "User tidak ditemukan" });
    return;
  }
  const trackReEnable = (cat: string, prev: boolean, next: boolean | undefined) => {
    if (next === true && prev === false) reEnabled.push(cat);
  };
  trackReEnable("market_news", current.pushMarketNews, updates["pushMarketNews"] as boolean | undefined);
  trackReEnable("calendar_event", current.pushCalendarEvents, updates["pushCalendarEvents"] as boolean | undefined);
  trackReEnable("price_anomaly", current.pushPriceAnomaly, updates["pushPriceAnomaly"] as boolean | undefined);
  trackReEnable("weekly_recap", current.pushWeeklyRecap, updates["pushWeeklyRecap"] as boolean | undefined);
  trackReEnable("signal_flip", current.pushSignalFlip, updates["pushSignalFlip"] as boolean | undefined);

  if (Array.isArray(d.marketOpenSessions)) {
    // Deduplicate while preserving order so the UI's checkbox order is stable.
    const seen = new Set<string>();
    const cleaned = d.marketOpenSessions.filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
    updates["marketOpenSessions"] = cleaned;
    const prevOn = Array.isArray(current.marketOpenSessions) && current.marketOpenSessions.length > 0;
    if (cleaned.length > 0 && !prevOn) reEnabled.push("market_open");
  }
  if (typeof d.pushDormancyNudge === "boolean") {
    updates["pushDormancyNudge"] = d.pushDormancyNudge;
    // Re-opting in resets the auto-pause streak so the user gets the
    // full 3-strike budget again.
    if (d.pushDormancyNudge) updates["dormancyNudgeStreak"] = 0;
    trackReEnable("dormancy_nudge", current.pushDormancyNudge, d.pushDormancyNudge);
  }
  if (typeof d.pushOnboarding === "boolean") updates["pushOnboarding"] = d.pushOnboarding;
  if (d.dismissDisengageNotice === true) updates["disengageNoticeCategory"] = null;
  if (typeof d.guardrailRevenge === "boolean") updates["guardrailRevenge"] = d.guardrailRevenge;
  if (typeof d.guardrailOvertrading === "boolean") updates["guardrailOvertrading"] = d.guardrailOvertrading;
  if (typeof d.guardrailHighRisk === "boolean") updates["guardrailHighRisk"] = d.guardrailHighRisk;
  if (typeof d.coolingOffEnabled === "boolean") updates["coolingOffEnabled"] = d.coolingOffEnabled;
  if (typeof d.pushAnalysisCompleted === "boolean") updates["pushAnalysisCompleted"] = d.pushAnalysisCompleted;
  if (typeof d.pushTpSlHit === "boolean") updates["pushTpSlHit"] = d.pushTpSlHit;
  if (typeof d.pushLoginAlert === "boolean") updates["pushLoginAlert"] = d.pushLoginAlert;
  if (typeof d.nativePushEnabled === "boolean") updates["nativePushEnabled"] = d.nativePushEnabled;
  if (typeof d.webPushEnabled === "boolean") updates["webPushEnabled"] = d.webPushEnabled;
  if (typeof d.quietHoursEnabled === "boolean") updates["quietHoursEnabled"] = d.quietHoursEnabled;
  if (typeof d.quietHoursStart === "string") updates["quietHoursStart"] = d.quietHoursStart;
  if (typeof d.quietHoursEnd === "string") updates["quietHoursEnd"] = d.quietHoursEnd;
  if (typeof d.notificationTimezone === "string") updates["notificationTimezone"] = d.notificationTimezone;
  if (typeof d.progressionNotificationsEnabled === "boolean") updates["progressionNotificationsEnabled"] = d.progressionNotificationsEnabled;

  if (reEnabled.length > 0) {
    const nowIso = new Date().toISOString();
    const nextCheckpoints = { ...((current.disengageCheckpoints ?? {}) as Record<string, string>) };
    const nextStreaks = { ...((current.disengageStreaks ?? {}) as Record<string, number>) };
    for (const cat of reEnabled) {
      nextCheckpoints[cat] = nowIso;
      nextStreaks[cat] = 0;
    }
    updates["disengageCheckpoints"] = nextCheckpoints;
    updates["disengageStreaks"] = nextStreaks;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Tidak ada perubahan" });
    return;
  }
  const [updated] = await db
    .update(users)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(users.id, req.userId!))
    .returning(PREF_SELECT);
  res.json(updated);
});

export default router;
