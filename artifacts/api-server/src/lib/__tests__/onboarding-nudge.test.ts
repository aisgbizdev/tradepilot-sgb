import { describe, it, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { users, notifications, watchlistItems } from "@workspace/db/schema";
import { dispatchOnboardingNudges } from "../onboarding-nudge";

const RUN_ID = randomBytes(4).toString("hex");
const seededUserIds: number[] = [];
// 12:00 in Asia/Jakarta, safely outside the default 22:00–07:00 quiet window.
// Keep the fixture well before real users so a test tick does not dispatch
// onboarding notifications to unrelated accounts in the shared dev database.
const DAYTIME = new Date("2020-01-15T05:00:00.000Z");
const QUIET_TIME = new Date("2020-01-15T17:00:00.000Z"); // 00:00 in Jakarta
const hoursBefore = (now: Date, hours: number) =>
  new Date(now.getTime() - hours * 60 * 60 * 1000);

async function createUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<number> {
  const suffix = randomBytes(6).toString("hex");
  const [row] = await db
    .insert(users)
    .values({
      email: `onboard-${RUN_ID}-${suffix}@example.test`,
      passwordHash: await bcrypt.hash("x", 4),
      displayName: `Onb ${RUN_ID} ${suffix}`,
      securityQuestion: "q?",
      securityAnswerHash: await bcrypt.hash("a", 4),
      pushOnboarding: true,
      ...overrides,
    })
    .returning({ id: users.id });
  seededUserIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(watchlistItems).where(inArray(watchlistItems.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
});

describe("onboarding-nudge: one-shot semantics", () => {
  it("skips users <24h old", async () => {
    const id = await createUser({ createdAt: hoursBefore(DAYTIME, 1) });
    await dispatchOnboardingNudges(DAYTIME);
    const [row] = await db
      .select({ stamp: users.onboardingNudgeSentAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    expect(row.stamp).toBeNull();
  });

  it("stamps users with a populated watchlist without sending", async () => {
    const id = await createUser({ createdAt: hoursBefore(DAYTIME, 25) });
    await db.insert(watchlistItems).values({ userId: id, instrument: "EUR/USD" });
    await dispatchOnboardingNudges(DAYTIME);
    const [row] = await db
      .select({ stamp: users.onboardingNudgeSentAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    expect(row.stamp).not.toBeNull();
    // No onboarding notification row should have been created for this user.
    const onbRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, id));
    expect(onbRows.length).toBe(0);
  });

  it("is a true one-shot — second dispatch tick is a no-op", async () => {
    const id = await createUser({ createdAt: hoursBefore(DAYTIME, 25) });
    await dispatchOnboardingNudges(DAYTIME);
    const [first] = await db
      .select({ stamp: users.onboardingNudgeSentAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    expect(first.stamp).not.toBeNull();
    const stamp1 = first.stamp!;

    await dispatchOnboardingNudges(new Date(DAYTIME.getTime() + 60 * 1000));
    const [second] = await db
      .select({ stamp: users.onboardingNudgeSentAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    // Stamp must remain exactly the same (no re-write).
    expect(second.stamp?.getTime()).toBe(stamp1.getTime());
  });

  it("defers sending during quiet hours without stamping the user", async () => {
    const id = await createUser({ createdAt: hoursBefore(DAYTIME, 25) });
    const stats = await dispatchOnboardingNudges(QUIET_TIME);
    const [row] = await db
      .select({ stamp: users.onboardingNudgeSentAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const delivered = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, id));
    expect(stats.suppressedQuiet).toBeGreaterThanOrEqual(1);
    expect(row.stamp).toBeNull();
    expect(delivered).toHaveLength(0);
  });
});
