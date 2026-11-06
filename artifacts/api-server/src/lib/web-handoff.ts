// Mobile-app-to-browser session handoff: POST /auth/web-handoff
// (Bearer-authenticated, called by the Flutter app) mints a one-time code;
// GET /auth/web-handoff/consume (no auth — opened in the system browser)
// atomically claims it and mints a web session. See lib/session.ts's
// createHandoffSession for why this doesn't touch the native session that
// requested it, and routes/auth.ts for the two route handlers.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./db";
import { webHandoffCodes } from "@workspace/db/schema";

// Same-moment handoff, not a session of its own — the app opens the
// browser immediately after requesting this, so 60s is generous while
// still bounding a lost/abandoned attempt.
const CODE_TTL_MS = 60 * 1000;

// Exact-match allowlist — grow this as more pages need a handoff entry
// point. Deliberately exact equality, never a prefix/pattern match, so
// `next` can never become an open redirect via a crafted
// "/topup/../../evil" or similar.
// "/topup?source=app" is the same /topup page, but tells it the browser
// was opened from the app (not a normal desktop/mobile-web visit) — see
// topup.tsx's useDokuReturnStatus, which only fires the
// id.tradepilot.app:// return deep link when this is present. See
// chat 2026-10-05.
const ALLOWED_NEXT_PATHS = new Set<string>(["/topup", "/topup?source=app"]);

export function isAllowedNextPath(next: unknown): next is string {
  return typeof next === "string" && ALLOWED_NEXT_PATHS.has(next);
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Absolute origin the handoff URL is anchored to. Always from server
 * config, never from the request's Host header — required so the code
 * (a one-time bearer-equivalent) can never be redirected to an
 * attacker-controlled host via a spoofed Host/X-Forwarded-Host.
 */
export function resolveWebHandoffOrigin(): string {
  const configured = process.env["PUBLIC_BASE_URL"]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "https://tradepilot.id";
}

/** Issue a new one-time web-handoff code for `userId`. Returns the raw
 *  code (never stored — only its hash is) plus the TTL in seconds. */
export async function issueWebHandoffCode(
  userId: number,
  next: string,
): Promise<{ code: string; expiresIn: number }> {
  const code = randomBytes(32).toString("base64url");
  await db.insert(webHandoffCodes).values({
    userId,
    next,
    codeHash: sha256Hex(code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return { code, expiresIn: Math.floor(CODE_TTL_MS / 1000) };
}

export type WebHandoffOutcome =
  | { ok: true; userId: number; next: string }
  | { ok: false };

/**
 * Atomically consume a one-time web-handoff code. The "mark used" step is
 * a conditional UPDATE ... WHERE used_at IS NULL AND expires_at > now() so
 * two simultaneous consume requests for the same code can never both
 * succeed — same idiom as consumeMobileExchangeCode in mobile-oauth.ts.
 * Collapses "not found" / "already used" / "expired" into one outcome on
 * purpose — the caller only ever responds with a generic redirect to
 * /login?error=handoff_expired, never leaking which case it was.
 */
export async function consumeWebHandoffCode(rawCode: string): Promise<WebHandoffOutcome> {
  if (typeof rawCode !== "string" || !rawCode) return { ok: false };
  const codeHash = sha256Hex(rawCode);
  const [claimed] = await db
    .update(webHandoffCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(webHandoffCodes.codeHash, codeHash),
        isNull(webHandoffCodes.usedAt),
        gt(webHandoffCodes.expiresAt, new Date()),
      ),
    )
    .returning({ userId: webHandoffCodes.userId, next: webHandoffCodes.next });
  if (!claimed) return { ok: false };
  return { ok: true, userId: claimed.userId, next: claimed.next };
}
