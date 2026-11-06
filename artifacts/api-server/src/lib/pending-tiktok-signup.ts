// Short-lived, single-use tokens bridging GET /auth/tiktok/callback (where
// a brand-new TikTok sign-in is first seen, but has no email to create a
// user row with) and POST /auth/tiktok/complete-signup (where the user
// supplies that email). Same hash-and-store shape as lib/reauth.ts, but
// keyed by an anonymous pending profile instead of an existing userId.
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { pendingTiktokSignups } from "@workspace/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { TiktokProfile } from "./tiktok-oauth";

const TTL_MS = 15 * 60 * 1000;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface PendingTiktokProfile extends TiktokProfile {
  /** Set only when this signup was reached via the mobile OAuth browser
   *  flow — see mobileOauthTransactions in the schema. Null for an
   *  ordinary website signup. */
  mobileTransactionId: number | null;
}

/** Issue a fresh pending-signup token for this TikTok profile. Returns the
 *  raw token (show once, via an httpOnly cookie — never a URL) and expiry.
 *  `mobileTransactionId` links this signup to a mobile OAuth transaction so
 *  POST /auth/tiktok/complete-signup knows to hand the browser back to the
 *  app (one-time exchange code) instead of creating a normal web session. */
export async function issuePendingTiktokSignup(
  profile: TiktokProfile,
  mobileTransactionId?: number,
): Promise<{ token: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_MS);

  await db.insert(pendingTiktokSignups).values({
    tokenHash: hashToken(raw),
    tiktokId: profile.tiktokId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    mobileTransactionId: mobileTransactionId ?? null,
    expiresAt,
  });

  return { token: raw, expiresAt };
}

/** Look up (without consuming) the pending profile for a raw token — used
 *  to pre-fill/validate before the user submits their email. Returns null
 *  if the token is missing, expired, or already used. */
export async function peekPendingTiktokSignup(
  rawToken: string,
): Promise<PendingTiktokProfile | null> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return null;
  const [row] = await db
    .select()
    .from(pendingTiktokSignups)
    .where(
      and(
        eq(pendingTiktokSignups.tokenHash, hashToken(rawToken)),
        isNull(pendingTiktokSignups.usedAt),
        gt(pendingTiktokSignups.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    tiktokId: row.tiktokId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    mobileTransactionId: row.mobileTransactionId,
  };
}

/** Consume the pending-signup token inside the caller's transaction — must
 *  be called only once the new user row has actually been created, so a
 *  failed signup can be retried with the same token. */
export async function consumePendingTiktokSignup(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  rawToken: string,
): Promise<PendingTiktokProfile | null> {
  const tokenHash = hashToken(rawToken);
  const [row] = await tx
    .select()
    .from(pendingTiktokSignups)
    .where(
      and(
        eq(pendingTiktokSignups.tokenHash, tokenHash),
        isNull(pendingTiktokSignups.usedAt),
        gt(pendingTiktokSignups.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  await tx
    .update(pendingTiktokSignups)
    .set({ usedAt: new Date() })
    .where(eq(pendingTiktokSignups.id, row.id));
  return {
    tiktokId: row.tiktokId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    mobileTransactionId: row.mobileTransactionId,
  };
}
