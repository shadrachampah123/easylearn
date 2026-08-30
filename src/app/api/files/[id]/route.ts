import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { db } from "@/db";
import { assignments, uploadedFiles } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { getObjectStorageConfig, objectDownloadUrl } from "@/lib/object-storage";
import { uploadStorageDir } from "@/lib/upload-storage";
import { isInlinePreviewable } from "@/lib/uploads";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

const ADMIN_ROLES = new Set(["super_admin", "school_admin", "head_teacher"]);

/**
 * Serve an uploaded file with authentication and per-file access control.
 *
 *  - Assignment materials: any authenticated user may read them.
 *  - Submission files: only the learner who uploaded them, the teacher who
 *    owns the assignment, and school administrators may read them.
 *
 * Video/audio players (and PDF viewers) issue HTTP Range requests, so this
 * endpoint implements byte-range serving (206 Partial Content).
 *
 * The browser passes the token as a ?token= query parameter because <img>,
 * <video> and <a download> cannot set an Authorization header; plain fetch
 * callers may use the Bearer header or the el_token cookie as usual.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    let token = getTokenFromRequest(request);
    if (!token) {
      token = request.nextUrl.searchParams.get("token") || "";
    }
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const payload = await verifyToken(token);
    if (!payload) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { id } = await params;

    await ensureFileUploadSchema();

    const [row] = await db
      .select()
      .from(uploadedFiles)
      .where(eq(uploadedFiles.id, id))
      .limit(1);

    if (!row) {
      return new Response(JSON.stringify({ success: false, error: "File not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    /* ── Access control ── */
    if (row.purpose === "submission") {
      const isUploader = row.uploaderId === payload.userId;
      let isAssignmentTeacher = false;
      if (!isUploader && row.assignmentId) {
        const [assignment] = await db
          .select({ teacherId: assignments.teacherId })
          .from(assignments)
          .where(eq(assignments.id, row.assignmentId))
          .limit(1);
        isAssignmentTeacher = Boolean(assignment && assignment.teacherId === payload.userId);
      }
      if (!isUploader && !isAssignmentTeacher && !ADMIN_ROLES.has(payload.role)) {
        return new Response(JSON.stringify({ success: false, error: "You cannot access this file" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Purpose "assignment": any authenticated user may read it.

    /* ── Cloud object storage: redirect to a presigned (or public) URL ──
       Media/PDF clients follow the redirect and then issue Range requests
       directly against the object store, so large video/audio streams never
       pass through this serverless function. */
    if (row.storageBackend === "object") {
      const config = getObjectStorageConfig();
      if (!config.enabled) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "This file is stored in cloud object storage, which is not configured.",
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(null, {
        status: 307,
        headers: { Location: objectDownloadUrl(config, row.storedName) },
      });
    }

    const absolutePath = path.join(uploadStorageDir(), row.storedName);

    let size: number;
    try {
      size = (await stat(absolutePath)).size;
    } catch {
      return new Response(JSON.stringify({ success: false, error: "File not found on disk" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const contentType = row.mimeType || "application/octet-stream";
    const inline = isInlinePreviewable(row.category);
    const encodedName = encodeURIComponent(row.originalName)
      .replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
    const asciiName = row.originalName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;

    const baseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    };

    /* ── HTTP Range support (video/audio seeking, PDF readers) ── */
    const rangeHeader = request.headers.get("range");
    const parsedRange = parseRange(rangeHeader, size);
    if (rangeHeader && parsedRange) {
      const { start, end } = parsedRange;
      const stream = Readable.toWeb(
        createReadStream(absolutePath, { start, end })
      ) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    if (rangeHeader) {
      // Un-satisfiable range (e.g. start beyond EOF) — per RFC 7233.
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes */${size}`,
        },
      });
    }

    const stream = Readable.toWeb(createReadStream(absolutePath)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(size) },
    });
  } catch (error) {
    console.error("Serve file error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: schemaAwareErrorMessage(error, "The file could not be served. Please try again."),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/** Parse a `bytes=start-end` header. Returns null when it cannot be honoured. */
function parseRange(
  range: string | null,
  size: number
): { start: number; end: number } | null {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match || size <= 0) return null;

  const [, startText, endText] = match;

  // Suffix range: last N bytes (e.g. `bytes=-500`).
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(size - suffix, 0);
    return { start, end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}
