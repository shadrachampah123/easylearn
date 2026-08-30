import { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { deleteObject, getObjectStorageConfig } from "@/lib/object-storage";
import { eq } from "drizzle-orm";
import { uploadStorageDir } from "@/lib/upload-storage";

export const runtime = "nodejs";

/**
 * Remove a previously uploaded file. Only the uploader may delete their own
 * upload (used when a teacher/learner removes a file from the form before the
 * assignment/submission is saved).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const { id } = await params;

    await ensureFileUploadSchema();

    const [row] = await db
      .select()
      .from(uploadedFiles)
      .where(eq(uploadedFiles.id, id))
      .limit(1);

    if (!row) return notFoundResponse("Uploaded file");

    const isAdmin = ["super_admin", "school_admin"].includes(payload.role);
    if (row.uploaderId !== payload.userId && !isAdmin) {
      return errorResponse("You can only delete files you uploaded", 403);
    }

    // Remove the database row first so nothing can resolve it mid-delete,
    // then remove the bytes (best effort — a missing object/file is fine).
    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, id));

    if (row.storageBackend === "object") {
      await deleteObject(getObjectStorageConfig(), row.storedName);
    } else {
      await unlink(path.join(uploadStorageDir(), row.storedName)).catch(() => undefined);
    }

    return successResponse({ message: "File deleted" });
  } catch (error) {
    console.error("Delete upload error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The file could not be deleted. Please try again."),
      500
    );
  }
}
