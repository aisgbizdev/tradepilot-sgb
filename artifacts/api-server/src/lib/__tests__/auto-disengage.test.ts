import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { users, notifications } from "@workspace/db/schema";
import { runAutoDisengage, resetDisengageStreak } from "../auto-disengage";

const RUN_ID = randomBytes(4).toString("hex");
const seededUserIds: number[] = [];

async function createTestUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<number> {
  const suffix = randomBytes(6).toString("hex");
  const [row] = await db
    .insert(users)
    .values({
      email: `disengage-${RUN_ID}-${suffix}@example.test`,
      passwordHash: await bcrypt.hash("not-used", 4),
      displayName: `Disengage ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash: await bcrypt.hash("answer", 4),
      pushPriceAnomaly: true,
      ...overrides,
    })
    .returning({ id: users.id });
  seededUserIds.push(row.id);
  return row.id;
}

async function seedUnreadNotifications(
  userId: number,
  category: string,
  count: number,
  ageHours = 72,
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    // Space them ~6h apart, all older than 48h.
    const created = new Date(now - (ageHours + i * 6) * 60 * 60 * 1000);
    await db.insert(notifications).values({
      userId,
      title: `n${i}`,
      message: `m${i}`,
      type: "info",
      category,
      createdAt: created,
      dedupeKey: `disengage-test:${userId}:${category}:${i}:${RUN_ID}:${randomBytes(3).toString("hex")}`,
    });
  }
}

beforeAll(async () => {
  // Each test creates its own user, so no shared seed.
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
});

beforeEach(async () => {
  // No-op: tests are independent and use fresh users.
});

describe("auto-disengage: lifecycle", () => {
  it("flips toggle off, sets banner, and persists streak reset", async () => {
    const userId = await createTestUser({ pushPriceAnomaly: true });
    await seedUnreadNotifications(userId, "price_anomaly", 3);

    const stats = await runAutoDisengage(new Date());
    expect(stats.paused).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({
        pushPriceAnomaly: users.pushPriceAnomaly,
        disengageNoticeCategory: users.disengageNoticeCategory,
        disengageStreaks: users.disengageStreaks,
        disengageCheckpoints: users.disengageCheckpoints,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    expect(row.pushPriceAnomaly).toBe(false);
    expect(row.disengageNoticeCategory).toBe("price_anomaly");
    expect(row.disengageStreaks?.["price_anomaly"]).toBe(0);
    expect(row.disengageCheckpoints?.["price_anomaly"]).toBeTruthy();
  });

  it("does NOT re-stamp the banner on a second tick once the toggle is off", async () => {
    const userId = await createTestUser({ pushPriceAnomaly: true });
    await seedUnreadNotifications(userId, "price_anomaly", 4);

    await runAutoDisengage(new Date());
    // Simulate user dismissing the banner via PATCH /push/prefs.
    await db
      .update(users)
      .set({ disengageNoticeCategory: null, updatedAt: new Date() })
      .where(eq(users.id, userId));

    // Second tick: historical unread rows still exist, but toggle is off.
    await runAutoDisengage(new Date());

    const [row] = await db
      .select({ disengageNoticeCategory: users.disengageNoticeCategory })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(row.disengageNoticeCategory).toBeNull();
  });

  it("does NOT re-trigger after re-enable thanks to the checkpoint", async () => {
    const userId = await createTestUser({ pushPriceAnomaly: true });
    await seedUnreadNotifications(userId, "price_anomaly", 4);

    await runAutoDisengage(new Date());
    // User re-enables + we checkpoint at "now" (simulating push.ts logic).
    await db
      .update(users)
      .set({
        pushPriceAnomaly: true,
        disengageNoticeCategory: null,
        disengageCheckpoints: { price_anomaly: new Date().toISOString() },
        disengageStreaks: { price_anomaly: 0 },
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    const stats = await runAutoDisengage(new Date());
    expect(stats.paused).toBe(0);

    const [row] = await db
      .select({
        pushPriceAnomaly: users.pushPriceAnomaly,
        disengageNoticeCategory: users.disengageNoticeCategory,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(row.pushPriceAnomaly).toBe(true);
    expect(row.disengageNoticeCategory).toBeNull();
  });

  it("counts only notifications newer than the checkpoint", async () => {
    const userId = await createTestUser({ pushPriceAnomaly: true });
    // Two old unread (pre-checkpoint) + one new unread (post-checkpoint).
    await seedUnreadNotifications(userId, "price_anomaly", 2, 200); // 200h ago
    const checkpoint = new Date(Date.now() - 150 * 60 * 60 * 1000);
    await db
      .update(users)
      .set({
        disengageCheckpoints: { price_anomaly: checkpoint.toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    // One newer unread (still older than 48h gate so it counts).
    await db.insert(notifications).values({
      userId,
      title: "n-new",
      message: "m-new",
      type: "info",
      category: "price_anomaly",
      createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      dedupeKey: `disengage-test-new:${userId}:${RUN_ID}:${randomBytes(3).toString("hex")}`,
    });

    const stats = await runAutoDisengage(new Date());
    // Only 1 unread after checkpoint → streak=1, below threshold, no pause.
    expect(stats.paused).toBe(0);

    const [row] = await db
      .select({
        pushPriceAnomaly: users.pushPriceAnomaly,
        disengageStreaks: users.disengageStreaks,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(row.pushPriceAnomaly).toBe(true);
    expect(row.disengageStreaks?.["price_anomaly"]).toBe(1);
  });

  it("resetDisengageStreak zeroes the per-category streak", async () => {
    const userId = await createTestUser({
      pushPriceAnomaly: true,
      disengageStreaks: { price_anomaly: 2 },
    });
    await resetDisengageStreak(userId, "price_anomaly");
    const [row] = await db
      .select({ disengageStreaks: users.disengageStreaks })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(row.disengageStreaks?.["price_anomaly"]).toBe(0);
  });
});
