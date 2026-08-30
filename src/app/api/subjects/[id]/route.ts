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
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, inArray } from "drizzle-orm";

const ADMIN_ROLES = ["super_admin", "school_admin"];

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) return unauthorizedResponse();
  const payload = await verifyToken(token);
  if (!payload) return unauthorizedResponse();
  if (!ADMIN_ROLES.includes(payload.role)) {
    return errorResponse("Only administrators can manage subjects", 403);
  }
  return payload;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof Response) return auth;

    const { id } = await params;
    const body = await request.json();
    const { name, code, departmentId, description } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return errorResponse("Subject name is required");
    }

    const [existing] = await db
      .select({ id: subjects.id })
      .from(subjects)
      .where(eq(subjects.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Subject");

    const [updated] = await db
      .update(subjects)
      .set({
        name: name !== undefined ? name.trim() : undefined,
        code: code !== undefined ? (code?.trim() || null) : undefined,
        departmentId: departmentId !== undefined ? departmentId || null : undefined,
        description: description !== undefined ? (description?.trim() || null) : undefined,
      })
      .where(eq(subjects.id, id))
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
    const auth = await requireAdmin(request);
    if (auth instanceof Response) return auth;

    const { id } = await params;
    const [existing] = await db
      .select({ id: subjects.id })
      .from(subjects)
      .where(eq(subjects.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Subject");

    // A subject is referenced by required assignment/quiz relationships. Remove
    // those content trees in the same transaction, while preserving resources and
    // timetable rows by clearing their optional subject relationship.
    await db.transaction(async (tx) => {
      const subjectAssignments = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(eq(assignments.subjectId, id));
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
          // Answers reference both submissions and questions. Remove by question
          // too, so even malformed/partial historical submissions cannot block the delete.
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
        .where(eq(quizzes.subjectId, id));
      const quizIds = subjectQuizzes.map((quiz) => quiz.id);

      if (quizIds.length > 0) {
        await tx.delete(quizAttempts).where(inArray(quizAttempts.quizId, quizIds));
        await tx.delete(quizQuestions).where(inArray(quizQuestions.quizId, quizIds));
        await tx.delete(quizzes).where(inArray(quizzes.id, quizIds));
      }

      await tx.delete(teacherClasses).where(eq(teacherClasses.subjectId, id));
      await tx.update(resources).set({ subjectId: null }).where(eq(resources.subjectId, id));
      await tx.update(timetableEntries).set({ subjectId: null }).where(eq(timetableEntries.subjectId, id));
      await tx.delete(subjects).where(eq(subjects.id, id));
    });

    return successResponse({ message: "Subject deleted" });
  } catch (error) {
    console.error("Delete subject error:", error);
    return errorResponse("The subject could not be deleted. Please retry.", 500);
  }
}
