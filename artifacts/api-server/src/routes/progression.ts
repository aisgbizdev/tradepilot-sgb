import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../lib/db";
import { requireAdmin, requireAuth, type AuthRequest } from "../middleware/auth";
import { feedback, progressionAchievements, progressionEvidenceSessions, progressionProfiles, progressionProofs, tradeJournal, users, xpLedger } from "@workspace/db/schema";
import { ACHIEVEMENTS, awardProgression, checklistCycleSubject, levelForXp, rankForLevel, validProgressionTimezone } from "../lib/progression";

const router = Router();
export const GUIDE_IDS = [
  "how-ai-works", "feature-map", "history-performance", "reading-analysis",
  "validity-confidence", "adaptive-plan", "personal-progression",
  "analysis-workflow", "bias-confidence-validity", "levels-chart",
  "timeframe-risk-map", "technical-fundamental", "standard-plan",
  "adaptive-position-plan", "account-rules", "terms", "data-handling",
  "fomo", "revenge", "loss-aversion", "anchoring", "risk-mindset",
  "plan-vs-prediction", "journaling", "patience",
] as const;
const CHECKLIST_ITEMS = ["risk_acknowledged","invalidation_reviewed","timeframe_checked","no_revenge_trade"] as const;

type GuideLedgerRow = {
  id: number;
  source: string;
  sourceEventId: string;
  xp: number;
  correctionOfLedgerId: number | null;
};

export function completedGuideIdsFromLedger(ledger: GuideLedgerRow[]): string[] {
  const revoked = new Set(
    ledger
      .filter((row) => row.xp < 0 && row.correctionOfLedgerId != null)
      .map((row) => row.correctionOfLedgerId),
  );
  const completed = new Set(
    ledger
      .filter((row) =>
        row.source === "guide_completion" &&
        row.xp > 0 &&
        !revoked.has(row.id) &&
        row.sourceEventId.startsWith("guide:")
      )
      .map((row) => row.sourceEventId.slice("guide:".length)),
  );
  return GUIDE_IDS.filter((guideId) => completed.has(guideId));
}

export const startEvidenceSchema = z.object({
  source: z.enum(["pre_analysis_checklist", "guide_completion"]),
  guideId: z.enum(GUIDE_IDS).optional(),
  checklist: z.object({ instrument: z.string().trim().min(1).max(32), timeframe: z.string().trim().min(1).max(16) }).optional(),
}).superRefine((v, ctx) => {
  if (v.source === "guide_completion" && !v.guideId) ctx.addIssue({ code: "custom", message: "Known guide required" });
  if (v.source === "pre_analysis_checklist" && !v.checklist) ctx.addIssue({ code: "custom", message: "Checklist context required" });
});
const activitySchema = z.object({ token: z.string().min(32).max(256) });

router.get("/progression/summary", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const [profile] = await db.select().from(progressionProfiles).where(eq(progressionProfiles.userId, req.userId!)).limit(1);
  const totalXp = profile?.totalXp ?? 0; const curve = levelForXp(totalXp);
  res.json({ totalXp, level: curve.level, masteryLevel: curve.masteryLevel, rank: rankForLevel(curve.level), currentLevelXp: curve.currentLevelXp, nextLevelXp: curve.nextXp, currentStreak: profile?.currentStreak ?? 0, longestStreak: profile?.longestStreak ?? 0 });
});

router.get("/progression/catalog", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const unlocked = await db.select({ key: progressionAchievements.key, unlockedAt: progressionAchievements.unlockedAt }).from(progressionAchievements).where(eq(progressionAchievements.userId, req.userId!));
  const map = new Map(unlocked.map((x) => [x.key, x.unlockedAt]));
  const ledger = await db.select({ id: xpLedger.id, source: xpLedger.source, sourceEventId: xpLedger.sourceEventId, xp: xpLedger.xp, correctionOfLedgerId: xpLedger.correctionOfLedgerId }).from(xpLedger).where(eq(xpLedger.userId, req.userId!));
  const revoked = new Set(ledger.filter((x) => x.xp < 0 && x.correctionOfLedgerId != null).map((x) => x.correctionOfLedgerId));
  const count = (source: string) => ledger.filter((x) => x.source === source && x.xp > 0 && !revoked.has(x.id)).length;
  const completedGuideIds = completedGuideIdsFromLedger(ledger);
  const [profile] = await db.select().from(progressionProfiles).where(eq(progressionProfiles.userId, req.userId!)).limit(1);
  const p = profile ?? { currentStreak: 0, totalXp: 0 };
  const curve = levelForXp(p.totalXp);
  const eligible = (key: string) => key === "first_reflection" ? count("quality_journal") >= 1 : key.startsWith("journal_") ? count("quality_journal") >= Number(key.split("_")[1]) : key.startsWith("evaluation_") ? count("analysis_evaluation") >= Number(key.split("_")[1]) : key.startsWith("checklist_") ? count("pre_analysis_checklist") >= Number(key.split("_")[1]) : key.startsWith("guide_") ? count("guide_completion") >= Number(key.split("_")[1]) : key.startsWith("wait_") ? count("risk_warning_wait") >= Number(key.split("_")[1]) : key.startsWith("streak_") ? p.currentStreak >= Number(key.split("_")[1]) : key.startsWith("level_") ? curve.level >= Number(key.split("_")[1]) : key === "mastery_1" ? curve.masteryLevel >= 1 : p.totalXp >= 1000;
  res.json({ achievements: ACHIEVEMENTS.map((key) => ({ key, unlocked: map.has(key) && eligible(key), unlockedAt: map.has(key) && eligible(key) ? map.get(key)?.toISOString() ?? null : null })), completedGuideIds });
});

router.get("/progression/history", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"] ?? 50) || 50));
  const entries = await db.select().from(xpLedger).where(eq(xpLedger.userId, req.userId!)).orderBy(desc(xpLedger.createdAt)).limit(limit);
  res.json({ entries: entries.map((x) => ({ id: x.id, source: x.source, xp: x.xp, dayBucket: x.dayBucket, ruleVersion: x.ruleVersion, createdAt: x.createdAt.toISOString() })) });
});

router.post("/progression/evidence", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const parsed = startEvidenceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bukti progres tidak valid" }); return; }
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const [user] = await db.select({ timezone: users.notificationTimezone }).from(users).where(eq(users.id, req.userId!)).limit(1);
  if (!user) { res.status(401).json({ error: "User tidak ditemukan" }); return; }
  await db.insert(progressionProfiles).values({ userId: req.userId!, progressionTimezone: validProgressionTimezone(user.timezone) }).onConflictDoNothing();
  const [profile] = await db.select({ timezone: progressionProfiles.progressionTimezone }).from(progressionProfiles).where(eq(progressionProfiles.userId, req.userId!)).limit(1);
  const delayMs = parsed.data.source === "guide_completion" ? 20_000 : 5_000;
  if (parsed.data.source === "pre_analysis_checklist") {
    const prefix = `${parsed.data.checklist!.instrument}:${parsed.data.checklist!.timeframe}:`;
    const [recentCycle] = await db.select({ id: progressionEvidenceSessions.id }).from(progressionEvidenceSessions).where(and(
      eq(progressionEvidenceSessions.userId, req.userId!),
      eq(progressionEvidenceSessions.kind, "pre_analysis_checklist"),
      sql`${progressionEvidenceSessions.subject} LIKE ${`${prefix}%`}`,
      sql`${progressionEvidenceSessions.issuedAt} >= ${new Date(now.getTime() - 20 * 60 * 60_000)}`,
    )).limit(1);
    if (recentCycle) { res.status(409).json({ error: "Siklus persiapan instrumen/timeframe ini sudah dimulai" }); return; }
  }
  const subject = parsed.data.source === "guide_completion"
    ? parsed.data.guideId!
    : checklistCycleSubject(parsed.data.checklist!.instrument, parsed.data.checklist!.timeframe, now, profile?.timezone || "UTC");
  await db.insert(progressionEvidenceSessions).values({ userId: req.userId!, kind: parsed.data.source, subject, tokenHash: createHash("sha256").update(token).digest("hex"), minimumCompleteAt: new Date(now.getTime() + delayMs) });
  res.status(201).json({ token, source: parsed.data.source, subject, minimumCompleteAt: new Date(now.getTime() + delayMs).toISOString() });
});

router.post("/progression/activity", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const parsed = activitySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Aktivitas progres tidak valid" }); return; }
  const hash = createHash("sha256").update(parsed.data.token).digest("hex");
  const [session] = await db.select().from(progressionEvidenceSessions).where(and(eq(progressionEvidenceSessions.userId, req.userId!), eq(progressionEvidenceSessions.tokenHash, hash))).limit(1);
  if (!session || session.consumedAt || session.minimumCompleteAt > new Date()) { res.status(400).json({ error: "Bukti kedaluwarsa, sudah dipakai, atau terlalu cepat" }); return; }
  const consumed = await db.update(progressionEvidenceSessions).set({ consumedAt: new Date(), decision: "accepted" }).where(and(eq(progressionEvidenceSessions.id, session.id), sql`${progressionEvidenceSessions.consumedAt} IS NULL`)).returning({ id: progressionEvidenceSessions.id });
  if (!consumed[0]) { res.status(400).json({ error: "Bukti sudah dipakai" }); return; }
  // Guide ids are global per user; checklist ids are one preparation cycle
  // per local server day/instrument/timeframe, never caller supplied.
  const eventId = session.kind === "guide_completion" ? `guide:${session.subject}` : `checklist:${session.subject}`;
  const result = await awardProgression({ userId: req.userId!, source: session.kind as "pre_analysis_checklist" | "guide_completion", sourceEventId: eventId, qualityScore: 100, metadata: { evidenceSessionId: session.id, subject: session.subject } });
  res.status(result.awarded ? 201 : 200).json(result);
});

// Read-only audit: deliberately no user ranking, aggregate, or write route.
router.get("/admin/progression/audit", requireAdmin, async (req: AuthRequest, res): Promise<void> => {
  const userId = Number(req.query["userId"]);
  const source = typeof req.query["source"] === "string" ? req.query["source"] : undefined;
  const ruleVersion = typeof req.query["ruleVersion"] === "string" ? req.query["ruleVersion"] : undefined;
  const anomaly = req.query["anomaly"] === "true";
  const conditions = Number.isInteger(userId) && userId > 0 ? [eq(xpLedger.userId, userId)] : [];
  if (source) conditions.push(eq(xpLedger.source, source));
  if (ruleVersion) conditions.push(eq(xpLedger.ruleVersion, ruleVersion));
  if (anomaly) conditions.push(sql`${xpLedger.xp} <= 0 OR ${xpLedger.correctionOfLedgerId} IS NOT NULL`);
  const rows = await db.select({ ledger: xpLedger, proof: progressionProofs }).from(xpLedger).leftJoin(progressionProofs, eq(xpLedger.proofId, progressionProofs.id)).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(xpLedger.createdAt)).limit(200);
  res.json({ entries: rows.map(({ ledger: x, proof }) => ({ id: x.id, userId: x.userId, source: x.source, sourceEventId: x.sourceEventId, xp: x.xp, dayBucket: x.dayBucket, ruleVersion: x.ruleVersion, metadata: x.metadata, correctionOfLedgerId: x.correctionOfLedgerId, correctionReason: x.correctionReason, proofId: x.proofId, proof: proof ? { metadata: proof.metadata, qualityScore: proof.qualityScore, decision: proof.decision, rejectionReason: proof.rejectionReason, occurredAt: proof.occurredAt.toISOString() } : null, createdAt: x.createdAt.toISOString() })) });
});

// Conservative, repeat-safe migration aid. Only existing entries with the
// exact same unambiguous evidence required for live awards are considered;
// outcomes, P/L, analysis count and timestamps supplied by clients are ignored.
router.post("/admin/progression/backfill", requireAdmin, async (_req: AuthRequest, res): Promise<void> => {
  const journals = await db.select({ id: tradeJournal.id, userId: tradeJournal.userId, note: tradeJournal.note, mood: tradeJournal.mood, entryPrice: tradeJournal.entryPrice, createdAt: tradeJournal.createdAt }).from(tradeJournal);
  const evaluations = await db.select({ id: feedback.id, userId: feedback.userId, analysisId: feedback.analysisId, note: feedback.note, createdAt: feedback.createdAt }).from(feedback);
  let awarded = 0;
  for (const row of journals) {
    if ((row.note?.trim().length ?? 0) < 10) continue;
    const r = await awardProgression({ userId: row.userId, source: "quality_journal", sourceEventId: String(row.id), qualityScore: 100, occurredAt: row.createdAt, ruleVersion: "104-backfill.2", metadata: { journalId: row.id, backfill: true } });
    if (r.awarded) awarded++;
  }
  for (const row of evaluations) {
    const r = await awardProgression({ userId: row.userId, source: "analysis_evaluation", sourceEventId: String(row.id), qualityScore: 100, occurredAt: row.createdAt, ruleVersion: "104-backfill.2", metadata: { feedbackId: row.id, analysisId: row.analysisId, backfill: true } });
    if (r.awarded) awarded++;
  }
  res.json({ awarded, scanned: journals.length + evaluations.length, ruleVersion: "104-backfill.1" });
});

export default router;