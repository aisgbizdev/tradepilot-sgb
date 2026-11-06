// Store-readiness (P2-B3): native push (FCM HTTP v1) delivery, kept
// entirely separate from — and independent of — the existing Web Push
// (VAPID) implementation in `lib/webpush.ts`. Mirrors that file's shape
// deliberately: same "load device rows -> send -> clean up dead tokens on
// error" structure, so the two channels stay easy to reason about side by
// side.
//
// Auth: `google-auth-library`'s `GoogleAuth` — NOT the Firebase Admin SDK
// (not a dependency here, and not needed just to call the plain HTTP v1
// REST endpoint with an OAuth2 bearer token). Credentials are supplied
// explicitly via FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY (see below) rather than Application Default
// Credentials — ADC's GOOGLE_APPLICATION_CREDENTIALS convention expects a
// file path, and this deployment's secret store only hands out strings.
// The downloaded service-account JSON itself must never be committed to
// this repo.
import { GoogleAuth } from "google-auth-library";
import { db } from "./db";
import { nativePushDevices, users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_SEND_TIMEOUT_MS = 8_000;
const ANDROID_CHANNEL_ID = "trade_pilot_alerts";

const projectId = process.env["FIREBASE_PROJECT_ID"] || "";
const clientEmail = process.env["FIREBASE_CLIENT_EMAIL"] || "";
// The secret store hands us the PEM's newlines as the two literal
// characters "\" and "n" — undo that before handing the key to
// google-auth-library, or it fails to parse as a valid private key.
const privateKey = (process.env["FIREBASE_PRIVATE_KEY"] || "").replace(/\\n/g, "\n");

// Replit Secrets (and most PaaS secret stores) are strings, not files, so
// ADC's GOOGLE_APPLICATION_CREDENTIALS file-path convention has nothing to
// find in this deployment — the service-account key must be supplied
// directly via these three vars instead. Checking only FIREBASE_PROJECT_ID
// (as this used to) reported the channel as "configured" even when there
// was no credential GoogleAuth could actually authenticate with, which is
// why sends failed silently in production despite the boot log looking
// clean.
export const nativePushConfigured = Boolean(projectId && clientEmail && privateKey);

if (!nativePushConfigured) {
  // Named per-variable so a deploy log alone tells you exactly which
  // Secret is missing — never the values themselves, just presence.
  const missing = [
    !projectId && "FIREBASE_PROJECT_ID",
    !clientEmail && "FIREBASE_CLIENT_EMAIL",
    !privateKey && "FIREBASE_PRIVATE_KEY",
  ].filter((v): v is string => Boolean(v));
  logger.warn(
    { missing },
    "Native push (FCM) disabled — missing required env var(s). Set all three " +
      "(from the Firebase service-account JSON) as production Secrets to enable delivery.",
  );
}

// `GoogleAuth` caches/refreshes the OAuth2 token internally — one instance
// is reused across every send rather than re-authenticating per call.
const auth = nativePushConfigured
  ? new GoogleAuth({
      scopes: [FCM_SCOPE],
      credentials: { client_email: clientEmail, private_key: privateKey },
    })
  : null;

export interface NativePushPayload {
  title: string;
  body: string;
  /** Allowlisted tap-target — mirrors `NotificationActionType`. Sent as a
   * string in the FCM `data` payload (FCM data values must all be strings). */
  actionType?: string | null;
  actionId?: string | null;
  notificationId?: number | null;
}

/** Last 8 chars only — enough to correlate a log line with a DB row during
 * an incident without ever writing a usable token to the logs. */
function tokenSuffix(token: string): string {
  return token.length > 8 ? token.slice(-8) : token;
}

export type SendOutcome =
  | { ok: true }
  | { ok: false; reason: "unregistered" | "auth" | "invalid" | "network"; status?: number };

interface FcmErrorDetail {
  ["@type"]?: string;
  errorCode?: string;
}

async function sendToDevice(
  token: string,
  platform: string,
  payload: NativePushPayload,
): Promise<SendOutcome> {
  if (!auth) return { ok: false, reason: "auth" };

  const data: Record<string, string> = {};
  if (payload.actionType) data["actionType"] = payload.actionType;
  if (payload.actionId) data["actionId"] = payload.actionId;
  if (payload.notificationId != null) data["notificationId"] = String(payload.notificationId);

  const message = {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data,
      android: {
        notification: { channel_id: ANDROID_CHANNEL_ID },
      },
      apns: {
        payload: {
          aps: { sound: "default", "content-available": 1 },
        },
      },
    },
  };

  try {
    const client = await auth.getClient();
    await client.request({
      url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      method: "POST",
      data: message,
      timeout: FCM_SEND_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err: unknown) {
    const response = (err as { response?: { status?: number; data?: unknown } }).response;
    const status = response?.status;
    const errorCode = (
      response?.data as { error?: { details?: FcmErrorDetail[] } } | undefined
    )?.error?.details?.find((d) => d["@type"]?.endsWith("FcmError"))?.errorCode;

    // FCM reports an unregistered/uninstalled app via 404 (NOT_FOUND) or an
    // UNREGISTERED error detail in the response body — either way the
    // device is gone for good, so we clean it up the same way `webpush.ts`
    // retires dead Web Push subscriptions on 410/404. A bare 400 is NOT
    // reliably "this token is dead" — FCM also returns 400 for a malformed
    // request or a misconfigured project, and deleting on every 400 would
    // wipe out every valid token a user has the moment the server itself
    // is misconfigured. Only delete on a confirmed unregistered signal.
    if (status === 404 || errorCode === "UNREGISTERED") {
      await db.delete(nativePushDevices).where(eq(nativePushDevices.token, token));
      logger.info(
        { tokenSuffix: tokenSuffix(token), platform },
        "Removed invalid native push device token",
      );
      return { ok: false, reason: "unregistered", status };
    }
    logger.warn(
      { status, errorCode, tokenSuffix: tokenSuffix(token), platform },
      "Failed to send native push notification",
    );
    if (status === 401 || status === 403) return { ok: false, reason: "auth", status };
    if (status == null) return { ok: false, reason: "network" };
    return { ok: false, reason: "invalid", status };
  }
}

/**
 * Send to every enabled device the user has registered. Individual device
 * failures never throw (captured per-device as a SendOutcome above) — only
 * a truly unexpected error (e.g. the DB query itself failing) rejects, so
 * a caller doing `void sendNativePushToUser(...).catch(...)` keeps working
 * unchanged. Callers that need to know whether anything actually got
 * delivered (e.g. the /native-push/test endpoint) can inspect the
 * resolved outcomes instead of trusting that a resolved promise means
 * success.
 */
export async function sendNativePushToUser(
  userId: number,
  payload: NativePushPayload,
): Promise<SendOutcome[]> {
  if (!nativePushConfigured) return [];

  // `nativePushEnabled` is the per-user master switch for the whole FCM
  // channel (set via PATCH /push/prefs). When it's off we suppress the OS
  // push entirely — the in-app notification row is still created by the
  // caller (createNotification), so nothing is lost, just no pop-up.
  const [row] = await db
    .select({ nativePushEnabled: users.nativePushEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.nativePushEnabled) return [];

  const devices = await db
    .select()
    .from(nativePushDevices)
    .where(eq(nativePushDevices.userId, userId));

  const enabled = devices.filter((d) => d.enabled);
  const results: SendOutcome[] = [];
  for (const device of enabled) {
    results.push(await sendToDevice(device.token, device.platform, payload));
  }
  return results;
}

export async function sendNativePushToUsers(
  userIds: number[],
  payload: NativePushPayload,
): Promise<void> {
  await Promise.all(userIds.map((id) => sendNativePushToUser(id, payload)));
}
