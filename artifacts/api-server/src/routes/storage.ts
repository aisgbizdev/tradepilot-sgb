import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAuth, getAuthContext } from "../middleware/auth";
import { db } from "../lib/db";
import { creditTopupRequests } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Cap upload size at 5 MB — avatars only. Prevents abuse of presigned URLs.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/**
 * POST /storage/uploads/request-url
 *
 * Auth-gated. Returns a presigned URL for direct upload of an avatar image.
 * Body is JSON metadata only — the file is PUT directly to the returned URL.
 */
router.post("/storage/uploads/request-url", requireAuth, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    if (size > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: "File terlalu besar (maks 5 MB)" });
      return;
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      res.status(400).json({ error: "Tipe file tidak didukung" });
      return;
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // Defence in depth: the upload-URL endpoint validates client-supplied
    // `contentType`, but the actual PUT to GCS is not cryptographically
    // bound to it — an attacker with an upload URL could swap in arbitrary
    // bytes (e.g. HTML/JS) and serve them from this same origin, creating
    // a stored-XSS vector. Reject anything that isn't an image at serve
    // time, and force `nosniff` so browsers don't second-guess us.
    const [metadata] = await objectFile.getMetadata();
    const actualContentType = String(metadata.contentType ?? "");
    if (!actualContentType.startsWith("image/")) {
      res.status(415).json({ error: "Unsupported object type" });
      return;
    }

    // This route otherwise serves any object to any caller (object paths
    // are non-enumerable random UUIDs — avatars and other current object
    // types rely on that). Payment-proof screenshots are more sensitive
    // (could show partial payment-app/bank info), so narrowly gate just
    // those: if this path belongs to a top-up request, only its owner or
    // an admin may read it. Every other object type is unaffected.
    const [topupOwner] = await db
      .select({ userId: creditTopupRequests.userId })
      .from(creditTopupRequests)
      .where(eq(creditTopupRequests.proofObjectPath, objectPath))
      .limit(1);
    if (topupOwner) {
      const auth = await getAuthContext(req);
      const isOwner = auth?.userId === topupOwner.userId;
      const isAdmin = auth?.role === "admin" || auth?.role === "super_admin";
      if (!isOwner && !isAdmin) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
