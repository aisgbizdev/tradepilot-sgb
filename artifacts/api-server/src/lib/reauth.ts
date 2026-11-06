// Short-lived, single-use re-authentication tokens for sensitive
// operations (currently: deleting a Google-only account).
//
// A fresh identity proof (e.g. a fresh Google ID token) is exchanged for a
// `reauthToken`. The raw token is returned once and never stored — only its
// SHA-256 hash lands in `reauth_tokens`. Consuming it marks it used inside
// the same transaction, so it can never be replayed.
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { reauthTokens } from "@workspace/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";

export type ReauthPurpose = "delete_account";

const TTL_MS = 5 * 60 * 1000;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Issue a fresh reauth token bound to `userId` + `purpose`. Any prior
 * unused token for the same user+purpose is invalidated so only the newest
 * one works. Returns the raw token (show once) and its expiry.
 */
export async function issueReauthToken(
  userId: number,
  purpose: ReauthPurpose,
): Promise<{ token: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_MS);

  await db.transaction(async (tx) => {
    await tx
      .delete(reauthTokens)
      .where(
        and(eq(reauthTokens.userId, userId), eq(reauthTokens.purpose, purpose)),
      );
    await tx.insert(reauthTokens).values({
      userId,
      tokenHash: hashToken(raw),
      purpose,
      expiresAt,
    });
  });

  return { token: raw, expiresAt };
}

/**
 * Consume a reauth token: it must exist, be unused, unexpired, and belong
 * to `userId` for exactly this `purpose`. On success it's marked used
 * atomically and `true` is returned. Any failure returns `false` (callers
 * surface a single generic 401).
 */
export async function consumeReauthToken(
  userId: number,
  purpose: ReauthPurpose,
  rawToken: string,
): Promise<boolean> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return false;
  const tokenHash = hashToken(rawToken);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: reauthTokens.id })
      .from(reauthTokens)
      .where(
        and(
          eq(reauthTokens.tokenHash, tokenHash),
          eq(reauthTokens.userId, userId),
          eq(reauthTokens.purpose, purpose),
          isNull(reauthTokens.usedAt),
          gt(reauthTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) return false;
    await tx
      .update(reauthTokens)
      .set({ usedAt: new Date() })
      .where(eq(reauthTokens.id, row.id));
    return true;
  });
}
