import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
  message?: string;
}

function clientIp(req: Request): string {
  // Relies on Express `trust proxy` being configured at the app level so
  // `req.ip` reflects the real client IP from the trusted proxy chain
  // instead of an arbitrary, attacker-controlled `x-forwarded-for` value.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

// Safely derive the email portion of a per-(ip,email) key. Must never throw
// — limiter middleware runs before the route's Zod schema, so an attacker
// can ship `email: 123` or `email: {}` and we'd crash with a 500 instead of
// a clean 400 if we naively called `.toLowerCase()` on a non-string.
function emailKeyPart(req: Request): string {
  const v = req.body?.email;
  return typeof v === "string" ? v.toLowerCase() : "";
}

// Rate limiters are a production safety net (DoS, credential stuffing,
// sign-up flooding). In local dev and the e2e harness they only get in
// the way — the e2e suite registers many users from a single IP in a
// short window and would otherwise hit `registerLimiter` and fail with
// 429 "Terlalu banyak pendaftaran". Bypass when NODE_ENV is explicitly
// "development" (set by the e2e test-server). The unit-test suite runs
// with NODE_ENV=test (vitest default) and continues to exercise the
// real limiter so the 429 / Retry-After contract stays covered.
function rateLimitDisabled(): boolean {
  return process.env["NODE_ENV"] === "development";
}

function buildLimiter(opts: RateLimitOptions) {
  const store = new Map<string, Bucket>();
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (rateLimitDisabled()) return next();
    const key = opts.keyFn(req);
    const now = Date.now();
    const bucket = store.get(key);

    if (!bucket || bucket.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    if (bucket.count >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error:
          opts.message ??
          `Terlalu banyak percobaan. Coba lagi dalam ${retryAfter} detik. / Too many attempts. Try again in ${retryAfter}s.`,
      });
      return;
    }

    bucket.count += 1;
    next();
  };
  return Object.assign(middleware, { store });
}

// /auth/login runs bcrypt.compare on every request — that's CPU-expensive by
// design. Without a limiter it's a cheap DoS vector and an open door for
// credential-stuffing. Keying on `ip|email` lets honest users on a shared
// IP keep retrying their own account without being blocked by a neighbour.
export const loginLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `${clientIp(req)}|${emailKeyPart(req)}`,
  message:
    "Terlalu banyak percobaan login. Coba lagi dalam beberapa menit. / Too many login attempts. Try again in a few minutes.",
});

// /auth/register has no identifier yet, so the limiter is per-IP. Sized
// generously so households / offices behind a single NAT can still legitimately
// sign up multiple accounts within an hour.
export const registerLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak pendaftaran dari alamat ini. Coba lagi dalam satu jam. / Too many sign-ups from this address. Try again in an hour.",
});

// Google OAuth entrypoint + callback. Per-IP — there's no email identifier
// at redirect time. Sized to allow a few retries after a cancelled consent
// screen while still capping automated abuse of the token-exchange path.
export const googleOAuthLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan login Google. Coba lagi dalam beberapa menit. / Too many Google login attempts. Try again in a few minutes.",
});

// POST /auth/google/native — per-IP; the caller isn't authenticated yet.
export const googleNativeLoginLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan login Google. Coba lagi dalam beberapa menit. / Too many Google login attempts. Try again in a few minutes.",
});

// POST /auth/apple/native — per-IP; same budget as its Google counterpart.
export const appleNativeLoginLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan login Apple. Coba lagi dalam beberapa menit. / Too many Apple login attempts. Try again in a few minutes.",
});

// Facebook OAuth entrypoint + callback — per-IP, same budget as Google's.
export const facebookOAuthLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan login Facebook. Coba lagi dalam beberapa menit. / Too many Facebook login attempts. Try again in a few minutes.",
});

// TikTok OAuth entrypoint + callback — per-IP, same budget as Google's.
export const tiktokOAuthLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan login TikTok. Coba lagi dalam beberapa menit. / Too many TikTok login attempts. Try again in a few minutes.",
});

// POST /auth/tiktok/complete-signup — per-IP; caller isn't authenticated
// yet (this is what actually creates the account).
export const tiktokCompleteSignupLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan. Coba lagi dalam beberapa menit. / Too many attempts. Try again in a few minutes.",
});

// GET /auth/{facebook,tiktok}/mobile/start — per-IP; the caller isn't
// authenticated (this is the very first hop of the mobile OAuth flow).
export const mobileOauthStartLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan login. Coba lagi dalam beberapa menit. / Too many login attempts. Try again in a few minutes.",
});

// POST /auth/mobile/exchange — per-IP. Deliberately tighter than the start
// limiter: a legitimate app calls this exactly once per sign-in, right
// after the browser redirect completes, so a burst of attempts here is a
// much stronger abuse signal than repeated /mobile/start hits.
export const mobileOauthExchangeLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak percobaan. Coba lagi dalam beberapa menit. / Too many attempts. Try again in a few minutes.",
});

// POST /auth/reauth/google and POST /auth/reauth/apple — per-user (mounted
// after requireAuth). Tighter budget: a legit re-auth happens once right
// before a sensitive action. Shared across both providers rather than
// duplicated per-provider, matching how DELETE /auth/account already
// handles either provider's reauthToken through one code path.
export const reauthLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak percobaan verifikasi ulang. Coba lagi nanti. / Too many re-authentication attempts. Try again later.",
});

// Per-user limiter for POST /api/push/test. Keyed off `req.userId`, so it
// must be mounted after `requireAuth`.
export const pushTestLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak tes notifikasi. Coba lagi sebentar lagi. / Too many test notifications. Try again in a bit.",
});

// Per-user limiter for POST /api/native-push/test. Same budget as the Web
// Push test — enough for a QA pass, capped so the FCM send path can't be
// hammered. Mount after `requireAuth`.
export const nativePushTestLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak tes notifikasi. Coba lagi sebentar lagi. / Too many test notifications. Try again in a bit.",
});

// Store-readiness (P2-B3): per-user limiter for native-push device
// register/unregister. A device re-registers on every app foreground in
// some client implementations, so the cap is generous — this only exists
// to blunt abuse (e.g. a compromised client hammering the endpoint), not
// to interfere with normal app usage.
export const nativePushRegisterLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak pendaftaran perangkat. Coba lagi sebentar lagi. / Too many device registrations. Try again in a bit.",
});

// Store-readiness (P0): per-user limiter for the destructive account-
// deletion endpoint. Deliberately tight — this is a one-way, catastrophic
// action, so there is no legitimate reason to hit it more than a couple
// times in a day (retry after a failed attempt).
export const accountDeletionLimiter = buildLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak percobaan penghapusan akun. Coba lagi besok atau hubungi support. / Too many account deletion attempts. Try again tomorrow or contact support.",
});

// Per-user limiter for the manual trade-journal endpoints (task #161).
// Write path is gated tighter than read because journal entries land
// directly in the user's permanent record — accidental double-submit
// from a phone tap-storm shouldn't create dozens of duplicate rows.
export const journalWriteLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak update jurnal. Coba lagi sebentar lagi. / Too many journal updates. Try again in a moment.",
});

// Looser limiter for journal list + stats reads — the journal page
// re-queries on filter changes and we don't want to throttle normal
// browsing, only outright scraping.
export const journalReadLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message:
    "Terlalu banyak permintaan jurnal. Coba lagi sebentar lagi. / Too many journal requests. Try again in a moment.",
});

// Per-IP limiter for the public AI transparency dashboard (task #164).
// Endpoint is intentionally unauthenticated so anyone can audit the
// AI's track record, so the key is just the caller IP. Generous cap
// because the page polls between window tabs and refetches on locale
// changes; the goal is only to deflect obvious scraping.
export const performanceLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak permintaan. Coba lagi sebentar lagi. / Too many requests. Try again in a moment.",
});

// Public landing traffic can be bursty. This limiter protects the snapshot
// endpoint while its process-wide cache and in-flight dedupe protect the AI
// generation itself.
export const landingPreviewLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => clientIp(req),
  message:
    "Terlalu banyak permintaan preview. Coba lagi sebentar lagi. / Too many preview requests. Try again shortly.",
});

// Per-IP limiter for POST /events/track (page-view + key-action analytics
// pings, task: admin analytics dashboard). Endpoint is unauthenticated-
// tolerant like outbound-click telemetry, so it's reachable by anyone —
// this only exists to deflect obvious flooding, not to shape normal
// traffic (a real user's page views + a handful of actions stay well
// under this in any given minute).
export const trackEventLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => clientIp(req),
});

// POST /topups/doku/checkout — per-user (mounted after requireAuth). A
// legit top-up is an occasional action; this budget just guards against a
// buggy client retry-looping DOKU checkout-session creation.
export const dokuCheckoutLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message: "Terlalu banyak percobaan top-up. Coba lagi dalam beberapa menit.",
});

// POST /topups/doku/notify — DOKU's own servers call this, not end users,
// so this is a generous ceiling meant only to absorb a burst/retry storm
// (DOKU retries up to 6x per its docs), not to rate-limit legitimate
// traffic. Per-IP since there's no authenticated user on this route.
export const dokuNotifyLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyFn: (req) => clientIp(req),
});

// POST /auth/web-handoff — per-user (mounted after requireAuth), falling
// back to per-IP for the rare case req.userId isn't set yet. Same budget
// as reauthLimiter: a legit handoff happens once per menu tap.
export const webHandoffIssueLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 5,
  keyFn: (req) => {
    const id = (req as Request & { userId?: number }).userId;
    return typeof id === "number" ? `user-${id}` : clientIp(req);
  },
  message: "Terlalu banyak percobaan. Coba lagi sebentar lagi. / Too many attempts. Try again shortly.",
});

// GET /auth/web-handoff/consume — per-IP; this endpoint is unauthenticated
// (opened directly in the system browser) so there's no userId to key on.
export const webHandoffConsumeLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => clientIp(req),
  message: "Terlalu banyak percobaan. Coba lagi sebentar lagi. / Too many attempts. Try again shortly.",
});

setInterval(() => {
  const now = Date.now();
  for (const limiter of [
    loginLimiter,
    registerLimiter,
    pushTestLimiter,
    nativePushRegisterLimiter,
    accountDeletionLimiter,
    journalWriteLimiter,
    journalReadLimiter,
    performanceLimiter,
    landingPreviewLimiter,
    trackEventLimiter,
    dokuCheckoutLimiter,
    dokuNotifyLimiter,
    webHandoffIssueLimiter,
    webHandoffConsumeLimiter,
  ]) {
    for (const [k, b] of limiter.store) {
      if (b.resetAt <= now) limiter.store.delete(k);
    }
  }
}, 60_000).unref();
