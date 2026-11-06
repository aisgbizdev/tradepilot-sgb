// Sign in with Apple (native app flow) for login / registration.
//
// The mobile app runs Apple's native authorization UI, obtaining an
// `identityToken` (a JWT signed by Apple) and an `authorizationCode`, then
// posts both — plus the RAW nonce it generated (Apple only ever sees the
// SHA-256 hash of it) — to POST /auth/apple/native. The server:
//   1. verifies the identity token's signature against Apple's published
//      JWKS (never just decodes it), issuer, audience, expiry, and nonce;
//   2. exchanges the authorization code with Apple's own token endpoint as
//      a second, independent proof that the code is genuine, unexpired,
//      and unused;
//   3. upserts the account (match apple_id -> link by verified email ->
//      create) and issues a normal TradePilot session.
//
// Config (env):
//   APPLE_TEAM_ID              - Apple Developer Team ID
//   APPLE_KEY_ID               - Key ID of the Sign in with Apple `.p8` key
//   APPLE_PRIVATE_KEY          - PKCS#8 private key from the `.p8` file.
//                                Read only from env/deployment secrets —
//                                never checked into source. `\n` is
//                                unescaped the same way the Firebase
//                                service-account key is handled elsewhere
//                                in this codebase, so the value can be
//                                stored as a single-line secret.
//   APPLE_ALLOWED_CLIENT_IDS   - comma-separated allowlist of audiences
//                                (bundle ids / services ids) accepted as
//                                the `aud` of a native identity token.
//   APPLE_NATIVE_CLIENT_ID     - optional override for the client_id used
//                                when exchanging an authorization code.
//                                Defaults to whichever allowed audience the
//                                identity token actually matched — correct
//                                for a single native iOS app.
//
// Never logged, anywhere in this module or its callers: identityToken,
// authorizationCode, nonce, the generated client-secret JWT, or any Apple
// token-endpoint response body.

import { createHash } from "node:crypto";
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";

export const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

/** Allowlisted audiences for a native Apple identity token's `aud` claim. */
export function nativeAppleAudiences(): string[] {
  const raw = process.env["APPLE_ALLOWED_CLIENT_IDS"] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Non-empty when every piece of Apple native-auth config is present:
 * the audience allowlist, and the three values needed to sign a client
 * secret for the authorization-code exchange. Routes check this first and
 * return 503 rather than throwing when it's false — the server itself
 * never fails to start over missing Apple config.
 */
export function isNativeAppleConfigured(): boolean {
  return (
    nativeAppleAudiences().length > 0 &&
    Boolean(process.env["APPLE_TEAM_ID"]?.trim()) &&
    Boolean(process.env["APPLE_KEY_ID"]?.trim()) &&
    Boolean(process.env["APPLE_PRIVATE_KEY"]?.trim())
  );
}

export interface AppleProfile {
  appleId: string;
  /** Lowercased. Null when Apple didn't include an `email` claim this time
   *  (allowed on a returning sign-in — see resolveAppleUser). */
  email: string | null;
  /** Always true when `email` is non-null: an unverified email is rejected
   *  during verification, so a profile with an email always has it proven. */
  emailVerified: boolean;
  /** The `aud` claim that actually matched the allowlist — reused as the
   *  client_id for the authorization-code exchange. */
  audience: string;
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// A single process-wide remote JWK set. `jose` keeps it cached and only
// refetches https://appleid.apple.com/auth/keys when a token's `kid` isn't
// found in the cached set (subject to `cooldownDuration`, so a burst of
// bad `kid`s can't hammer Apple), or after `cacheMaxAge` elapses — this is
// the "cache with TTL + refresh on unknown kid" behavior required for
// verifying against a rotating key set.
let appleJwks: JWTVerifyGetKey | null = null;
function getAppleJwks(): JWTVerifyGetKey {
  if (!appleJwks) {
    appleJwks = createRemoteJWKSet(APPLE_JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 60 * 60 * 1000,
    });
  }
  return appleJwks;
}

// Test-only seam: jose's Node runtime fetches the remote JWKS with
// node:https directly (not the global `fetch`), so a unit test can't
// intercept it the usual way. Swapping the resolver here lets a test
// exercise the *real* verifyAppleIdentityToken end-to-end against a
// synthetic RSA key (via jose's createLocalJWKSet) instead of either
// hitting the network or duplicating the verification logic in the test.
// Never called from production code. Passing `null` restores the lazy
// singleton above.
export function __setAppleJwksForTesting(resolver: JWTVerifyGetKey | null): void {
  appleJwks = resolver;
}

/**
 * Verify a Sign in with Apple **identity token** obtained by the native app
 * and return the normalized profile. Throws on any failure — callers turn
 * every failure into the same generic 401 so nothing here becomes an
 * account/email enumeration oracle.
 *
 * Validates (never trusts the request body for any of this):
 *  - signature against Apple's live JWKS, algorithm pinned to RS256
 *    (what Apple actually signs identity tokens with — every key at
 *    https://appleid.apple.com/auth/keys is RSA/RS256);
 *  - issuer is exactly https://appleid.apple.com;
 *  - audience is in the configured allowlist;
 *  - exp not passed, iat within a bounded age, both with a small clock-skew
 *    allowance;
 *  - sub present;
 *  - nonce claim equals SHA-256(rawNonce) — the mobile app hashes its raw
 *    nonce before sending it to Apple, so this proves the token was issued
 *    for *this* login attempt;
 *  - email_verified is true (accepting Apple's boolean or string "true")
 *    whenever an email claim is present.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  rawNonce: string,
): Promise<AppleProfile> {
  const audiences = nativeAppleAudiences();
  if (audiences.length === 0) {
    throw new Error("APPLE_ALLOWED_CLIENT_IDS is not configured");
  }

  const { payload } = await jwtVerify(identityToken, getAppleJwks(), {
    issuer: APPLE_ISSUER,
    audience: audiences,
    // Apple signs the identity token itself with RS256 — every key at
    // https://appleid.apple.com/auth/keys is `"kty": "RSA"` /
    // `"alg": "RS256"`. Do not confuse this with buildAppleClientSecret()
    // below: that's a *different* JWT — one we sign ourselves with our
    // own EC private key (the `.p8` file) for the authorization-code
    // exchange — and it correctly stays ES256.
    algorithms: ["RS256"],
    clockTolerance: 60,
    maxTokenAge: "10m",
  });

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new Error("Apple identity token missing sub");

  const expectedNonce = sha256Hex(rawNonce);
  if (typeof payload["nonce"] !== "string" || payload["nonce"] !== expectedNonce) {
    throw new Error("Apple identity token nonce mismatch");
  }

  // jwtVerify already threw if `aud` didn't intersect `audiences`, so this
  // is just recovering *which* allowed audience matched (Apple always
  // sends a single string, but tolerate an array defensively).
  const audClaim = payload.aud;
  const audienceList = Array.isArray(audClaim) ? audClaim : [audClaim];
  const audience = audienceList.find(
    (a): a is string => typeof a === "string" && audiences.includes(a),
  );
  if (!audience) throw new Error("Apple identity token audience not allowed");

  const rawEmail = typeof payload["email"] === "string" ? payload["email"] : null;
  if (rawEmail) {
    const verifiedClaim = payload["email_verified"];
    const emailVerified = verifiedClaim === true || verifiedClaim === "true";
    if (!emailVerified) {
      throw new Error("Apple account email is not verified");
    }
    return { appleId: sub, email: rawEmail.toLowerCase(), emailVerified: true, audience };
  }

  // No email claim at all — allowed on a *returning* sign-in (Apple only
  // guarantees email on the first authorization for a given app). The
  // caller (resolveAppleUser) requires an existing apple_id match in this
  // case; it cannot create a brand-new account without an email.
  return { appleId: sub, email: null, emailVerified: false, audience };
}

export class AppleTokenExchangeError extends Error {
  constructor(message = "Apple authorization code exchange failed") {
    super(message);
    this.name = "AppleTokenExchangeError";
  }
}

/**
 * Build the ES256 client-secret JWT Apple's token endpoint requires in
 * place of a static client secret (Sign in with Apple has no such thing —
 * every exchange is authenticated with a freshly signed, short-lived JWT
 * derived from the `.p8` private key). Minted fresh per request; nothing
 * about it is cached or persisted.
 */
async function buildAppleClientSecret(clientId: string): Promise<string> {
  const teamId = process.env["APPLE_TEAM_ID"]?.trim();
  const keyId = process.env["APPLE_KEY_ID"]?.trim();
  const rawKey = process.env["APPLE_PRIVATE_KEY"];
  if (!teamId || !keyId || !rawKey) {
    throw new Error("Apple native sign-in is not fully configured");
  }
  // Deployment secrets commonly can't hold real newlines; the private key
  // is stored with literal `\n` sequences and unescaped here — the same
  // convention this codebase already uses for FIREBASE_PRIVATE_KEY.
  const pem = rawKey.replace(/\\n/g, "\n");
  const privateKey = await importPKCS8(pem, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

/**
 * Exchange a native authorization code with Apple's own /auth/token
 * endpoint. This is an independent, server-to-server proof that the code
 * is genuine, unexpired, and not already used — an attacker who somehow
 * obtained a valid-looking identity token alone cannot pass this step.
 *
 * Throws `AppleTokenExchangeError` on any failure (invalid/expired/reused
 * code, audience mismatch, network failure); callers turn that into a
 * generic 401. The response body (which may include a refresh_token) is
 * deliberately discarded — see the account-deletion revoke notes for why
 * it is not persisted.
 */
export async function exchangeAppleAuthorizationCode(
  authorizationCode: string,
  clientId: string,
): Promise<void> {
  const clientIdForExchange = process.env["APPLE_NATIVE_CLIENT_ID"]?.trim() || clientId;
  const clientSecret = await buildAppleClientSecret(clientIdForExchange);
  const body = new URLSearchParams({
    client_id: clientIdForExchange,
    client_secret: clientSecret,
    code: authorizationCode,
    grant_type: "authorization_code",
  });

  let response: Response;
  try {
    response = await fetch(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new AppleTokenExchangeError("Apple token endpoint unreachable");
  }

  if (!response.ok) {
    throw new AppleTokenExchangeError(`Apple token endpoint returned ${response.status}`);
  }
  // Body intentionally not read into a variable that could be logged by
  // accident — refresh_token/access_token/id_token never leave this
  // function. See lib/apple-oauth.ts module doc for the storage blocker.
  await response.json();
}
