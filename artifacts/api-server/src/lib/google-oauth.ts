// Google OAuth 2.0 (Authorization Code flow) for login / registration.
//
// Server-side redirect flow — no client-side SDK, no CSP changes:
//   1. GET /api/auth/google         -> 302 to Google consent
//   2. Google -> GET /api/auth/google/callback?code=...&state=...
//   3. exchange code, verify the id_token, upsert the user, set the
//      session cookie, 302 back into the SPA
//
// Config (env):
//   GOOGLE_CLIENT_ID                 - OAuth 2.0 Web client id (redirect flow)
//   GOOGLE_CLIENT_SECRET             - matching client secret
//   PUBLIC_BASE_URL                  - origin the redirect_uri is built from
//   GOOGLE_NATIVE_ALLOWED_CLIENT_IDS - comma-separated allowlist of OAuth
//                                      client ids accepted as the `aud` of a
//                                      native-app Google ID token (Android +
//                                      iOS + server/web). See
//                                      POST /auth/google/native.
//
// The redirect_uri sent to Google is always
//   <base>/api/auth/google/callback
// and must be registered verbatim in the Google Cloud console.

import { OAuth2Client } from "google-auth-library";

export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";

/** Non-empty when the native Google Sign-In endpoint can operate. */
export function nativeGoogleAudiences(): string[] {
  const raw = process.env["GOOGLE_NATIVE_ALLOWED_CLIENT_IDS"] ?? "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // The web client id is always a valid audience too (some SDK setups use
  // a `serverClientId` equal to it), but only if it's actually configured.
  const web = process.env["GOOGLE_CLIENT_ID"]?.trim();
  if (web && !list.includes(web)) list.push(web);
  return list;
}

export function isNativeGoogleConfigured(): boolean {
  return nativeGoogleAudiences().length > 0;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env["GOOGLE_CLIENT_ID"] && process.env["GOOGLE_CLIENT_SECRET"],
  );
}

/**
 * Absolute origin the OAuth redirect_uri is anchored to. Prefers the
 * explicit PUBLIC_BASE_URL env (so the value Google sees is deterministic
 * and matches what's registered) and only falls back to deriving it from
 * the request when that's unset.
 */
export function resolvePublicBaseUrl(reqOrigin?: {
  protocol: string;
  host: string | undefined;
}): string {
  const configured = process.env["PUBLIC_BASE_URL"]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (reqOrigin?.host) {
    return `${reqOrigin.protocol}://${reqOrigin.host}`.replace(/\/+$/, "");
  }
  // Last resort — local dev default (matches the Vite dev-server port).
  return "http://localhost:5173";
}

function createClient(baseUrl: string): OAuth2Client {
  return new OAuth2Client({
    clientId: process.env["GOOGLE_CLIENT_ID"]!,
    clientSecret: process.env["GOOGLE_CLIENT_SECRET"]!,
    redirectUri: `${baseUrl}${GOOGLE_CALLBACK_PATH}`,
  });
}

/** Build the Google consent-screen URL to redirect the browser to. */
export function buildGoogleAuthUrl(baseUrl: string, state: string): string {
  return createClient(baseUrl).generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    // Always show the account chooser so a shared browser doesn't silently
    // reuse whatever Google account happens to be signed in.
    prompt: "select_account",
  });
}

/**
 * Exchange the authorization `code` for tokens, verify the returned
 * id_token against our client id, and return the normalized profile.
 * Throws on any failure (bad code, unverified signature, wrong audience).
 */
export async function exchangeCodeForProfile(
  baseUrl: string,
  code: string,
): Promise<GoogleProfile> {
  const client = createClient(baseUrl);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error("Google token response had no id_token");
  }
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env["GOOGLE_CLIENT_ID"]!,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google id_token payload missing sub/email");
  }
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
  };
}

/**
 * Verify a Google **ID token** obtained by a native app's Google SDK and
 * return the normalized profile.
 *
 * `google-auth-library`'s `verifyIdToken` checks the signature against
 * Google's rotating public keys, the issuer, `exp`/`iat` (with a small
 * clock-skew tolerance), and that `aud` is one of the allowed client ids.
 * We additionally require a verified email and a `sub`.
 *
 * Throws on any failure. The allowlist comes from server config
 * (`GOOGLE_NATIVE_ALLOWED_CLIENT_IDS`), never from the request.
 */
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleProfile> {
  const audiences = nativeGoogleAudiences();
  if (audiences.length === 0) {
    throw new Error("GOOGLE_NATIVE_ALLOWED_CLIENT_IDS is not configured");
  }
  // No client id/secret needed just to verify a token.
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: audiences,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google id_token payload missing sub/email");
  }
  if (payload.email_verified !== true) {
    throw new Error("Google account email is not verified");
  }
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
  };
}
