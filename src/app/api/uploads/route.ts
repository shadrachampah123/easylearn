import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { authorizeUpload } from "@/lib/upload-auth";
import { isObjectStorageEnabled } from "@/lib/object-storage";
import { MULTIPART_DISABLED_MESSAGE, describeUploadFailure } from "@/lib/upload-mode";
import {
  MAX_FILES_PER_REQUEST,
  MAX_REQUEST_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  categoryForExtension,
  fileExtension,
  type StoredAttachment,
} from "@/lib/uploads";
import { verifyUploadContent } from "@/lib/upload-content";
import { uploadStorageDir } from "@/lib/upload-storage";
import { guardSchoolContext } from "@/lib/tenant";

export const runtime = "nodejs";

/**
 * Report which upload backend the client should use. When cloud object storage
 * is configured the browser uploads straight to the bucket via POST
 * /api/uploads/presign (bypassing the serverless request-body limit); otherwise
 * it posts a multipart form here and the bytes land on local disk.
 */
export async function GET(request: NextRequest) {
  const auth = await guardSchoolContext(request);
  if (!auth.ok) return auth.response;

  return successResponse({
    storage: isObjectStorageEnabled() ? "object" : "local",
  });
}

/**
 * Can this deployment write uploads to local disk?
 *
 * Deliberately NON-MUTATING. This runs before the request has been authorized, so it
 * must not create anything on the caller's behalf — an authenticated-but-unauthorized
 * user must not be able to make the server mkdir a directory. The previous version of
 * this check called `mkdir(..., { recursive: true })` first, which did exactly that.
 *
 * A missing upload directory is normal (it is created on the first successful write),
 * so a nonexistent path is not a refusal: walk up to the nearest existing ancestor and
 * ask whether THAT is writable, since creating a child inside it needs write permission
 * on it. The walk terminates at the filesystem root; `path.dirname` is idempotent there.
 *
 * This still detects the case the guard exists for. On a read-only serverless bundle the
 * ancestor of the missing directory exists but rejects writes with EROFS/EACCES, so the
 * probe returns false and the caller is refused up front instead of hitting an opaque
 * 500 mid-write.
 */
async function uploadDirIsWritable(): Promise<boolean> {
  let dir = uploadStorageDir();
  for (;;) {
    try {
      /* Write permission on the directory, and search permission to reach entries in
         it, are both required to create a file inside it. */
      await access(dir, fsConstants.W_OK | fsConstants.X_OK);
      return true;
    } catch (error) {
      /* Anything other than "does not exist" — EACCES, EROFS, ENOTDIR — means no. */
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

/**
 * Upload one or more files from a local device to LOCAL DISK.
 *
 * multipart/form-data fields:
 *  - purpose:     "assignment" (teacher materials) | "submission" (learner work)
 *  - assignmentId: required when purpose is "submission"
 *  - file:        the file (may be repeated, up to MAX_FILES_PER_REQUEST)
 *
 * Limits (enforced here, the client-side checks are just UX):
 *  - Videos: strict 100 MB per file.
 *  - Other files: 50 MB per file.
 *  - Request body: 100 MB + multipart overhead.
 *
 * When object storage is enabled, large uploads bypass this endpoint entirely —
 * see POST /api/uploads/presign.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    /* AUTHENTICATED callers only: this guard sits after authentication so an anonymous
       request still gets a plain 401 and learns nothing about the deployment's storage
       configuration.

       Object storage being CONFIGURED does not by itself make the disk path impossible.
       A deployment can have a bucket AND a writable filesystem, and there the multipart
       route is still the supported path for small files — refusing it would break that
       guarantee (tests/object-storage-live.test.ts, "the local upload path still works").
       What cannot work is a READ-ONLY filesystem, which is what a serverless bundle
       presents: the write failed there as an opaque EROFS 500 with a generic message.

       So ask the FILESYSTEM rather than inferring from configuration. If the upload
       directory cannot be written, answer 409 with an actionable message instead of
       attempting an impossible write.

       The probe is non-mutating on purpose: it runs before `authorizeUpload` below, so
       it must not create the directory as a side effect of asking the question. See
       `uploadDirIsWritable`. */
    if (isObjectStorageEnabled() && !(await uploadDirIsWritable())) {
      return errorResponse(MULTIPART_DISABLED_MESSAGE, 409);
    }

    // Reject oversized bodies before buffering anything.
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_REQUEST_SIZE_BYTES) {
      return errorResponse(
        "The upload is too large. Videos are limited to 100 MB and other files to 50 MB.",
        413
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorResponse("Invalid upload request. Expected multipart/form-data.");
    }

    const purposeRaw = String(form.get("purpose") || "");
    const purpose = purposeRaw === "submission" ? "submission" : "assignment";
    const assignmentId =
      (form.get("assignmentId") as string | null)?.trim() || null;

    const files = form
      .getAll("file")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);

    if (files.length === 0) {
      return errorResponse("No file was provided. Choose a file from your device and try again.");
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return errorResponse(`You can upload at most ${MAX_FILES_PER_REQUEST} files at a time.`);
    }

    await ensureFileUploadSchema();

    /* ── Role + purpose authorization (shared with the presign flow) ── */
    const authorization = await authorizeUpload({
      role: ctx.school.role,
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      purpose,
      assignmentId: purpose === "submission" ? assignmentId : null,
    });
    if (!authorization.ok) {
      return errorResponse(authorization.error || "Upload not allowed", authorization.status || 400);
    }

    /* ── Validate every file, then store it on disk and register it ── */
    const storageDir = uploadStorageDir();
    await mkdir(storageDir, { recursive: true });

    const saved: { attachment: StoredAttachment; storedName: string }[] = [];
    try {
      for (const file of files) {
        /* ── What is this file? ──
           The extension is the only part of the request the server stores, so
           it is the anchor. The size limit follows from the extension alone —
           a client cannot buy itself a larger limit by declaring a different
           MIME type. */
        const extensionCategory = categoryForExtension(file.name);
        if (!extensionCategory) {
          return errorResponse(
            `"${file.name}" is not a supported file type. Allowed: documents (PDF, Word, PowerPoint, Excel, text), images, audio, video and ZIP archives.`
          );
        }

        // Strict size enforcement — video: 100 MB, everything else: 50 MB.
        if (extensionCategory === "video") {
          if (file.size > MAX_VIDEO_SIZE_BYTES) {
            return errorResponse(
              `"${file.name}" exceeds the strict 100 MB size limit for video uploads.`,
              413
            );
          }
        } else if (file.size > MAX_FILE_SIZE_BYTES) {
          return errorResponse(
            `"${file.name}" exceeds the 50 MB size limit for this file type.`,
            413
          );
        }

        const ext = fileExtension(file.name);
        const storedName = `${randomUUID()}${ext ? `.${ext}` : ""}`;
        const buffer = Buffer.from(await file.arrayBuffer());

        /* ── The server decides what the file IS ──
           The client's declared MIME type is NOT the answer: a client can
           claim anything. The server checks the file's own bytes against the
           allow-list entry for its extension and stores the content type IT
           derived, so the file can never be served as a document the browser
           would execute. */
        const verdict = verifyUploadContent(file.name, buffer, file.type || undefined);
        if (!verdict.ok) {
          return errorResponse(
            verdict.reason ||
              `"${file.name}" is not a supported file type. Allowed: documents (PDF, Word, PowerPoint, Excel, text), images, audio, video and ZIP archives.`
          );
        }

        await writeFile(path.join(storageDir, storedName), buffer);

        const [row] = await db
          .insert(uploadedFiles)
          .values({
            // Phase 2E (Step 1): every uploaded file is tenant-attributed at write time.
            schoolId: ctx.schoolId,
            uploaderId: ctx.userId,
            purpose,
            assignmentId: purpose === "submission" ? assignmentId : null,
            originalName: file.name.slice(0, 255),
            storedName,
            // The SERVER's content type, not the one the client declared.
            mimeType: verdict.contentType!.slice(0, 150),
            category: verdict.category!,
            sizeBytes: file.size,
            storageBackend: "local",
          })
          .returning();

        saved.push({
          storedName,
          attachment: {
            fileId: row.id,
            name: row.originalName,
            type: row.category,
            size: row.sizeBytes,
            url: `/api/files/${row.id}`,
          },
        });
      }
    } catch (error) {
      // Best effort cleanup of any bytes already written for this request.
      await Promise.all(
        saved.map((entry) =>
          unlink(path.join(storageDir, entry.storedName)).catch(() => undefined)
        )
      );
      console.error(describeUploadFailure(error, { backend: "local", fileCount: saved.length }));
      return errorResponse(
        schemaAwareErrorMessage(error, "The file could not be uploaded. Please try again."),
        500
      );
    }

    return successResponse(saved.map((entry) => entry.attachment), 201);
  } catch (error) {
    console.error(describeUploadFailure(error, { backend: "local", fileCount: 0 }));
    return errorResponse(
      schemaAwareErrorMessage(error, "The file could not be uploaded. Please try again."),
      500
    );
  }
}
