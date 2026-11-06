import { Router } from "express";
import { notifyAdminsUserCreated, notifySuperAdminsUserDeleted } from "../lib/jobs";
import { notifyCriticalSecurityEvent, notifyLoginAlert } from "../lib/security-notification";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { db } from "../lib/db";
import {
  users,
  sessions,
  pushSubscriptions,
  nativePushDevices,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { createSingleSession, createHandoffSession, endSession } from "../lib/session";
import {
  issueWebHandoffCode,
  consumeWebHandoffCode,
  isAllowedNextPath,
  resolveWebHandoffOrigin,
} from "../lib/web-handoff";
import {
  loginLimiter,
  registerLimiter,
  accountDeletionLimiter,
  googleOAuthLimiter,
  googleNativeLoginLimiter,
  appleNativeLoginLimiter,
  facebookOAuthLimiter,
  tiktokOAuthLimiter,
  tiktokCompleteSignupLimiter,
  mobileOauthStartLimiter,
  mobileOauthExchangeLimiter,
  reauthLimiter,
  webHandoffIssueLimiter,
  webHandoffConsumeLimiter,
} from "../middleware/rate-limit";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import {
  buildGoogleAuthUrl,
  exchangeCodeForProfile,
  isGoogleOAuthConfigured,
  isNativeGoogleConfigured,
  resolvePublicBaseUrl,
  verifyGoogleIdToken,
} from "../lib/google-oauth";
import {
  resolveGoogleUser,
  GoogleAccountConflictError,
} from "../lib/google-account";
import {
  isNativeAppleConfigured,
  verifyAppleIdentityToken,
  exchangeAppleAuthorizationCode,
} from "../lib/apple-oauth";
import {
  resolveAppleUser,
  AppleAccountConflictError,
  AppleAccountUnavailableError,
} from "../lib/apple-account";
import { issueReauthToken, consumeReauthToken } from "../lib/reauth";
import {
  buildFacebookAuthUrl,
  exchangeCodeForFacebookProfile,
  isFacebookOAuthConfigured,
} from "../lib/facebook-oauth";
import {
  resolveFacebookUser,
  FacebookAccountConflictError,
} from "../lib/facebook-account";
import {
  buildTiktokAuthUrl,
  exchangeCodeForTiktokProfile,
  generateCodeVerifier,
  isTiktokOAuthConfigured,
} from "../lib/tiktok-oauth";
import { findUserByTiktokId, createUserFromTiktokSignup, TiktokEmailTakenError } from "../lib/tiktok-account";
import { issuePendingTiktokSignup, peekPendingTiktokSignup, consumePendingTiktokSignup } from "../lib/pending-tiktok-signup";
import {
  createMobileTransaction,
  findPendingMobileTransaction,
  getMobileTransactionById,
  issueMobileExchangeCode,
  consumeMobileExchangeCode,
  isAllowedMobileRedirectUri,
  isValidCodeChallenge,
  buildMobileCallbackUrl,
  type MobileOauthTransactionRow,
} from "../lib/mobile-oauth";
import { ExchangeMobileAuthCodeBody } from "@workspace/api-zod";

const router = Router();

/**
 * The public user shape every auth response returns. `hasPassword` lets a
 * client tell a password account from a Google-only one (e.g. to hide the
 * "change password" menu, or to pick the right re-auth method).
 */
function serializeUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    selectedMode: u.selectedMode,
    themePreference: u.themePreference,
    onboardingCompleted: u.onboardingCompleted,
    avatarUrl: u.avatarUrl,
    // `hasPassword` lets a client tell a password account from a
    // Google-only one; `createdAt` was already declared required in the
    // OpenAPI `User` schema but never actually returned — now it is.
    hasPassword: u.passwordHash != null,
    createdAt:
      u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
  };
}

const SECURITY_QUESTIONS = [
  "Nama hewan peliharaan pertama kamu?",
  "Nama kota tempat kamu lahir?",
  "Nama ibu kandung kamu?",
  "Nama sekolah dasar kamu?",
  "Nama teman terbaik masa kecil kamu?",
];

const registerSchema = z.object({
  email: z.string().email("Format email tidak valid"),
  password: z.string().min(6, "Password minimal 6 karakter"),
  displayName: z.string().min(1, "Nama wajib diisi").max(80, "Nama terlalu panjang"),
  selectedMode: z.enum(["beginner", "pro"], {
    errorMap: () => ({ message: "Mode harus 'beginner' atau 'pro'" }),
  }),
  securityQuestion: z
    .string()
    .refine((v) => SECURITY_QUESTIONS.includes(v), "Pertanyaan keamanan tidak valid"),
  securityAnswer: z.string().min(1, "Jawaban keamanan wajib diisi"),
  rememberMe: z.boolean().optional(),
});

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function getSessionExpiry(rememberMe: boolean): Date {
  const ms = rememberMe
    ? 30 * 24 * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms);
}

router.post("/auth/register", registerLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    res.status(400).json({ error: first?.message ?? "Data registrasi tidak valid" });
    return;
  }
  const { email, password, displayName, selectedMode, securityQuestion, securityAnswer, rememberMe } =
    parsed.data;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "Email sudah terdaftar" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const securityAnswerHash = await bcrypt.hash(
    securityAnswer.toLowerCase().trim(),
    12
  );

  const [user] = await db
    .insert(users)
    .values({
      email: email.toLowerCase(),
      passwordHash,
      displayName,
      selectedMode: selectedMode ?? "pro",
      securityQuestion,
      securityAnswerHash,
    })
    .returning();

  const token = generateToken();
  const expiresAt = getSessionExpiry(rememberMe ?? false);

  await createSingleSession(user.id, token, expiresAt);

  res.cookie("session_token", token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    expires: expiresAt,
  });

  void notifyAdminsUserCreated(user.displayName);

  res.status(201).json({ token, user: serializeUser(user) });
});

const loginSchema = z.object({
  email: z.string().min(1, "Username atau email wajib diisi"),
  password: z.string().min(1, "Password wajib diisi"),
  rememberMe: z.boolean().optional(),
});

router.post("/auth/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    res.status(400).json({ error: first?.message ?? "Email dan password wajib diisi" });
    return;
  }
  const { email, password, rememberMe } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user) {
    res.status(401).json({ error: "Email atau password salah" });
    return;
  }

  // Google-OAuth-only account (no local password). Steer the user to the
  // Google button instead of leaking "this email exists" via a distinct
  // 401 — but a specific message here is a materially better UX and the
  // email is already confirmed to exist by this branch only when the
  // password would also have to match, so keep it explicit.
  if (!user.passwordHash) {
    res.status(401).json({
      error: "Akun ini terdaftar lewat Google. Silakan login dengan Google.",
    });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Email atau password salah" });
    return;
  }

  const token = generateToken();
  const expiresAt = getSessionExpiry(rememberMe ?? false);

  await createSingleSession(user.id, token, expiresAt);

  res.cookie("session_token", token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    expires: expiresAt,
  });

  void notifyLoginAlert(user.id);

  res.json({ token, user: serializeUser(user) });
});

// ---------------------------------------------------------------------------
// Google OAuth 2.0 (login + registration) — server-side redirect flow.
// See lib/google-oauth.ts for the flow overview and required env config.
// ---------------------------------------------------------------------------

const GOOGLE_STATE_COOKIE = "g_oauth_state";
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

function requestOrigin(req: { protocol: string; get(name: string): string | undefined }) {
  return { protocol: req.protocol, host: req.get("host") };
}

// Start the flow: stash a CSRF `state` in a short-lived cookie and bounce
// the browser to Google's consent screen.
router.get("/auth/google", googleOAuthLimiter, (req, res) => {
  if (!isGoogleOAuthConfigured()) {
    res.status(503).json({ error: "Login Google belum dikonfigurasi." });
    return;
  }

  const state = generateToken();
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: GOOGLE_STATE_TTL_MS,
    path: "/api/auth/google",
  });

  const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
  res.redirect(buildGoogleAuthUrl(baseUrl, state));
});

// Google redirects back here with `?code` + `?state`. On any failure we
// bounce to /login?error=google rather than showing a JSON blob.
router.get("/auth/google/callback", googleOAuthLimiter, async (req, res) => {
  const fail = (reason: string, code = "google") => {
    res.clearCookie(GOOGLE_STATE_COOKIE, { path: "/api/auth/google" });
    logger.warn({ reason }, "[auth] Google OAuth callback failed");
    res.redirect(`/login?error=${code}`);
  };

  if (!isGoogleOAuthConfigured()) {
    fail("not_configured");
    return;
  }

  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
  const cookieState = req.cookies?.[GOOGLE_STATE_COOKIE];

  if (req.query["error"]) {
    // User denied consent, or Google returned an error param.
    fail(`google_error:${String(req.query["error"]).slice(0, 40)}`);
    return;
  }
  if (!code || !state || !cookieState || state !== cookieState) {
    fail("bad_state");
    return;
  }

  let profile;
  try {
    const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
    profile = await exchangeCodeForProfile(baseUrl, code);
  } catch (err) {
    logger.warn({ err }, "[auth] Google code exchange failed");
    fail("exchange_failed");
    return;
  }

  if (!profile.emailVerified) {
    fail("email_unverified", "google_unverified");
    return;
  }

  // Upsert: match on google_id, then link by verified email, else create.
  // Shared with POST /auth/google/native — see lib/google-account.ts.
  let user: typeof users.$inferSelect;
  let isNewUser: boolean;
  try {
    ({ user, isNewUser } = await resolveGoogleUser(profile));
  } catch (err) {
    logger.error({ err }, "[auth] Google user upsert failed");
    fail(
      err instanceof GoogleAccountConflictError ? "account_conflict" : "upsert_failed",
    );
    return;
  }

  const token = generateToken();
  // A Google sign-in is an explicit "this is my device" action — give it
  // the long (remember-me) session like the checkbox on the login form.
  const expiresAt = getSessionExpiry(true);

  await createSingleSession(user.id, token, expiresAt);

  res.clearCookie(GOOGLE_STATE_COOKIE, { path: "/api/auth/google" });
  res.cookie("session_token", token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    expires: expiresAt,
  });

  if (isNewUser) {
    void notifyAdminsUserCreated(user.displayName);
  }
  void notifyLoginAlert(user.id);

  // Land on the dashboard — it's a ProtectedRoute (the fresh session
  // cookie satisfies it) and it fires the onboarding modal for the
  // brand-new accounts that skipped the register form.
  res.redirect("/dashboard");
});

// ---------------------------------------------------------------------------
// Facebook Login (login + registration) — server-side redirect flow.
// See lib/facebook-oauth.ts for the flow overview and required env config.
// Mirrors the Google block above exactly (Facebook's `email` permission
// returns a Facebook-confirmed address, so account linking works the same
// way) — the one difference is a rare account with no email on file at
// all, handled as a plain login failure rather than TikTok's pending-
// signup detour.
// ---------------------------------------------------------------------------

const FACEBOOK_STATE_COOKIE = "fb_oauth_state";
const FACEBOOK_STATE_TTL_MS = 10 * 60 * 1000;

router.get("/auth/facebook", facebookOAuthLimiter, (req, res) => {
  if (!isFacebookOAuthConfigured()) {
    res.status(503).json({ error: "Login Facebook belum dikonfigurasi." });
    return;
  }

  const state = generateToken();
  res.cookie(FACEBOOK_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: FACEBOOK_STATE_TTL_MS,
    path: "/api/auth/facebook",
  });

  const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
  res.redirect(buildFacebookAuthUrl(baseUrl, state));
});

// ---------------------------------------------------------------------------
// Mobile OAuth browser flow (Flutter) — Facebook. See lib/mobile-oauth.ts
// for the transaction model. The Flutter app opens this URL in a system
// browser; it validates redirect_uri + PKCE params, creates a persistent
// transaction row, and redirects straight to Facebook's own consent
// screen using the SAME provider-facing redirect_uri
// (/auth/facebook/callback) as the website flow — nothing about what
// Facebook itself sees is any different from a normal web login.
// ---------------------------------------------------------------------------
router.get("/auth/facebook/mobile/start", mobileOauthStartLimiter, async (req, res) => {
  if (!isFacebookOAuthConfigured()) {
    res.status(503).json({ error: "provider_unavailable" });
    return;
  }

  const redirectUri = typeof req.query["redirect_uri"] === "string" ? req.query["redirect_uri"] : null;
  const codeChallenge = typeof req.query["code_challenge"] === "string" ? req.query["code_challenge"] : null;
  const codeChallengeMethod =
    typeof req.query["code_challenge_method"] === "string" ? req.query["code_challenge_method"] : null;

  if (!isAllowedMobileRedirectUri(redirectUri)) {
    res.status(400).json({ error: "invalid_callback" });
    return;
  }
  if (codeChallengeMethod !== "S256" || !isValidCodeChallenge(codeChallenge)) {
    res.status(400).json({ error: "invalid_callback" });
    return;
  }

  const { state } = await createMobileTransaction({
    provider: "facebook",
    redirectUri,
    codeChallenge,
  });

  const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
  res.redirect(buildFacebookAuthUrl(baseUrl, state));
});

// Facebook and TikTok's own consent screens redirect back to the SAME
// callback URL below for both the website and the mobile OAuth browser
// flow (Flutter) — the provider itself only ever knows about one
// registered HTTPS redirect_uri. The two flows are told apart purely by
// whether the returned `state` matches a pending mobileOauthTransactions
// row (mobile) or the state cookie set by GET /auth/facebook below (web);
// see lib/mobile-oauth.ts. Checked first, before any cookie is even read,
// so the website flow's own logic further down is completely unchanged
// when it isn't a mobile transaction.
async function handleFacebookMobileCallback(
  req: { query: Record<string, unknown>; protocol: string; get(name: string): string | undefined },
  res: { redirect(url: string): void },
  transaction: MobileOauthTransactionRow,
): Promise<void> {
  const fail = (errorCode: string) => {
    logger.warn({ errorCode, provider: "facebook" }, "[auth] Facebook mobile OAuth callback failed");
    res.redirect(buildMobileCallbackUrl(transaction.redirectUri, { error: errorCode }));
  };

  if (req.query["error"]) {
    fail("access_denied");
    return;
  }
  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  if (!code) {
    fail("invalid_state");
    return;
  }
  if (!isFacebookOAuthConfigured()) {
    fail("provider_unavailable");
    return;
  }

  let profile;
  try {
    const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
    profile = await exchangeCodeForFacebookProfile(baseUrl, code);
  } catch (err) {
    logger.warn({ err }, "[auth] Facebook mobile code exchange failed");
    fail("authentication_failed");
    return;
  }

  if (!profile.email) {
    fail("facebook_no_email");
    return;
  }

  let user: typeof users.$inferSelect;
  let isNewUser: boolean;
  try {
    ({ user, isNewUser } = await resolveFacebookUser({ ...profile, email: profile.email }));
  } catch (err) {
    if (err instanceof FacebookAccountConflictError) {
      fail("account_conflict");
    } else {
      logger.error({ err }, "[auth] Facebook mobile user upsert failed");
      fail("authentication_failed");
    }
    return;
  }

  // No session is created here — only a one-time code. The mobile app
  // exchanges it via POST /auth/mobile/exchange, which is the only point
  // in this whole flow that creates a real TradePilot session.
  const exchangeCode = await issueMobileExchangeCode(transaction.id, user.id, isNewUser);
  res.redirect(buildMobileCallbackUrl(transaction.redirectUri, { code: exchangeCode }));
}

// Facebook redirects back here with `?code` + `?state`. On any failure we
// bounce to /login?error=facebook rather than showing a JSON blob.
router.get("/auth/facebook/callback", facebookOAuthLimiter, async (req, res) => {
  const stateParam = typeof req.query["state"] === "string" ? req.query["state"] : null;
  const mobileTransaction = await findPendingMobileTransaction(stateParam);
  if (mobileTransaction) {
    await handleFacebookMobileCallback(req, res, mobileTransaction);
    return;
  }

  const fail = (reason: string, code = "facebook") => {
    res.clearCookie(FACEBOOK_STATE_COOKIE, { path: "/api/auth/facebook" });
    logger.warn({ reason }, "[auth] Facebook OAuth callback failed");
    res.redirect(`/login?error=${code}`);
  };

  if (!isFacebookOAuthConfigured()) {
    fail("not_configured");
    return;
  }

  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
  const cookieState = req.cookies?.[FACEBOOK_STATE_COOKIE];

  if (req.query["error"]) {
    fail(`facebook_error:${String(req.query["error"]).slice(0, 40)}`);
    return;
  }
  if (!code || !state || !cookieState || state !== cookieState) {
    fail("bad_state");
    return;
  }

  let profile;
  try {
    const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
    profile = await exchangeCodeForFacebookProfile(baseUrl, code);
  } catch (err) {
    logger.warn({ err }, "[auth] Facebook code exchange failed");
    fail("exchange_failed");
    return;
  }

  if (!profile.email) {
    fail("no_email", "facebook_no_email");
    return;
  }

  // Upsert: match on facebook_id, then link by email, else create.
  let user: typeof users.$inferSelect;
  let isNewUser: boolean;
  try {
    ({ user, isNewUser } = await resolveFacebookUser({ ...profile, email: profile.email }));
  } catch (err) {
    logger.error({ err }, "[auth] Facebook user upsert failed");
    fail(
      err instanceof FacebookAccountConflictError ? "account_conflict" : "upsert_failed",
    );
    return;
  }

  const token = generateToken();
  const expiresAt = getSessionExpiry(true);

  await createSingleSession(user.id, token, expiresAt);

  res.clearCookie(FACEBOOK_STATE_COOKIE, { path: "/api/auth/facebook" });
  res.cookie("session_token", token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    expires: expiresAt,
  });

  if (isNewUser) {
    void notifyAdminsUserCreated(user.displayName);
  }
  void notifyLoginAlert(user.id);

  res.redirect("/dashboard");
});

// ---------------------------------------------------------------------------
// TikTok Login Kit (login + registration) — server-side redirect flow.
// See lib/tiktok-oauth.ts for the flow overview and required env config.
//
// TikTok never returns an email, so — unlike Google/Apple — a brand-new
// sign-in can't create the user row directly at callback time. It instead
// issues a pendingTiktokSignups token (short-lived httpOnly cookie) and
// bounces to /auth/tiktok/complete-signup, which collects a real email
// before the account is actually created.
// ---------------------------------------------------------------------------

const TIKTOK_STATE_COOKIE = "tt_oauth_state";
const TIKTOK_VERIFIER_COOKIE = "tt_oauth_verifier";
const TIKTOK_PENDING_COOKIE = "tt_pending_signup";
const TIKTOK_STATE_TTL_MS = 10 * 60 * 1000;
const TIKTOK_PENDING_TTL_MS = 15 * 60 * 1000;

router.get("/auth/tiktok", tiktokOAuthLimiter, (req, res) => {
  if (!isTiktokOAuthConfigured()) {
    res.status(503).json({ error: "Login TikTok belum dikonfigurasi." });
    return;
  }

  const state = generateToken();
  const codeVerifier = generateCodeVerifier();
  const cookieOpts = {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax" as const,
    maxAge: TIKTOK_STATE_TTL_MS,
    path: "/api/auth/tiktok",
  };
  res.cookie(TIKTOK_STATE_COOKIE, state, cookieOpts);
  res.cookie(TIKTOK_VERIFIER_COOKIE, codeVerifier, cookieOpts);

  const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
  res.redirect(buildTiktokAuthUrl(baseUrl, state, codeVerifier));
});

// ---------------------------------------------------------------------------
// Mobile OAuth browser flow (Flutter) — TikTok. Same shape as Facebook's
// /mobile/start above, but TikTok also needs its OWN provider-side PKCE
// verifier (equivalent to the tt_oauth_verifier cookie the web flow uses)
// — a system-browser tab opened fresh by the app can't rely on carrying a
// cookie back to whichever backend instance handles the callback, so it's
// stored on the transaction row instead (see lib/mobile-oauth.ts).
// ---------------------------------------------------------------------------
router.get("/auth/tiktok/mobile/start", mobileOauthStartLimiter, async (req, res) => {
  if (!isTiktokOAuthConfigured()) {
    res.status(503).json({ error: "provider_unavailable" });
    return;
  }

  const redirectUri = typeof req.query["redirect_uri"] === "string" ? req.query["redirect_uri"] : null;
  const codeChallenge = typeof req.query["code_challenge"] === "string" ? req.query["code_challenge"] : null;
  const codeChallengeMethod =
    typeof req.query["code_challenge_method"] === "string" ? req.query["code_challenge_method"] : null;

  if (!isAllowedMobileRedirectUri(redirectUri)) {
    res.status(400).json({ error: "invalid_callback" });
    return;
  }
  if (codeChallengeMethod !== "S256" || !isValidCodeChallenge(codeChallenge)) {
    res.status(400).json({ error: "invalid_callback" });
    return;
  }

  const providerCodeVerifier = generateCodeVerifier();
  const { state } = await createMobileTransaction({
    provider: "tiktok",
    redirectUri,
    codeChallenge,
    providerCodeVerifier,
  });

  const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
  res.redirect(buildTiktokAuthUrl(baseUrl, state, providerCodeVerifier));
});

// See handleFacebookMobileCallback above for the general shape. TikTok's
// version additionally has to fork on new-vs-returning user exactly like
// the website callback below does, since TikTok never returns an email —
// a brand-new mobile sign-in still needs the web /auth/tiktok/complete-signup
// page to collect one, just linked back to this mobile transaction (see
// pendingTiktokSignups.mobileTransactionId) so that page hands the browser
// back to the app afterward instead of landing on the dashboard.
async function handleTiktokMobileCallback(
  req: { query: Record<string, unknown>; protocol: string; get(name: string): string | undefined },
  res: { redirect(url: string): void; cookie(name: string, value: string, opts: Record<string, unknown>): void },
  transaction: MobileOauthTransactionRow,
): Promise<void> {
  const fail = (errorCode: string) => {
    logger.warn({ errorCode, provider: "tiktok" }, "[auth] TikTok mobile OAuth callback failed");
    res.redirect(buildMobileCallbackUrl(transaction.redirectUri, { error: errorCode }));
  };

  if (req.query["error"]) {
    fail("access_denied");
    return;
  }
  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  if (!code) {
    fail("invalid_state");
    return;
  }
  if (!isTiktokOAuthConfigured() || !transaction.providerCodeVerifier) {
    fail("provider_unavailable");
    return;
  }

  let profile;
  try {
    const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
    profile = await exchangeCodeForTiktokProfile(baseUrl, code, transaction.providerCodeVerifier);
  } catch (err) {
    logger.warn({ err }, "[auth] TikTok mobile code exchange failed");
    fail("authentication_failed");
    return;
  }

  const existingUser = await findUserByTiktokId(profile.tiktokId);
  if (existingUser) {
    await db
      .update(users)
      .set({ tiktokDisplayName: profile.displayName, tiktokAvatarUrl: profile.avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, existingUser.id));
    const exchangeCode = await issueMobileExchangeCode(transaction.id, existingUser.id, false);
    res.redirect(buildMobileCallbackUrl(transaction.redirectUri, { code: exchangeCode }));
    return;
  }

  // Brand-new TikTok sign-in via mobile: still no email. Reuse the same
  // web complete-signup page — linked to this mobile transaction — rather
  // than build a second, parallel email-collection UI.
  const { token: pendingToken } = await issuePendingTiktokSignup(profile, transaction.id);
  res.cookie(TIKTOK_PENDING_COOKIE, pendingToken, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: TIKTOK_PENDING_TTL_MS,
    path: "/api/auth/tiktok",
  });
  res.redirect("/auth/tiktok/complete-signup?mobile=1");
}

// TikTok redirects back here with `?code` + `?state`. On any failure we
// bounce to /login?error=tiktok rather than showing a JSON blob.
router.get("/auth/tiktok/callback", tiktokOAuthLimiter, async (req, res) => {
  const mobileStateParam = typeof req.query["state"] === "string" ? req.query["state"] : null;
  const mobileTransaction = await findPendingMobileTransaction(mobileStateParam);
  if (mobileTransaction) {
    await handleTiktokMobileCallback(req, res, mobileTransaction);
    return;
  }

  const clearOAuthCookies = () => {
    res.clearCookie(TIKTOK_STATE_COOKIE, { path: "/api/auth/tiktok" });
    res.clearCookie(TIKTOK_VERIFIER_COOKIE, { path: "/api/auth/tiktok" });
  };
  const fail = (reason: string, code = "tiktok") => {
    clearOAuthCookies();
    logger.warn({ reason }, "[auth] TikTok OAuth callback failed");
    res.redirect(`/login?error=${code}`);
  };

  if (!isTiktokOAuthConfigured()) {
    fail("not_configured");
    return;
  }

  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
  const cookieState = req.cookies?.[TIKTOK_STATE_COOKIE];
  const codeVerifier = req.cookies?.[TIKTOK_VERIFIER_COOKIE];

  if (req.query["error"]) {
    fail(`tiktok_error:${String(req.query["error"]).slice(0, 40)}`);
    return;
  }
  if (!code || !state || !cookieState || state !== cookieState || !codeVerifier) {
    fail("bad_state");
    return;
  }

  let profile;
  try {
    const baseUrl = resolvePublicBaseUrl(requestOrigin(req));
    profile = await exchangeCodeForTiktokProfile(baseUrl, code, codeVerifier);
  } catch (err) {
    logger.warn({ err }, "[auth] TikTok code exchange failed");
    fail("exchange_failed");
    return;
  }

  clearOAuthCookies();

  // Returning user: tiktok_id already belongs to an account -> log them in
  // directly, same session shape as the Google callback.
  const existingUser = await findUserByTiktokId(profile.tiktokId);
  if (existingUser) {
    const token = generateToken();
    const expiresAt = getSessionExpiry(true);
    await createSingleSession(existingUser.id, token, expiresAt);
    // Keep the captured TikTok profile fresh (display name/avatar can
    // change on TikTok's side between logins) — this data is the actual
    // product goal of this feature, independent of auth.
    await db
      .update(users)
      .set({ tiktokDisplayName: profile.displayName, tiktokAvatarUrl: profile.avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, existingUser.id));
    res.cookie("session_token", token, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      expires: expiresAt,
    });
    void notifyLoginAlert(existingUser.id);
    res.redirect("/dashboard");
    return;
  }

  // Brand-new TikTok sign-in: no email to create the account with yet.
  // Stash the verified profile server-side and ask the browser to finish
  // signup with a real email.
  const { token: pendingToken } = await issuePendingTiktokSignup(profile);
  res.cookie(TIKTOK_PENDING_COOKIE, pendingToken, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: TIKTOK_PENDING_TTL_MS,
    path: "/api/auth/tiktok",
  });
  res.redirect("/auth/tiktok/complete-signup");
});

// The frontend's "finish signup" page reads the pending TikTok profile
// (display name only — never the tiktok_id itself) to show a friendly
// "Hi, {name}" before asking for an email. The pending token stays in its
// httpOnly cookie throughout; it's never exposed to page JS as a value the
// client could tamper with.
router.get("/auth/tiktok/pending-signup", tiktokOAuthLimiter, async (req, res) => {
  const pendingToken = req.cookies?.[TIKTOK_PENDING_COOKIE];
  const profile = pendingToken ? await peekPendingTiktokSignup(pendingToken) : null;
  if (!profile) {
    res.status(404).json({ error: "Sesi pendaftaran TikTok tidak ditemukan atau sudah kedaluwarsa." });
    return;
  }
  res.json({ displayName: profile.displayName, avatarUrl: profile.avatarUrl });
});

const tiktokCompleteSignupSchema = z
  .object({ email: z.string().trim().email("Email tidak valid") })
  .strict();

router.post(
  "/auth/tiktok/complete-signup",
  tiktokCompleteSignupLimiter,
  async (req, res) => {
    const pendingToken = req.cookies?.[TIKTOK_PENDING_COOKIE];
    if (!pendingToken) {
      // We have no row to check here, so we can't know whether this was a
      // mobile-linked signup — the frontend's own `?mobile=1` query flag
      // (set when it was redirected here from the mobile OAuth callback)
      // is what lets the page still offer a "back to app" deep link for
      // this case. See tiktok-complete-signup.tsx.
      res.status(400).json({ error: "Sesi pendaftaran TikTok tidak ditemukan atau sudah kedaluwarsa." });
      return;
    }
    const parsed = tiktokCompleteSignupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Email tidak valid" });
      return;
    }

    let user: typeof users.$inferSelect;
    // Captured from the pending-signup row before the transaction either
    // commits or rolls back — a JS variable assignment survives a DB
    // rollback even though the row's own `usedAt` update doesn't (see
    // consumePendingTiktokSignup's doc comment), so this is still correct
    // in the TiktokEmailTakenError branch below.
    let mobileTransactionId: number | null = null;
    try {
      user = await db.transaction(async (tx) => {
        const profile = await consumePendingTiktokSignup(tx, pendingToken);
        if (!profile) {
          throw new Error("PENDING_SIGNUP_EXPIRED");
        }
        mobileTransactionId = profile.mobileTransactionId;
        return createUserFromTiktokSignup(tx, profile, parsed.data.email);
      });
    } catch (err) {
      if (err instanceof TiktokEmailTakenError) {
        if (mobileTransactionId != null) {
          const tx = await getMobileTransactionById(mobileTransactionId);
          if (tx) {
            res.status(409).json({
              error: "Email sudah terdaftar",
              mobileRedirectUrl: buildMobileCallbackUrl(tx.redirectUri, { error: "email_already_registered" }),
            });
            return;
          }
        }
        res.status(409).json({ error: "Email sudah terdaftar" });
        return;
      }
      if (err instanceof Error && err.message === "PENDING_SIGNUP_EXPIRED") {
        res.status(400).json({ error: "Sesi pendaftaran TikTok tidak ditemukan atau sudah kedaluwarsa." });
        return;
      }
      logger.error({ err }, "[auth] TikTok complete-signup failed");
      res.status(500).json({ error: "Gagal menyelesaikan pendaftaran TikTok" });
      return;
    }

    res.clearCookie(TIKTOK_PENDING_COOKIE, { path: "/api/auth/tiktok" });

    // Mobile-linked signup: hand the browser back to the app with a
    // one-time exchange code instead of creating a web session here.
    // "Session hanya dibuat ketika exchange mobile berhasil" — the actual
    // createSingleSession call for this user happens in
    // POST /auth/mobile/exchange, not here.
    if (mobileTransactionId != null) {
      const tx = await getMobileTransactionById(mobileTransactionId);
      if (tx) {
        const exchangeCode = await issueMobileExchangeCode(tx.id, user.id, true);
        res.status(201).json({
          user: serializeUser(user),
          mobileRedirectUrl: buildMobileCallbackUrl(tx.redirectUri, { code: exchangeCode }),
        });
        return;
      }
    }

    const token = generateToken();
    const expiresAt = getSessionExpiry(true);
    await createSingleSession(user.id, token, expiresAt);
    res.cookie("session_token", token, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      expires: expiresAt,
    });

    void notifyAdminsUserCreated(user.displayName);
    void notifyLoginAlert(user.id);

    res.status(201).json({ token, user: serializeUser(user) });
  },
);

// ---------------------------------------------------------------------------
// Final leg of the mobile OAuth browser flow (Flutter) — exchanges the
// one-time code from the id.tradepilot.app://auth/callback?code=... deep
// link, plus the PKCE code_verifier, for a real TradePilot session. This
// is the ONLY point in the whole mobile Facebook/TikTok flow that creates
// a session or ever returns a Bearer token — the callback routes above
// only ever hand back an opaque, short-lived code.
// ---------------------------------------------------------------------------
router.post("/auth/mobile/exchange", mobileOauthExchangeLimiter, async (req, res) => {
  const parsed = ExchangeMobileAuthCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Permintaan tidak valid." });
    return;
  }

  const outcome = await consumeMobileExchangeCode(parsed.data.code, parsed.data.codeVerifier);
  if (!outcome.ok) {
    const byReason = {
      not_found: { status: 401, error: "authentication_failed" },
      bad_verifier: { status: 401, error: "invalid_verifier" },
      already_used: { status: 409, error: "code_already_used" },
      expired: { status: 410, error: "exchange_expired" },
    } as const;
    const mapped = byReason[outcome.reason];
    logger.warn({ reason: outcome.reason }, "[auth] Mobile OAuth exchange rejected");
    res.status(mapped.status).json({ error: mapped.error });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, outcome.userId)).limit(1);
  if (!user) {
    // Extremely unlikely (account deleted between code issuance and
    // exchange) — the code was already consumed above either way.
    res.status(401).json({ error: "authentication_failed" });
    return;
  }

  const token = generateToken();
  const expiresAt = getSessionExpiry(true);
  await createSingleSession(user.id, token, expiresAt, "native");

  if (outcome.isNewUser) void notifyAdminsUserCreated(user.displayName);
  void notifyLoginAlert(user.id);

  res.json({ token, user: serializeUser(user) });
});

// ---------------------------------------------------------------------------
// Mobile-app-to-browser session handoff: the Flutter app is logged in via
// Bearer token, but a browser opened from an in-app menu (e.g. Profil ->
// Kredit Analisis -> tradepilot.id/topup) has no session_token cookie and
// no way to get one short of asking the user to log in again. This mints a
// one-time code the app bakes into a URL it opens in the system browser;
// GET /auth/web-handoff/consume below trades that code for a real cookie
// session. See lib/web-handoff.ts for the issue/consume logic.
// ---------------------------------------------------------------------------
const webHandoffSchema = z.object({ next: z.string() }).strict();

router.post(
  "/auth/web-handoff",
  requireAuth,
  webHandoffIssueLimiter,
  async (req: AuthRequest, res) => {
    const parsed = webHandoffSchema.safeParse(req.body);
    if (!parsed.success || !isAllowedNextPath(parsed.data.next)) {
      res.status(400).json({ error: "Tujuan tidak didukung." });
      return;
    }

    const { code, expiresIn } = await issueWebHandoffCode(req.userId!, parsed.data.next);
    res.status(201).json({
      url: `${resolveWebHandoffOrigin()}/api/auth/web-handoff/consume?code=${code}`,
      expiresIn,
    });
  },
);

router.get("/auth/web-handoff/consume", webHandoffConsumeLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  const rawCode = typeof req.query["code"] === "string" ? req.query["code"] : "";
  const outcome = await consumeWebHandoffCode(rawCode);
  if (!outcome.ok) {
    res.redirect(302, "/login?error=handoff_expired");
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, outcome.userId)).limit(1);
  if (!user) {
    // Account deleted between issuing and consuming the code — the code
    // was already consumed above either way.
    res.redirect(302, "/login?error=handoff_expired");
    return;
  }

  const token = generateToken();
  const expiresAt = getSessionExpiry(false);
  await createHandoffSession(user.id, token, expiresAt);

  res.cookie("session_token", token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    expires: expiresAt,
  });

  res.redirect(302, outcome.next);
});

// ---------------------------------------------------------------------------
// Native Google Sign-In (mobile). The Flutter app obtains a Google ID token
// with the native Google SDK and posts it here; the server verifies it and
// issues a normal TradePilot session (Bearer token, no cookie needed).
// Config: GOOGLE_NATIVE_ALLOWED_CLIENT_IDS (see lib/google-oauth.ts).
// ---------------------------------------------------------------------------

const googleNativeSchema = z
  .object({ idToken: z.string().min(1, "idToken wajib diisi") })
  .strict();

router.post(
  "/auth/google/native",
  googleNativeLoginLimiter,
  async (req, res) => {
    if (!isNativeGoogleConfigured()) {
      res.status(503).json({ error: "Login Google native belum dikonfigurasi." });
      return;
    }
    const parsed = googleNativeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Permintaan tidak valid." });
      return;
    }

    let profile;
    try {
      profile = await verifyGoogleIdToken(parsed.data.idToken);
    } catch (err) {
      // Never log the raw token — `err` from google-auth-library does not
      // contain it, but keep the log minimal regardless.
      logger.warn(
        { reason: err instanceof Error ? err.message : "verify_failed" },
        "[auth] Google native id_token verification failed",
      );
      res.status(401).json({
        error: "Login Google tidak dapat diverifikasi. Silakan coba lagi.",
      });
      return;
    }

    let user: typeof users.$inferSelect;
    let isNewUser: boolean;
    try {
      ({ user, isNewUser } = await resolveGoogleUser(profile));
    } catch (err) {
      if (err instanceof GoogleAccountConflictError) {
        res.status(409).json({
          error: "Email ini sudah tertaut ke akun Google lain.",
        });
        return;
      }
      logger.error({ err }, "[auth] Google native user upsert failed");
      res.status(500).json({ error: "Terjadi kesalahan. Silakan coba lagi." });
      return;
    }

    const token = generateToken();
    const expiresAt = getSessionExpiry(true);
    await createSingleSession(user.id, token, expiresAt, "native");

    if (isNewUser) void notifyAdminsUserCreated(user.displayName);
    void notifyLoginAlert(user.id);

    res.json({ token, user: serializeUser(user) });
  },
);

// ---------------------------------------------------------------------------
// Re-authentication for sensitive operations. A Google-only account proves
// identity with a FRESH Google ID token and gets a short-lived, single-use
// reauthToken that one sensitive endpoint (currently DELETE /auth/account)
// will accept.
// ---------------------------------------------------------------------------

const googleReauthSchema = z
  .object({ idToken: z.string().min(1, "idToken wajib diisi") })
  .strict();

router.post(
  "/auth/reauth/google",
  requireAuth,
  reauthLimiter,
  async (req: AuthRequest, res) => {
    if (!isNativeGoogleConfigured()) {
      res.status(503).json({ error: "Verifikasi Google belum dikonfigurasi." });
      return;
    }
    const parsed = googleReauthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Permintaan tidak valid." });
      return;
    }

    const [user] = await db
      .select({ id: users.id, email: users.email, googleId: users.googleId })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    let profile;
    try {
      profile = await verifyGoogleIdToken(parsed.data.idToken);
    } catch {
      res.status(401).json({
        error: "Verifikasi Google gagal. Silakan coba lagi.",
      });
      return;
    }

    // The fresh token must belong to the SAME Google identity / email as
    // the signed-in account.
    const sameIdentity =
      (user.googleId != null && user.googleId === profile.googleId) ||
      user.email.toLowerCase() === profile.email;
    if (!sameIdentity) {
      res.status(401).json({
        error: "Akun Google tidak cocok dengan akun yang sedang masuk.",
      });
      return;
    }

    const { token, expiresAt } = await issueReauthToken(
      user.id,
      "delete_account",
    );
    res.json({ reauthToken: token, expiresAt: expiresAt.toISOString() });
  },
);

// ---------------------------------------------------------------------------
// Native Sign in with Apple (mobile). The app runs Apple's own
// authorization UI and posts the resulting identity token + authorization
// code here, along with the raw nonce it generated (Apple only ever sees
// the SHA-256 hash of it — see lib/apple-oauth.ts). Verification, account
// linking, session issuance, and error shape all mirror
// POST /auth/google/native above; see lib/apple-oauth.ts and
// lib/apple-account.ts for the Apple-specific rules.
// Config: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY,
// APPLE_ALLOWED_CLIENT_IDS (see lib/apple-oauth.ts).
// ---------------------------------------------------------------------------

// A trimmed, control-character-stripped, length-capped optional name part.
// Apple only ever sends givenName/familyName on the very first
// authorization for a given app — used solely as a display-name candidate
// when creating a brand-new account (see lib/apple-account.ts).
function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

const appleNamePart = z
  .string()
  .trim()
  .max(100, "Nama terlalu panjang")
  .transform(stripControlCharacters)
  .optional();

const appleNativeSchema = z
  .object({
    identityToken: z.string().min(1, "identityToken wajib diisi").max(8000),
    authorizationCode: z.string().min(1, "authorizationCode wajib diisi").max(2048),
    nonce: z.string().min(1, "nonce wajib diisi").max(512),
    givenName: appleNamePart,
    familyName: appleNamePart,
  })
  .strict();

router.post(
  "/auth/apple/native",
  appleNativeLoginLimiter,
  async (req, res) => {
    if (!isNativeAppleConfigured()) {
      res.status(503).json({ error: "Login Apple native belum dikonfigurasi." });
      return;
    }
    const parsed = appleNativeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Permintaan tidak valid." });
      return;
    }

    let profile;
    try {
      profile = await verifyAppleIdentityToken(parsed.data.identityToken, parsed.data.nonce);
    } catch (err) {
      // Never log the raw token/nonce/code — `err` here is our own thrown
      // Error with a short reason string, never the credential itself.
      logger.warn(
        { reason: err instanceof Error ? err.message : "verify_failed" },
        "[auth] Apple native identity token verification failed",
      );
      res.status(401).json({
        error: "Login Apple tidak dapat diverifikasi. Silakan coba lagi.",
      });
      return;
    }

    try {
      await exchangeAppleAuthorizationCode(parsed.data.authorizationCode, profile.audience);
    } catch (err) {
      logger.warn(
        { reason: err instanceof Error ? err.message : "exchange_failed" },
        "[auth] Apple authorization code exchange failed",
      );
      res.status(401).json({
        error: "Login Apple tidak dapat diverifikasi. Silakan coba lagi.",
      });
      return;
    }

    let user: typeof users.$inferSelect;
    let isNewUser: boolean;
    try {
      ({ user, isNewUser } = await resolveAppleUser(profile, {
        givenName: parsed.data.givenName ?? null,
        familyName: parsed.data.familyName ?? null,
      }));
    } catch (err) {
      if (err instanceof AppleAccountConflictError) {
        res.status(409).json({
          error: "Email ini sudah tertaut ke akun Apple lain.",
        });
        return;
      }
      if (err instanceof AppleAccountUnavailableError) {
        res.status(401).json({
          error: "Login Apple tidak dapat diverifikasi. Silakan coba lagi.",
        });
        return;
      }
      logger.error({ err }, "[auth] Apple native user upsert failed");
      res.status(500).json({ error: "Terjadi kesalahan. Silakan coba lagi." });
      return;
    }

    const token = generateToken();
    const expiresAt = getSessionExpiry(true);
    await createSingleSession(user.id, token, expiresAt, "native");

    if (isNewUser) void notifyAdminsUserCreated(user.displayName);
    void notifyLoginAlert(user.id);

    res.json({ token, user: serializeUser(user) });
  },
);

// Re-authentication for sensitive operations on an Apple-only account —
// same purpose and same consumer (DELETE /auth/account) as
// POST /auth/reauth/google above, just proven with a fresh Apple identity
// token + authorization code instead of a fresh Google ID token. The two
// providers share the same `reauthLimiter` and the same underlying
// reauth_tokens table/purpose; a token this issues can only ever be
// consumed by the same userId it was issued to, so a Google reauth token
// can't authenticate an Apple account's deletion or vice versa.
const appleReauthSchema = z
  .object({
    identityToken: z.string().min(1, "identityToken wajib diisi").max(8000),
    authorizationCode: z.string().min(1, "authorizationCode wajib diisi").max(2048),
    nonce: z.string().min(1, "nonce wajib diisi").max(512),
  })
  .strict();

router.post(
  "/auth/reauth/apple",
  requireAuth,
  reauthLimiter,
  async (req: AuthRequest, res) => {
    if (!isNativeAppleConfigured()) {
      res.status(503).json({ error: "Verifikasi Apple belum dikonfigurasi." });
      return;
    }
    const parsed = appleReauthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Permintaan tidak valid." });
      return;
    }

    const [user] = await db
      .select({ id: users.id, appleId: users.appleId })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    let profile;
    try {
      profile = await verifyAppleIdentityToken(parsed.data.identityToken, parsed.data.nonce);
    } catch {
      res.status(401).json({
        error: "Verifikasi Apple gagal. Silakan coba lagi.",
      });
      return;
    }

    try {
      await exchangeAppleAuthorizationCode(parsed.data.authorizationCode, profile.audience);
    } catch {
      res.status(401).json({
        error: "Verifikasi Apple gagal. Silakan coba lagi.",
      });
      return;
    }

    // The fresh token must belong to the SAME Apple identity as the
    // signed-in account — unlike Google, never fall back to matching by
    // email here: an account with no apple_id yet has nothing to reauth
    // *as* Apple in the first place.
    if (!user.appleId || user.appleId !== profile.appleId) {
      res.status(401).json({
        error: "Akun Apple tidak cocok dengan akun yang sedang masuk.",
      });
      return;
    }

    const { token, expiresAt } = await issueReauthToken(
      user.id,
      "delete_account",
    );
    res.json({ reauthToken: token, expiresAt: expiresAt.toISOString() });
  },
);

router.post("/auth/logout", requireAuth, async (req: AuthRequest, res) => {
  const token = req.sessionToken;
  if (token) {
    await endSession(token, "user_initiated");
  }
  res.clearCookie("session_token");
  res.json({ message: "Berhasil logout" });
});

router.get("/auth/me", requireAuth, async (req: AuthRequest, res) => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.userId!))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User tidak ditemukan" });
    return;
  }

  res.json(serializeUser(user));
});

const profileUpdateSchema = z
  .object({
    displayName: z
      .string()
      .min(1, "Nama wajib diisi")
      .max(80, "Nama terlalu panjang")
      .optional(),
    selectedMode: z
      .enum(["beginner", "pro"], {
        errorMap: () => ({ message: "Mode harus 'beginner' atau 'pro'" }),
      })
      .optional(),
    themePreference: z
      .enum(["light", "dark"], {
        errorMap: () => ({ message: "Tema harus 'light' atau 'dark'" }),
      })
      .optional(),
    onboardingCompleted: z
      .boolean({ invalid_type_error: "onboardingCompleted harus boolean" })
      .optional(),
    lang: z
      .enum(["en", "id"], {
        errorMap: () => ({ message: "Bahasa harus 'en' atau 'id'" }),
      })
      .optional(),
    // Only accept canonical object paths issued by our upload flow
    // (`/objects/uploads/<uuid>`) or `null` to clear. Without this whitelist,
    // a caller could point `avatarUrl` at any object key — including someone
    // else's upload or an attacker-uploaded HTML payload from a different
    // prefix — and have the app render it as their profile photo.
    avatarUrl: z
      .string({ invalid_type_error: "Avatar tidak valid" })
      .regex(
        /^\/objects\/uploads\/[A-Za-z0-9_-]{8,64}$/,
        "URL avatar tidak valid"
      )
      .nullable()
      .optional(),
  })
  .strict();

router.patch("/auth/profile", requireAuth, async (req: AuthRequest, res) => {
  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    res.status(400).json({ error: first?.message ?? "Data profil tidak valid" });
    return;
  }
  const { displayName, selectedMode, themePreference, onboardingCompleted, lang, avatarUrl } =
    parsed.data;

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (displayName !== undefined) updateData["displayName"] = displayName;
  if (selectedMode !== undefined) updateData["selectedMode"] = selectedMode;
  if (themePreference !== undefined) updateData["themePreference"] = themePreference;
  if (onboardingCompleted !== undefined) updateData["onboardingCompleted"] = onboardingCompleted;
  if (lang !== undefined) updateData["lang"] = lang;
  if (avatarUrl !== undefined) updateData["avatarUrl"] = avatarUrl;

  const [updated] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, req.userId!))
    .returning();

  res.json(serializeUser(updated));
});

const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ invalid_type_error: "Password lama wajib diisi" })
      .min(1, "Password lama wajib diisi"),
    newPassword: z
      .string({ invalid_type_error: "Password baru minimal 6 karakter" })
      .min(6, "Password baru minimal 6 karakter"),
  })
  .strict();

router.patch("/auth/password", requireAuth, async (req: AuthRequest, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    res
      .status(400)
      .json({ error: first?.message ?? "Password lama dan baru wajib diisi" });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.userId!))
    .limit(1);

  if (!user.passwordHash) {
    res.status(400).json({
      error: "Akun Google tidak memiliki password untuk diubah.",
    });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Password lama salah" });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, req.userId!));

  void notifyCriticalSecurityEvent(req.userId!, "password_changed");

  res.json({ message: "Password berhasil diubah" });
});

const changeSecurityQuestionSchema = z
  .object({
    currentPassword: z
      .string({ invalid_type_error: "Semua field wajib diisi" })
      .min(1, "Semua field wajib diisi"),
    securityQuestion: z
      .string({ invalid_type_error: "Pertanyaan keamanan tidak valid" })
      .refine(
        (v) => SECURITY_QUESTIONS.includes(v),
        "Pertanyaan keamanan tidak valid"
      ),
    securityAnswer: z
      .string({ invalid_type_error: "Semua field wajib diisi" })
      .min(1, "Semua field wajib diisi"),
  })
  .strict();

router.patch("/auth/security-question", requireAuth, async (req: AuthRequest, res) => {
  const parsed = changeSecurityQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    res
      .status(400)
      .json({ error: first?.message ?? "Semua field wajib diisi" });
    return;
  }
  const { currentPassword, securityQuestion, securityAnswer } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.userId!))
    .limit(1);

  if (!user.passwordHash) {
    res.status(400).json({
      error:
        "Akun Google tidak menggunakan pertanyaan keamanan. Kelola akun lewat Google.",
    });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Password salah" });
    return;
  }

  const securityAnswerHash = await bcrypt.hash(
    securityAnswer.toLowerCase().trim(),
    12
  );

  await db
    .update(users)
    .set({ securityQuestion, securityAnswerHash, updatedAt: new Date() })
    .where(eq(users.id, req.userId!));

  void notifyCriticalSecurityEvent(req.userId!, "security_question_changed");

  res.json({ message: "Pertanyaan keamanan berhasil diubah" });
});

// Store-readiness (P0): self-service account deletion. `DELETE /api/account`
// (recommended in the brief) is deliberately placed here as `/auth/account`
// instead of a standalone one-route router — every other account-lifecycle
// operation (register/login/logout/profile/password/security-question)
// already lives in this file, and this is one more of the same kind, not a
// new domain.
// Apple-only accounts reuse this same `reauthToken` branch: it's issued by
// POST /auth/reauth/apple (same purpose, same table, same consumeReauthToken
// call below) exactly like a Google-only account's token from
// POST /auth/reauth/google. Apple credential revocation
// (POST https://appleid.apple.com/auth/revoke) is intentionally NOT called
// here: it requires a stored Apple refresh token, and this codebase has no
// encrypted-at-rest secret storage to hold one safely yet (see
// lib/apple-oauth.ts's exchangeAppleAuthorizationCode, which deliberately
// discards the refresh_token Apple returns rather than persist it in
// plaintext). The user's own `apple_id` column is deleted along with the
// rest of the row below — there is no separate Apple identity/credential
// row left behind. Revocation should be added once encrypted secret
// storage exists; see the deployment notes for this blocker.
const deleteAccountSchema = z
  .object({
    // Which one is required depends on the account (enforced below):
    //  - password account       -> currentPassword
    //  - Google/Apple-only account -> reauthToken from
    //    POST /auth/reauth/google or POST /auth/reauth/apple
    currentPassword: z
      .string({ invalid_type_error: "Password tidak valid" })
      .min(1, "Password wajib diisi")
      .optional(),
    reauthToken: z
      .string({ invalid_type_error: "Token tidak valid" })
      .min(1)
      .optional(),
  })
  .strict();

router.delete(
  "/auth/account",
  requireAuth,
  accountDeletionLimiter,
  async (req: AuthRequest, res) => {
    const parsed = deleteAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      res.status(400).json({ error: first?.message ?? "Password wajib diisi" });
      return;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1);

    // requireAuth already guarantees the row exists (it was just read to
    // populate req.userId/req.userRole), but a generic error here rather
    // than a crash keeps this endpoint's error surface consistent with
    // every other account route.
    if (!user) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    // Re-authentication proof. A live session alone is not enough to
    // delete an account.
    //  - password account   -> the current password
    //  - Google/Apple-only account -> a single-use reauthToken issued by
    //    POST /auth/reauth/google or POST /auth/reauth/apple after a
    //    fresh Google ID token / Apple identity token + authorization code
    if (user.passwordHash) {
      if (!parsed.data.currentPassword) {
        res.status(400).json({ error: "Password wajib diisi" });
        return;
      }
      const valid = await bcrypt.compare(
        parsed.data.currentPassword,
        user.passwordHash,
      );
      if (!valid) {
        res.status(401).json({ error: "Password salah" });
        return;
      }
    } else {
      if (!parsed.data.reauthToken) {
        res.status(400).json({
          error: "Verifikasi ulang diperlukan untuk menghapus akun Google.",
        });
        return;
      }
      const ok = await consumeReauthToken(
        user.id,
        "delete_account",
        parsed.data.reauthToken,
      );
      if (!ok) {
        res.status(401).json({
          error: "Verifikasi ulang tidak valid atau sudah kedaluwarsa.",
        });
        return;
      }
    }

    // Best-effort GCS cleanup of the user's avatar. Deliberately OUTSIDE
    // the DB transaction below and never allowed to fail the deletion —
    // an orphaned storage object is a minor cleanup issue, not a reason
    // to leave the account (and all its data) undeleted.
    if (user.avatarUrl) {
      try {
        const objectStorageService = new ObjectStorageService();
        await objectStorageService.deleteObjectEntity(user.avatarUrl);
      } catch (err) {
        if (!(err instanceof ObjectNotFoundError)) {
          logger.warn({ err, userId: user.id }, "Failed to delete avatar during account deletion");
        }
      }
    }

    // Every user-owned table references `users.id` with `onDelete:
    // "cascade"` (analyses, feedback, notifications, sessions,
    // push_subscriptions, native_push_devices, journal entries, watchlist,
    // filter presets, price alerts, daily digests, user tags, etc.) — a
    // single delete on the `users` row is sufficient to remove every
    // relation. `outbound_clicks`/`analytics_events` use `onDelete: "set
    // null"` instead, which is the intentional anonymize-not-delete
    // behavior for telemetry rows (no PII beyond a now-null user
    // reference). Wrapped in a transaction purely for atomicity with the
    // explicit push-channel deletes below (which are already covered by
    // cascade, but making them explicit here keeps the "what gets
    // removed" list self-documenting and immune to a future FK change
    // silently breaking cleanup).
    await db.transaction(async (tx) => {
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id));
      await tx.delete(nativePushDevices).where(eq(nativePushDevices.userId, user.id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
      await tx.delete(users).where(eq(users.id, user.id));
    });

    res.clearCookie("session_token");

    void notifySuperAdminsUserDeleted(user.displayName).catch((err) => {
      logger.warn({ err, userId: user.id }, "Failed to notify admins of self-deletion");
    });

    res.json({ message: "Akun berhasil dihapus" });
  },
);

export default router;
