import { NextRequest } from "next/server";
import { db } from "@/db";
import { submissions, assignments, users } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { resolveUploadedAttachments } from "@/lib/attachment-auth";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, and, desc } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  isAssignmentInSchool,
  sqlSubmissionInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    const assignmentId = request.nextUrl.searchParams.get("assignmentId");

    let query = db
      .select({
        id: submissions.id,
        content: submissions.content,
        attachments: submissions.attachments,
        status: submissions.status,
        score: submissions.score,
        maxScore: submissions.maxScore,
        percentage: submissions.percentage,
        feedback: submissions.feedback,
        submittedAt: submissions.submittedAt,
        gradedAt: submissions.gradedAt,
        createdAt: submissions.createdAt,
        assignmentId: submissions.assignmentId,
        assignmentTitle: assignments.title,
        learnerFirstName: users.firstName,
        learnerLastName: users.lastName,
        learnerId: submissions.learnerId,
      })
      .from(submissions)
      .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
      .leftJoin(users, eq(submissions.learnerId, users.id))
      .orderBy(desc(submissions.submittedAt))
      .$dynamic();

    /* Phase 2C tenant boundary: a submission is only ever reachable when it belongs to
       the caller's school — its learner is an active member AND its assignment resolves to
       that school alone. Applied to every branch, including the supervisory one, which
       Phase 1 left unscoped. */
    if (schoolRole === "learner") {
      query = query.where(and(
        eq(submissions.learnerId, ctx.userId),
        sqlSubmissionInSchool(ctx.schoolId, submissions.id)
      ));
    } else if (schoolRole === "teacher") {
      // Teachers only see submissions for assignments they manage, inside their school.
      query = query.where(and(
        eq(assignments.teacherId, ctx.userId),
        sqlSubmissionInSchool(ctx.schoolId, submissions.id)
      ));
    } else if (hasSchoolAdminExtendedRole(ctx)) {
      query = query.where(sqlSubmissionInSchool(ctx.schoolId, submissions.id));
    } else {
      return errorResponse("You are not authorized to view submissions", 403);
    }

    if (assignmentId) {
      query = query.where(eq(submissions.assignmentId, assignmentId));
    }

    const results = await query.limit(100);

    return successResponse(results);
  } catch (error) {
    console.error("Submissions list error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (ctx.school.role !== "learner") {
      return errorResponse("Only learners can submit assignments", 403);
    }

    const body = await request.json();
    const { assignmentId, content, attachments } = body;

    if (!assignmentId) {
      return errorResponse("Assignment ID is required");
    }

    // allow_file_uploads lives in the schema but only 0009 adds the column.
    await ensureFileUploadSchema();

    // Check assignment exists and is published
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);

    if (!assignment) {
      return errorResponse("Assignment not found", 404);
    }

    /* Phase 2C: the assignment must belong to the learner's own school before anything else
       is decided. A foreign (or unattributable) assignment is reported as not found. */
    if (!(await isAssignmentInSchool(ctx.schoolId, assignmentId))) {
      return errorResponse("Assignment not found", 404);
    }

    if (assignment.status !== "published") {
      return errorResponse("This assignment is not accepting submissions");
    }

    /* Verify the learner is enrolled in the assignment's class.
       Phase 1 denied only when the learner had at least one enrollment elsewhere and none
       here — an explicit "if no enrollment found, allow" fallback. Phase 2C removes that
       permissive fallback (brief §3): the enrollment must exist, otherwise the submission is
       refused. */
    const { learnerClasses } = await import("@/db/schema");
    const [enrollment] = await db
      .select({ id: learnerClasses.id })
      .from(learnerClasses)
      .where(and(eq(learnerClasses.learnerId, ctx.userId), eq(learnerClasses.classId, assignment.classId)))
      .limit(1);

    if (!enrollment) {
      return errorResponse("You are not enrolled in the class for this assignment", 403);
    }

    /* ── File upload gate: the teacher must explicitly enable uploads ── */
    let resolvedAttachments: { fileId: string; name: string; type: string; size: number; url: string }[] = [];
    const submittedFiles = Array.isArray(attachments) ? attachments : [];
    if (submittedFiles.length > 0 && !assignment.allowFileUploads) {
      return errorResponse(
        "File uploads are not enabled for this assignment. Your teacher must allow submissions with files first.",
        403
      );
    }
    if (submittedFiles.length > 0) {
      const resolved = await resolveUploadedAttachments(submittedFiles, {
        uploaderId: ctx.userId,
        purpose: "submission",
        assignmentId,
      });
      if (!resolved.ok) {
        return errorResponse(resolved.error || "The attached files could not be verified");
      }
      resolvedAttachments = resolved.attachments;
    }

    // Check for existing submission
    const [existing] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(
        eq(submissions.assignmentId, assignmentId),
        eq(submissions.learnerId, ctx.userId)
      ))
      .limit(1);

    if (existing) {
      // Update existing submission
      const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
      
      if (isLate && !assignment.allowLate) {
        return errorResponse("Late submissions are not allowed for this assignment");
      }

      const [updated] = await db
        .update(submissions)
        .set({
          content,
          attachments: resolvedAttachments.length > 0 ? resolvedAttachments : null,
          status: isLate ? "late" : "submitted",
          submittedAt: new Date(),
        })
        .where(eq(submissions.id, existing.id))
        .returning();

      return successResponse(updated);
    }

    // Create new submission
    const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
    
    if (isLate && !assignment.allowLate) {
      return errorResponse("Late submissions are not allowed for this assignment");
    }

    const [newSubmission] = await db.insert(submissions).values({
      assignmentId,
      learnerId: ctx.userId,
      content: content || null,
      attachments: resolvedAttachments.length > 0 ? resolvedAttachments : null,
      status: isLate ? "late" : "submitted",
      submittedAt: new Date(),
    }).returning();

    return successResponse(newSubmission, 201);
  } catch (error) {
    console.error("Create submission error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The submission could not be saved. Please try again."),
      500
    );
  }
}
