// Covers POST /native-push/test with Firebase genuinely "configured" —
// the success (200), all-rejected (502), and partial-success response
// shapes that `native-push.test.ts` can't exercise (that file intentionally
// runs with Firebase unset, see its "returns 503" tests).
//
// `lib/native-push.ts` reads FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY
// once, eagerly, at import time. To get a fresh module graph with those
// vars set (and google-auth-library mocked) without disturbing the
// existing suite's "unconfigured" module instance, this file sets the env
// vars and calls `vi.resetModules()` in `beforeAll`, then dynamically
// imports `app` and everything it needs (Vitest isolates modules per test
// file by default, so this doesn't affect other test files' registries).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

class FakeFcmError extends Error {
  response?: { status?: number; data?: unknown };
  constructor(response?: { status?: number; data?: unknown }) {
    super(`fake FCM error${response?.status ? ` (${response.status})` : ""}`);
    this.response = response;
  }
}

// Swapped per-test; call() lets a test see how many messages FCM
// "received" so far, for the partial-success case.
let call = 0;
let fcmRequestImpl: (callIndex: number) => Promise<{ status?: number }> = async () => ({ status: 200 });

vi.mock("google-auth-library", () => {
  class FakeGoogleAuth {
    constructor(_opts: unknown) {}
    async getClient() {
      return {
        request: async () => {
          call += 1;
          return fcmRequestImpl(call);
        },
      };
    }
  }
  return { GoogleAuth: FakeGoogleAuth };
});

const ENV_KEYS = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let app: typeof import("../../app").default;
let db: typeof import("../../lib/db").db;
let schema: typeof import("@workspace/db/schema");
let nativePushTestLimiter: typeof import("../../middleware/rate-limit").nativePushTestLimiter;

const RUN_ID = randomBytes(4).toString("hex");
let userId: number;
let token: string;

function fakeDeviceToken(label: string): string {
  return `${label}-${randomBytes(24).toString("hex")}`;
}

function authHeader(): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env["FIREBASE_PROJECT_ID"] = "test-project";
  process.env["FIREBASE_CLIENT_EMAIL"] = "test@test-project.iam.gserviceaccount.com";
  process.env["FIREBASE_PRIVATE_KEY"] =
    "-----BEGIN PRIVATE KEY-----\\nZmFrZQ==\\n-----END PRIVATE KEY-----\\n";

  // No vi.resetModules() needed: this project's vitest.config.ts runs
  // `pool: "forks"` with one forked process per test file, so this file
  // starts with a fresh module registry on its own — nothing here has
  // imported the app graph yet, and forcing a reset would risk duplicate
  // instances of third-party modules already imported above (e.g. `eq`
  // from drizzle-orm) diverging from the copies `app` pulls in below.
  ({ default: app } = await import("../../app"));
  ({ db } = await import("../../lib/db"));
  schema = await import("@workspace/db/schema");
  ({ nativePushTestLimiter } = await import("../../middleware/rate-limit"));

  const email = `native-push-cfg-${RUN_ID}@example.test`;
  const [row] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash: await bcrypt.hash("not-used", 4),
      displayName: `Native Push Cfg ${RUN_ID}`,
    })
    .returning({ id: schema.users.id });
  userId = row!.id;

  token = `${RUN_ID}-${randomBytes(8).toString("hex")}`;
  await db.insert(schema.sessions).values({
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(async () => {
  await db.delete(schema.nativePushDevices).where(eq(schema.nativePushDevices.userId, userId));
  nativePushTestLimiter.store.clear();
  call = 0;
  fcmRequestImpl = async () => ({ status: 200 });
});

describe("POST /native-push/test — Firebase configured", () => {
  it("returns 200 with accepted=1 when FCM accepts the message", async () => {
    await db.insert(schema.nativePushDevices).values({
      userId,
      token: fakeDeviceToken("cfg-ok"),
      platform: "android",
      enabled: true,
    });

    const res = await request(app).post("/api/native-push/test").set(...authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ targeted: 1, accepted: 1, failures: [] });
  });

  it("returns 502 when FCM rejects every targeted device", async () => {
    await db.insert(schema.nativePushDevices).values({
      userId,
      token: fakeDeviceToken("cfg-fail"),
      platform: "android",
      enabled: true,
    });
    fcmRequestImpl = async () => {
      throw new FakeFcmError({ status: 401 });
    };

    const res = await request(app).post("/api/native-push/test").set(...authHeader());

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ targeted: 1, accepted: 0, failures: ["auth"] });
  });

  it("reports a correct partial-success shape across multiple devices", async () => {
    await db.insert(schema.nativePushDevices).values([
      { userId, token: fakeDeviceToken("cfg-partial-a"), platform: "android", enabled: true },
      { userId, token: fakeDeviceToken("cfg-partial-b"), platform: "ios", enabled: true },
      { userId, token: fakeDeviceToken("cfg-partial-c"), platform: "android", enabled: true },
    ]);
    // First device succeeds, the rest are reported unregistered.
    fcmRequestImpl = async (n) => {
      if (n === 1) return { status: 200 };
      throw new FakeFcmError({ status: 404 });
    };

    const res = await request(app).post("/api/native-push/test").set(...authHeader());

    expect(res.status).toBe(200);
    expect(res.body.targeted).toBe(3);
    expect(res.body.accepted).toBe(1);
    expect(res.body.failures).toEqual(["unregistered", "unregistered"]);
    // Invariant from the task spec: 0 <= accepted <= targeted and
    // failures.length === targeted - accepted.
    expect(res.body.accepted).toBeGreaterThanOrEqual(0);
    expect(res.body.accepted).toBeLessThanOrEqual(res.body.targeted);
    expect(res.body.failures.length).toBe(res.body.targeted - res.body.accepted);
  });

  it("returns 429 once the per-user quota is exhausted within the window", async () => {
    await db.insert(schema.nativePushDevices).values({
      userId,
      token: fakeDeviceToken("cfg-rate"),
      platform: "android",
      enabled: true,
    });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/native-push/test").set(...authHeader());
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).post("/api/native-push/test").set(...authHeader());
    expect(blocked.status).toBe(429);
  });
});
