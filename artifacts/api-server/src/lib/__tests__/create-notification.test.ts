import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray, like } from "drizzle-orm";

vi.mock("../webpush", () => ({
  sendPushToUser: vi.fn(async () => {}),
  sendPushToUsers: vi.fn(async () => {}),
  sendPushToAllSubscribed: vi.fn(async () => {}),
}));

vi.mock("../native-push", () => ({
  sendNativePushToUser: vi.fn(async () => {}),
  sendNativePushToUsers: vi.fn(async () => {}),
}));

import { sendPushToUser } from "../webpush";
import { sendNativePushToUser } from "../native-push";
import { notificationsEmitter } from "../notifications-emitter";
import { createNotification, createNotificationsForUsers } from "../create-notification";
import { db } from "../db";
import { users, notifications } from "@workspace/db/schema";

const sendPushToUserMock = sendPushToUser as unknown as ReturnType<typeof vi.fn>;
const sendNativePushToUserMock = sendNativePushToUser as unknown as ReturnType<typeof vi.fn>;

const RUN_ID = randomBytes(4).toString("hex");
const EMAIL_PREFIX = `notif-helper-${RUN_ID}`;
const seededUserIds: number[] = [];

async function createTestUser(): Promise<number> {
  const suffix = randomBytes(6).toString("hex");
  const [row] = await db
    .insert(users)
    .values({
      email: `${EMAIL_PREFIX}-${suffix}@example.test`,
      passwordHash: await bcrypt.hash("not-used", 4),
      displayName: `Notif Helper ${RUN_ID} ${suffix}`,
      securityQuestion: "test?",
      securityAnswerHash: await bcrypt.hash("answer", 4),
    })
    .returning({ id: users.id });
  seededUserIds.push(row.id);
  return row.id;
}

let alice: number;
let bob: number;
let carol: number;

beforeAll(async () => {
  alice = await createTestUser();
  bob = await createTestUser();
  carol = await createTestUser();
});

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

beforeEach(() => {
  sendPushToUserMock.mockClear();
  sendPushToUserMock.mockImplementation(async () => {});
  sendNativePushToUserMock.mockClear();
  sendNativePushToUserMock.mockImplementation(async () => {});
});

describe("createNotification", () => {
  it("inserts the in-app row and emits SSE for the user", async () => {
    const events: unknown[] = [];
    const off = notificationsEmitter.subscribeForUser(alice, (evt) => events.push(evt));

    await createNotification(alice, {
      title: "Hai Alice",
      message: "Cek notifikasimu.",
      type: "info",
    });

    off();

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, alice));
    const found = rows.find((r) => r.title === "Hai Alice");
    expect(found).toBeTruthy();
    expect(found?.message).toBe("Cek notifikasimu.");
    expect(found?.type).toBe("info");

    expect(events.length).toBe(1);
  });

  it("does NOT call sendPushToUser when push is omitted", async () => {
    await createNotification(alice, {
      title: "Tanpa Push",
      message: "Cuma in-app.",
    });
    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });

  it("does NOT call sendPushToUser when push is null", async () => {
    await createNotification(alice, {
      title: "Push Disuppress",
      message: "Pref user opted out.",
      type: "warning",
    }, null);
    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });

  it("calls sendPushToUser exactly once when push is provided", async () => {
    await createNotification(
      bob,
      { title: "Push Aktif", message: "Body in-app", type: "info" },
      { url: "/notifications", tag: "x-tag" },
    );

    expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
    const [calledUserId, payload] = sendPushToUserMock.mock.calls[0] as [
      number,
      { title: string; body: string; url?: string; tag?: string },
    ];
    expect(calledUserId).toBe(bob);
    // Defaults: push.title falls back to content.title, push.body to content.message.
    expect(payload.title).toBe("Push Aktif");
    expect(payload.body).toBe("Body in-app");
    expect(payload.url).toBe("/notifications");
    expect(payload.tag).toBe("x-tag");
  });

  it("uses explicit push title/body overrides when provided", async () => {
    await createNotification(
      bob,
      { title: "In-app Title", message: "In-app Body" },
      { title: "Push Title", body: "Push Body", url: "/" },
    );

    const [, payload] = sendPushToUserMock.mock.calls[0] as [number, { title: string; body: string }];
    expect(payload.title).toBe("Push Title");
    expect(payload.body).toBe("Push Body");
  });

  it("does not propagate push delivery errors to the caller", async () => {
    sendPushToUserMock.mockImplementationOnce(async () => {
      throw new Error("transport boom");
    });

    await expect(
      createNotification(
        bob,
        { title: "Push Gagal", message: "Tetap insert in-app" },
        { url: "/" },
      ),
    ).resolves.toBe(true);

    // The in-app row was still inserted even though push threw.
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, bob));
    expect(rows.find((r) => r.title === "Push Gagal")).toBeTruthy();
  });
});

describe("createNotificationsForUsers", () => {
  it("returns immediately when userIds is empty (no insert, no push)", async () => {
    await createNotificationsForUsers([], { title: "Nope", message: "Empty" }, { url: "/" });
    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });

  it("inserts one row per user and pushes to every user when no skip list", async () => {
    await createNotificationsForUsers(
      [alice, bob, carol],
      { title: "Bulk Push", message: "All hands" },
      { url: "/notifications", tag: "bulk" },
    );

    const rows = await db
      .select()
      .from(notifications)
      .where(inArray(notifications.userId, [alice, bob, carol]));
    const bulkRows = rows.filter((r) => r.title === "Bulk Push");
    expect(bulkRows.length).toBe(3);

    expect(sendPushToUserMock).toHaveBeenCalledTimes(3);
    const calledIds = sendPushToUserMock.mock.calls.map((c: unknown[]) => c[0] as number).sort();
    expect(calledIds).toEqual([alice, bob, carol].sort());
  });

  it("skips push for users in pushSkipUserIds but still inserts in-app rows for them", async () => {
    await createNotificationsForUsers(
      [alice, bob, carol],
      { title: "Bulk Skip", message: "Mixed prefs" },
      { url: "/notifications", tag: "skip-test" },
      { pushSkipUserIds: [bob] },
    );

    const rows = await db
      .select()
      .from(notifications)
      .where(inArray(notifications.userId, [alice, bob, carol]));
    const skipRows = rows.filter((r) => r.title === "Bulk Skip");
    // All 3 still get the in-app row...
    expect(skipRows.length).toBe(3);

    // ...but only alice + carol get the OS-level push.
    expect(sendPushToUserMock).toHaveBeenCalledTimes(2);
    const calledIds = sendPushToUserMock.mock.calls.map((c: unknown[]) => c[0] as number).sort();
    expect(calledIds).toEqual([alice, carol].sort());
  });

  it("does not push at all when push is null, regardless of skip list", async () => {
    await createNotificationsForUsers(
      [alice, bob],
      { title: "Bulk No Push", message: "In-app only" },
      null,
    );
    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });

  it("emits one SSE event per user on the bulk path", async () => {
    const aliceEvents: unknown[] = [];
    const bobEvents: unknown[] = [];
    const offA = notificationsEmitter.subscribeForUser(alice, (e) => aliceEvents.push(e));
    const offB = notificationsEmitter.subscribeForUser(bob, (e) => bobEvents.push(e));

    await createNotificationsForUsers(
      [alice, bob],
      { title: "Bulk SSE", message: "Fan-out check" },
    );

    offA();
    offB();
    expect(aliceEvents.length).toBe(1);
    expect(bobEvents.length).toBe(1);
  });

  it("persists targetRole on every inserted row when provided", async () => {
    await createNotificationsForUsers(
      [alice, bob],
      {
        title: "Role Broadcast",
        message: "Only admins",
        type: "info",
        targetRole: "admin",
      },
    );

    const rows = await db
      .select()
      .from(notifications)
      .where(inArray(notifications.userId, [alice, bob]));
    const roleRows = rows.filter((r) => r.title === "Role Broadcast");
    expect(roleRows.length).toBe(2);
    for (const r of roleRows) {
      expect(r.targetRole).toBe("admin");
    }
  });

  it("swallows bulk push delivery errors and still resolves", async () => {
    sendPushToUserMock.mockImplementation(async () => {
      throw new Error("bulk transport boom");
    });

    await expect(
      createNotificationsForUsers(
        [alice, bob],
        { title: "Bulk Push Fail", message: "All push fail" },
        { url: "/" },
      ),
    ).resolves.toBeUndefined();

    // In-app rows still inserted for both users despite push errors.
    const rows = await db
      .select()
      .from(notifications)
      .where(inArray(notifications.userId, [alice, bob]));
    const failRows = rows.filter((r) => r.title === "Bulk Push Fail");
    expect(failRows.length).toBe(2);
  });
});

describe("createNotification — native push (P2-B3) + actionType/actionId (P2-B2)", () => {
  it("calls sendNativePushToUser alongside sendPushToUser when push is provided", async () => {
    await createNotification(
      alice,
      { title: "Dual Channel", message: "Body" },
      { url: "/", tag: "dual" },
    );
    expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
    expect(sendNativePushToUserMock).toHaveBeenCalledTimes(1);
    const [calledUserId] = sendNativePushToUserMock.mock.calls[0] as [number];
    expect(calledUserId).toBe(alice);
  });

  it("persists actionType/actionId on the row and forwards them (plus the new row's id) to native push", async () => {
    await createNotification(
      bob,
      { title: "Actionable", message: "Tap me", actionType: "open_analysis", actionId: "42" },
      { url: "/analyses/42" },
    );

    const rows = await db.select().from(notifications).where(eq(notifications.userId, bob));
    const found = rows.find((r) => r.title === "Actionable");
    expect(found?.actionType).toBe("open_analysis");
    expect(found?.actionId).toBe("42");

    const [, payload] = sendNativePushToUserMock.mock.calls[0] as [
      number,
      { actionType?: string | null; actionId?: string | null; notificationId?: number | null },
    ];
    expect(payload.actionType).toBe("open_analysis");
    expect(payload.actionId).toBe("42");
    expect(payload.notificationId).toBe(found?.id);
  });

  it("Web Push still fires when Native Push rejects", async () => {
    sendNativePushToUserMock.mockImplementationOnce(async () => {
      throw new Error("fcm boom");
    });
    await expect(
      createNotification(alice, { title: "Native Fails", message: "Web should still fire" }, { url: "/" }),
    ).resolves.toBe(true);
    expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
  });

  it("Native Push still fires when Web Push rejects", async () => {
    sendPushToUserMock.mockImplementationOnce(async () => {
      throw new Error("webpush boom");
    });
    await expect(
      createNotification(bob, { title: "Web Fails", message: "Native should still fire" }, { url: "/" }),
    ).resolves.toBe(true);
    expect(sendNativePushToUserMock).toHaveBeenCalledTimes(1);
  });

  it("the in-app notification row is still inserted when BOTH push channels reject", async () => {
    sendPushToUserMock.mockImplementationOnce(async () => {
      throw new Error("webpush boom");
    });
    sendNativePushToUserMock.mockImplementationOnce(async () => {
      throw new Error("fcm boom");
    });

    await expect(
      createNotification(alice, { title: "Both Fail", message: "Row must still exist" }, { url: "/" }),
    ).resolves.toBe(true);

    const rows = await db.select().from(notifications).where(eq(notifications.userId, alice));
    expect(rows.find((r) => r.title === "Both Fail")).toBeTruthy();
  });

  it("does not call sendNativePushToUser when push is omitted or null", async () => {
    await createNotification(alice, { title: "No Push A", message: "x" });
    await createNotification(alice, { title: "No Push B", message: "x" }, null);
    expect(sendNativePushToUserMock).not.toHaveBeenCalled();
  });
});

describe("createNotification — fire-and-forget timing", () => {
  it("resolves before the push promise resolves (push is non-blocking)", async () => {
    let resolvePush: (() => void) | undefined;
    let pushFinished = false;
    const pushGate = new Promise<void>((r) => {
      resolvePush = r;
    });

    sendPushToUserMock.mockImplementationOnce(async () => {
      // Simulate a slow push transport. The helper must NOT await this.
      await pushGate;
      pushFinished = true;
    });

    await createNotification(
      alice,
      { title: "Timing Test", message: "Push must not block" },
      { url: "/" },
    );

    // Contract: the helper resolved without waiting for the push transport.
    // If the helper had awaited the push, this flag would have been true.
    expect(pushFinished).toBe(false);

    // Release the push so vitest doesn't see the dangling promise / open
    // handle, then yield so the in-flight push settles cleanly.
    resolvePush?.();
    await new Promise((r) => setImmediate(r));
    expect(pushFinished).toBe(true);
  });
});
