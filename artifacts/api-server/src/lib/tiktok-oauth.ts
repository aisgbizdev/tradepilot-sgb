// TikTok Login Kit (OAuth 2.0 + PKCE) for login / registration.
//
// Server-side redirect flow — same shape as lib/google-oauth.ts:
//   1. GET /api/auth/tiktok          -> 302 to TikTok's consent screen
//   2. TikTok -> GET /api/auth/tiktok/callback?code=...&state=...
//   3. exchange code, fetch the user's profile, upsert/pend the user,
//      set the session cookie (or bounce to the "finish signup" page),
//      302 back into the SPA
//
// Critical difference from Google/Apple: TikTok's `user.info.basic` scope
// NEVER returns an email — there is no `email` claim at all. So a
// brand-new TikTok sign-in can't create a `users` row directly (email is
// NOT NULL + unique); it goes through pendingTiktokSignups + a
// complete-signup step that collects a real email first. See
// lib/tiktok-account.ts.
//
// Config (env):
//   TIKTOK_CLIENT_KEY    - TikTok Login Kit client key
//   TIKTOK_CLIENT_SECRET - matching client secret
//   PUBLIC_BASE_URL       - origin the redirect_uri is built from (shared
//                           with Google — see google-oauth.ts)
//
// The redirect_uri sent to TikTok is always
//   <base>/api/auth/tiktok/callback
// and must be registered verbatim in the TikTok for Developers console.
import { createHash, randomBytes } from "node:crypto";

export const TIKTOK_CALLBACK_PATH = "/api/auth/tiktok/callback";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
const FETCH_TIMEOUT_MS = 8_000;

export function isTiktokOAuthConfigured(): boolean {
  return Boolean(process.env["TIKTOK_CLIENT_KEY"] && process.env["TIKTOK_CLIENT_SECRET"]);
}

export interface TiktokProfile {
  tiktokId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** PKCE code_verifier per RFC 7636 — TikTok requires S256 code_challenge. */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Build the TikTok consent-screen URL to redirect the browser to. */
export function buildTiktokAuthUrl(baseUrl: string, state: string, codeVerifier: string): string {
  const params = new URLSearchParams({
    client_key: process.env["TIKTOK_CLIENT_KEY"]!,
    response_type: "code",
    scope: "user.info.basic",
    redirect_uri: `${baseUrl}${TIKTOK_CALLBACK_PATH}`,
    state,
    code_challenge: codeChallengeFor(codeVerifier),
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TiktokTokenResponse {
  access_token?: string;
  open_id?: string;
  error?: string;
  error_description?: string;
}

interface TiktokUserInfoResponse {
  data?: {
    user?: {
      open_id?: string;
      display_name?: string;
      avatar_url?: string;
    };
  };
  error?: { code?: string; message?: string };
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange the authorization `code` for an access token, fetch the user's
 * basic profile, and return it normalized. Throws on any failure (bad
 * code, PKCE mismatch, TikTok API error).
 */
export async function exchangeCodeForTiktokProfile(
  baseUrl: string,
  code: string,
  codeVerifier: string,
): Promise<TiktokProfile> {
  const tokenRes = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_key: process.env["TIKTOK_CLIENT_KEY"]!,
      client_secret: process.env["TIKTOK_CLIENT_SECRET"]!,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${baseUrl}${TIKTOK_CALLBACK_PATH}`,
      code_verifier: codeVerifier,
    }),
  });
  const tokenBody = (await tokenRes.json()) as TiktokTokenResponse;
  if (!tokenRes.ok || !tokenBody.access_token || !tokenBody.open_id) {
    throw new Error(`TikTok token exchange failed: ${tokenBody.error ?? tokenRes.status}`);
  }

  const userRes = await fetchWithTimeout(
    `${USER_INFO_URL}?fields=open_id,display_name,avatar_url`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/json" },
    },
  );
  const userBody = (await userRes.json()) as TiktokUserInfoResponse;
  const user = userBody.data?.user;
  if (!userRes.ok || !user?.open_id) {
    throw new Error(`TikTok user info fetch failed: ${userBody.error?.message ?? userRes.status}`);
  }

  return {
    tiktokId: user.open_id,
    displayName: user.display_name ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
}
