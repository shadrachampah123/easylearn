/**
 * Shared authorization rules for file uploads.
 *
 * Used by BOTH upload paths (the legacy multipart POST /api/uploads for local
 * disk, and the presigned direct-to-object-storage flow) so the exact same
 * role/purpose/assignment rules apply no matter where the bytes end up.
 */
import { db } from "@/db";
import { assignments } from "@/db/schema";
import { eq } from "drizzle-orm";

const TEACHER_ROLES = new Set(["super_admin", "school_admin", "head_teacher", "teacher"]);

export interface UploadAuthorization {
  ok: boolean;
  /** HTTP status to return when the upload is rejected (defaults to 400). */
  status?: number;
  error?: string;
}

export async function authorizeUpload(options: {
  role: string;
  purpose: "assignment" | "submission";
  assignmentId: string | null;
}): Promise<UploadAuthorization> {
  const { role, purpose, assignmentId } = options;

  if (purpose === "assignment") {
    if (!TEACHER_ROLES.has(role)) {
      return { ok: false, status: 403, error: "Only teachers can upload assignment files" };
    }
    return { ok: true };
  }

  // purpose === "submission"
  if (role !== "learner") {
    return { ok: false, status: 403, error: "Only learners can upload submission files" };
  }
  if (!assignmentId) {
    return { ok: false, error: "Assignment ID is required for submission files" };
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
    return { ok: false, status: 404, error: "Assignment not found" };
  }
  if (assignment.status !== "published") {
    return { ok: false, error: "This assignment is not accepting submissions" };
  }
  // The teacher must explicitly enable file uploads for this assignment.
  if (!assignment.allowFileUploads) {
    return {
      ok: false,
      status: 403,
      error:
        "File uploads are not enabled for this assignment. Your teacher must allow submissions with files first.",
    };
  }
  const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
  if (isLate && !assignment.allowLate) {
    return { ok: false, error: "Late submissions are not allowed for this assignment" };
  }

  return { ok: true };
}
