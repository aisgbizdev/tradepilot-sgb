// Facebook Login (OAuth 2.0 Authorization Code flow) for login / registration.
//
// Server-side redirect flow — same shape as lib/google-oauth.ts:
//   1. GET /api/auth/facebook          -> 302 to Facebook's consent screen
//   2. Facebook -> GET /api/auth/facebook/callback?code=...&state=...
//   3. exchange code, fetch the Graph API profile, upsert the user, set
//      the session cookie, 302 back into the SPA
//
// Unlike TikTok, Facebook's `email` permission does return a real,
// Facebook-confirmed email address for the vast majority of accounts, so
// this mirrors Google's account model exactly (match facebook_id -> link
// by verified email -> create). The one edge case Facebook allows that
// Google's OIDC flow doesn't: an account can have no email on file at all
// (e.g. phone-only signup) — `email` may simply be absent from the Graph
// API response. That's rare enough not to warrant TikTok's whole
// pending-signup detour; it's treated as a plain login failure asking the
// user to try a different method.
//
// Config (env):
//   FACEBOOK_APP_ID     - Facebook App ID (public, sent to the browser)
//   FACEBOOK_APP_SECRET - matching App Secret
//   PUBLIC_BASE_URL      - origin the redirect_uri is built from (shared
//                          with Google/TikTok — see google-oauth.ts)
//
// The redirect_uri sent to Facebook is always
//   <base>/api/auth/facebook/callback
// and must be registered verbatim in the Meta for Developers app's Valid
// OAuth Redirect URIs.
const FACEBOOK_API_VERSION = "v21.0";
export const FACEBOOK_CALLBACK_PATH = "/api/auth/facebook/callback";

const AUTHORIZE_URL = `https://www.facebook.com/${FACEBOOK_API_VERSION}/dialog/oauth`;
const TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/oauth/access_token`;
const ME_URL = `https://graph.facebook.com/${FACEBOOK_API_VERSION}/me`;
const FETCH_TIMEOUT_MS = 8_000;

export function isFacebookOAuthConfigured(): boolean {
  return Boolean(process.env["FACEBOOK_APP_ID"] && process.env["FACEBOOK_APP_SECRET"]);
}

export interface FacebookProfile {
  facebookId: string;
  /** Null when Facebook has no confirmed email on file for this account
   *  (rare — e.g. phone-only signups) or the user didn't grant the
   *  `email` permission. Callers must handle this explicitly; there is
   *  no unverified-email state to worry about otherwise, unlike Google. */
  email: string | null;
  name: string | null;
}

/** Build the Facebook consent-screen URL to redirect the browser to. */
export function buildFacebookAuthUrl(baseUrl: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env["FACEBOOK_APP_ID"]!,
    redirect_uri: `${baseUrl}${FACEBOOK_CALLBACK_PATH}`,
    state,
    scope: "email,public_profile",
    response_type: "code",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface FacebookTokenResponse {
  access_token?: string;
  error?: { message?: string; type?: string };
}

interface FacebookMeResponse {
  id?: string;
  name?: string;
  email?: string;
  error?: { message?: string };
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
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
 * profile from the Graph API, and return it normalized. Throws on any
 * failure (bad code, redirect_uri mismatch, Facebook API error).
 */
export async function exchangeCodeForFacebookProfile(
  baseUrl: string,
  code: string,
): Promise<FacebookProfile> {
  const tokenParams = new URLSearchParams({
    client_id: process.env["FACEBOOK_APP_ID"]!,
    client_secret: process.env["FACEBOOK_APP_SECRET"]!,
    redirect_uri: `${baseUrl}${FACEBOOK_CALLBACK_PATH}`,
    code,
  });
  const tokenRes = await fetchWithTimeout(`${TOKEN_URL}?${tokenParams.toString()}`);
  const tokenBody = (await tokenRes.json()) as FacebookTokenResponse;
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new Error(`Facebook token exchange failed: ${tokenBody.error?.message ?? tokenRes.status}`);
  }

  const meParams = new URLSearchParams({
    fields: "id,name,email",
    access_token: tokenBody.access_token,
  });
  const meRes = await fetchWithTimeout(`${ME_URL}?${meParams.toString()}`);
  const meBody = (await meRes.json()) as FacebookMeResponse;
  if (!meRes.ok || !meBody.id) {
    throw new Error(`Facebook profile fetch failed: ${meBody.error?.message ?? meRes.status}`);
  }

  return {
    facebookId: meBody.id,
    email: meBody.email ? meBody.email.toLowerCase() : null,
    name: meBody.name ?? null,
  };
}
