// Shared Google account upsert — used by both the web redirect callback
// (GET /auth/google/callback) and the native endpoint
// (POST /auth/google/native) so the two flows produce identical accounts.
//
// Rule (matches the web flow that shipped first):
//   1. match on google_id             -> that user
//   2. else match on the VERIFIED email:
//        - not yet linked to Google   -> link this google_id, return
//        - already linked, same id    -> return (also caught by step 1)
//        - already linked, other id   -> throw GoogleAccountConflictError
//   3. else create a new account with product defaults
import { db } from "./db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { GoogleProfile } from "./google-oauth";

export class GoogleAccountConflictError extends Error {
  constructor() {
    super("This email is already linked to a different Google account");
    this.name = "GoogleAccountConflictError";
  }
}

export interface ResolvedGoogleUser {
  user: typeof users.$inferSelect;
  isNewUser: boolean;
}

export async function resolveGoogleUser(
  profile: GoogleProfile,
): Promise<ResolvedGoogleUser> {
  const [byGoogleId] = await db
    .select()
    .from(users)
    .where(eq(users.googleId, profile.googleId))
    .limit(1);
  if (byGoogleId) return { user: byGoogleId, isNewUser: false };

  const [byEmail] = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);

  if (byEmail) {
    if (byEmail.googleId && byEmail.googleId !== profile.googleId) {
      throw new GoogleAccountConflictError();
    }
    const [linked] = await db
      .update(users)
      .set({ googleId: profile.googleId, updatedAt: new Date() })
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
      googleId: profile.googleId,
      displayName,
      selectedMode: "pro",
    })
    .returning();
  return { user: created, isNewUser: true };
}
