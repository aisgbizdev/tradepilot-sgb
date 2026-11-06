import { UAParser } from "ua-parser-js";

// Best-effort device/browser/OS + country resolution for analytics events
// (routes/events.ts `POST /events/track`). Both parsers here are pure,
// local/offline lookups — no external API calls, no added request latency
// beyond in-process work.
//
// `geoip-lite` bundles a multi-MB dataset that it loads into memory at
// require-time, so it's dynamically imported and cached on first use
// instead of being a top-level import — most requests never touch this
// module at all (only the analytics-event route does).
let geoipModule: typeof import("geoip-lite") | null = null;
async function loadGeoip(): Promise<typeof import("geoip-lite")> {
  if (!geoipModule) {
    geoipModule = (await import("geoip-lite")).default;
  }
  return geoipModule;
}

export interface ParsedDevice {
  deviceType: string; // "mobile" | "tablet" | "desktop" | other UAParser device types
  browser: string | null;
  os: string | null;
}

export function parseUserAgent(userAgent: string): ParsedDevice {
  if (!userAgent) {
    return { deviceType: "unknown", browser: null, os: null };
  }
  const result = new UAParser(userAgent).getResult();
  return {
    // UAParser leaves `device.type` undefined for plain desktop browsers —
    // only mobile/tablet/console/etc are explicitly typed.
    deviceType: result.device.type ?? "desktop",
    browser: result.browser.name ?? null,
    os: result.os.name ?? null,
  };
}

// Resolves a 2-letter ISO-3166-1 country code from an IP address. Returns
// null for private/local/unresolvable IPs (expected in local dev, where
// `req.ip` is typically ::1 or 127.0.0.1). The raw IP is intentionally
// never returned/persisted by this module — only the derived country.
export async function lookupCountry(ip: string | undefined): Promise<string | null> {
  if (!ip) return null;
  try {
    const geoip = await loadGeoip();
    const result = geoip.lookup(ip);
    return result?.country ?? null;
  } catch {
    return null;
  }
}

// `req.ip` depends on Express's `trust proxy` hop count (app.ts sets 1)
// matching the real number of reverse-proxy hops in front of the app. If
// the deployment platform actually sits behind more hops than that
// (common on managed platforms — an edge load balancer plus an internal
// routing layer), `req.ip` resolves to an intermediate proxy's IP instead
// of the real client's, which is typically a private address geoip-lite
// can never resolve — every event then gets bucketed as "unknown"
// country. For this best-effort analytics lookup only (never for rate
// limiting or any security decision), read the leftmost address in
// `X-Forwarded-For` directly instead — that's the original client
// regardless of how many hops sit between it and this process. Safe to
// trust here because a spoofed value only ever produces a wrong country
// label, not a security bypass.
export function resolveClientIpForGeo(req: {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const first = raw?.split(",")[0]?.trim();
  return first || req.ip;
}
