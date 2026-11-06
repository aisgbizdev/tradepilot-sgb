// Shared Apple account upsert — used by both POST /auth/apple/native and
// (for the identity match check) POST /auth/reauth/apple, mirroring the
// Google account-linking rules in lib/google-account.ts:
//   1. match on apple_id                -> that user
//   2. else match on the VERIFIED email:
//        - not yet linked to Apple      -> link this apple_id, return
//        - already linked, same id      -> return (also caught by step 1)
//        - already linked, other id     -> throw AppleAccountConflictError
//   3. else create a new account with product defaults (same as a brand
//      new Google account: selectedMode "pro", no password, no security
//      question, onboarding not yet completed)
//
// Unlike the Google path, this one runs inside a transaction and retries
// once on a unique-constraint violation, so two parallel requests for the
// same brand-new apple_id (a double-tapped Sign in with Apple button, or a
// retried request) can never create two users or link the same apple_id
// twice — Postgres's unique index on `apple_id` is the source of truth,
// this is just making the race resolve to "one winner, other reads the
// result" instead of an uncaught constraint-violation error.
import { db } from "./db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { AppleProfile } from "./apple-oauth";

export class AppleAccountConflictError extends Error {
  constructor() {
    super("This email is already linked to a different Apple account");
    this.name = "AppleAccountConflictError";
  }
}

/**
 * Thrown when no account can be resolved because Apple's identity token
 * carried no `email` claim (allowed on a returning sign-in) *and* no
 * existing account is linked to this `apple_id` yet. `users.email` is
 * NOT NULL + unique, so a brand-new account cannot be created without a
 * real email — and Apple always includes one on a genuine first
 * authorization, so this should only ever surface for a malformed or
 * out-of-order request. Callers map it to the same generic 401 as any
 * other verification failure.
 */
export class AppleAccountUnavailableError extends Error {
  constructor() {
    super("No email available to create or match an Apple account");
    this.name = "AppleAccountUnavailableError";
  }
}

export interface AppleNameCandidate {
  givenName: string | null;
  familyName: string | null;
}

export interface ResolvedAppleUser {
  user: typeof users.$inferSelect;
  isNewUser: boolean;
}

// Postgres unique-violation errors surface here as a `DrizzleQueryError`
// wrapping the real `pg` driver error (with `.code === "23505"`) as its
// `.cause` — not `.code` directly on the thrown error — so both levels
// need checking.
function hasUniqueViolationCode(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

function isUniqueViolation(err: unknown): boolean {
  if (hasUniqueViolationCode(err)) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return hasUniqueViolationCode(cause);
}

// givenName/familyName are only ever used as a display-name *candidate* at
// account-creation time (rule: never overwrite a display name the user has
// already chosen on any later login).
function candidateDisplayName(
  profile: AppleProfile,
  name: AppleNameCandidate,
): string {
  const full = [name.givenName, name.familyName].filter(Boolean).join(" ").trim();
  if (full) return full.slice(0, 80);
  if (profile.email) return profile.email.split("@")[0]!;
  return `Apple User ${profile.appleId.slice(-6)}`;
}

async function attemptResolve(
  profile: AppleProfile,
  name: AppleNameCandidate,
): Promise<ResolvedAppleUser> {
  return db.transaction(async (tx) => {
    const [byAppleId] = await tx
      .select()
      .from(users)
      .where(eq(users.appleId, profile.appleId))
      .limit(1);
    if (byAppleId) return { user: byAppleId, isNewUser: false };

    if (!profile.email) {
      // Returning sign-in with no email claim, but we don't know this
      // apple_id yet — nothing to match on and nothing safe to create.
      throw new AppleAccountUnavailableError();
    }

    const [byEmail] = await tx
      .select()
      .from(users)
      .where(eq(users.email, profile.email))
      .limit(1);

    if (byEmail) {
      if (byEmail.appleId && byEmail.appleId !== profile.appleId) {
        throw new AppleAccountConflictError();
      }
      const [linked] = await tx
        .update(users)
        .set({ appleId: profile.appleId, updatedAt: new Date() })
        .where(eq(users.id, byEmail.id))
        .returning();
      return { user: linked, isNewUser: false };
    }

    const [created] = await tx
      .insert(users)
      .values({
        email: profile.email,
        appleId: profile.appleId,
        displayName: candidateDisplayName(profile, name),
        selectedMode: "pro",
      })
      .returning();
    return { user: created, isNewUser: true };
  });
}

export async function resolveAppleUser(
  profile: AppleProfile,
  name: AppleNameCandidate = { givenName: null, familyName: null },
): Promise<ResolvedAppleUser> {
  try {
    return await attemptResolve(profile, name);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a race to a concurrent request that just created/linked this
    // exact apple_id (or claimed the same email) inside its own
    // transaction, which has already committed by the time ours aborted.
    // Re-read once, outside a transaction, and hand back the winner's row.
    const [byAppleId] = await db
      .select()
      .from(users)
      .where(eq(users.appleId, profile.appleId))
      .limit(1);
    if (byAppleId) return { user: byAppleId, isNewUser: false };
    throw err;
  }
}
