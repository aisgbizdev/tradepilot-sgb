import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users, xpLedger } from "@workspace/db/schema";
import { db } from "../db";
import { awardProgression } from "../progression";

describe("guide XP daily cap", () => {
  it("lets a capped guide earn XP on a later day, but never twice", async () => {
    const suffix = randomBytes(8).toString("hex");
    const [user] = await db.insert(users).values({
      email: `guide-cap-${suffix}@example.test`,
      passwordHash: await bcrypt.hash("not-used", 4),
      displayName: "Guide cap test",
      securityQuestion: "test?",
      securityAnswerHash: await bcrypt.hash("answer", 4),
      notificationTimezone: "UTC",
      progressionNotificationsEnabled: false,
    }).returning({ id: users.id });
    const firstDay = new Date(Date.now() - 3 * 86_400_000);
    const nextDay = new Date(Date.now() - 2 * 86_400_000);
    const complete = (guide: string, occurredAt: Date) => awardProgression({
      userId: user!.id,
      source: "guide_completion",
      sourceEventId: `guide:${guide}`,
      qualityScore: 100,
      occurredAt,
    });

    try {
      expect(await complete("analysis-workflow", firstDay)).toMatchObject({ awarded: true, xp: 15 });
      expect(await complete("how-ai-works", firstDay)).toMatchObject({ awarded: true, xp: 15 });
      expect(await complete("feature-map", firstDay)).toMatchObject({ awarded: false, reason: "daily_cap" });
      expect(await complete("feature-map", nextDay)).toMatchObject({ awarded: true, xp: 15 });
      expect(await complete("feature-map", nextDay)).toMatchObject({ awarded: false, reason: "duplicate" });
      const awards = await db.select({ id: xpLedger.id }).from(xpLedger).where(and(
        eq(xpLedger.userId, user!.id),
        eq(xpLedger.source, "guide_completion"),
        eq(xpLedger.sourceEventId, "guide:feature-map"),
      ));
      expect(awards).toHaveLength(1);
    } finally {
      await db.delete(users).where(eq(users.id, user!.id));
    }
  });
});