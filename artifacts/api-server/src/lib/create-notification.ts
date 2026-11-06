import { db } from "./db";
import { notifications } from "@workspace/db/schema";
import { logger } from "./logger";
import { sendPushToUser } from "./webpush";
import { sendNativePushToUser } from "./native-push";
import { notificationsEmitter } from "./notifications-emitter";

type NotificationType = "info" | "warning" | "error";
type Role = "user" | "admin" | "super_admin";
/** Allowlisted tap-targets — keep in sync with the `notificationActionTypeEnum`
 * pg enum in `lib/db/src/schema/index.ts`. Deliberately closed rather than a
 * free-form URL: the client resolves these to an in-app navigation itself. */
export type NotificationActionType = "open_notification" | "open_analysis";

export interface NotificationContent {
  title: string;
  message: string;
  type?: NotificationType;
  /** Broadcast tag for the in-app notification row (admin broadcasts only). */
  targetRole?: Role | null;
  /**
   * Category slug recognised by `lib/notification-guards.ts`
   * (e.g. "market_news", "calendar_event"). Persisted to
   * `notifications.category` so the per-category frequency cap can
   * count rows without depending on title/message string-matching.
   */
  category?: string | null;
  /**
   * Optional cross-run dedupe key. When set, a UNIQUE constraint on
   * `notifications.dedupe_key` ensures the same key can only ever
   * insert one row — so repeated job ticks for the same news item or
   * calendar event collapse into a single delivery. When the insert
   * conflicts, the call resolves without sending push.
   */
  dedupeKey?: string | null;
  /** Store-readiness (P2-B2): what tapping this notification should do.
   * Omit for a plain informational row with no tap action. */
  actionType?: NotificationActionType | null;
  /** The id `actionType` refers to (e.g. an analysis id for "open_analysis"). */
  actionId?: string | null;
}

/**
 * Optional Web Push payload. When omitted, only the in-app notification +
 * SSE event is delivered (no OS-level pop-up). When provided, push is
 * fired in the background and any delivery error is logged but never
 * propagated back to the caller.
 *
 * `title` / `body` default to the in-app `content.title` / `content.message`
 * when omitted, so the simplest usage is `push: {}`.
 */
export interface PushSpec {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

/**
 * Single source of truth for delivering a user-facing notification:
 *  1. Insert the in-app `notifications` row (so it appears in /notifications).
 *  2. Emit the SSE event (so the in-app feed updates without refresh).
 *  3. If `push` is provided, fire a Web Push delivery in the background
 *     (best-effort; OS pop-up on every device the user has subscribed).
 *
 * The returned promise resolves once the DB insert + SSE emit are done.
 * Push delivery is fire-and-forget and never blocks the caller's HTTP
 * response — failures are logged via `logger.warn`, never thrown.
 *
 * Per-user preference checks (e.g. `users.pushExpiry`) are the caller's
 * responsibility — pass `push: null` (or omit) to suppress the OS pop-up
 * while still creating the in-app notification.
 */
export async function createNotification(
  userId: number,
  content: NotificationContent,
  push?: PushSpec | null,
): Promise<boolean> {
  const type = content.type ?? "info";
  let notificationId: number | undefined;

  // When a dedupeKey is provided, rely on the UNIQUE index to collapse
  // races between concurrent ticks: if a row with this key already
  // exists, `returning` comes back empty and we skip the SSE + push so
  // the user only ever sees one delivery for the same event.
  if (content.dedupeKey) {
    const inserted = await db
      .insert(notifications)
      .values({
        userId,
        title: content.title,
        message: content.message,
        type,
        ...(content.targetRole !== undefined ? { targetRole: content.targetRole } : {}),
        ...(content.category !== undefined ? { category: content.category } : {}),
        ...(content.actionType !== undefined ? { actionType: content.actionType } : {}),
        ...(content.actionId !== undefined ? { actionId: content.actionId } : {}),
        dedupeKey: content.dedupeKey,
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id });
    if (inserted.length === 0) return false;
    notificationId = inserted[0]!.id;
  } else {
    const inserted = await db
      .insert(notifications)
      .values({
        userId,
        title: content.title,
        message: content.message,
        type,
        ...(content.targetRole !== undefined ? { targetRole: content.targetRole } : {}),
        ...(content.category !== undefined ? { category: content.category } : {}),
        ...(content.actionType !== undefined ? { actionType: content.actionType } : {}),
        ...(content.actionId !== undefined ? { actionId: content.actionId } : {}),
      })
      .returning({ id: notifications.id });
    notificationId = inserted[0]?.id;
  }

  notificationsEmitter.emitForUser(userId, {
    id: notificationId,
    title: content.title,
    message: content.message,
    type,
    category: content.category ?? null,
    actionType: content.actionType ?? null,
    actionId: content.actionId ?? null,
    createdAt: new Date().toISOString(),
  });

  // Web Push and Native Push are independent, best-effort channels — a
  // failure (or a disabled channel) in one must never suppress the other,
  // and neither may ever throw back into the caller (this function's
  // success already reflects the DB row being created, not delivery).
  if (push) {
    void sendPushToUser(userId, {
      title: push.title ?? content.title,
      body: push.body ?? content.message,
      ...(push.url !== undefined ? { url: push.url } : {}),
      ...(push.tag !== undefined ? { tag: push.tag } : {}),
    }).catch((err) => {
      logger.warn({ err, userId }, "Background web push delivery failed");
    });

    void sendNativePushToUser(userId, {
      title: push.title ?? content.title,
      body: push.body ?? content.message,
      actionType: content.actionType ?? null,
      actionId: content.actionId ?? null,
      notificationId: notificationId ?? null,
    }).catch((err) => {
      logger.warn({ err, userId }, "Background native push delivery failed");
    });
  }
  return true;
}

/**
 * Bulk variant for fan-out patterns (admin broadcasts, "notify all admins").
 * Inserts every row in one DB call, emits one SSE event per user, and fans
 * out push to every user that does not appear in `pushSkipUserIds`.
 *
 * Callers that pre-filter on per-user preferences (e.g. broadcast respects
 * `users.pushBroadcast`) should pass the opted-out user IDs via
 * `pushSkipUserIds`. Callers that don't care should omit the option.
 */
export async function createNotificationsForUsers(
  userIds: number[],
  content: NotificationContent,
  push?: PushSpec | null,
  options?: { pushSkipUserIds?: number[] },
): Promise<void> {
  if (userIds.length === 0) return;
  const type = content.type ?? "info";

  const rows = userIds.map((userId) => ({
    userId,
    title: content.title,
    message: content.message,
    type,
    ...(content.targetRole !== undefined ? { targetRole: content.targetRole } : {}),
    ...(content.category !== undefined ? { category: content.category } : {}),
    ...(content.actionType !== undefined ? { actionType: content.actionType } : {}),
    ...(content.actionId !== undefined ? { actionId: content.actionId } : {}),
  }));

  // `.returning()` on a multi-row insert comes back in the same order the
  // rows were given, so zipping it back against `userIds` by index
  // correctly pairs each new notification id with the user it belongs to
  // (needed for the native-push data payload and the SSE event).
  const inserted = await db
    .insert(notifications)
    .values(rows)
    .returning({ id: notifications.id, userId: notifications.userId });
  const idByUserId = new Map(inserted.map((r) => [r.userId, r.id]));

  const nowIso = new Date().toISOString();
  for (const userId of userIds) {
    notificationsEmitter.emitForUser(userId, {
      id: idByUserId.get(userId),
      title: content.title,
      message: content.message,
      type,
      category: content.category ?? null,
      actionType: content.actionType ?? null,
      actionId: content.actionId ?? null,
      createdAt: nowIso,
    });
  }

  if (push) {
    const skip = new Set(options?.pushSkipUserIds ?? []);
    const pushTargets = userIds.filter((id) => !skip.has(id));
    for (const userId of pushTargets) {
      void sendPushToUser(userId, {
        title: push.title ?? content.title,
        body: push.body ?? content.message,
        ...(push.url !== undefined ? { url: push.url } : {}),
        ...(push.tag !== undefined ? { tag: push.tag } : {}),
      }).catch((err) => {
        logger.warn({ err, userId }, "Background web push delivery failed");
      });

      void sendNativePushToUser(userId, {
        title: push.title ?? content.title,
        body: push.body ?? content.message,
        actionType: content.actionType ?? null,
        actionId: content.actionId ?? null,
        notificationId: idByUserId.get(userId) ?? null,
      }).catch((err) => {
        logger.warn({ err, userId }, "Background native push delivery failed");
      });
    }
  }
}
