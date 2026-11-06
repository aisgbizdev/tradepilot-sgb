import { describe, it, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { inArray, eq, desc } from "drizzle-orm";

import { db } from "../db";
import { users, analyses, notifications } from "@workspace/db/schema";
import {
  buildDormancyMessage,
  computeDormancyMicroStat,
  dispatchDormancyNudge,
} from "../dormancy";

const RUN_ID = randomBytes(4).toString("hex");
const seededUserIds: number[] = [];

async function createUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<number> {
  const suffix = randomBytes(6).toString("hex");
  const [row] = await db
    .insert(users)
    .values({
      email: `dormancy-${RUN_ID}-${suffix}@example.test`,
      passwordHash: await bcrypt.hash("x", 4),
      displayName: `Dormancy ${RUN_ID} ${suffix}`,
      securityQuestion: "q?",
      securityAnswerHash: await bcrypt.hash("a", 4),
      ...overrides,
    })
    .returning({ id: users.id });
  seededUserIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(analyses).where(inArray(analyses.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
});

// 10:00 Asia/Jakarta = 03:00 UTC (Jakarta has no DST). Outside the default
// 22:00-07:00 quiet-hours window, so the dispatcher MUST fire.
function jakartaTenAm(): Date {
  const d = new Date();
  d.setUTCHours(3, 0, 0, 0);
  return d;
}

describe("dormancy: buildDormancyMessage", () => {
  it("uses the generic copy when no micro-stat is given", () => {
    const { title, body } = buildDormancyMessage();
    expect(title).toContain("Kangen");
    expect(body).toContain("Pasar minggu ini");
    expect(body).toContain("cek analisa");
  });

  it("interpolates a micro-stat when provided", () => {
    const { body } = buildDormancyMessage("3 berita high-impact hari ini");
    expect(body).toContain("3 berita high-impact hari ini");
    expect(body).not.toContain("cek analisa terbaru");
  });

  it("treats null micro-stat as 'no stat'", () => {
    const { body } = buildDormancyMessage(null);
    expect(body).toContain("cek analisa");
  });
});

describe("dormancy: computeDormancyMicroStat", () => {
  it("returns null when the user has never run an analysis", async () => {
    const id = await createUser();
    expect(await computeDormancyMicroStat(id)).toBeNull();
  });

  it("returns 'N hari sejak…' based on the most recent analysis", async () => {
    const id = await createUser();
    await db.insert(analyses).values({
      userId: id,
      instrument: "EUR/USD",
      timeframe: "1h",
      mode: "beginner",
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      marketCondition: "ranging",
      riskLevel: "low",
      confidenceMin: 50,
      confidenceMax: 70,
      createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    const stat = await computeDormancyMicroStat(id);
    expect(stat).toMatch(/^9 hari sejak/);
  });
});

describe("dormancy: dispatchDormancyNudge", () => {
  it("auto-pauses the toggle after 3 unanswered nudges", async () => {
    // Seed a user who's been dormant >7d and is mid-streak at 2.
    const id = await createUser({
      pushDormancyNudge: true,
      dormancyNudgeStreak: 2,
      dormancyLastNudgeAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      dailySummaryTimezone: "Asia/Jakarta",
    });

    await dispatchDormancyNudge(jakartaTenAm());

    const [row] = await db
      .select({
        pushDormancyNudge: users.pushDormancyNudge,
        dormancyNudgeStreak: users.dormancyNudgeStreak,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    expect(row.dormancyNudgeStreak).toBe(3);
    expect(row.pushDormancyNudge).toBe(false);
  });

  it("injects computeDormancyMicroStat output into the persisted notification body", async () => {
    const id = await createUser({
      pushDormancyNudge: true,
      dormancyNudgeStreak: 0,
      dormancyLastNudgeAt: null,
      dailySummaryTimezone: "Asia/Jakarta",
    });
    // Seed a single analysis 9 days ago so micro-stat = "9 hari sejak…".
    await db.insert(analyses).values({
      userId: id,
      instrument: "EUR/USD",
      timeframe: "1h",
      mode: "beginner",
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      marketCondition: "ranging",
      riskLevel: "low",
      confidenceMin: 50,
      confidenceMax: 70,
      createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });

    await dispatchDormancyNudge(jakartaTenAm());

    const [notif] = await db
      .select({ message: notifications.message, category: notifications.category })
      .from(notifications)
      .where(eq(notifications.userId, id))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(notif).toBeDefined();
    expect(notif.category).toBe("dormancy_nudge");
    // Anywhere from 8 to 9 days depending on clock vs. tick offset; what
    // matters is that the computed micro-stat string was injected verbatim.
    expect(notif.message).toMatch(/\d+ hari sejak analisa terakhirmu/);
  });
});
