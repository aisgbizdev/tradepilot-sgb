import webpush from "web-push";
import { db } from "./db";
import { pushSubscriptions } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const vapidEmail = process.env.VAPID_EMAIL || "mailto:admin@aitradingassistant.app";
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";

const vapidConfigured = Boolean(vapidPublicKey && vapidPrivateKey);

if (!vapidConfigured) {
  logger.warn(
    "VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is missing. " +
      "Web Push notifications are disabled. Set both env vars to enable push delivery."
  );
} else {
  try {
    webpush.setVapidDetails(vapidEmail, vapidPublicKey, vapidPrivateKey);
    logger.info("Web Push (VAPID) configured successfully");
  } catch (err) {
    logger.error({ err }, "Failed to configure VAPID details — push notifications disabled");
  }
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function sendPushToUser(userId: number, payload: PushPayload): Promise<void> {
  if (!vapidConfigured) return;

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 410 || status === 404) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        logger.info({ endpoint: sub.endpoint }, "Removed expired push subscription");
      } else {
        logger.warn({ err, endpoint: sub.endpoint }, "Failed to send push notification");
      }
    }
  }
}

export async function sendPushToUsers(userIds: number[], payload: PushPayload): Promise<void> {
  await Promise.all(userIds.map((id) => sendPushToUser(id, payload)));
}

export async function sendPushToAllSubscribed(payload: PushPayload): Promise<void> {
  const subs = await db.select().from(pushSubscriptions);
  const userIds = [...new Set(subs.map((s) => s.userId))];
  await sendPushToUsers(userIds, payload);
}
