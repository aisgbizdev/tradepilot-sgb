// Shared Facebook account upsert — used by GET /auth/facebook/callback.
// Mirrors lib/google-account.ts exactly (same rule, same shape):
//   1. match on facebook_id           -> that user
//   2. else match on the email:
//        - not yet linked to Facebook -> link this facebook_id, return
//        - already linked, same id    -> return (also caught by step 1)
//        - already linked, other id   -> throw FacebookAccountConflictError
//   3. else create a new account with product defaults
//
// Facebook's `email` permission returns a Facebook-confirmed address for
// the account — there's no separate "unverified" state to check the way
// Google's OIDC `email_verified` claim requires. Callers must still
// handle `profile.email === null` (rare accounts with no email on file)
// before calling this — see routes/auth.ts.
import { db } from "./db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { FacebookProfile } from "./facebook-oauth";

export class FacebookAccountConflictError extends Error {
  constructor() {
    super("This email is already linked to a different Facebook account");
    this.name = "FacebookAccountConflictError";
  }
}

export interface ResolvedFacebookUser {
  user: typeof users.$inferSelect;
  isNewUser: boolean;
}

export async function resolveFacebookUser(
  profile: FacebookProfile & { email: string },
): Promise<ResolvedFacebookUser> {
  const [byFacebookId] = await db
    .select()
    .from(users)
    .where(eq(users.facebookId, profile.facebookId))
    .limit(1);
  if (byFacebookId) return { user: byFacebookId, isNewUser: false };

  const [byEmail] = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);

  if (byEmail) {
    if (byEmail.facebookId && byEmail.facebookId !== profile.facebookId) {
      throw new FacebookAccountConflictError();
    }
    const [linked] = await db
      .update(users)
      .set({ facebookId: profile.facebookId, updatedAt: new Date() })
      .where(eq(users.id, byEmail.id))
      .returning();
    return { user: linked, isNewUser: false };
  }

  const displayName =
    profile.name?.trim().slice(0, 80) || profile.email.split("@")[0];
  const [created] = await db
    .insert(users)
    .values({
      email: profile.email,
      facebookId: profile.facebookId,
      displayName,
      selectedMode: "pro",
    })
    .returning();
  return { user: created, isNewUser: true };
}
