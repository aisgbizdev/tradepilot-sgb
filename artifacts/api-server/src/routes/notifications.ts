import { Router } from "express";
import { db } from "../lib/db";
import { notifications } from "@workspace/db/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { notificationsEmitter } from "../lib/notifications-emitter";
import { resetDisengageStreak } from "../lib/auto-disengage";

const router = Router();

router.get("/notifications/stream", requireAuth, (req: AuthRequest, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  res.write(`event: ready\ndata: {"ok":true}\n\n`);

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = notificationsEmitter.subscribeForUser(req.userId!, (ev) => {
    send("notification", ev.notification);
  });

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.get("/notifications", requireAuth, async (req: AuthRequest, res) => {
  const unreadOnly = req.query["unreadOnly"] === "true";

  // `unreadCount` is always computed from the FULL set (not filtered by
  // `unreadOnly`) and always scoped to the authenticated user only — it's
  // the badge count, independent of whichever slice of the list the
  // caller happens to be viewing right now.
  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(
        unreadOnly
          ? and(eq(notifications.userId, req.userId!), isNull(notifications.readAt))
          : eq(notifications.userId, req.userId!)
      )
      .orderBy(desc(notifications.createdAt))
      .limit(50),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, req.userId!), isNull(notifications.readAt))),
  ]);

  res.json({ notifications: rows, unreadCount: countRow?.count ?? 0 });
});

router.patch("/notifications/:id/read", requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params["id"]);

  const [updated] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.id, id), eq(notifications.userId, req.userId!))
    )
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Notifikasi tidak ditemukan" });
    return;
  }

  // Tier 3 (task #142 E): reset the per-category disengage streak so
  // a user who actually starts engaging again won't get auto-paused
  // on the next worker tick. Fire-and-forget — the response shouldn't
  // wait on this housekeeping update.
  if (updated.category) {
    void resetDisengageStreak(req.userId!, updated.category);
  }

  res.json({ message: "Notifikasi ditandai telah dibaca" });
});

router.patch("/notifications/read-all", requireAuth, async (req: AuthRequest, res) => {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, req.userId!),
        isNull(notifications.readAt)
      )
    );

  res.json({ message: "Semua notifikasi ditandai telah dibaca" });
});

export default router;
