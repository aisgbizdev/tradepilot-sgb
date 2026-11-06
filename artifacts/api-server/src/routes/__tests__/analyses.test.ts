import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

import app from "../../app";
import { db } from "../../lib/db";
import {
  users,
  sessions,
  analyses,
} from "@workspace/db/schema";

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `analyses-test-${RUN_ID}`;
const INSTRUMENT_PREFIX = `INST-${RUN_ID}`;

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const seededUserIds: number[] = [];
const seededAnalysisIds: number[] = [];

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
      displayName: `Analyses Test ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `analyses-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
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

async function seedAnalysis(userId: number, opts: {
  instrument: string;
  daysAgo?: number;
  techBuyCount?: number | null;
  techSellCount?: number | null;
  techNeutralCount?: number | null;
} = { instrument: INSTRUMENT_PREFIX }) {
  const created = opts.daysAgo
    ? new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000)
    : new Date();
  const [row] = await db
    .insert(analyses)
    .values({
      userId,
      instrument: opts.instrument,
      timeframe: "1h",
      mode: "beginner",
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      marketCondition: "ranging",
      riskLevel: "low",
      confidenceMin: 50,
      confidenceMax: 70,
      techBuyCount: opts.techBuyCount ?? null,
      techSellCount: opts.techSellCount ?? null,
      techNeutralCount: opts.techNeutralCount ?? null,
      createdAt: created,
    })
    .returning({ id: analyses.id });
  seededAnalysisIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  alice = await createUser();
  bob = await createUser();
  // Seed several analyses for alice across two instruments.
  for (let i = 0; i < 5; i++) {
    await seedAnalysis(alice.id, { instrument: `${INSTRUMENT_PREFIX}-A` });
  }
  for (let i = 0; i < 3; i++) {
    await seedAnalysis(alice.id, { instrument: `${INSTRUMENT_PREFIX}-B` });
  }
  // One for bob — must never appear in alice's results.
  await seedAnalysis(bob.id, { instrument: `${INSTRUMENT_PREFIX}-BOB` });
});

afterAll(async () => {
  if (seededAnalysisIds.length > 0) {
    await db.delete(analyses).where(inArray(analyses.id, seededAnalysisIds));
  }
  if (seededUserIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("GET /analyses auth gate", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await request(app).get("/api/analyses");
    expect(res.status).toBe(401);
  });

  it("returns 401 with a bogus bearer token", async () => {
    const res = await request(app)
      .get("/api/analyses")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

describe("GET /analyses/history-summary filters", () => {
  it("combines repeated instrument filters without leaking another user's rows", async () => {
    const query =
      `range=all` +
      `&instruments=${encodeURIComponent(`${INSTRUMENT_PREFIX}-A`)}` +
      `&instruments=${encodeURIComponent(`${INSTRUMENT_PREFIX}-B`)}` +
      `&timeframes=1h`;
    const res = await request(app)
      .get(`/api/analyses/history-summary?${query}`)
      .set(...authHeader(alice));

    expect(res.status).toBe(200);
    expect(res.body.overall.total).toBe(8);
    expect(res.body.byTimeframe).toEqual([
      expect.objectContaining({ timeframe: "1h", total: 8 }),
    ]);
    expect(res.body.byInstrument).toEqual([
      expect.objectContaining({
        instrument: `${INSTRUMENT_PREFIX}-A`,
        total: 5,
        byTimeframe: [expect.objectContaining({ timeframe: "1h", total: 5 })],
      }),
      expect.objectContaining({
        instrument: `${INSTRUMENT_PREFIX}-B`,
        total: 3,
        byTimeframe: [expect.objectContaining({ timeframe: "1h", total: 3 })],
      }),
    ]);
  });

  it("treats the Other Instruments token as every non-core instrument", async () => {
    const res = await request(app)
      .get("/api/analyses/history-summary?range=all&instruments=__other__")
      .set(...authHeader(alice));

    expect(res.status).toBe(200);
    expect(res.body.overall.total).toBe(8);
    expect(res.body.byInstrument.map((row: { instrument: string }) => row.instrument)).toEqual([
      `${INSTRUMENT_PREFIX}-A`,
      `${INSTRUMENT_PREFIX}-B`,
    ]);
  });
});

describe("GET /analyses ownership", () => {
  it("only returns analyses owned by the requesting user", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&limit=100`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    // alice has 5+3 = 8 analyses with this prefix; bob's row must not leak in.
    expect(res.body.total).toBe(8);
    for (const row of res.body.analyses) {
      expect(row.userId).toBe(alice.id);
      expect(row.instrument).not.toContain("BOB");
    }
  });

  it("filters by instrument substring", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}-A&limit=100`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
  });

  it("returns original instrument names when filtering Other Instruments", async () => {
    const res = await request(app)
      .get("/api/analyses?instruments=__other__&limit=100")
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.analyses.every((row: { instrument: string }) =>
      row.instrument.startsWith(INSTRUMENT_PREFIX),
    )).toBe(true);
  });

  it("filters by mode", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&mode=beginner&limit=100`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);

    const proRes = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&mode=pro&limit=100`)
      .set(...authHeader(alice));
    expect(proRes.status).toBe(200);
    expect(proRes.body.total).toBe(0);
  });
});

describe("GET /analyses pagination clamps", () => {
  it("default page=1, limit=20 when not provided", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
  });

  it("clamps limit to a minimum of 1", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&limit=0`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.analyses.length).toBeLessThanOrEqual(1);
  });

  it("clamps limit to a maximum of 100", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&limit=99999`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });

  it("falls back to defaults for non-numeric page/limit", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&page=banana&limit=banana`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
  });

  it("clamps negative page back up to 1", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&page=-3`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
  });

  it("respects a valid page=2 with explicit limit", async () => {
    const res = await request(app)
      .get(`/api/analyses?instrument=${INSTRUMENT_PREFIX}&page=2&limit=5`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(5);
    // alice has 8 total, page=2 limit=5 → 3 items on second page.
    expect(res.body.analyses.length).toBe(3);
  });
});

describe("GET /analyses/:id ownership", () => {
  it("returns 401 without auth", async () => {
    const aliceAnalysisId = seededAnalysisIds[0];
    const res = await request(app).get(`/api/analyses/${aliceAnalysisId}`);
    expect(res.status).toBe(401);
  });

  it("returns the analysis to its owner", async () => {
    const aliceAnalysisId = seededAnalysisIds[0];
    const res = await request(app)
      .get(`/api/analyses/${aliceAnalysisId}`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(aliceAnalysisId);
    expect(res.body.userId).toBe(alice.id);
  });

  it("returns 404 (not 403) when another user requests someone else's analysis (no enumeration)", async () => {
    // Pick alice's first seeded analysis and try as bob.
    const aliceAnalysisId = seededAnalysisIds[0];
    const res = await request(app)
      .get(`/api/analyses/${aliceAnalysisId}`)
      .set(...authHeader(bob));
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app)
      .get(`/api/analyses/999999999`)
      .set(...authHeader(alice));
    expect(res.status).toBe(404);
  });

  it("round-trips the technical-indicator snapshot used by the saved Market Context Summary card", async () => {
    // Snapshot the indicator tally the user saw on the Analyze tab so the
    // saved analysis page can render the same Market Context Summary card.
    const id = await seedAnalysis(alice.id, {
      instrument: `${INSTRUMENT_PREFIX}-MCS`,
      techBuyCount: 7,
      techSellCount: 2,
      techNeutralCount: 3,
    });
    const res = await request(app)
      .get(`/api/analyses/${id}`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.techBuyCount).toBe(7);
    expect(res.body.techSellCount).toBe(2);
    expect(res.body.techNeutralCount).toBe(3);
  });

  it("leaves the snapshot null when no indicators were captured (back-compat for legacy rows)", async () => {
    const id = await seedAnalysis(alice.id, {
      instrument: `${INSTRUMENT_PREFIX}-NO-MCS`,
    });
    const res = await request(app)
      .get(`/api/analyses/${id}`)
      .set(...authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.techBuyCount).toBeNull();
    expect(res.body.techSellCount).toBeNull();
    expect(res.body.techNeutralCount).toBeNull();
  });
});
