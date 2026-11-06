/**
 * lib/doku.ts — signature generation/verification for DOKU Checkout,
 * against the algorithm documented at developers.doku.com/get-started-with-
 * doku-api/signature-component and jokul.doku.com's HTTP Notification
 * best-practice guide (same scheme for outgoing requests AND incoming
 * webhook verification, just a different Request-Target).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, createHmac } from "node:crypto";

const TEST_CLIENT_ID = "MCH-TEST-0001";
const TEST_SECRET_KEY = "test-secret-key-doku";

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["DOKU_CLIENT_ID", "DOKU_SECRET_KEY", "DOKU_ENVIRONMENT"]) savedEnv[k] = process.env[k];
  process.env["DOKU_CLIENT_ID"] = TEST_CLIENT_ID;
  process.env["DOKU_SECRET_KEY"] = TEST_SECRET_KEY;
  process.env["DOKU_ENVIRONMENT"] = "sandbox";
});
afterAll(() => {
  for (const k of ["DOKU_CLIENT_ID", "DOKU_SECRET_KEY", "DOKU_ENVIRONMENT"]) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { isDokuConfigured, verifyDokuNotificationSignature } = await import("../doku");

function referenceSignature(params: {
  clientId: string;
  requestId: string;
  requestTimestamp: string;
  requestTarget: string;
  rawBody: string;
  secretKey: string;
}): string {
  const digest = createHash("sha256").update(params.rawBody, "utf8").digest("base64");
  const componentString = [
    `Client-Id:${params.clientId}`,
    `Request-Id:${params.requestId}`,
    `Request-Timestamp:${params.requestTimestamp}`,
    `Request-Target:${params.requestTarget}`,
    `Digest:${digest}`,
  ].join("\n");
  const hmac = createHmac("sha256", params.secretKey).update(componentString, "utf8").digest("base64");
  return `HMACSHA256=${hmac}`;
}

describe("isDokuConfigured", () => {
  it("is true when both env vars are set", () => {
    expect(isDokuConfigured()).toBe(true);
  });

  it("is false when the secret key is missing", () => {
    const saved = process.env["DOKU_SECRET_KEY"];
    delete process.env["DOKU_SECRET_KEY"];
    expect(isDokuConfigured()).toBe(false);
    process.env["DOKU_SECRET_KEY"] = saved;
  });
});

describe("verifyDokuNotificationSignature", () => {
  const notificationPath = "/api/topups/doku/notify";
  const rawBody = JSON.stringify({
    order: { invoice_number: "TP-abc123", amount: 20000 },
    transaction: { status: "SUCCESS" },
  });

  function validHeaders() {
    const requestId = "354206b9-6770-4c36-9ad8-602d66207b07";
    const requestTimestamp = "2026-01-01T00:00:00Z";
    const signature = referenceSignature({
      clientId: TEST_CLIENT_ID,
      requestId,
      requestTimestamp,
      requestTarget: notificationPath,
      rawBody,
      secretKey: TEST_SECRET_KEY,
    });
    return { clientId: TEST_CLIENT_ID, requestId, requestTimestamp, signature };
  }

  it("accepts a correctly computed signature", () => {
    const ok = verifyDokuNotificationSignature(validHeaders(), rawBody, notificationPath);
    expect(ok).toBe(true);
  });

  it("rejects a tampered body (digest no longer matches)", () => {
    const headers = validHeaders();
    const tamperedBody = JSON.stringify({
      order: { invoice_number: "TP-abc123", amount: 999999999 },
      transaction: { status: "SUCCESS" },
    });
    expect(verifyDokuNotificationSignature(headers, tamperedBody, notificationPath)).toBe(false);
  });

  it("rejects a signature computed for the wrong Request-Target", () => {
    const requestId = "354206b9-6770-4c36-9ad8-602d66207b07";
    const requestTimestamp = "2026-01-01T00:00:00Z";
    const wrongSignature = referenceSignature({
      clientId: TEST_CLIENT_ID,
      requestId,
      requestTimestamp,
      requestTarget: "/some/other/path",
      rawBody,
      secretKey: TEST_SECRET_KEY,
    });
    const ok = verifyDokuNotificationSignature(
      { clientId: TEST_CLIENT_ID, requestId, requestTimestamp, signature: wrongSignature },
      rawBody,
      notificationPath,
    );
    expect(ok).toBe(false);
  });

  it("rejects a signature computed with the wrong secret key", () => {
    const requestId = "354206b9-6770-4c36-9ad8-602d66207b07";
    const requestTimestamp = "2026-01-01T00:00:00Z";
    const wrongSignature = referenceSignature({
      clientId: TEST_CLIENT_ID,
      requestId,
      requestTimestamp,
      requestTarget: notificationPath,
      rawBody,
      secretKey: "not-the-real-secret",
    });
    const ok = verifyDokuNotificationSignature(
      { clientId: TEST_CLIENT_ID, requestId, requestTimestamp, signature: wrongSignature },
      rawBody,
      notificationPath,
    );
    expect(ok).toBe(false);
  });

  it("rejects a Client-Id that doesn't match our configured merchant", () => {
    const requestId = "354206b9-6770-4c36-9ad8-602d66207b07";
    const requestTimestamp = "2026-01-01T00:00:00Z";
    const signature = referenceSignature({
      clientId: "MCH-SOMEONE-ELSE",
      requestId,
      requestTimestamp,
      requestTarget: notificationPath,
      rawBody,
      secretKey: TEST_SECRET_KEY,
    });
    const ok = verifyDokuNotificationSignature(
      { clientId: "MCH-SOMEONE-ELSE", requestId, requestTimestamp, signature },
      rawBody,
      notificationPath,
    );
    expect(ok).toBe(false);
  });

  it("rejects when any header is missing", () => {
    const headers = validHeaders();
    expect(verifyDokuNotificationSignature({ ...headers, signature: undefined }, rawBody, notificationPath)).toBe(false);
    expect(verifyDokuNotificationSignature({ ...headers, requestId: undefined }, rawBody, notificationPath)).toBe(false);
    expect(verifyDokuNotificationSignature({ ...headers, requestTimestamp: undefined }, rawBody, notificationPath)).toBe(false);
    expect(verifyDokuNotificationSignature({ ...headers, clientId: undefined }, rawBody, notificationPath)).toBe(false);
  });

  it("returns false (not throw) when DOKU isn't configured", () => {
    const saved = process.env["DOKU_SECRET_KEY"];
    delete process.env["DOKU_SECRET_KEY"];
    expect(verifyDokuNotificationSignature(validHeaders(), rawBody, notificationPath)).toBe(false);
    process.env["DOKU_SECRET_KEY"] = saved;
  });
});
