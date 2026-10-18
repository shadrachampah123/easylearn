import { NextRequest } from "next/server";
import { db } from "@/db";
import { submissions, assignments, users, learnerClasses } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { resolveUploadedAttachments } from "@/lib/attachment-auth";
import { ensureFileUploadSchema, isSchemaOutOfDate, schemaAwareErrorMessage, legacyInsert } from "@/lib/schema-resilience";
import { eq, and, desc } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  sqlAssignmentInSchool,
  sqlLearnerClassInSchool,
  sqlSchoolRowInSchool,
  sqlSubmissionInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    const assignmentId = request.nextUrl.searchParams.get("assignmentId");
    const submissionScope = await sqlSchoolRowInSchool(
      ctx.schoolId, "submissions", submissions.id, sqlSubmissionInSchool(ctx.schoolId, submissions.id)
    );
    const assignmentScope = await sqlSchoolRowInSchool(
      ctx.schoolId, "assignments", assignments.id, sqlAssignmentInSchool(ctx.schoolId, assignments.id)
    );

    // Phase 2D fix: accumulated conditions array — single WHERE with AND, never overwritten
    // Always preserve tenant predicate + role, plus assignmentId filter
    const conditions: any[] = [];

    if (schoolRole === "learner") {
      conditions.push(eq(submissions.learnerId, ctx.userId));
    } else if (schoolRole === "teacher") {
      conditions.push(eq(assignments.teacherId, ctx.userId));
    } else if (!hasSchoolAdminExtendedRole(ctx)) {
      return errorResponse("You are not authorized to view submissions", 403);
    }
    conditions.push(submissionScope, assignmentScope, sqlUserInSchool(ctx.schoolId, submissions.learnerId));

    if (assignmentId) {
      conditions.push(eq(submissions.assignmentId, assignmentId));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const results = await db
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
      .leftJoin(assignments, and(eq(submissions.assignmentId, assignments.id), assignmentScope))
      .leftJoin(users, and(eq(submissions.learnerId, users.id), sqlUserInSchool(ctx.schoolId, users.id)))
      .where(whereClause)
      .orderBy(desc(submissions.submittedAt))
      .limit(100);

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

    // The explicit row school_id is authoritative on migrated schemas. Relational fallback
    // is used only if the school_id column is genuinely absent (pre-0016), never when a
    // direct row belongs to a different school.
    const assignmentScope = await sqlSchoolRowInSchool(
      ctx.schoolId, "assignments", assignments.id, sqlAssignmentInSchool(ctx.schoolId, assignments.id)
    );
    const submissionScope = await sqlSchoolRowInSchool(
      ctx.schoolId, "submissions", submissions.id, sqlSubmissionInSchool(ctx.schoolId, submissions.id)
    );
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(and(eq(assignments.id, assignmentId), assignmentScope))
      .limit(1);

    if (!assignment) {
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
    const learnerClassScope = await sqlSchoolRowInSchool(
      ctx.schoolId, "learner_classes", learnerClasses.id, sqlLearnerClassInSchool(ctx.schoolId, learnerClasses.id)
    );
    const [enrollment] = await db
      .select({ id: learnerClasses.id })
      .from(learnerClasses)
      .where(and(
        eq(learnerClasses.learnerId, ctx.userId),
        eq(learnerClasses.classId, assignment.classId),
        learnerClassScope,
        sqlUserInSchool(ctx.schoolId, learnerClasses.learnerId)
      ))
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
        eq(submissions.learnerId, ctx.userId),
        submissionScope,
        sqlUserInSchool(ctx.schoolId, submissions.learnerId)
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
        .where(and(eq(submissions.id, existing.id), submissionScope))
        .returning();

      return successResponse(updated);
    }

    // Create new submission
    const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
    
    if (isLate && !assignment.allowLate) {
      return errorResponse("Late submissions are not allowed for this assignment");
    }

    let newSubmission;
    try {
      [newSubmission] = await db
        .insert(submissions)
        .values({
          schoolId: ctx.schoolId,
          assignmentId,
          learnerId: ctx.userId,
          content: content || null,
          attachments: resolvedAttachments.length > 0 ? resolvedAttachments : null,
          status: isLate ? "late" : "submitted",
          submittedAt: new Date(),
        })
        .returning();
    } catch (error) {
      // Phase 2E (Step 1) — narrow legacy compatibility ONLY: the fallback below may run
      // when this database predates migration 0016 (school_id column/table missing).
      // Any other error (constraint violation, transient DB failure, bad input) is
      // rethrown so a row can never be written without a school.
      if (!isSchemaOutOfDate(error)) throw error;
      [newSubmission] = await legacyInsert(db, "submissions", {
        assignmentId,
        learnerId: ctx.userId,
        content: content || null,
        attachments: resolvedAttachments.length > 0 ? resolvedAttachments : null,
        status: isLate ? "late" : "submitted",
        submittedAt: new Date(),
      }, ["id", "assignmentId", "learnerId", "content", "attachments", "status", "score", "maxScore", "percentage", "feedback", "gradedBy", "aiReport", "submittedAt", "gradedAt", "createdAt"]);
    }

    return successResponse(newSubmission, 201);
  } catch (error) {
    console.error("Create submission error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The submission could not be saved. Please try again."),
      500
    );
  }
}
