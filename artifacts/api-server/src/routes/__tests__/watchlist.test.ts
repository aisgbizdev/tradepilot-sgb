import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users, sessions, analyses, watchlistItems } from "@workspace/db/schema";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `watchlist-test-${RUN_ID}`;

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const seededUserIds: number[] = [];
let alice: SeedUser;
let bob: SeedUser;

async function createUser(): Promise<SeedUser> {
  const suffix = randomBytes(6).toString("hex");
  const email = `${EMAIL_PREFIX}-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Watchlist Test ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `wl-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

function authHeader(u: SeedUser): [string, string] {
  return ["Authorization", `Bearer ${u.token}`];
}

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(watchlistItems).where(inArray(watchlistItems.userId, seededUserIds));
    await db.delete(analyses).where(inArray(analyses.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("/watchlist auth", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/watchlist");
    expect(res.status).toBe(401);
  });
});

describe("/watchlist CRUD", () => {
  it("starts empty, accepts a star, returns it, and is idempotent on a re-star", async () => {
    const empty = await request(app).get("/api/watchlist").set(...authHeader(alice));
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);

    const add1 = await request(app)
      .post("/api/watchlist")
      .set(...authHeader(alice))
      .send({ instrument: "EUR/USD" });
    expect(add1.status).toBe(201);
    expect(add1.body.instrument).toBe("EUR/USD");

    const add2 = await request(app)
      .post("/api/watchlist")
      .set(...authHeader(alice))
      .send({ instrument: "EUR/USD" });
    expect(add2.status).toBe(201);

    const list = await request(app).get("/api/watchlist").set(...authHeader(alice));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].instrument).toBe("EUR/USD");
  });

  it("rejects an empty-string instrument", async () => {
    const res = await request(app)
      .post("/api/watchlist")
      .set(...authHeader(alice))
      .send({ instrument: "   " });
    expect(res.status).toBe(400);
  });

  it("removes an item idempotently", async () => {
    await request(app)
      .post("/api/watchlist")
      .set(...authHeader(alice))
      .send({ instrument: "XAU/USD" });

    const rm1 = await request(app)
      .delete("/api/watchlist/" + encodeURIComponent("XAU/USD"))
      .set(...authHeader(alice));
    expect(rm1.status).toBe(200);

    const rm2 = await request(app)
      .delete("/api/watchlist/" + encodeURIComponent("XAU/USD"))
      .set(...authHeader(alice));
    expect(rm2.status).toBe(200);

    const list = await request(app).get("/api/watchlist").set(...authHeader(alice));
    expect(list.body.items.find((i: { instrument: string }) => i.instrument === "XAU/USD")).toBeUndefined();
  });

  it("scopes items per user (bob cannot see alice's stars)", async () => {
    await request(app)
      .post("/api/watchlist")
      .set(...authHeader(alice))
      .send({ instrument: "GBP/USD" });

    const bobList = await request(app).get("/api/watchlist").set(...authHeader(bob));
    expect(bobList.status).toBe(200);
    expect(bobList.body.items).toEqual([]);
  });

  it("returns mostRecentAnalysisId for starred instruments that have analyses", async () => {
    await request(app)
      .post("/api/watchlist")
      .set(...authHeader(alice))
      .send({ instrument: "USD/JPY" });

    const [older] = await db
      .insert(analyses)
      .values({
        userId: alice.id,
        instrument: "USD/JPY",
        timeframe: "1D",
        mode: "beginner",
        validUntil: new Date(Date.now() + 60 * 60 * 1000),
        marketCondition: "ranging",
        riskLevel: "low",
        confidenceMin: 50,
        confidenceMax: 60,
      })
      .returning({ id: analyses.id });

    // Newer analysis should win.
    const [newer] = await db
      .insert(analyses)
      .values({
        userId: alice.id,
        instrument: "USD/JPY",
        timeframe: "4h",
        mode: "pro",
        validUntil: new Date(Date.now() + 60 * 60 * 1000),
        marketCondition: "trending_up",
        riskLevel: "medium",
        confidenceMin: 60,
        confidenceMax: 70,
      })
      .returning({ id: analyses.id });

    const list = await request(app).get("/api/watchlist").set(...authHeader(alice));
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { instrument: string }) => i.instrument === "USD/JPY");
    expect(item).toBeTruthy();
    expect(item.mostRecentAnalysisId).toBe(newer.id);
    expect(item.mostRecentAnalysisId).not.toBe(older.id);
    expect(item.mostRecentAnalysisAt).toBeTruthy();
  });
});
