// TikTok account lookup + creation.
//
// Unlike Google/Apple (lib/google-account.ts, lib/apple-account.ts) there
// is no email-based linking step here — TikTok never provides one. A
// TikTok sign-in either matches an existing `tiktok_id` (returning login)
// or, if not, must go through the pendingTiktokSignups + complete-signup
// flow (see routes/auth.ts) to collect an email before a user row can
// exist at all.
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "@workspace/db/schema";
import type { TiktokProfile } from "./tiktok-oauth";

export async function findUserByTiktokId(
  tiktokId: string,
): Promise<typeof users.$inferSelect | null> {
  const [row] = await db.select().from(users).where(eq(users.tiktokId, tiktokId)).limit(1);
  return row ?? null;
}

export class TiktokEmailTakenError extends Error {
  constructor() {
    super("This email is already registered");
    this.name = "TiktokEmailTakenError";
  }
}

/**
 * Create a brand-new user from a completed TikTok signup (profile +
 * user-supplied email). Callers must have already consumed the matching
 * pendingTiktokSignups token in the same transaction — see
 * POST /auth/tiktok/complete-signup.
 */
export async function createUserFromTiktokSignup(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  profile: TiktokProfile,
  email: string,
): Promise<typeof users.$inferSelect> {
  const normalizedEmail = email.toLowerCase();
  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  if (existing) throw new TiktokEmailTakenError();

  const displayName = profile.displayName?.trim().slice(0, 80) || normalizedEmail.split("@")[0];
  const [created] = await tx
    .insert(users)
    .values({
      email: normalizedEmail,
      tiktokId: profile.tiktokId,
      tiktokDisplayName: profile.displayName,
      tiktokAvatarUrl: profile.avatarUrl,
      displayName,
      selectedMode: "pro",
    })
    .returning();
  return created;
}
