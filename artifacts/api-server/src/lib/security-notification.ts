// Store-readiness (P2-B4.1 security hardening): account-security notices.
// Two tiers, per the spec:
//  - "critical" (password changed, security question changed): ALWAYS
//    creates the in-app notification row and ALWAYS attempts push,
//    regardless of any push preference or quiet-hours window — a user
//    must be able to find out their password was changed even if they've
//    muted everything else, in case it wasn't them.
//  - "login alert": respects `users.pushLoginAlert` for the OS push (the
//    in-app row is still always created either way), and does NOT bypass
//    quiet hours — a routine login is not an emergency.
import { createNotification } from "./create-notification";
import { db } from "./db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export type CriticalSecurityEventKind = "password_changed" | "security_question_changed";

const CRITICAL_COPY: Record<CriticalSecurityEventKind, { title: string; message: string }> = {
  password_changed: {
    title: "Password Diubah",
    message:
      "Password akun kamu baru saja diubah. Jika ini bukan kamu, segera hubungi support dan reset password.",
  },
  security_question_changed: {
    title: "Pertanyaan Keamanan Diubah",
    message:
      "Pertanyaan keamanan akun kamu baru saja diubah. Jika ini bukan kamu, segera hubungi support.",
  },
};

/** Critical account-security notice — bypasses `pushLoginAlert`/quiet hours
 * by design (see file header). Never throws; a notification failure must
 * never fail the password/security-question change it's reporting on. */
export async function notifyCriticalSecurityEvent(
  userId: number,
  kind: CriticalSecurityEventKind,
): Promise<void> {
  const copy = CRITICAL_COPY[kind];
  await createNotification(
    userId,
    { title: copy.title, message: copy.message, type: "warning", category: "security_alert" },
    { title: copy.title, body: copy.message, tag: `security-${kind}` },
  ).catch(() => {
    // Deliberately swallowed — see doc comment above.
  });
}

/** Routine login notice. Respects `pushLoginAlert` for the OS push only;
 * the in-app row is always created so the account's login history is
 * visible in /notifications regardless of the toggle. */
export async function notifyLoginAlert(userId: number): Promise<void> {
  const [user] = await db
    .select({ pushLoginAlert: users.pushLoginAlert })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const title = "Login Baru Terdeteksi";
  const message = "Akun kamu baru saja login. Jika ini bukan kamu, segera ubah password.";

  await createNotification(
    userId,
    { title, message, type: "info", category: "login_alert" },
    user?.pushLoginAlert === false ? null : { title, body: message, tag: "login-alert" },
  ).catch(() => {
    // Deliberately swallowed — login must never fail because a
    // notification-side write had a transient error.
  });
}
