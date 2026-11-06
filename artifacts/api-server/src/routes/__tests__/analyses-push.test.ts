import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

vi.mock("../../lib/openai", async () => {
  const actual = await vi.importActual<typeof import("../../lib/openai")>("../../lib/openai");
  return {
    ...actual,
    generateAnalysis: vi.fn(async () => ({
      output: {
        marketCondition: "ranging" as const,
        riskLevel: "low" as const,
        confidenceMin: 55,
        confidenceMax: 70,
        tradingBias: "neutral" as const,
        opportunity: "Tunggu breakout struktur untuk konfirmasi.",
        risk: "Sideways panjang bisa kasih sinyal palsu.",
        mainScenario: "Sideways menuju resistance.",
        alternativeScenario: "Breakdown ke support.",
        whyReason: "Likuiditas tipis, range jelas.",
        failureConditions: "Close di luar range.",
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 1 },
      model: "gpt-4o-mock",
    })),
  };
});

vi.mock("../../lib/webpush", async () => {
  const actual = await vi.importActual<typeof import("../../lib/webpush")>("../../lib/webpush");
  return {
    ...actual,
    sendPushToUser: vi.fn(async () => 0),
  };
});

const request = (await import("supertest")).default;
const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, analyses, notifications, pushSubscriptions } = await import(
  "@workspace/db/schema"
);
const { sendPushToUser } = await import("../../lib/webpush");

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `analyses-push-test-${RUN_ID}`;

interface SeedUser {
  id: number;
  email: string;
  token: string;
}

const seededUserIds: number[] = [];

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
      displayName: `Push Test ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });

  const token = `analyses-push-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({
    userId: row.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

let alice: SeedUser;

beforeAll(async () => {
  alice = await createUser();
});

afterAll(async () => {
  if (seededUserIds.length) {
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(analyses).where(inArray(analyses.userId, seededUserIds));
    await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.userId, seededUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  vi.mocked(sendPushToUser).mockClear();
});

describe("POST /api/analyses dispatches push on completion", () => {
  it("invokes sendPushToUser with the analysis-complete payload", async () => {
    const instrument = "XAU/USD";
    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${alice.token}`)
      .send({
        instrument,
        timeframe: "1h",
        mode: "beginner",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ instrument, timeframe: "1h", mode: "beginner" });

    // The route awaits createNotification (which awaits insert+SSE), and push
    // is fire-and-forget but synchronously invoked from createNotification.
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const [calledUserId, payload] = vi.mocked(sendPushToUser).mock.calls[0]!;
    expect(calledUserId).toBe(alice.id);
    expect(payload).toMatchObject({
      title: "Analisis Selesai ✅",
      url: `/analyses/${res.body.id}`,
      tag: `analysis-${res.body.id}`,
    });
    expect(payload.body).toContain(instrument);
    expect(payload.body).toContain("1h");

    // The in-app row also exists so SSE/notification list still works.
    const rows = await db
      .select({ id: notifications.id, title: notifications.title })
      .from(notifications)
      .where(eq(notifications.userId, alice.id));
    expect(rows.some((r) => r.title === "Analisis Selesai")).toBe(true);
  });

  it("does not fail the request when push delivery throws", async () => {
    vi.mocked(sendPushToUser).mockRejectedValueOnce(new Error("transport boom"));

    const instrument = "XAU/USD";
    const res = await request(app)
      .post("/api/analyses")
      .set("Authorization", `Bearer ${alice.token}`)
      .send({
        instrument,
        timeframe: "1h",
        mode: "beginner",
      });

    expect(res.status).toBe(201);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });
});
