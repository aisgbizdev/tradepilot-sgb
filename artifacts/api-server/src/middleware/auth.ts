import { Request, Response, NextFunction } from "express";
import { db } from "../lib/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { resolveSession } from "../lib/session";

export interface AuthRequest extends Request {
  userId?: number;
  userRole?: string;
  sessionToken?: string;
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const token =
    req.cookies?.["session_token"] ||
    req.headers["authorization"]?.replace("Bearer ", "");

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const session = await resolveSession(token);

  if (!session) {
    res.status(401).json({ error: "Session expired or invalid" });
    return;
  }

  req.userId = session.userId;
  req.sessionToken = token;

  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  req.userRole = user?.role ?? "user";
  next();
}

/**
 * Non-throwing variant of the requireAuth lookup for routes that serve a
 * mix of public and sensitive content (e.g. GET /storage/objects/*, which
 * is unauthenticated for most object types but needs to know the caller's
 * identity to gate a narrow subset — see storage.ts). Returns null for any
 * missing/invalid/expired session instead of writing a 401 response.
 */
export async function getAuthContext(
  req: Request,
): Promise<{ userId: number; role: string } | null> {
  const token =
    req.cookies?.["session_token"] ||
    req.headers["authorization"]?.replace("Bearer ", "");
  if (!token) return null;

  const session = await resolveSession(token);
  if (!session) return null;

  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  return { userId: session.userId, role: user?.role ?? "user" };
}

export async function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  await requireAuth(req, res, async () => {
    if (req.userRole !== "admin" && req.userRole !== "super_admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });
}

export async function requireSuperAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  await requireAuth(req, res, async () => {
    if (req.userRole !== "super_admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });
}
