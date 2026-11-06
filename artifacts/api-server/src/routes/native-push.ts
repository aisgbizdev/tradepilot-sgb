// Store-readiness (P2-B3): native push (FCM) device registration.
// Deliberately separate from `routes/push.ts` (Web Push/VAPID) — the two
// channels have unrelated payload shapes and lifecycles; see
// `lib/native-push.ts` for the actual FCM send implementation.
import { Router } from "express";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { nativePushDevices } from "@workspace/db/schema";
import { requireAuth, AuthRequest } from "../middleware/auth";
import {
  nativePushRegisterLimiter,
  nativePushTestLimiter,
} from "../middleware/rate-limit";
import { sendNativePushToUser, nativePushConfigured } from "../lib/native-push";
import { logger } from "../lib/logger";

const router = Router();

const registerSchema = z
  .object({
    token: z.string().min(20).max(4096),
    platform: z.enum(["android", "ios"]),
  })
  .strict();

const unregisterSchema = z
  .object({
    token: z.string().min(20).max(4096),
  })
  .strict();

function tokenSuffix(token: string): string {
  return token.length > 8 ? token.slice(-8) : token;
}

router.post(
  "/native-push/register",
  requireAuth,
  nativePushRegisterLimiter,
  async (req: AuthRequest, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data registrasi perangkat tidak valid" });
      return;
    }
    const { token, platform } = parsed.data;
    const now = new Date();

    // Upsert on the globally-unique token: if this exact device token was
    // previously registered under a different account (e.g. the device
    // logged out and a different user logged in), ownership transfers to
    // the current authenticated user rather than erroring — this is the
    // correct behavior for a shared/re-logged-in device.
    await db
      .insert(nativePushDevices)
      .values({
        userId: req.userId!,
        token,
        platform,
        enabled: true,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: nativePushDevices.token,
        set: {
          userId: req.userId!,
          platform,
          enabled: true,
          lastSeenAt: now,
          updatedAt: now,
        },
      });

    logger.info(
      { userId: req.userId, platform, tokenSuffix: tokenSuffix(token) },
      "Native push device registered",
    );

    res.status(201).json({ message: "Perangkat berhasil didaftarkan" });
  },
);

router.delete("/native-push/unregister", requireAuth, async (req: AuthRequest, res) => {
  const parsed = unregisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Token tidak valid" });
    return;
  }

  // Scoped by userId AND token — a caller can only ever remove their own
  // device registration, never another user's.
  await db
    .delete(nativePushDevices)
    .where(
      and(
        eq(nativePushDevices.userId, req.userId!),
        eq(nativePushDevices.token, parsed.data.token),
      ),
    );

  res.json({ message: "Perangkat berhasil dihapus" });
});

// Send a sample FCM push to the caller's own enabled devices. Mirrors
// POST /push/test (which only covers Web Push) but for the native channel:
// authenticated, per-user rate-limited, and it goes through the exact same
// `sendNativePushToUser` code path production uses — so a passing test is
// real proof the FCM HTTP v1 wiring works. It deliberately does NOT accept
// a token or a URL from the request body.
router.post(
  "/native-push/test",
  requireAuth,
  nativePushTestLimiter,
  async (req: AuthRequest, res) => {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(nativePushDevices)
      .where(
        and(
          eq(nativePushDevices.userId, req.userId!),
          eq(nativePushDevices.enabled, true),
        ),
      );

    if (!count || count === 0) {
      res.status(404).json({
        error:
          "Belum ada perangkat mobile yang terdaftar. / No registered mobile devices yet.",
      });
      return;
    }

    if (!nativePushConfigured) {
      res.status(503).json({
        error: "Firebase belum dikonfigurasi di server. / Firebase is not configured on the server.",
      });
      return;
    }

    const results = await sendNativePushToUser(req.userId!, {
      title: "TradePilot.id",
      body: "Notifikasi mobile kamu sudah aktif. / Mobile notifications are working.",
      actionType: "open_notification",
    });
    const accepted = results.filter((r) => r.ok).length;
    const failures = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);

    logger.info(
      { userId: req.userId, targeted: results.length, accepted },
      "Native push test sent",
    );

    // A resolved promise here used to be reported as success regardless of
    // what FCM actually did with it — `delivered` was just the device
    // count queried above, so a client could see 200 with zero pushes
    // ever reaching a device. Report what was actually accepted instead.
    res.status(accepted > 0 ? 200 : 502).json({
      targeted: results.length,
      accepted,
      failures: failures.map((f) => f.reason),
    });
  },
);

export default router;
