import { Router, type IRouter } from "express";
import { db } from "../lib/db";
import { outboundClicks, analyticsEvents, sessions, users } from "@workspace/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { RecordOutboundClickBody, TrackAnalyticsEventBody } from "@workspace/api-zod";
import { trackEventLimiter } from "../middleware/rate-limit";
import { parseUserAgent, lookupCountry, resolveClientIpForGeo } from "../lib/request-meta";

const router: IRouter = Router();

// Server-side cap on the `metadata` JSON payload — an unbounded
// client-influenced jsonb column is an abuse vector even under rate
// limiting. Comfortably larger than any legitimate {instrument,
// timeframe}-shaped payload we send today.
const MAX_METADATA_BYTES = 2048;

// Shared by every fire-and-forget telemetry route below: resolve the
// signed-in user (if any) from the session cookie/Bearer header without
// requiring auth. Never throws — telemetry must never crash the request.
async function resolveUserId(req: {
  cookies?: Record<string, string>;
  headers: { authorization?: string };
}): Promise<number | null> {
  const token =
    req.cookies?.["session_token"] ||
    req.headers["authorization"]?.replace("Bearer ", "");
  if (!token) return null;
  try {
    const [session] = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
      .limit(1);
    return session ? session.userId : null;
  } catch {
    return null;
  }
}

// Fire-and-forget client telemetry. Auth is *optional* — splash, landing,
// and the dashboard TikTok card all need to record clicks for both signed-in
// and signed-out visitors. We never reject the request, even on validation
// failure: a 4xx here would race the user's outbound navigation and
// occasionally surface as a console error in the browser, which is not
// worth it for a non-critical analytics ping.
router.post("/events/outbound-click", async (req, res) => {
  // Always 204 first — write completes asynchronously.
  res.status(204).end();

  const parsed = RecordOutboundClickBody.safeParse(req.body);
  if (!parsed.success) return;

  const userId = await resolveUserId(req);

  try {
    await db.insert(outboundClicks).values({
      userId,
      placement: parsed.data.placement,
      target: parsed.data.target,
      lang: parsed.data.lang ?? null,
    });
  } catch {
    // Same: never throw.
  }
});

// Generic app-usage telemetry (page views + a handful of key actions) for
// the admin analytics dashboard. Same fire-and-forget contract as
// outbound-click above. Device/browser/OS + country are resolved
// server-side from the request itself — the client never gets to claim
// its own device or location.
router.post("/events/track", trackEventLimiter, async (req, res) => {
  res.status(204).end();

  const parsed = TrackAnalyticsEventBody.safeParse(req.body);
  if (!parsed.success) return;

  let metadata: Record<string, unknown> = {};
  if (parsed.data.metadata) {
    const size = Buffer.byteLength(JSON.stringify(parsed.data.metadata));
    if (size <= MAX_METADATA_BYTES) {
      metadata = parsed.data.metadata as Record<string, unknown>;
    }
  }

  const userId = await resolveUserId(req);
  const ua = req.headers["user-agent"] ?? "";
  const { deviceType, browser, os } = parseUserAgent(ua);
  const country = await lookupCountry(resolveClientIpForGeo(req));

  try {
    await db.insert(analyticsEvents).values({
      userId,
      eventType: parsed.data.eventType,
      path: parsed.data.path ?? null,
      metadata,
      userAgent: ua || null,
      deviceType,
      browser,
      os,
      country,
    });
  } catch {
    // Same: never throw.
  }
});

export default router;
