import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  assignments,
  assignmentAnswers,
  assignmentCorrections,
  assignmentQuestions,
  quizAttempts,
  quizQuestions,
  quizzes,
  resources,
  subjects,
  submissions,
  teacherClasses,
  timetableEntries,
} from "@/db/schema";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, inArray, and } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  isDepartmentInSchool,
} from "@/lib/tenant";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can manage subjects", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { name, code, departmentId, description } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return errorResponse("Subject name is required");
    }

    // Tenant check: subject must belong to caller's school
    let existing;
    try {
      [existing] = await db
        .select({ id: subjects.id })
        .from(subjects)
        .where(and(eq(subjects.id, id), eq(subjects.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      return notFoundResponse("Subject");
    }

    if (!existing) return notFoundResponse("Subject");

    if (departmentId) {
      const deptOk = await isDepartmentInSchool(ctx.schoolId, departmentId);
      if (!deptOk) return errorResponse("Department not found", 404);
    }

    const [updated] = await db
      .update(subjects)
      .set({
        name: name !== undefined ? name.trim() : undefined,
        code: code !== undefined ? (code?.trim() || null) : undefined,
        departmentId: departmentId !== undefined ? departmentId || null : undefined,
        description: description !== undefined ? (description?.trim() || null) : undefined,
      })
      .where(and(eq(subjects.id, id), eq(subjects.schoolId, ctx.schoolId)))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update subject error:", error);
    return errorResponse("The subject could not be updated. Please retry.", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can manage subjects", 403);
    }

    const { id } = await params;

    let existing;
    try {
      [existing] = await db
        .select({ id: subjects.id })
        .from(subjects)
        .where(and(eq(subjects.id, id), eq(subjects.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      return notFoundResponse("Subject");
    }

    if (!existing) return notFoundResponse("Subject");

    // A subject is referenced by required assignment/quiz relationships. Remove
    // those content trees in the same transaction, while preserving resources and
    // timetable rows by clearing their optional subject relationship.
    await db.transaction(async (tx) => {
      const subjectAssignments = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.subjectId, id), eq(assignments.schoolId, ctx.schoolId)));
      const assignmentIds = subjectAssignments.map((assignment) => assignment.id);

      if (assignmentIds.length > 0) {
        const assignmentSubmissions = await tx
          .select({ id: submissions.id })
          .from(submissions)
          .where(inArray(submissions.assignmentId, assignmentIds));
        const submissionIds = assignmentSubmissions.map((submission) => submission.id);
        const assignmentQuestionRows = await tx
          .select({ id: assignmentQuestions.id })
          .from(assignmentQuestions)
          .where(inArray(assignmentQuestions.assignmentId, assignmentIds));
        const assignmentQuestionIds = assignmentQuestionRows.map((question) => question.id);

        if (submissionIds.length > 0) {
          await tx.delete(assignmentAnswers).where(inArray(assignmentAnswers.submissionId, submissionIds));
        }
        if (assignmentQuestionIds.length > 0) {
          await tx.delete(assignmentAnswers).where(inArray(assignmentAnswers.questionId, assignmentQuestionIds));
        }
        await tx.delete(assignmentCorrections).where(inArray(assignmentCorrections.assignmentId, assignmentIds));
        await tx.delete(assignmentQuestions).where(inArray(assignmentQuestions.assignmentId, assignmentIds));
        if (submissionIds.length > 0) {
          await tx.delete(submissions).where(inArray(submissions.id, submissionIds));
        }
        await tx.delete(assignments).where(inArray(assignments.id, assignmentIds));
      }

      const subjectQuizzes = await tx
        .select({ id: quizzes.id })
        .from(quizzes)
        .where(and(eq(quizzes.subjectId, id), eq(quizzes.schoolId, ctx.schoolId)));
      const quizIds = subjectQuizzes.map((quiz) => quiz.id);

      if (quizIds.length > 0) {
        await tx.delete(quizAttempts).where(inArray(quizAttempts.quizId, quizIds));
        await tx.delete(quizQuestions).where(inArray(quizQuestions.quizId, quizIds));
        await tx.delete(quizzes).where(inArray(quizzes.id, quizIds));
      }

      try {
        await tx
          .delete(teacherClasses)
          .where(and(eq(teacherClasses.subjectId, id), eq(teacherClasses.schoolId, ctx.schoolId)));
      } catch {
        await tx.delete(teacherClasses).where(eq(teacherClasses.subjectId, id));
      }

      try {
        await tx
          .update(resources)
          .set({ subjectId: null })
          .where(and(eq(resources.subjectId, id), eq(resources.schoolId, ctx.schoolId)));
        await tx
          .update(timetableEntries)
          .set({ subjectId: null })
          .where(and(eq(timetableEntries.subjectId, id), eq(timetableEntries.schoolId, ctx.schoolId)));
      } catch {
        await tx.update(resources).set({ subjectId: null }).where(eq(resources.subjectId, id));
        await tx.update(timetableEntries).set({ subjectId: null }).where(eq(timetableEntries.subjectId, id));
      }

      await tx.delete(subjects).where(and(eq(subjects.id, id), eq(subjects.schoolId, ctx.schoolId)));
    });

    return successResponse({ message: "Subject deleted" });
  } catch (error) {
    console.error("Delete subject error:", error);
    return errorResponse("The subject could not be deleted. Please retry.", 500);
  }
}
