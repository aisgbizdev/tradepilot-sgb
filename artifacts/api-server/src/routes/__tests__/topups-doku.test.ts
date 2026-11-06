/**
 * DOKU Checkout integration: POST /topups/doku/checkout (both the "va" and
 * "qris" methods — both real DOKU channels, "va" alone carries the flat
 * admin fee), GET /topups/doku/:id/status, POST /topups/doku/notify (the
 * webhook), and the fact that every fixed package goes through DOKU only
 * (there is no manual/proof-upload path any more — retired once DOKU's own
 * QRIS became available for every package, including the smallest one,
 * which supports "qris" only, not "va"). createDokuCheckout (the outbound
 * HTTP call to DOKU) is mocked; the incoming webhook's signature
 * verification is exercised for real (same convention as
 * auth-mobile-facebook.test.ts mocking only the provider-facing HTTP call,
 * never our own crypto).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes, createHash, createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

vi.mock("../../lib/doku", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/doku")>();
  return { ...actual, createDokuCheckout: vi.fn() };
});

const request = (await import("supertest")).default;
const app = (await import("../../app")).default;
const { db } = await import("../../lib/db");
const { users, sessions, creditTopupRequests, creditLedger, creditBalances, notifications } = await import(
  "@workspace/db/schema"
);
const { getTopupPackages, DOKU_ADMIN_FEE_RUPIAH, getDokuPaymentMethodTypes } = await import("../../lib/credits");
const { createDokuCheckout } = await import("../../lib/doku");

const mockCreateCheckout = vi.mocked(createDokuCheckout);

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `topups-doku-test-${RUN_ID}`;
const NOTIFICATION_PATH = "/api/topups/doku/notify";

const TEST_CLIENT_ID = "MCH-TEST-0001";
const TEST_SECRET_KEY = "test-secret-key-doku";

const [PKG_5K, PKG_20K, PKG_40K] = getTopupPackages();

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
      displayName: `Topups DOKU Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });
  const token = `topups-doku-${RUN_ID}-${suffix}-${randomBytes(8).toString("hex")}`;
  await db.insert(sessions).values({ userId: row.id, token, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  seededUserIds.push(row.id);
  return { id: row.id, email, token };
}

function authHeader(u: SeedUser): [string, string] {
  return ["Authorization", `Bearer ${u.token}`];
}

function fakeCheckoutResult(overrides: Partial<{ paymentUrl: string; sessionId: string; tokenId: string }> = {}) {
  return {
    sessionId: overrides.sessionId ?? `session-${randomBytes(4).toString("hex")}`,
    tokenId: overrides.tokenId ?? `token-${randomBytes(4).toString("hex")}`,
    paymentUrl: overrides.paymentUrl ?? `https://sandbox.doku.com/checkout-link-v2/${randomBytes(4).toString("hex")}`,
    expiredDateRaw: "20260101000000",
  };
}

function dokuSignature(params: {
  requestId: string;
  requestTimestamp: string;
  requestTarget: string;
  rawBody: string;
}): string {
  const digest = createHash("sha256").update(params.rawBody, "utf8").digest("base64");
  const componentString = [
    `Client-Id:${TEST_CLIENT_ID}`,
    `Request-Id:${params.requestId}`,
    `Request-Timestamp:${params.requestTimestamp}`,
    `Request-Target:${params.requestTarget}`,
    `Digest:${digest}`,
  ].join("\n");
  const hmac = createHmac("sha256", TEST_SECRET_KEY).update(componentString, "utf8").digest("base64");
  return `HMACSHA256=${hmac}`;
}

async function sendNotification(bodyObj: object, opts: { badSignature?: boolean } = {}) {
  const rawBody = JSON.stringify(bodyObj);
  const requestId = randomBytes(8).toString("hex");
  const requestTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const signature = opts.badSignature
    ? "HMACSHA256=not-a-real-signature"
    : dokuSignature({ requestId, requestTimestamp, requestTarget: NOTIFICATION_PATH, rawBody });
  return request(app)
    .post(NOTIFICATION_PATH)
    .set("Client-Id", TEST_CLIENT_ID)
    .set("Request-Id", requestId)
    .set("Request-Timestamp", requestTimestamp)
    .set("Signature", signature)
    .set("Content-Type", "application/json")
    .send(bodyObj);
}

const ENV_KEYS = ["DOKU_CLIENT_ID", "DOKU_SECRET_KEY", "DOKU_ENVIRONMENT", "PUBLIC_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env["DOKU_CLIENT_ID"] = TEST_CLIENT_ID;
  process.env["DOKU_SECRET_KEY"] = TEST_SECRET_KEY;
  process.env["DOKU_ENVIRONMENT"] = "sandbox";
  process.env["PUBLIC_BASE_URL"] = "http://localhost:5173";
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, seededUserIds));
  await db.delete(creditBalances).where(inArray(creditBalances.userId, seededUserIds));
  await db.delete(creditTopupRequests).where(inArray(creditTopupRequests.userId, seededUserIds));
  await db.delete(sessions).where(inArray(sessions.userId, seededUserIds));
  await db.delete(users).where(inArray(users.id, seededUserIds));
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  mockCreateCheckout.mockReset();
});

describe("POST /topups/doku/checkout — smallest package (Rp5.000) is QRIS-only", () => {
  it("accepts method=qris for the smallest package", async () => {
    const user = await createUser();
    const fake = fakeCheckoutResult();
    mockCreateCheckout.mockResolvedValueOnce(fake);

    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_5K.amountRupiah, method: "qris" });
    expect(res.status).toBe(201);

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, res.body.id));
    // No admin fee — the smallest package's QRIS payment is exactly the
    // package price.
    expect(row).toMatchObject({ amountRupiah: PKG_5K.amountRupiah, creditsRequested: PKG_5K.credits });
    expect(mockCreateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ amountRupiah: PKG_5K.amountRupiah, paymentMethodTypes: ["QRIS"] }),
    );
  });

  it("rejects method=va for the smallest package — VA isn't offered for it", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_5K.amountRupiah, method: "va" });
    expect(res.status).toBe(400);
  });
});

describe("POST /topups/doku/checkout", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .send({ amountRupiah: PKG_20K.amountRupiah, method: "va" });
    expect(res.status).toBe(401);
  });

  it("rejects an amount that isn't any fixed package", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: 12345, method: "va" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing/invalid method", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_20K.amountRupiah });
    expect(res.status).toBe(400);
  });

  it("VA: creates a pending request, adds the admin fee, and restricts the checkout page to the VA channel", async () => {
    const user = await createUser();
    const fake = fakeCheckoutResult();
    mockCreateCheckout.mockResolvedValueOnce(fake);

    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_20K.amountRupiah, method: "va" });
    expect(res.status).toBe(201);
    expect(res.body.paymentUrl).toBe(fake.paymentUrl);
    expect(typeof res.body.id).toBe("number");

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, res.body.id));
    expect(row).toMatchObject({
      status: "pending",
      paymentProvider: "doku",
      // The row (and what's actually sent to DOKU) is the package price
      // PLUS the flat admin fee that covers DOKU's own transaction fee —
      // credits granted stay tied to the package alone (see below).
      amountRupiah: PKG_20K.amountRupiah + DOKU_ADMIN_FEE_RUPIAH,
      creditsRequested: PKG_20K.credits,
      dokuSessionId: fake.sessionId,
      dokuPaymentUrl: fake.paymentUrl,
    });
    expect(row!.dokuInvoiceNumber).toBeTruthy();
    expect(mockCreateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        amountRupiah: PKG_20K.amountRupiah + DOKU_ADMIN_FEE_RUPIAH,
        paymentMethodTypes: getDokuPaymentMethodTypes("va"),
      }),
    );
  });

  it("QRIS: creates a pending request for the bare package amount (no admin fee) and restricts the checkout page to QRIS", async () => {
    const user = await createUser();
    const fake = fakeCheckoutResult();
    mockCreateCheckout.mockResolvedValueOnce(fake);

    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_20K.amountRupiah, method: "qris" });
    expect(res.status).toBe(201);

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, res.body.id));
    expect(row).toMatchObject({
      status: "pending",
      paymentProvider: "doku",
      amountRupiah: PKG_20K.amountRupiah,
      creditsRequested: PKG_20K.credits,
    });
    expect(mockCreateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ amountRupiah: PKG_20K.amountRupiah, paymentMethodTypes: ["QRIS"] }),
    );
  });

  it("source=app embeds &source=app into DOKU's success/cancel callback URLs; omitted otherwise", async () => {
    const user = await createUser();
    const fake = fakeCheckoutResult();
    mockCreateCheckout.mockResolvedValueOnce(fake);

    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_20K.amountRupiah, method: "qris", source: "app" });
    expect(res.status).toBe(201);
    expect(mockCreateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: expect.stringMatching(/\?doku=success&id=\d+&source=app$/),
        callbackUrlCancel: expect.stringMatching(/\?doku=cancel&id=\d+&source=app$/),
      }),
    );

    mockCreateCheckout.mockResolvedValueOnce(fakeCheckoutResult());
    const plain = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_20K.amountRupiah, method: "qris" });
    expect(plain.status).toBe(201);
    expect(mockCreateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: expect.stringMatching(/\?doku=success&id=\d+$/),
        callbackUrlCancel: expect.stringMatching(/\?doku=cancel&id=\d+$/),
      }),
    );
  });

  it("marks the request rejected and returns 502 when DOKU's API call fails", async () => {
    const user = await createUser();
    mockCreateCheckout.mockRejectedValueOnce(new Error("boom"));

    const res = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_40K.amountRupiah, method: "va" });
    expect(res.status).toBe(502);

    // The row was still created (to reserve the invoice number) but must
    // not be left "pending" forever — no orphaned pending request.
    const rows = await db
      .select()
      .from(creditTopupRequests)
      .where(eq(creditTopupRequests.userId, user.id));
    expect(rows.some((r) => r.status === "rejected")).toBe(true);
  });
});

describe("GET /topups/doku/:id/status", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/topups/doku/1/status");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a request owned by someone else", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    mockCreateCheckout.mockResolvedValueOnce(fakeCheckoutResult());
    const created = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(owner))
      .send({ amountRupiah: PKG_20K.amountRupiah, method: "va" });

    const res = await request(app)
      .get(`/api/topups/doku/${created.body.id}/status`)
      .set(...authHeader(stranger));
    expect(res.status).toBe(404);
  });

  it("returns the current status for the owner", async () => {
    const user = await createUser();
    mockCreateCheckout.mockResolvedValueOnce(fakeCheckoutResult());
    const created = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah: PKG_20K.amountRupiah, method: "va" });

    const res = await request(app)
      .get(`/api/topups/doku/${created.body.id}/status`)
      .set(...authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, status: "pending" });
  });
});

describe("POST /topups/doku/notify (webhook)", () => {
  async function createPendingDokuRequest(user: SeedUser, amountRupiah: number) {
    const fake = fakeCheckoutResult();
    mockCreateCheckout.mockResolvedValueOnce(fake);
    const created = await request(app)
      .post("/api/topups/doku/checkout")
      .set(...authHeader(user))
      .send({ amountRupiah, method: "va" });
    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, created.body.id));
    return row!;
  }

  it("rejects a notification with an invalid signature — no credit granted", async () => {
    const user = await createUser();
    const target = await createPendingDokuRequest(user, PKG_20K.amountRupiah);

    const res = await sendNotification(
      { order: { invoice_number: target.dokuInvoiceNumber, amount: PKG_20K.amountRupiah }, transaction: { status: "SUCCESS" } },
      { badSignature: true },
    );
    expect(res.status).toBe(400);

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, target.id));
    expect(row!.status).toBe("pending");
  });

  it("SUCCESS with a valid signature grants credits and approves the request", async () => {
    const user = await createUser();
    const target = await createPendingDokuRequest(user, PKG_20K.amountRupiah);

    const res = await sendNotification({
      order: { invoice_number: target.dokuInvoiceNumber, amount: PKG_20K.amountRupiah },
      transaction: { status: "SUCCESS" },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, target.id));
    expect(row!.status).toBe("approved");
    expect(row!.creditsGranted).toBe(PKG_20K.credits);

    const [balance] = await db.select().from(creditBalances).where(eq(creditBalances.userId, user.id));
    expect(balance!.balance).toBe(PKG_20K.credits);

    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.topupRequestId, target.id));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ source: "topup_approval", amount: PKG_20K.credits });
  });

  it("a replayed SUCCESS notification for an already-approved request doesn't double-grant credits", async () => {
    const user = await createUser();
    const target = await createPendingDokuRequest(user, PKG_20K.amountRupiah);
    const body = {
      order: { invoice_number: target.dokuInvoiceNumber, amount: PKG_20K.amountRupiah },
      transaction: { status: "SUCCESS" },
    };

    const first = await sendNotification(body);
    expect(first.status).toBe(200);
    const second = await sendNotification(body);
    expect(second.status).toBe(200);

    const [balance] = await db.select().from(creditBalances).where(eq(creditBalances.userId, user.id));
    expect(balance!.balance).toBe(PKG_20K.credits);

    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.topupRequestId, target.id));
    expect(ledgerRows).toHaveLength(1);
  });

  it("FAILED marks the request rejected without granting credit", async () => {
    const user = await createUser();
    const target = await createPendingDokuRequest(user, PKG_40K.amountRupiah);

    const res = await sendNotification({
      order: { invoice_number: target.dokuInvoiceNumber, amount: PKG_40K.amountRupiah },
      transaction: { status: "FAILED" },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, target.id));
    expect(row!.status).toBe("rejected");
    expect(row!.creditsGranted).toBeNull();
  });

  it("PENDING leaves the request pending (nothing to do yet)", async () => {
    const user = await createUser();
    const target = await createPendingDokuRequest(user, PKG_20K.amountRupiah);

    const res = await sendNotification({
      order: { invoice_number: target.dokuInvoiceNumber, amount: PKG_20K.amountRupiah },
      transaction: { status: "PENDING" },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(creditTopupRequests).where(eq(creditTopupRequests.id, target.id));
    expect(row!.status).toBe("pending");
  });

  it("returns 404 for an unknown invoice number", async () => {
    const res = await sendNotification({
      order: { invoice_number: `TP-unknown-${randomBytes(4).toString("hex")}`, amount: 20000 },
      transaction: { status: "SUCCESS" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed body (missing invoice_number)", async () => {
    const res = await sendNotification({ transaction: { status: "SUCCESS" } });
    expect(res.status).toBe(400);
  });
});
