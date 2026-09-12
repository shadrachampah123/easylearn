import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignments, classes, subjects, users, submissions } from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolStaffRole,
  isClassInSchool,
  sqlAssignmentInSchool,
} from "@/lib/tenant";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { resolveUploadedAttachments } from "@/lib/attachment-auth";
import { EASYAI_MAX_MARKS_MAX, EASYAI_MAX_MARKS_MIN } from "@/lib/easyai";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, desc, and, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    // allow_file_uploads lives in the schema but only 0009 adds the column.
    await ensureFileUploadSchema();

    const classId = request.nextUrl.searchParams.get("classId");
    const subjectId = request.nextUrl.searchParams.get("subjectId");
    const status = request.nextUrl.searchParams.get("status");

    let query = db
      .select({
        id: assignments.id,
        title: assignments.title,
        description: assignments.description,
        instructions: assignments.instructions,
        status: assignments.status,
        dueDate: assignments.dueDate,
        maxScore: assignments.maxScore,
        allowLate: assignments.allowLate,
        allowFileUploads: assignments.allowFileUploads,
        aiGradingEnabled: assignments.aiGradingEnabled,
        aiMaxMarks: assignments.aiMaxMarks,
        attachments: assignments.attachments,
        createdAt: assignments.createdAt,
        className: classes.name,
        classLevel: classes.level,
        subjectName: subjects.name,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
      })
      .from(assignments)
      .leftJoin(classes, eq(assignments.classId, classes.id))
      .leftJoin(subjects, eq(assignments.subjectId, subjects.id))
      .leftJoin(users, eq(assignments.teacherId, users.id))
      .orderBy(desc(assignments.createdAt))
      .$dynamic();

    /* Phase 2C: every branch is restricted to assignments that resolve to the caller's
       school BEFORE the Phase 1 filters below. Another school's assignment can never be
       returned, whatever `classId`/`subjectId`/`status` the caller asks for. */
    query = query.where(sqlAssignmentInSchool(ctx.schoolId, assignments.id));

    // For teachers, show their own assignments
    if (ctx.school.role === "teacher") {
      query = query.where(eq(assignments.teacherId, ctx.userId));
    }

    // Filter by class
    if (classId) {
      query = query.where(eq(assignments.classId, classId));
    }

    // Filter by subject
    if (subjectId) {
      query = query.where(eq(assignments.subjectId, subjectId));
    }

    // Filter by status
    if (status) {
      query = query.where(eq(assignments.status, status as "draft" | "published" | "closed"));
    }

    const results = await query.limit(50);

    // For learners, add submission status
    if (ctx.school.role === "learner") {
      const assignmentsWithStatus = await Promise.all(
        results.map(async (assignment) => {
          const [submission] = await db
            .select({
              id: submissions.id,
              status: submissions.status,
              score: submissions.score,
              maxScore: submissions.maxScore,
              percentage: submissions.percentage,
              gradedBy: submissions.gradedBy,
            })
            .from(submissions)
            .where(and(
              eq(submissions.assignmentId, assignment.id),
              eq(submissions.learnerId, ctx.userId)
            ))
            .limit(1);
          return { ...assignment, submission: submission || null };
        })
      );
      return successResponse(assignmentsWithStatus);
    }

    return successResponse(results);
  } catch (error) {
    console.error("Assignments list error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolStaffRole(ctx)) {
      return errorResponse("Only teachers can create assignments", 403);
    }

    const body = await request.json();
    const { title, description, instructions, classId, subjectId, termId, dueDate, maxScore, allowLate, attachments, allowFileUploads, status, aiGradingEnabled, aiMaxMarks } = body;

    if (!title || !classId || !subjectId) {
      return errorResponse("Title, class, and subject are required");
    }

    /* Phase 2C: an assignment may only be created for a class of the caller's school. */
    if (!(await isClassInSchool(ctx.schoolId, classId))) {
      return notFoundResponse("Class");
    }

    // Every attached file must be one the teacher actually uploaded.
    const resolved = await resolveUploadedAttachments(attachments, {
      uploaderId: ctx.userId,
      purpose: "assignment",
    });
    if (!resolved.ok) {
      return errorResponse(resolved.error || "The attached files could not be verified");
    }

    // EasyAI configuration: when AI grading is on the teacher must set the total
    // maximum marks the AI is allowed to allocate.
    const easyAiEnabled = aiGradingEnabled === true;
    let easyAiMaxMarks: number | null = null;
    if (easyAiEnabled) {
      const parsed = Number(aiMaxMarks);
      if (!Number.isInteger(parsed) || parsed < EASYAI_MAX_MARKS_MIN || parsed > EASYAI_MAX_MARKS_MAX) {
        return errorResponse(
          `Set the EasyAI total marks (a whole number between ${EASYAI_MAX_MARKS_MIN} and ${EASYAI_MAX_MARKS_MAX}) when enabling EasyAI grading`
        );
      }
      easyAiMaxMarks = parsed;
    }

    const [newAssignment] = await db.insert(assignments).values({
      title,
      description: description || null,
      instructions: instructions || null,
      classId,
      subjectId,
      teacherId: ctx.userId,
      termId: termId || null,
      dueDate: dueDate ? new Date(dueDate) : null,
      maxScore: maxScore || 100,
      allowLate: allowLate || false,
      attachments: resolved.attachments.length > 0 ? resolved.attachments : null,
      allowFileUploads: allowFileUploads === true,
      aiGradingEnabled: easyAiEnabled,
      aiMaxMarks: easyAiMaxMarks,
      status: status || "draft",
    }).returning();

    await logActivity({
      userId: ctx.userId,
      action: "create",
      entityType: "assignment",
      entityId: newAssignment.id,
      description: `Created assignment ${newAssignment.title}`,
      details: JSON.stringify({ title: newAssignment.title, classId: newAssignment.classId }),
    });

    return successResponse(newAssignment, 201);
  } catch (error) {
    console.error("Create assignment error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The assignment could not be created. Please try again."),
      500
    );
  }
}
