import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import {
  progressionAchievements, progressionNotificationCooldowns, progressionProfiles, progressionProofs, users, xpLedger,
} from "@workspace/db/schema";
import { createNotification } from "./create-notification";
import { withinQuietHours } from "./notification-guards";
import { createHmac } from "node:crypto";

export const PROGRESSION_RULE_VERSION = "104.2";
export const PROGRESSION_SOURCES = [
  "quality_journal", "analysis_evaluation", "pre_analysis_checklist",
  "guide_completion", "discipline_streak", "risk_warning_wait",
] as const;
export type ProgressionSource = typeof PROGRESSION_SOURCES[number];

const RULES: Record<ProgressionSource, { xp: number; cap: number; quality: number }> = {
  quality_journal: { xp: 20, cap: 2, quality: 70 },
  analysis_evaluation: { xp: 12, cap: 3, quality: 1 },
  pre_analysis_checklist: { xp: 8, cap: 3, quality: 1 },
  guide_completion: { xp: 15, cap: 2, quality: 1 },
  discipline_streak: { xp: 10, cap: 1, quality: 1 },
  risk_warning_wait: { xp: 15, cap: 2, quality: 1 },
};
const RANKS = [
  ["seedling", 1], ["observer", 10], ["planner", 20], ["guardian", 30],
  ["navigator", 40], ["strategist", 50], ["sentinel", 60], ["vanguard", 70],
  ["steward", 85], ["apex", 100],
] as const;
export const ACHIEVEMENTS = [
  "first_reflection","journal_5","journal_20","journal_50","evaluation_1",
  "evaluation_10","evaluation_50","checklist_1","checklist_10","checklist_50",
  "guide_1","guide_5","guide_10","wait_1","wait_10","streak_3","streak_7",
  "streak_30","level_10","level_25","level_50","level_75","level_100",
  "mastery_1","consistent_1000",
] as const;
export const RANK_KEYS = RANKS.map((r) => r[0]);

export function levelForXp(totalXp: number): { level: number; masteryLevel: number; nextXp: number; currentLevelXp: number } {
  // Early milestones are attainable through a few ordinary discipline actions.
  let remaining = Math.max(0, totalXp), level = 1;
  while (level < 100) {
    const needed = 50 + (level - 1) * 20;
    if (remaining < needed) {
      const currentLevelXp = totalXp - remaining;
      return { level, masteryLevel: 0, currentLevelXp, nextXp: currentLevelXp + needed };
    }
    remaining -= needed; level++;
  }
  const masteryLevel = Math.floor(remaining / 500);
  const currentLevelXp = totalXp - (remaining % 500);
  return { level: 100, masteryLevel, currentLevelXp, nextXp: currentLevelXp + 500 };
}
export function rankForLevel(level: number): string {
  return [...RANKS].reverse().find((r) => level >= r[1])?.[0] ?? "seedling";
}
export function localDay(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (kind: string) => parts.find((p) => p.type === kind)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  catch { return now.toISOString().slice(0, 10); }
}
export function validProgressionTimezone(timezone: string | null | undefined): string {
  try { if (timezone) new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return timezone || "UTC"; }
  catch { return "UTC"; }
}
export function checklistCycleSubject(instrument: string, timeframe: string, now: Date, timezone: string): string {
  return `${instrument}:${timeframe}:${localDay(now, timezone)}`;
}
export function riskWaitSourceEventId(instrument: string, event: { currency: string; epochMs: number; name: string }): string {
  return `wait:${instrument}:${event.currency}:${event.epochMs}:${event.name}`;
}
export function withinDailySourceCap(existingXp: number, source: ProgressionSource): boolean {
  return existingXp + RULES[source].xp <= RULES[source].cap * RULES[source].xp;
}
function previousDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
export function streaksForDays(days: string[]): { current: number; longest: number; lastDay: string | null } {
  const sorted = [...new Set(days)].sort();
  const lastDay = sorted.at(-1) ?? null;
  if (!lastDay) return { current: 0, longest: 0, lastDay: null };
  const set = new Set(sorted); let current = 0; let cursor = lastDay;
  while (set.has(cursor)) { current++; cursor = previousDay(cursor); }
  let longest = 0, run = 0, previous: string | null = null;
  for (const day of sorted) { run = previous === previousDay(day) ? run + 1 : 1; longest = Math.max(longest, run); previous = day; }
  return { current, longest, lastDay };
}
async function refreshStreak(userId: number): Promise<number> {
  const rows = await db.select({ id: xpLedger.id, source: xpLedger.source, xp: xpLedger.xp, day: xpLedger.dayBucket, correctionOfLedgerId: xpLedger.correctionOfLedgerId }).from(xpLedger).where(eq(xpLedger.userId, userId));
  const revoked = new Set(rows.filter((x) => x.xp < 0 && x.correctionOfLedgerId != null).map((x) => x.correctionOfLedgerId!));
  const streak = streaksForDays(rows.filter((x) => x.source !== "discipline_streak" && x.source !== "correction" && x.xp > 0 && !revoked.has(x.id)).map((x) => x.day));
  await db.insert(progressionProfiles).values({ userId, currentStreak: streak.current, longestStreak: streak.longest, lastDisciplineDay: streak.lastDay })
    .onConflictDoUpdate({ target: progressionProfiles.userId, set: { currentStreak: streak.current, longestStreak: streak.longest, lastDisciplineDay: streak.lastDay, updatedAt: new Date() } });
  return streak.current;
}

export async function awardProgression(input: {
  userId: number; source: ProgressionSource; sourceEventId: string; qualityScore?: number;
  metadata?: Record<string, unknown>; occurredAt?: Date; ruleVersion?: string;
}): Promise<{ awarded: boolean; xp: number; reason?: string }> {
  const rule = RULES[input.source]; const now = new Date();
  const [user] = await db.select({ notificationTimezone: users.notificationTimezone, dailySummaryTimezone: users.dailySummaryTimezone, progressionNotificationsEnabled: users.progressionNotificationsEnabled, quietHoursEnabled: users.quietHoursEnabled, quietHoursStart: users.quietHoursStart, quietHoursEnd: users.quietHoursEnd, lang: users.lang })
    .from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) return { awarded: false, xp: 0, reason: "user_not_found" };
  if ((input.qualityScore ?? 0) < rule.quality) return { awarded: false, xp: 0, reason: "quality" };
  const occurredAt = input.occurredAt && input.occurredAt <= now ? input.occurredAt : now;
  const initialTimezone = validProgressionTimezone(user.notificationTimezone || user.dailySummaryTimezone);
  await db.insert(progressionProfiles).values({ userId: input.userId, progressionTimezone: initialTimezone }).onConflictDoNothing();
  const [frozenProfile] = await db.select({ timezone: progressionProfiles.progressionTimezone }).from(progressionProfiles).where(eq(progressionProfiles.userId, input.userId)).limit(1);
  const dayBucket = localDay(occurredAt, frozenProfile?.timezone || initialTimezone);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(104, ${input.userId})`);
    const proofKey = and(
      eq(progressionProofs.userId, input.userId),
      eq(progressionProofs.source, input.source),
      eq(progressionProofs.sourceEventId, input.sourceEventId),
    );
    const [existingProof] = await tx.select({
      id: progressionProofs.id,
      decision: progressionProofs.decision,
      rejectionReason: progressionProofs.rejectionReason,
    }).from(progressionProofs).where(proofKey).limit(1);
    if (existingProof && (existingProof.decision !== "rejected" || existingProof.rejectionReason !== "daily_cap")) {
      return { awarded: false, xp: 0, reason: "duplicate" };
    }
    const [usage] = await tx.select({ total: sql<number>`coalesce(sum(${xpLedger.xp}), 0)::int` }).from(xpLedger)
      .where(and(eq(xpLedger.userId, input.userId), eq(xpLedger.source, input.source), eq(xpLedger.dayBucket, dayBucket)));
    if (!withinDailySourceCap(Number(usage?.total ?? 0), input.source)) {
      if (!existingProof) await tx.insert(progressionProofs).values({
        userId: input.userId, source: input.source, sourceEventId: input.sourceEventId,
        qualityScore: input.qualityScore ?? 0, metadata: input.metadata ?? {}, occurredAt,
        decision: "rejected", rejectionReason: "daily_cap",
      });
      return { awarded: false, xp: 0, reason: "daily_cap" };
    }
    const proof = existingProof
      ? await tx.update(progressionProofs).set({
        decision: "accepted", rejectionReason: null, occurredAt,
        qualityScore: input.qualityScore ?? 0, metadata: input.metadata ?? {},
      }).where(eq(progressionProofs.id, existingProof.id)).returning({ id: progressionProofs.id })
      : await tx.insert(progressionProofs).values({
        userId: input.userId, source: input.source, sourceEventId: input.sourceEventId,
        qualityScore: input.qualityScore ?? 0, metadata: input.metadata ?? {}, occurredAt,
      }).returning({ id: progressionProofs.id });
    const ledger = await tx.insert(xpLedger).values({ userId: input.userId, source: input.source, sourceEventId: input.sourceEventId, proofId: proof[0].id, xp: rule.xp, dayBucket, ruleVersion: input.ruleVersion ?? PROGRESSION_RULE_VERSION, metadata: input.metadata ?? {} }).returning();
    const [prior] = await tx.select().from(progressionProfiles).where(eq(progressionProfiles.userId, input.userId)).limit(1);
    const [aggregate] = await tx.select({ total: sql<number>`coalesce(sum(${xpLedger.xp}), 0)::int` }).from(xpLedger).where(eq(xpLedger.userId, input.userId));
    const totalXp = Number(aggregate?.total ?? 0), curve = levelForXp(totalXp), rankKey = rankForLevel(curve.level);
    await tx.insert(progressionProfiles).values({ userId: input.userId, totalXp, level: curve.level, masteryLevel: curve.masteryLevel, rankKey })
      .onConflictDoUpdate({ target: progressionProfiles.userId, set: { totalXp, level: curve.level, masteryLevel: curve.masteryLevel, rankKey, updatedAt: now } });
    const all = await tx.select({ id: xpLedger.id, source: xpLedger.source, xp: xpLedger.xp, correctionOfLedgerId: xpLedger.correctionOfLedgerId }).from(xpLedger).where(eq(xpLedger.userId, input.userId));
    const revoked = new Set(all.filter((x) => x.correctionOfLedgerId != null && x.xp < 0).map((x) => x.correctionOfLedgerId));
    const countSource = (source: string) => all.filter((x) => x.source === source && x.xp > 0 && !revoked.has(x.id)).length;
    const streak = prior?.currentStreak ?? 0;
    const unlock = ACHIEVEMENTS.filter((key) =>
      (key === "first_reflection" && countSource("quality_journal") >= 1) ||
      (key === "journal_5" && countSource("quality_journal") >= 5) || (key === "journal_20" && countSource("quality_journal") >= 20) || (key === "journal_50" && countSource("quality_journal") >= 50) ||
      (key === "evaluation_1" && countSource("analysis_evaluation") >= 1) || (key === "evaluation_10" && countSource("analysis_evaluation") >= 10) || (key === "evaluation_50" && countSource("analysis_evaluation") >= 50) ||
      (key === "checklist_1" && countSource("pre_analysis_checklist") >= 1) || (key === "checklist_10" && countSource("pre_analysis_checklist") >= 10) || (key === "checklist_50" && countSource("pre_analysis_checklist") >= 50) ||
      (key === "guide_1" && countSource("guide_completion") >= 1) || (key === "guide_5" && countSource("guide_completion") >= 5) || (key === "guide_10" && countSource("guide_completion") >= 10) ||
      (key === "wait_1" && countSource("risk_warning_wait") >= 1) || (key === "wait_10" && countSource("risk_warning_wait") >= 10) ||
      (key === "streak_3" && streak >= 3) || (key === "streak_7" && streak >= 7) || (key === "streak_30" && streak >= 30) ||
      (key === "level_10" && curve.level >= 10) || (key === "level_25" && curve.level >= 25) ||
      (key === "level_50" && curve.level >= 50) || (key === "level_75" && curve.level >= 75) ||
      (key === "level_100" && curve.level >= 100) || (key === "mastery_1" && curve.masteryLevel >= 1) ||
      (key === "consistent_1000" && totalXp >= 1000)
    );
    const badges: string[] = [];
    for (const key of unlock) {
      const inserted = await tx.insert(progressionAchievements).values({ userId: input.userId, key, sourceLedgerId: ledger[0]!.id }).onConflictDoNothing().returning({ key: progressionAchievements.key });
      if (inserted[0]) badges.push(key);
    }
    // Compare with the user's XP under the current curve, not their stored
    // level from an older curve, so a rules rollout is not a new achievement.
    const previousCurve = levelForXp(prior?.totalXp ?? 0);
    return { awarded: true, xp: rule.xp, notice: { level: curve.level > previousCurve.level ? curve.level : undefined, rank: rankKey !== rankForLevel(previousCurve.level) ? rankKey : undefined, badges } };
  });
  const notice = "notice" in result ? result.notice : undefined;
  if (result.awarded && user.progressionNotificationsEnabled && notice && (notice.level || notice.rank || notice.badges.length)) {
    const id = user.lang === "id";
    const title = notice.badges.length ? (id ? "Badge baru terbuka" : "New badge unlocked") : notice.rank ? (id ? "Rank baru tercapai" : "New rank reached") : (id ? "Level naik" : "Level up");
    const labels: Record<string, [string, string]> = { seedling: ["Tunas", "Seedling"], observer: ["Pengamat", "Observer"], planner: ["Perencana", "Planner"], guardian: ["Penjaga", "Guardian"], navigator: ["Navigator", "Navigator"], strategist: ["Strategis", "Strategist"], sentinel: ["Pewaspada", "Sentinel"], vanguard: ["Pelopor", "Vanguard"], steward: ["Pengelola", "Steward"], apex: ["Puncak", "Apex"] };
    const badgeLabels: Record<string, [string, string]> = {
      first_reflection:["Refleksi Pertama","First Reflection"],journal_5:["5 Refleksi","5 Reflections"],journal_20:["20 Refleksi","20 Reflections"],journal_50:["50 Refleksi","50 Reflections"],evaluation_1:["Evaluasi Pertama","First Evaluation"],evaluation_10:["10 Evaluasi","10 Evaluations"],evaluation_50:["50 Evaluasi","50 Evaluations"],checklist_1:["Checklist Pertama","First Checklist"],checklist_10:["10 Checklist","10 Checklists"],checklist_50:["50 Checklist","50 Checklists"],guide_1:["Panduan Pertama","First Guide"],guide_5:["5 Panduan","5 Guides"],guide_10:["10 Panduan","10 Guides"],wait_1:["Menunggu dengan Aman","Safe Wait"],wait_10:["10 Kali Menunggu Aman","10 Safe Waits"],streak_3:["Konsisten 3 Hari","3-Day Streak"],streak_7:["Konsisten 7 Hari","7-Day Streak"],streak_30:["Konsisten 30 Hari","30-Day Streak"],level_10:["Level 10","Level 10"],level_25:["Level 25","Level 25"],level_50:["Level 50","Level 50"],level_75:["Level 75","Level 75"],level_100:["Level 100","Level 100"],mastery_1:["Mastery Pertama","First Mastery"],consistent_1000:["1.000 XP Disiplin","1,000 Discipline XP"],
    };
    const badgeLabel = (key: string) => badgeLabels[key]?.[id ? 0 : 1] ?? (id ? "Pencapaian disiplin" : "Discipline achievement");
    const message = notice.badges.length ? `${id ? "Pencapaian disiplin" : "Discipline achievement"}: ${notice.badges.map(badgeLabel).join(", ")}.` : notice.rank ? `${id ? "Anda mencapai rank" : "You reached rank"} ${labels[notice.rank]![id ? 0 : 1]}.` : `${id ? "Anda mencapai level" : "You reached level"} ${notice.level}.`;
    const dedupe = notice.badges.length ? `progression:badge:${input.userId}:${notice.badges.join(":")}` : `progression:${input.userId}:${notice.level ?? notice.rank}`;
    const sentAt = new Date();
    const gate = await db.insert(progressionNotificationCooldowns).values({ userId: input.userId, category: "progression", lastSentAt: sentAt })
      .onConflictDoUpdate({
        target: [progressionNotificationCooldowns.userId, progressionNotificationCooldowns.category],
        set: { lastSentAt: sentAt },
        where: sql`${progressionNotificationCooldowns.lastSentAt} <= ${new Date(sentAt.getTime() - 60 * 60_000)}`,
      }).returning({ userId: progressionNotificationCooldowns.userId });
    if (gate[0]) await createNotification(input.userId, { title, message, category: "progression", dedupeKey: dedupe }, withinQuietHours(user) ? null : { url: "/progression", tag: "progression" });
  }
  // A day is qualified by real awarded discipline evidence, not by an
  // analysis/trade count. The deterministic day key makes this one award/day.
  if (result.awarded && input.source !== "discipline_streak") {
    const streak = await refreshStreak(input.userId);
    if (streak >= 2) await awardProgression({ userId: input.userId, source: "discipline_streak", sourceEventId: `day:${dayBucket}`, qualityScore: 100, metadata: { qualifyingDay: dayBucket, streak } });
  }
  return result;
}

/** Internal-only recorded correction; there is intentionally no HTTP grant endpoint. */
export async function recordProgressionCorrection(input: { userId: number; correctionOfLedgerId: number; xp: number; reason: string }): Promise<void> {
  if (!Number.isInteger(input.xp) || !input.reason.trim()) throw new Error("Invalid progression correction");
  const [original] = await db.select().from(xpLedger).where(and(eq(xpLedger.id, input.correctionOfLedgerId), eq(xpLedger.userId, input.userId))).limit(1);
  if (!original) throw new Error("Original ledger row not found");
  const signature = createHmac("sha256", process.env["PROGRESSION_CORRECTION_SECRET"] ?? "development-only-progression-correction")
    .update(`${input.userId}:${original.id}:${input.xp}:${input.reason}`).digest("hex");
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(104, ${input.userId})`);
    await tx.insert(xpLedger).values({ userId: input.userId, source: "correction", sourceEventId: `revoke:${original.id}`, xp: input.xp, dayBucket: localDay(new Date(), "UTC"), ruleVersion: PROGRESSION_RULE_VERSION, metadata: { correction: true }, correctionOfLedgerId: original.id, correctionReason: input.reason, signature }).onConflictDoNothing();
    const [sum] = await tx.select({ total: sql<number>`coalesce(sum(${xpLedger.xp}), 0)::int` }).from(xpLedger).where(eq(xpLedger.userId, input.userId));
    const curve = levelForXp(Number(sum?.total ?? 0));
    await tx.insert(progressionProfiles).values({ userId: input.userId, totalXp: Number(sum?.total ?? 0), level: curve.level, masteryLevel: curve.masteryLevel, rankKey: rankForLevel(curve.level) }).onConflictDoUpdate({ target: progressionProfiles.userId, set: { totalXp: Number(sum?.total ?? 0), level: curve.level, masteryLevel: curve.masteryLevel, rankKey: rankForLevel(curve.level), updatedAt: new Date() } });
  });
  await refreshStreak(input.userId);
}

/** Revoke an invalidated award once. A deterministic source event makes repeated
 * PATCH/DELETE operations idempotent while preserving both ledger rows. */
export async function revokeProgressionEvidence(userId: number, source: ProgressionSource, sourceEventId: string, reason: string): Promise<void> {
  const [original] = await db.select().from(xpLedger).where(and(eq(xpLedger.userId, userId), eq(xpLedger.source, source), eq(xpLedger.sourceEventId, sourceEventId))).limit(1);
  if (!original) return;
  const correctionId = `revoke:${original.id}`;
  const existing = await db.select({ id: xpLedger.id }).from(xpLedger).where(and(eq(xpLedger.userId, userId), eq(xpLedger.sourceEventId, correctionId))).limit(1);
  if (existing[0]) return;
  await recordProgressionCorrection({ userId, correctionOfLedgerId: original.id, xp: -original.xp, reason });
}