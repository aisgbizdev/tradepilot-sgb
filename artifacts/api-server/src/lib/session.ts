// TradePilot allows only one active session per account — a login on any
// device/browser (password, Google, Apple, TikTok, or Facebook) signs out
// every other device. Centralized here so every login/registration route
// applies the same rule instead of each one deleting old sessions itself.
// The one deliberate exception is the web-handoff flow (createHandoffSession
// below): it mints a web session for a user already signed in natively
// without touching that native session, since the whole point of the
// handoff is to avoid disrupting the app session that requested it.
//
// Also owns the "web" 15-minute idle auto-logout: session validity/idle
// resolution lives here (resolveSession), shared by requireAuth and
// getAuthContext, so there's exactly one place that decides "is this
// session still good" instead of two near-duplicate DB lookups drifting
// apart. Native/mobile-app sessions never idle-time-out — only expiresAt
// governs them — since a backgrounded app sitting idle isn't "the user
// left" the way an unattended browser tab is.
import { eq, and, gt } from "drizzle-orm";
import { db, type DB } from "./db";
import { sessions, authEvents } from "@workspace/db/schema";

export type SessionPlatform = "web" | "native";
type AuthEventReason = "user_initiated" | "idle_timeout";

export const WEB_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// Only write lastActivityAt when it's gone stale by at least this much —
// a session making requests every few seconds would otherwise issue a DB
// write on every single one for no accuracy benefit at a 15-minute scale.
const ACTIVITY_UPDATE_THROTTLE_MS = 60 * 1000;

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

async function logAuthEvent(
  tx: Tx | DB,
  userId: number,
  eventType: "login" | "logout",
  platform: SessionPlatform,
  reason?: AuthEventReason,
): Promise<void> {
  await tx.insert(authEvents).values({ userId, eventType, platform, reason: reason ?? null });
}

export async function createSingleSession(
  userId: number,
  token: string,
  expiresAt: Date,
  platform: SessionPlatform = "web",
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.insert(sessions).values({ userId, token, expiresAt, platform });
    await logAuthEvent(tx, userId, "login", platform);
  });
}

/**
 * Mints a *web* session for a user who is already authenticated on
 * another platform — used only by GET /auth/web-handoff/consume.
 * Deliberately NOT createSingleSession: that deletes every session the
 * user has regardless of platform, so calling it here would immediately
 * log the user out of the native app session that requested this very
 * handoff, defeating the feature. Instead this only clears the user's
 * other *web* sessions (so a handoff doesn't pile up stray browser
 * sessions) and leaves `native` sessions untouched. This is a deliberate,
 * narrow exception to the single-session-per-account rule — product
 * decision, see chat 2026-10-01.
 */
export async function createHandoffSession(
  userId: number,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.platform, "web")));
    await tx.insert(sessions).values({ userId, token, expiresAt, platform: "web" });
    await logAuthEvent(tx, userId, "login", "web");
  });
}

export interface ResolvedSession {
  userId: number;
}

/**
 * The single source of truth for "is this session token still valid" —
 * used by both requireAuth (hard 401 on failure) and getAuthContext
 * (soft null on failure). Handles the web-only 15-minute idle timeout:
 * past that, the session is hard-deleted (same invalidation idiom as
 * logout — this codebase has no soft "revoked" flag) and logged as a
 * logout with reason "idle_timeout". A still-fresh web session gets its
 * lastActivityAt bumped (throttled — see ACTIVITY_UPDATE_THROTTLE_MS).
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const [session] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      platform: sessions.platform,
      lastActivityAt: sessions.lastActivityAt,
    })
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!session) return null;

  if (session.platform === "web") {
    const idleForMs = Date.now() - session.lastActivityAt.getTime();
    if (idleForMs > WEB_IDLE_TIMEOUT_MS) {
      await db.transaction(async (tx) => {
        await tx.delete(sessions).where(eq(sessions.id, session.id));
        await logAuthEvent(tx, session.userId, "logout", "web", "idle_timeout");
      });
      return null;
    }
    if (idleForMs > ACTIVITY_UPDATE_THROTTLE_MS) {
      await db.update(sessions).set({ lastActivityAt: new Date() }).where(eq(sessions.id, session.id));
    }
  }

  return { userId: session.userId };
}

/**
 * Ends a session by token (POST /auth/logout, or the idle-timeout path
 * inside resolveSession above) and logs the matching "logout" auth event
 * with whichever platform that session actually was — the caller doesn't
 * need to know or pass it. A no-op if the token doesn't match any session
 * (already logged out / expired elsewhere).
 */
export async function endSession(
  token: string,
  reason: AuthEventReason = "user_initiated",
): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: sessions.id, userId: sessions.userId, platform: sessions.platform })
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);
    if (!session) return;
    await tx.delete(sessions).where(eq(sessions.id, session.id));
    await logAuthEvent(tx, session.userId, "logout", session.platform, reason);
  });
}
