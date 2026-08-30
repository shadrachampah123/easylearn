import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { assignments, uploadedFiles } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
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
import { eq } from "drizzle-orm";
import { uploadStorageDir } from "@/lib/upload-storage";

export const runtime = "nodejs";

const TEACHER_ROLES = new Set(["super_admin", "school_admin", "head_teacher", "teacher"]);

/**
 * Upload one or more files from a local device.
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

    /* ── Role + purpose authorization ── */
    if (purpose === "assignment") {
      if (!TEACHER_ROLES.has(payload.role)) {
        return errorResponse("Only teachers can upload assignment files", 403);
      }
    } else {
      if (payload.role !== "learner") {
        return errorResponse("Only learners can upload submission files", 403);
      }
      if (!assignmentId) {
        return errorResponse("Assignment ID is required for submission files");
      }
      const [assignment] = await db
        .select({
          id: assignments.id,
          status: assignments.status,
          dueDate: assignments.dueDate,
          allowLate: assignments.allowLate,
          allowFileUploads: assignments.allowFileUploads,
        })
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .limit(1);

      if (!assignment) {
        return errorResponse("Assignment not found", 404);
      }
      if (assignment.status !== "published") {
        return errorResponse("This assignment is not accepting submissions");
      }
      // The teacher must explicitly enable file uploads for this assignment.
      if (!assignment.allowFileUploads) {
        return errorResponse(
          "File uploads are not enabled for this assignment. Your teacher must allow submissions with files first.",
          403
        );
      }
      const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
      if (isLate && !assignment.allowLate) {
        return errorResponse("Late submissions are not allowed for this assignment");
      }
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
