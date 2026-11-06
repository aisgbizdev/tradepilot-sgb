// DOKU Checkout (Jokul) integration — signature scheme sourced from DOKU's
// official docs (developers.doku.com/get-started-with-doku-api and
// jokul.doku.com/docs/docs/http-notification). Both outgoing requests
// (creating a checkout session) and the incoming payment notification use
// the SAME signature scheme:
//   Digest        = base64(SHA-256(raw JSON body))
//   componentString =
//     "Client-Id:<id>\nRequest-Id:<id>\nRequest-Timestamp:<ts>\n" +
//     "Request-Target:<path>\nDigest:<digest>"
//     (no trailing newline)
//   Signature     = "HMACSHA256=" + base64(HMAC-SHA256(componentString, secretKey))
// For an outgoing request, Request-Target is the API endpoint path we're
// calling. For the incoming notification, Request-Target is the path of
// OUR OWN notification URL (not DOKU's), per DOKU's HTTP Notification
// best-practice guide.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

interface DokuConfig {
  clientId: string;
  secretKey: string;
  baseUrl: string;
}

function getDokuConfig(): DokuConfig | null {
  const clientId = process.env["DOKU_CLIENT_ID"];
  const secretKey = process.env["DOKU_SECRET_KEY"];
  if (!clientId || !secretKey) return null;
  const baseUrl =
    process.env["DOKU_ENVIRONMENT"] === "sandbox"
      ? "https://api-sandbox.doku.com"
      : "https://api.doku.com";
  return { clientId, secretKey, baseUrl };
}

export function isDokuConfigured(): boolean {
  return getDokuConfig() !== null;
}

function sha256Base64(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("base64");
}

function computeDokuSignature(params: {
  secretKey: string;
  clientId: string;
  requestId: string;
  requestTimestamp: string;
  requestTarget: string;
  digest: string;
}): string {
  const componentString = [
    `Client-Id:${params.clientId}`,
    `Request-Id:${params.requestId}`,
    `Request-Timestamp:${params.requestTimestamp}`,
    `Request-Target:${params.requestTarget}`,
    `Digest:${params.digest}`,
  ].join("\n");
  const hmac = createHmac("sha256", params.secretKey).update(componentString, "utf8").digest("base64");
  return `HMACSHA256=${hmac}`;
}

const CHECKOUT_PATH = "/checkout/v1/payment";

export interface CreateDokuCheckoutParams {
  invoiceNumber: string;
  amountRupiah: number;
  callbackUrl: string;
  callbackUrlCancel: string;
  paymentDueDateMinutes?: number;
  /** Restricts which channels DOKU's hosted page shows (e.g. ["QRIS"] or
   *  ["VIRTUAL_ACCOUNT_BCA"]) — per DOKU's docs, omitting this shows every
   *  channel active on the dashboard instead. */
  paymentMethodTypes?: readonly string[];
}

export interface DokuCheckoutResult {
  sessionId: string;
  tokenId: string;
  paymentUrl: string;
  /** DOKU's own format: yyyyMMddHHmmss, UTC+7 — kept as the raw string for
   *  display; not parsed into a Date since we track our own expiry from
   *  paymentDueDateMinutes instead of relying on parsing this format. */
  expiredDateRaw: string;
}

/**
 * Creates a DOKU Checkout session and returns the hosted payment page URL
 * to redirect the customer to. Throws on any non-2xx response or an
 * unexpected response shape — callers must not silently swallow this,
 * since a broken checkout means the user paid nothing and got no link.
 */
export async function createDokuCheckout(params: CreateDokuCheckoutParams): Promise<DokuCheckoutResult> {
  const config = getDokuConfig();
  if (!config) throw new Error("DOKU is not configured (DOKU_CLIENT_ID / DOKU_SECRET_KEY missing)");

  const body = {
    order: {
      amount: params.amountRupiah,
      invoice_number: params.invoiceNumber,
      currency: "IDR",
      callback_url: params.callbackUrl,
      callback_url_cancel: params.callbackUrlCancel,
      language: "ID",
      auto_redirect: true,
    },
    payment: {
      payment_due_date: params.paymentDueDateMinutes ?? 60,
      type: "SALE",
      ...(params.paymentMethodTypes && params.paymentMethodTypes.length > 0
        ? { payment_method_types: params.paymentMethodTypes }
        : {}),
    },
    // NOT setting additional_info.override_notification_url here — per
    // DOKU's docs, that field can only swap the DOMAIN of an ALREADY
    // dashboard-configured Notification URL (the path must match exactly),
    // it can't establish a path from scratch. This app only ever runs one
    // production DOKU environment, so there's no domain to swap between —
    // the Notification URL configured in DOKU Back Office (Checkout
    // Settings) is the single source of truth for where the payment
    // notification webhook goes.
  };
  const bodyJson = JSON.stringify(body);

  const requestId = randomUUID();
  const requestTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const digest = sha256Base64(bodyJson);
  const signature = computeDokuSignature({
    secretKey: config.secretKey,
    clientId: config.clientId,
    requestId,
    requestTimestamp,
    requestTarget: CHECKOUT_PATH,
    digest,
  });

  const res = await fetch(`${config.baseUrl}${CHECKOUT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": config.clientId,
      "Request-Id": requestId,
      "Request-Timestamp": requestTimestamp,
      Signature: signature,
    },
    body: bodyJson,
  });

  const json: unknown = await res.json().catch(() => null);
  const paymentUrl = (json as { response?: { payment?: { url?: string } } } | null)?.response?.payment?.url;
  if (!res.ok || typeof paymentUrl !== "string") {
    logger.error({ status: res.status, body: json }, "[doku] checkout creation failed");
    throw new Error(`DOKU checkout creation failed (HTTP ${res.status})`);
  }

  const response = (json as {
    response: {
      order: { session_id: string };
      payment: { token_id: string; url: string; expired_date: string };
    };
  }).response;

  return {
    sessionId: response.order.session_id,
    tokenId: response.payment.token_id,
    paymentUrl: response.payment.url,
    expiredDateRaw: response.payment.expired_date,
  };
}

export interface DokuNotificationHeaders {
  clientId: string | undefined;
  requestId: string | undefined;
  requestTimestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Verifies the Signature header on an incoming DOKU payment notification.
 * `rawBody` must be the exact bytes DOKU sent (before JSON.parse) — see
 * app.ts's express.json({ verify }) which stashes this on req.rawBody.
 * `notificationPath` is the path of OUR OWN notification endpoint (e.g.
 * "/api/topups/doku/notify"), per DOKU's signature-for-incoming-webhook
 * rule — NOT the DOKU-side API path used when creating the checkout.
 */
export function verifyDokuNotificationSignature(
  headers: DokuNotificationHeaders,
  rawBody: string,
  notificationPath: string,
): boolean {
  const config = getDokuConfig();
  if (!config) return false;
  const { clientId, requestId, requestTimestamp, signature } = headers;
  if (!clientId || !requestId || !requestTimestamp || !signature) return false;
  if (clientId !== config.clientId) return false;

  const digest = sha256Base64(rawBody);
  const expected = computeDokuSignature({
    secretKey: config.secretKey,
    clientId,
    requestId,
    requestTimestamp,
    requestTarget: notificationPath,
    digest,
  });

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

export interface DokuNotificationBody {
  order?: { invoice_number?: string; amount?: number | string };
  transaction?: { status?: string; original_request_id?: string };
}
