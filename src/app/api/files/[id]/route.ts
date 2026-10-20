import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { db } from "@/db";
import { assignments, uploadedFiles } from "@/db/schema";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { getObjectStorageConfig, objectDownloadUrl } from "@/lib/object-storage";
import { uploadStorageDir } from "@/lib/upload-storage";
import { FILE_RESPONSE_CSP, servedContentTypeFor } from "@/lib/upload-content";
import { and, eq } from "drizzle-orm";
import {
  guardSchoolContext,
  SCHOOL_ADMIN_EXTENDED_ROLES,
  sqlFileInSchool,
} from "@/lib/tenant";

export const runtime = "nodejs";

/** School-level administrator roles, taken from the central tenant module. `super_admin` is
 *  deliberately absent: it is a platform role with no membership, so it cannot reach this
 *  route at all (Phase 2C). */
const ADMIN_ROLES = new Set<string>(SCHOOL_ADMIN_EXTENDED_ROLES);

/**
 * Serve an uploaded file with authentication, TENANT and per-file access control.
 *
 *  - Phase 2C: the file must belong to the caller's school. On a migrated schema
 *    (0016/0017) that means the file's own `school_id` — the school that wrote it — so
 *    another school's file is "not found": it is never fetched, never counted and never
 *    distinguishable from a file that does not exist. A legacy row whose `school_id` is
 *    still NULL is attributed through the relational chain (uploader membership + the
 *    assignment it belongs to) and is denied to everyone when that chain is ambiguous.
 *  - A user who belongs to more than one school therefore sees the files they uploaded
 *    to each of those schools in the school that stored them, and NEVER in their other
 *    school.
 *  - Submission files: only the learner who uploaded them, the teacher who
 *    owns the assignment, and school administrators may read them.
 *  - Assignment materials: any authenticated member of the file's school may read them.
 *    (Phase 1 allowed ANY authenticated user; Phase 2C tightens that to school members —
 *    see docs/PHASE2C_TENANT_AUTHORIZATION.md.)
 *
 * Video/audio players (and PDF viewers) issue HTTP Range requests, so this
 * endpoint implements byte-range serving (206 Partial Content).
 *
 * The session is the `httpOnly` `el_token` cookie. The browser attaches it to a
 * same-origin <img>, <video> and <a download> request by itself, so no credential
 * has to be put in the URL. The earlier `?token=` query-parameter fallback has been
 * removed: a token in a URL leaks into browser history, server access logs, and the
 * `Referer` header of every outbound link on the page.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) {
      /* The gate owns the status: 401 for a missing/expired session, 403 for an
         authenticated account with no active membership. */
      return auth.response;
    }
    const ctx = auth.context;

    const { id } = await params;

    await ensureFileUploadSchema();

    /* Tenant predicate INSIDE the query: a file belonging to another school (or to no
       school that can be established) is simply not found. */
    const [row] = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.id, id), sqlFileInSchool(ctx.schoolId, uploadedFiles.id)))
      .limit(1);

    if (!row) {
      return new Response(JSON.stringify({ success: false, error: "File not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    /* ── Phase 1 per-file access control (inside the tenant boundary) ── */
    if (row.purpose === "submission") {
      const isUploader = row.uploaderId === ctx.userId;
      let isAssignmentTeacher = false;
      if (!isUploader && row.assignmentId) {
        const [assignment] = await db
          .select({ teacherId: assignments.teacherId })
          .from(assignments)
          .where(eq(assignments.id, row.assignmentId))
          .limit(1);
        isAssignmentTeacher = Boolean(assignment && assignment.teacherId === ctx.userId);
      }
      if (!isUploader && !isAssignmentTeacher && !ADMIN_ROLES.has(ctx.school.role)) {
        return new Response(JSON.stringify({ success: false, error: "You cannot access this file" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Purpose "assignment": readable by any authenticated member of the file's school
    // (the tenant predicate above is what establishes membership).

    /* ── What is served, and how ──
       The content type is derived from the STORED FILE NAME, which ends in the
       extension the server validated when the file was uploaded. It is NOT
       the `mime_type` column: that column used to hold the MIME type the
       CLIENT declared, which meant a client could upload a file called
       `photo.png`, declare `text/html`, and have this route serve the bytes
       as an HTML document in the application's own origin.

       The content type now always comes from the server's allow-list, so it
       is never `text/html`, `image/svg+xml` or any other type a browser can
       execute. Files whose stored extension is not on the allow-list — rows
       uploaded before this rule existed, or a name the server does not
       recognise — are served as `application/octet-stream` with a download
       disposition, so unknown content is never rendered inline.

       The `Content-Security-Policy: sandbox` is the second layer: even if a
       browser were to treat a response as a document, the sandbox puts it in
       an opaque origin with scripting disabled, so it cannot reach this
       application's session or DOM. */
    const served = servedContentTypeFor(row.storedName);
    const contentType = served.contentType;
    const inline = served.inline;
    const encodedName = encodeURIComponent(row.originalName)
      .replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
    const asciiName = row.originalName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;

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
      /* The object store serves the object itself, so its response headers are
         the ones the browser sees. The response-header overrides force the
         server-determined content type and the safe disposition onto that
         response — the bytes were uploaded straight to the bucket and never
         passed through this application. */
      return new Response(null, {
        status: 307,
        headers: {
          Location: objectDownloadUrl(config, row.storedName, {
            contentType,
            disposition,
          }),
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": FILE_RESPONSE_CSP,
        },
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


    const baseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // Defence in depth: a file response is never a scriptable document.
      "Content-Security-Policy": FILE_RESPONSE_CSP,
      // A private, cookie-authenticated resource must not be embedded by
      // another origin.
      "Cross-Origin-Resource-Policy": "same-origin",
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
