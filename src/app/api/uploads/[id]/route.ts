import { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { deleteObject, getObjectStorageConfig } from "@/lib/object-storage";
import { and, eq } from "drizzle-orm";
import { uploadStorageDir } from "@/lib/upload-storage";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  sqlFileInSchool,
} from "@/lib/tenant";

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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const { id } = await params;

    await ensureFileUploadSchema();

    /* Phase 2C: the file must belong to the caller's school. The predicate is part of the
       query, so another school's file is "not found" — it is never loaded and never
       deleted. */
    const [row] = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.id, id), sqlFileInSchool(ctx.schoolId, uploadedFiles.id)))
      .limit(1);

    if (!row) return notFoundResponse("Uploaded file");

    // Phase 1 rule, now backed by the DB membership role: uploader or school administrator.
    if (row.uploaderId !== ctx.userId && !hasSchoolAdminRole(ctx)) {
      return errorResponse("You can only delete files you uploaded", 403);
    }

    // Remove the database row first so nothing can resolve it mid-delete,
    // then remove the bytes (best effort — a missing object/file is fine).
    await db
      .delete(uploadedFiles)
      .where(and(eq(uploadedFiles.id, id), sqlFileInSchool(ctx.schoolId, uploadedFiles.id)));

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
