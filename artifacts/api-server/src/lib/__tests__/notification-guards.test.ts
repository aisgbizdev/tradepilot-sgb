import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";

import { db } from "../db";
import { users, notifications } from "@workspace/db/schema";
import {
  withinQuietHours,
  hourInTimezone,
  respectFrequencyCap,
  alreadyDelivered,
  batchSimilar,
} from "../notification-guards";

const RUN_ID = randomBytes(4).toString("hex");
const seededUserIds: number[] = [];

async function createTestUser(): Promise<number> {
  const suffix = randomBytes(6).toString("hex");
  const [row] = await db
    .insert(users)
    .values({
      email: `guards-${RUN_ID}-${suffix}@example.test`,
      passwordHash: await bcrypt.hash("not-used", 4),
      displayName: `Guard ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash: await bcrypt.hash("answer", 4),
    })
    .returning({ id: users.id });
  seededUserIds.push(row.id);
  return row.id;
}

let alice: number;

beforeAll(async () => {
  alice = await createTestUser();
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
});

beforeEach(async () => {
  await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
});

describe("hourInTimezone", () => {
  it("returns the local hour in the named timezone", () => {
    // 2026-01-15T12:00:00Z is 19:00 in Asia/Jakarta (UTC+7).
    const t = new Date("2026-01-15T12:00:00Z");
    expect(hourInTimezone(t, "Asia/Jakarta")).toBe(19);
  });

  it("falls back to UTC when timezone is invalid", () => {
    const t = new Date("2026-01-15T05:00:00Z");
    expect(hourInTimezone(t, "Not/A_Zone")).toBe(5);
  });
});

describe("withinQuietHours", () => {
  it("suppresses at 02:00 Asia/Jakarta (inside the 22:00–07:00 window)", () => {
    // 2026-01-15T19:00:00Z is 02:00 next day in Asia/Jakarta.
    const t = new Date("2026-01-15T19:00:00Z");
    expect(withinQuietHours({ dailySummaryTimezone: "Asia/Jakarta" }, t)).toBe(true);
  });

  it("allows at 10:00 Asia/Jakarta (outside the window)", () => {
    // 2026-01-15T03:00:00Z is 10:00 in Asia/Jakarta.
    const t = new Date("2026-01-15T03:00:00Z");
    expect(withinQuietHours({ dailySummaryTimezone: "Asia/Jakarta" }, t)).toBe(false);
  });

  it("falls back to Asia/Jakarta when user has no timezone set", () => {
    const t = new Date("2026-01-15T19:00:00Z"); // 02:00 Jakarta
    expect(withinQuietHours({ dailySummaryTimezone: null }, t)).toBe(true);
  });

  it("respects custom start/end hours", () => {
    const t = new Date("2026-01-15T05:00:00Z"); // 05 UTC
    expect(
      withinQuietHours({ dailySummaryTimezone: "UTC" }, t, {
        startHour: 3,
        endHour: 6,
      }),
    ).toBe(true);
  });
});

describe("respectFrequencyCap", () => {
  it("allows when no rows in window", async () => {
    const r = await respectFrequencyCap(alice, "market_news", 60_000, 5);
    expect(r.allowed).toBe(true);
    expect(r.sentInWindow).toBe(0);
  });

  it("blocks when cap is reached", async () => {
    for (let i = 0; i < 3; i++) {
      await db.insert(notifications).values({
        userId: alice,
        title: "n",
        message: "m",
        category: "market_news",
      });
    }
    const r = await respectFrequencyCap(alice, "market_news", 60_000, 3);
    expect(r.allowed).toBe(false);
    expect(r.sentInWindow).toBe(3);
  });

  it("ignores rows in a different category", async () => {
    await db.insert(notifications).values({
      userId: alice,
      title: "n",
      message: "m",
      category: "calendar_event",
    });
    const r = await respectFrequencyCap(alice, "market_news", 60_000, 1);
    expect(r.allowed).toBe(true);
    expect(r.sentInWindow).toBe(0);
  });

  it("ignores rows older than the window", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.insert(notifications).values({
      userId: alice,
      title: "n",
      message: "m",
      category: "market_news",
      createdAt: old,
    });
    const r = await respectFrequencyCap(alice, "market_news", 60 * 60 * 1000, 1);
    expect(r.allowed).toBe(true);
    expect(r.sentInWindow).toBe(0);
  });
});

describe("alreadyDelivered", () => {
  it("returns false for unseen key", async () => {
    expect(await alreadyDelivered(`unseen-${RUN_ID}`)).toBe(false);
  });

  it("returns true once a row with the key exists", async () => {
    const key = `seen-${RUN_ID}-${randomBytes(3).toString("hex")}`;
    await db.insert(notifications).values({
      userId: alice,
      title: "n",
      message: "m",
      dedupeKey: key,
    });
    expect(await alreadyDelivered(key)).toBe(true);
  });
});

describe("batchSimilar", () => {
  it("collapses tight clusters by key", () => {
    const now = Date.now();
    const groups = batchSimilar(
      [
        { key: "XAU/USD", timestamp: now },
        { key: "XAU/USD", timestamp: now + 60_000 },
        { key: "XAU/USD", timestamp: now + 2 * 60_000 },
        { key: "EUR/USD", timestamp: now },
      ],
      10 * 60_000,
    );
    const xau = groups.find((g) => g.key === "XAU/USD" && g.items.length === 3);
    const eur = groups.find((g) => g.key === "EUR/USD");
    expect(xau).toBeTruthy();
    expect(eur?.items.length).toBe(1);
  });

  it("does not collapse items spread beyond the window", () => {
    const now = Date.now();
    const groups = batchSimilar(
      [
        { key: "XAU/USD", timestamp: now },
        { key: "XAU/USD", timestamp: now + 60 * 60_000 },
      ],
      10 * 60_000,
    );
    const xauGroups = groups.filter((g) => g.key === "XAU/USD");
    expect(xauGroups.length).toBe(2);
    for (const g of xauGroups) expect(g.items.length).toBe(1);
  });

  it("returns singletons as 1-item groups", () => {
    const groups = batchSimilar(
      [{ key: "EUR/USD", timestamp: Date.now() }],
      60_000,
    );
    expect(groups.length).toBe(1);
    expect(groups[0]!.items.length).toBe(1);
  });
});
