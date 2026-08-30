import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { authorizeUpload } from "@/lib/upload-auth";
import { isObjectStorageEnabled } from "@/lib/object-storage";
import {
  MAX_FILES_PER_REQUEST,
  MAX_REQUEST_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  categoryForFile,
  fileExtension,
  isVideoFile,
  type AttachmentCategory,
  type StoredAttachment,
} from "@/lib/uploads";
import { uploadStorageDir } from "@/lib/upload-storage";

export const runtime = "nodejs";

/**
 * Report which upload backend the client should use. When cloud object storage
 * is configured the browser uploads straight to the bucket via POST
 * /api/uploads/presign (bypassing the serverless request-body limit); otherwise
 * it posts a multipart form here and the bytes land on local disk.
 */
export async function GET(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) return unauthorizedResponse();
  const payload = await verifyToken(token);
  if (!payload) return unauthorizedResponse();

  return successResponse({
    storage: isObjectStorageEnabled() ? "object" : "local",
  });
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
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

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
      role: payload.role,
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
        const category: AttachmentCategory | null = categoryForFile(
          file.name,
          file.type || undefined
        );
        if (!category) {
          return errorResponse(
            `"${file.name}" is not a supported file type. Allowed: documents (PDF, Word, PowerPoint, Excel, text), images, audio, video and ZIP archives.`
          );
        }

        // Strict size enforcement — video: 100 MB, everything else: 50 MB.
        if (isVideoFile(file.name, file.type || undefined)) {
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
        await writeFile(path.join(storageDir, storedName), buffer);

        const [row] = await db
          .insert(uploadedFiles)
          .values({
            uploaderId: payload.userId,
            purpose,
            assignmentId: purpose === "submission" ? assignmentId : null,
            originalName: file.name.slice(0, 255),
            storedName,
            mimeType: (file.type || "application/octet-stream").slice(0, 150),
            category,
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
      return errorResponse(
        schemaAwareErrorMessage(error, "The file could not be uploaded. Please try again."),
        500
      );
    }

    return successResponse(saved.map((entry) => entry.attachment), 201);
  } catch (error) {
    console.error("Upload error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The file could not be uploaded. Please try again."),
      500
    );
  }
}
