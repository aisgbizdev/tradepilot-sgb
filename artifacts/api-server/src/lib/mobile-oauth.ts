// Shared plumbing for the mobile OAuth browser flow (Flutter opens a
// system browser at GET /auth/{facebook,tiktok}/mobile/start and gets
// handed back to the app via a custom-scheme deep link once signed in).
// See routes/auth.ts for the full flow and mobileOauthTransactions in the
// schema for the persistent (never in-memory) transaction row this reads
// and writes — the API can run as multiple instances, so an in-process Map
// would silently break as soon as /mobile/start and the provider callback
// land on different instances.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./db";
import { mobileOauthTransactions } from "@workspace/db/schema";

export type MobileOauthProvider = "facebook" | "tiktok";

// Overall transaction TTL — matches the web flow's OAuth state cookies
// (10 minutes: enough for a user to actually complete the provider's
// consent screen, short enough to bound a lost/abandoned attempt).
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

// One-time exchange code TTL, per spec: 60-120 seconds. This is a
// same-request handoff (system browser -> app foreground -> immediate
// token exchange), not a session — a long-lived code here would just be a
// bearer-token-in-a-URL with extra steps.
const EXCHANGE_CODE_TTL_MS = 90 * 1000;

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** BASE64URL(SHA-256(x)) — RFC 7636's S256 code_challenge transform. */
function s256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("base64url");
}

// RFC 7636 code_challenge for S256 is exactly BASE64URL(SHA-256(verifier))
// with no padding: 32 bytes -> 43 base64url characters. Rejecting anything
// else here means a malformed/short-circuited challenge fails fast at
// /mobile/start instead of silently becoming an unusable transaction.
const BASE64URL_SHA256_RE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && BASE64URL_SHA256_RE.test(challenge);
}

/**
 * Exact-match allowlist from MOBILE_OAUTH_REDIRECT_URIS (comma-separated).
 * Deliberately exact string equality — no startsWith/prefix/substring
 * matching — so this can never become an open redirect via a crafted
 * `id.tradepilot.app://auth/callback.evil.com` or similar.
 */
export function isAllowedMobileRedirectUri(redirectUri: unknown): redirectUri is string {
  if (typeof redirectUri !== "string" || redirectUri.length === 0) return false;
  const allowed = (process.env["MOBILE_OAUTH_REDIRECT_URIS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(redirectUri);
}

export interface CreateMobileTransactionParams {
  provider: MobileOauthProvider;
  redirectUri: string;
  codeChallenge: string;
  providerCodeVerifier?: string;
}

/** Issue a new pending mobile transaction. Returns the raw `state` to send
 *  to the provider (never stored — only its hash is). */
export async function createMobileTransaction(
  params: CreateMobileTransactionParams,
): Promise<{ id: number; state: string }> {
  const state = randomBytes(32).toString("hex");
  const [row] = await db
    .insert(mobileOauthTransactions)
    .values({
      stateHash: sha256Hex(state),
      provider: params.provider,
      redirectUri: params.redirectUri,
      mobileCodeChallenge: params.codeChallenge,
      providerCodeVerifier: params.providerCodeVerifier ?? null,
      expiresAt: new Date(Date.now() + TRANSACTION_TTL_MS),
    })
    .returning({ id: mobileOauthTransactions.id });
  return { id: row!.id, state };
}

export type MobileOauthTransactionRow = typeof mobileOauthTransactions.$inferSelect;

/** Plain lookup by id — used by POST /auth/tiktok/complete-signup to find
 *  the linked transaction's `redirectUri` once it already knows the id
 *  (stored on the pendingTiktokSignups row it just consumed). */
export async function getMobileTransactionById(id: number): Promise<MobileOauthTransactionRow | null> {
  const [row] = await db.select().from(mobileOauthTransactions).where(eq(mobileOauthTransactions.id, id)).limit(1);
  return row ?? null;
}

/**
 * Look up a still-pending (not expired, not yet issued a code) mobile
 * transaction by its raw `state`. Returns null for no match — the caller
 * (the provider callback route) treats that as "this is the web flow,
 * fall back to the existing cookie-based check" rather than an error, so
 * mobile/web discrimination never breaks the web flow's own state check.
 */
export async function findPendingMobileTransaction(
  rawState: string | null | undefined,
): Promise<MobileOauthTransactionRow | null> {
  if (!rawState) return null;
  const [row] = await db
    .select()
    .from(mobileOauthTransactions)
    .where(
      and(
        eq(mobileOauthTransactions.stateHash, sha256Hex(rawState)),
        isNull(mobileOauthTransactions.consumedAt),
        isNull(mobileOauthTransactions.exchangeCodeHash),
        gt(mobileOauthTransactions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Provider verified the user — mint the one-time exchange code, bind it to
 * `userId`/`isNewUser`, and return the raw code to put in the deep-link
 * redirect (`?code=...`). The transaction's PKCE challenge was already
 * fixed at /mobile/start time; this step never re-reads client input.
 */
export async function issueMobileExchangeCode(
  transactionId: number,
  userId: number,
  isNewUser: boolean,
): Promise<string> {
  const code = randomBytes(32).toString("hex"); // 256 bits
  await db
    .update(mobileOauthTransactions)
    .set({
      userId,
      isNewUser,
      exchangeCodeHash: sha256Hex(code),
      codeExpiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS),
    })
    .where(eq(mobileOauthTransactions.id, transactionId));
  return code;
}

export type ExchangeOutcome =
  | { ok: true; userId: number; isNewUser: boolean }
  | { ok: false; reason: "not_found" | "already_used" | "expired" | "bad_verifier" };

/**
 * Atomically consume a one-time mobile exchange code. Order of checks
 * matters for the stable error contract the mobile app relies on:
 * unknown code -> not_found, already consumed -> already_used, past its
 * TTL -> expired, PKCE mismatch -> bad_verifier. The actual "mark
 * consumed" is a conditional UPDATE ... WHERE consumed_at IS NULL so two
 * simultaneous exchange attempts for the same code can never both
 * succeed — the loser sees 0 affected rows and reports already_used.
 */
export async function consumeMobileExchangeCode(
  rawCode: string,
  codeVerifier: string,
): Promise<ExchangeOutcome> {
  if (typeof rawCode !== "string" || typeof codeVerifier !== "string" || !rawCode || !codeVerifier) {
    return { ok: false, reason: "not_found" };
  }
  const codeHash = sha256Hex(rawCode);
  const [row] = await db
    .select()
    .from(mobileOauthTransactions)
    .where(eq(mobileOauthTransactions.exchangeCodeHash, codeHash))
    .limit(1);
  if (!row || row.userId == null) return { ok: false, reason: "not_found" };
  if (row.consumedAt) return { ok: false, reason: "already_used" };
  if (!row.codeExpiresAt || row.codeExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const expectedChallenge = Buffer.from(row.mobileCodeChallenge, "utf8");
  const actualChallenge = Buffer.from(s256(codeVerifier), "utf8");
  const verifierOk =
    expectedChallenge.length === actualChallenge.length &&
    timingSafeEqual(expectedChallenge, actualChallenge);
  if (!verifierOk) return { ok: false, reason: "bad_verifier" };

  const [claimed] = await db
    .update(mobileOauthTransactions)
    .set({ consumedAt: new Date() })
    .where(and(eq(mobileOauthTransactions.id, row.id), isNull(mobileOauthTransactions.consumedAt)))
    .returning({ id: mobileOauthTransactions.id });
  if (!claimed) return { ok: false, reason: "already_used" };

  return { ok: true, userId: row.userId, isNewUser: row.isNewUser };
}

/** Build the deep-link URL back into the app — always the transaction's
 *  own already-allowlisted redirectUri, never anything client-supplied at
 *  callback time. */
export function buildMobileCallbackUrl(
  redirectUri: string,
  params: { code: string } | { error: string },
): string {
  const qs = "code" in params ? `code=${encodeURIComponent(params.code)}` : `error=${encodeURIComponent(params.error)}`;
  return `${redirectUri}?${qs}`;
}
