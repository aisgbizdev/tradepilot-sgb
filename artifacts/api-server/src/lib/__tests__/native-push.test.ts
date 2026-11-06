// Exercises the FCM outcome-classification logic in `lib/native-push.ts`
// directly (bypassing routes/native-push.ts and its rate limiter). The
// module reads FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY once, eagerly,
// at import time (deliberately — see the boot-warning comment in that
// file), so this file sets fake credentials and mocks `google-auth-library`
// BEFORE dynamically importing the module under test, rather than the
// static `import` + `beforeAll(() => process.env...)` pattern used
// elsewhere in this repo (which only works for env vars read lazily at
// call time). Device rows live in the real DB, matching how the rest of
// this suite tests DB-backed behavior — only the outbound FCM HTTP call is
// mocked, since that's the actual external boundary.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

interface FakeFcmResponse {
  status?: number;
  data?: unknown;
}

class FakeFcmError extends Error {
  response?: { status?: number; data?: unknown };
  constructor(response?: { status?: number; data?: unknown }) {
    super(`fake FCM error${response?.status ? ` (${response.status})` : ""}`);
    this.response = response;
  }
}

// Swapped out per test to script what the "FCM HTTP call" does next.
let fcmRequestImpl: () => Promise<FakeFcmResponse> = async () => ({ status: 200 });

vi.mock("google-auth-library", () => {
  class FakeGoogleAuth {
    // Constructor signature is irrelevant here — sendToDevice never
    // inspects the credentials object, only that GoogleAuth was
    // constructible (i.e. nativePushConfigured was true).
    constructor(_opts: unknown) {}
    async getClient() {
      return {
        request: async () => fcmRequestImpl(),
      };
    }
  }
  return { GoogleAuth: FakeGoogleAuth };
});

const ENV_KEYS = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let nativePush: typeof import("../native-push");
let db: typeof import("../db").db;
let schema: typeof import("@workspace/db/schema");

const RUN_ID = randomBytes(4).toString("hex");
let userId: number;

function fakeToken(label: string): string {
  return `${label}-${randomBytes(24).toString("hex")}`;
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env["FIREBASE_PROJECT_ID"] = "test-project";
  process.env["FIREBASE_CLIENT_EMAIL"] = "test@test-project.iam.gserviceaccount.com";
  // Not a real key — GoogleAuth itself is mocked above, so nothing ever
  // tries to parse this as PEM.
  process.env["FIREBASE_PRIVATE_KEY"] = "-----BEGIN PRIVATE KEY-----\\nZmFrZQ==\\n-----END PRIVATE KEY-----\\n";

  // No vi.resetModules() needed: this project's vitest.config.ts runs
  // `pool: "forks"` with one forked process per test file, so this file
  // already starts with a fresh module registry — nothing here has
  // imported native-push.ts yet, and forcing a reset would risk a
  // duplicate `drizzle-orm` instance diverging from the one `eq` (above)
  // is bound to.
  nativePush = await import("../native-push");
  ({ db } = await import("../db"));
  schema = await import("@workspace/db/schema");

  expect(nativePush.nativePushConfigured).toBe(true);

  const [row] = await db
    .insert(schema.users)
    .values({
      email: `native-push-lib-${RUN_ID}@example.test`,
      displayName: `Native Push Lib ${RUN_ID}`,
    })
    .returning({ id: schema.users.id });
  userId = row!.id;
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
  fcmRequestImpl = async () => ({ status: 200 });
});

async function registerDevice(label: string): Promise<string> {
  const token = fakeToken(label);
  await db.insert(schema.nativePushDevices).values({
    userId,
    token,
    platform: "android",
    enabled: true,
  });
  return token;
}

async function deviceExists(token: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.nativePushDevices.id })
    .from(schema.nativePushDevices)
    .where(eq(schema.nativePushDevices.token, token));
  return rows.length > 0;
}

const PAYLOAD = { title: "Test", body: "Body" };

describe("sendNativePushToUser: outcome classification", () => {
  it("returns ok:true on a successful FCM accept and keeps the token", async () => {
    const token = await registerDevice("ok");
    fcmRequestImpl = async () => ({ status: 200 });

    const results = await nativePush.sendNativePushToUser(userId, PAYLOAD);

    expect(results).toEqual([{ ok: true }]);
    expect(await deviceExists(token)).toBe(true);
  });

  it("deletes the device and reports 'unregistered' on a 404", async () => {
    const token = await registerDevice("404");
    fcmRequestImpl = async () => {
      throw new FakeFcmError({ status: 404 });
    };

    const results = await nativePush.sendNativePushToUser(userId, PAYLOAD);

    expect(results).toEqual([{ ok: false, reason: "unregistered", status: 404 }]);
    expect(await deviceExists(token)).toBe(false);
  });

  it("deletes the device and reports 'unregistered' on an UNREGISTERED error detail", async () => {
    const token = await registerDevice("unreg-detail");
    fcmRequestImpl = async () => {
      throw new FakeFcmError({
        status: 400,
        data: {
          error: {
            details: [
              { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" },
            ],
          },
        },
      });
    };

    const results = await nativePush.sendNativePushToUser(userId, PAYLOAD);

    expect(results).toEqual([{ ok: false, reason: "unregistered", status: 400 }]);
    expect(await deviceExists(token)).toBe(false);
  });

  it("does NOT delete the device on a bare 400 (malformed request / misconfigured project)", async () => {
    const token = await registerDevice("bare-400");
    fcmRequestImpl = async () => {
      throw new FakeFcmError({ status: 400, data: {} });
    };

    const results = await nativePush.sendNativePushToUser(userId, PAYLOAD);

    expect(results).toEqual([{ ok: false, reason: "invalid", status: 400 }]);
    expect(await deviceExists(token)).toBe(true);
  });

  it("classifies 401/403 as 'auth' and keeps the token", async () => {
    const token401 = await registerDevice("401");
    fcmRequestImpl = async () => {
      throw new FakeFcmError({ status: 401 });
    };
    expect(await nativePush.sendNativePushToUser(userId, PAYLOAD)).toEqual([
      { ok: false, reason: "auth", status: 401 },
    ]);
    expect(await deviceExists(token401)).toBe(true);

    await db.delete(schema.nativePushDevices).where(eq(schema.nativePushDevices.userId, userId));
    const token403 = await registerDevice("403");
    fcmRequestImpl = async () => {
      throw new FakeFcmError({ status: 403 });
    };
    expect(await nativePush.sendNativePushToUser(userId, PAYLOAD)).toEqual([
      { ok: false, reason: "auth", status: 403 },
    ]);
    expect(await deviceExists(token403)).toBe(true);
  });

  it("classifies an error with no HTTP response as 'network'", async () => {
    const token = await registerDevice("network");
    fcmRequestImpl = async () => {
      throw new Error("socket hang up");
    };

    const results = await nativePush.sendNativePushToUser(userId, PAYLOAD);

    expect(results).toEqual([{ ok: false, reason: "network" }]);
    expect(await deviceExists(token)).toBe(true);
  });

  it("returns one outcome per enabled device (partial success)", async () => {
    const okToken = await registerDevice("partial-ok");
    const badToken = await registerDevice("partial-404");
    let call = 0;
    fcmRequestImpl = async () => {
      call += 1;
      if (call === 1) return { status: 200 };
      throw new FakeFcmError({ status: 404 });
    };

    const results = await nativePush.sendNativePushToUser(userId, PAYLOAD);

    expect(results).toHaveLength(2);
    const accepted = results.filter((r) => r.ok).length;
    expect(accepted).toBe(1);
    expect(await deviceExists(okToken)).toBe(true);
    expect(await deviceExists(badToken)).toBe(false);
  });

  it("skips disabled devices entirely", async () => {
    const token = fakeToken("disabled");
    await db.insert(schema.nativePushDevices).values({
      userId,
      token,
      platform: "ios",
      enabled: false,
    });

    const results = await nativePush.sendNativePushToUser(userId, PAYLOAD);

    expect(results).toEqual([]);
  });
});
