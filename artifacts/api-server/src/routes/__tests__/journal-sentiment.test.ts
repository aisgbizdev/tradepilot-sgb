// Anonymised journal sentiment endpoint — privacy gates + buy/sell mix.
// Schema-level guardrails: must return `gated: true` (and null pcts)
// any time the directional sample is under MIN_ENTRIES (5) OR comes
// from fewer than MIN_TRADERS (3) distinct users, and must drop
// skipped entries entirely so they don't inflate the gate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import { users, sessions, tradeJournal } from "@workspace/db/schema";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `journal-sentiment-${RUN_ID}`;
const INST_GATED = `TEST/GATED-${RUN_ID}`;
const INST_OPEN = `TEST/OPEN-${RUN_ID}`;
const INST_SKIPONLY = `TEST/SKIP-${RUN_ID}`;

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const seededUserIds: number[] = [];
let alice: SeedUser;

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
      displayName: `JS Test ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });
  const token = `js-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

function auth(u: SeedUser): [string, string] {
  return ["Authorization", `Bearer ${u.token}`];
}

beforeAll(async () => {
  alice = await createUser();
  // INST_GATED: 4 entries from 3 users — fails MIN_ENTRIES (need 5).
  const a = await createUser();
  const b = await createUser();
  const c = await createUser();
  await db.insert(tradeJournal).values([
    { userId: a.id, instrument: INST_GATED, side: "buy", outcome: "open", tradedAt: new Date() },
    { userId: a.id, instrument: INST_GATED, side: "buy", outcome: "open", tradedAt: new Date() },
    { userId: b.id, instrument: INST_GATED, side: "sell", outcome: "open", tradedAt: new Date() },
    { userId: c.id, instrument: INST_GATED, side: "buy", outcome: "open", tradedAt: new Date() },
  ]);

  // INST_OPEN: 6 directional entries across 4 distinct traders →
  // satisfies both gates. Mix is 4 buys, 2 sells → 67/33.
  const u1 = await createUser();
  const u2 = await createUser();
  const u3 = await createUser();
  const u4 = await createUser();
  await db.insert(tradeJournal).values([
    { userId: u1.id, instrument: INST_OPEN, side: "buy",  outcome: "open", tradedAt: new Date() },
    { userId: u2.id, instrument: INST_OPEN, side: "buy",  outcome: "win",  tradedAt: new Date(), pnlAmount: "5" },
    { userId: u3.id, instrument: INST_OPEN, side: "buy",  outcome: "loss", tradedAt: new Date(), pnlAmount: "-3" },
    { userId: u4.id, instrument: INST_OPEN, side: "buy",  outcome: "open", tradedAt: new Date() },
    { userId: u1.id, instrument: INST_OPEN, side: "sell", outcome: "open", tradedAt: new Date() },
    { userId: u2.id, instrument: INST_OPEN, side: "sell", outcome: "open", tradedAt: new Date() },
  ]);

  // INST_SKIPONLY: 10 skipped entries from many users. Must STILL
  // gate — skipped entries are not directional votes and we drop
  // them entirely from the sample.
  for (let i = 0; i < 10; i++) {
    const skipUser = await createUser();
    await db.insert(tradeJournal).values({
      userId: skipUser.id,
      instrument: INST_SKIPONLY,
      side: "buy",
      outcome: "skipped",
      tradedAt: new Date(),
    });
  }
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(tradeJournal).where(inArray(tradeJournal.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("/api/journal/sentiment auth & validation", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/journal/sentiment?instrument=XAU/USD");
    expect(res.status).toBe(401);
  });

  it("rejects missing instrument", async () => {
    const res = await request(app).get("/api/journal/sentiment").set(...auth(alice));
    expect(res.status).toBe(400);
  });
});

describe("/api/journal/sentiment privacy gate", () => {
  it("gates and nulls percentages when sample is below MIN_ENTRIES", async () => {
    const res = await request(app)
      .get(`/api/journal/sentiment?instrument=${encodeURIComponent(INST_GATED)}`)
      .set(...auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.gated).toBe(true);
    expect(res.body.buyPct).toBeNull();
    expect(res.body.sellPct).toBeNull();
    // sampleSize and distinctTraders are suppressed when gated, so the
    // raw cohort counts can't be probed for membership inference.
    expect(res.body.sampleSize).toBeNull();
    expect(res.body.distinctTraders).toBeNull();
    expect(res.body.windowDays).toBeGreaterThan(0);
  });

  it("ignores skipped entries entirely — even a high count must stay gated", async () => {
    const res = await request(app)
      .get(`/api/journal/sentiment?instrument=${encodeURIComponent(INST_SKIPONLY)}`)
      .set(...auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.sampleSize).toBeNull();
    expect(res.body.distinctTraders).toBeNull();
    expect(res.body.gated).toBe(true);
    expect(res.body.buyPct).toBeNull();
    expect(res.body.sellPct).toBeNull();
  });

  it("returns buy/sell mix when both gates are satisfied", async () => {
    const res = await request(app)
      .get(`/api/journal/sentiment?instrument=${encodeURIComponent(INST_OPEN)}`)
      .set(...auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.gated).toBe(false);
    expect(res.body.sampleSize).toBe(6);
    expect(res.body.distinctTraders).toBe(4);
    // 4/6 = 67% buy, 2/6 = 33% sell (rounded).
    expect(res.body.buyPct).toBe(67);
    expect(res.body.sellPct).toBe(33);
  });

  it("never leaks user IDs in the response shape", async () => {
    const res = await request(app)
      .get(`/api/journal/sentiment?instrument=${encodeURIComponent(INST_OPEN)}`)
      .set(...auth(alice));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("userId");
    expect(body).not.toContain("user_id");
    expect(body).not.toMatch(/\\bemail\\b/);
  });
});
