import { NextRequest } from "next/server";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { authorizeUpload } from "@/lib/upload-auth";
import {
  MAX_VIDEO_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  categoryForExtension,
  fileExtension,
  type StoredAttachment,
} from "@/lib/uploads";
import { ruleForExtension, SCRIPTABLE_CONTENT_TYPES } from "@/lib/upload-content";
import {
  getObjectStorageConfig,
  newObjectKey,
  presignedUploadUrl,
} from "@/lib/object-storage";
import { guardSchoolContext } from "@/lib/tenant";

export const runtime = "nodejs";

interface PresignBody {
  purpose?: string;
  assignmentId?: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

/**
 * Prepare a direct-to-object-storage upload.
 *
 * The browser sends file metadata (not the bytes). The server validates the
 * uploader, the file type and size, and the assignment rules (the same rules
 * the multipart endpoint enforces), registers the file, and returns a presigned
 * PUT URL. The browser then uploads the bytes straight to the bucket — so
 * large videos never hit Vercel's ~4.5 MB request-body limit.
 *
 * Body (JSON): { purpose: "assignment"|"submission", assignmentId?, name,
 *                mimeType, size }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const config = getObjectStorageConfig();
    if (!config.enabled) {
      return errorResponse(
        "Cloud object storage is not configured. Set OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY_ID and OBJECT_STORAGE_SECRET_ACCESS_KEY to enable direct uploads.",
        503
      );
    }

    const body = (await request.json().catch(() => null)) as PresignBody | null;
    if (!body || typeof body !== "object") {
      return errorResponse("Invalid request body. Expected JSON.");
    }

    const name = String(body.name ?? "").trim();
    const mimeType = (body.mimeType ?? "").trim().slice(0, 150);
    const size = Number(body.size);
    const purpose = body.purpose === "submission" ? "submission" : "assignment";
    const assignmentId = (body.assignmentId ?? "").trim() || null;

    if (!name) {
      return errorResponse("A file name is required.");
    }
    if (!Number.isFinite(size) || size <= 0) {
      return errorResponse("A valid file size is required.");
    }

    /* ── Same type + size rules as the multipart endpoint ── */
    /* The content type is the SERVER's, derived from the extension allow-list.
       The client's declared MIME type is never used to decide what a file is:
       it is signed into the PUT only so the object store stores the type the
       server chose, and it is refused outright when it names a type a browser
       can execute.

       NOTE: in this flow the bytes go straight from the browser to the object
       store, so the server never sees them and cannot check that the file
       really is what its extension says. The download therefore forces a
       server-determined content type and a safe disposition on the object
       store's own response — see `objectDownloadUrl`. */
    const extension = fileExtension(name);
    const rule = ruleForExtension(extension);
    if (!rule) {
      return errorResponse(
        `"${name}" is not a supported file type. Allowed: documents (PDF, Word, PowerPoint, Excel, text), images, audio, video and ZIP archives.`
      );
    }
    const declaredType = mimeType.split(";")[0].trim().toLowerCase();
    if (declaredType && SCRIPTABLE_CONTENT_TYPES.has(declaredType)) {
      return errorResponse(
        `"${name}" declares the content type "${declaredType}", which a browser can execute. It was refused.`
      );
    }
    const category = rule.category;
    if (category === "video") {
      if (size > MAX_VIDEO_SIZE_BYTES) {
        return errorResponse(
          `"${name}" exceeds the strict 100 MB size limit for video uploads.`,
          413
        );
      }
    } else if (size > MAX_FILE_SIZE_BYTES) {
      return errorResponse(
        `"${name}" exceeds the 50 MB size limit for this file type.`,
        413
      );
    }

    // 0009 + 0010 must exist before we can insert a row with storage_backend.
    await ensureFileUploadSchema();

    /* ── Role + purpose authorization (shared with the multipart flow) ── */
    const authorization = await authorizeUpload({
      role: ctx.school.role,
      schoolId: ctx.schoolId,
      purpose,
      assignmentId: purpose === "submission" ? assignmentId : null,
    });
    if (!authorization.ok) {
      return errorResponse(authorization.error || "Upload not allowed", authorization.status || 400);
    }

    const ext = fileExtension(name);
    const key = newObjectKey(purpose, ext);
    // The SERVER's content type, not the one the client declared. The signed
    // PUT requires exactly this type, so the object store stores it.
    const contentType = rule.contentType;
    const presigned = presignedUploadUrl(config, key, contentType);

    // Register the file now; the browser uploads the bytes next. If the PUT
    // never happens or fails, the client cleans up via DELETE /api/uploads/<id>.
    const [row] = await db
      .insert(uploadedFiles)
      .values({
        // Phase 2E (Step 1): every uploaded file is tenant-attributed at write time.
        schoolId: ctx.schoolId,
        uploaderId: ctx.userId,
        purpose,
        assignmentId: purpose === "submission" ? assignmentId : null,
        originalName: name.slice(0, 255),
        storedName: key,
        mimeType: contentType.slice(0, 150),
        category,
        sizeBytes: size,
        storageBackend: "object",
      })
      .returning();

    const attachment: StoredAttachment = {
      fileId: row.id,
      name: row.originalName,
      type: row.category,
      size: row.sizeBytes,
      url: `/api/files/${row.id}`,
    };

    return successResponse(
      {
        fileId: row.id,
        attachment,
        upload: {
          method: "PUT",
          url: presigned.url,
          headers: presigned.headers,
          expiresInSeconds: config.uploadExpirySeconds,
        },
      },
      201
    );
  } catch (error) {
    console.error("Presign upload error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The file could not be prepared for upload. Please try again."),
      500
    );
  }
}
