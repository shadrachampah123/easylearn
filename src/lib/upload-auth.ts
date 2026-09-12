/**
 * Shared authorization rules for file uploads.
 *
 * Used by BOTH upload paths (the legacy multipart POST /api/uploads for local
 * disk, and the presigned direct-to-object-storage flow) so the exact same
 * role/purpose/assignment rules apply no matter where the bytes end up.
 */
import { db } from "@/db";
import { assignments } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { sqlAssignmentInSchool } from "@/lib/tenant";

/** School teaching roles. `super_admin` is a PLATFORM role: it holds no membership, cannot
 *  pass the Phase 2C school gate, and must never be treated as a school uploader. */
const TEACHER_ROLES = new Set(["school_admin", "head_teacher", "teacher"]);

export interface UploadAuthorization {
  ok: boolean;
  /** HTTP status to return when the upload is rejected (defaults to 400). */
  status?: number;
  error?: string;
}

export async function authorizeUpload(options: {
  /** Effective SCHOOL role from the database membership context (never the JWT claim). */
  role: string;
  /** The caller's verified school. Any referenced assignment must belong to it. */
  schoolId: string;
  purpose: "assignment" | "submission";
  assignmentId: string | null;
}): Promise<UploadAuthorization> {
  const { role, purpose, assignmentId, schoolId } = options;

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

  /* TENANT FIRST: the referenced assignment must belong to the uploader's school. The
     predicate is part of the query, so an assignment of another school is indistinguishable
     from one that does not exist (fail closed, no existence leak). */
  const [assignment] = await db
    .select({
      id: assignments.id,
      status: assignments.status,
      dueDate: assignments.dueDate,
      allowLate: assignments.allowLate,
      allowFileUploads: assignments.allowFileUploads,
    })
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), sqlAssignmentInSchool(schoolId, assignments.id)))
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
