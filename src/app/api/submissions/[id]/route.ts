import { NextRequest } from "next/server";
import { db } from "@/db";
import { submissions, assignments, assignmentAnswers, assignmentQuestions } from "@/db/schema";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { and, eq } from "drizzle-orm";
import { clientSafeErrorMessage } from "@/lib/schema-resilience";
import {
  hasSchoolRole,
  guardSchoolContext,
  sqlSubmissionInSchool,
} from "@/lib/tenant";

/**
 * Read a single submission with the learner's answers, so the teacher can grade what was
 * actually written instead of grading blind.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolRole(ctx, "school_admin", "head_teacher", "teacher")) {
      return errorResponse("Only teachers can review submissions", 403);
    }

    const { id } = await params;

    const [submission] = await db
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
        learnerId: submissions.learnerId,
        assignmentId: submissions.assignmentId,
        assignmentTitle: assignments.title,
        teacherId: assignments.teacherId,
      })
      .from(submissions)
      .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
      // Phase 2C tenant predicate: another school's submission is "not found".
      .where(and(eq(submissions.id, id), sqlSubmissionInSchool(ctx.schoolId, submissions.id)))
      .limit(1);

    if (!submission) return notFoundResponse("Submission");

    if (ctx.school.role === "teacher" && submission.teacherId !== ctx.userId) {
      return errorResponse("You can only review submissions for your own assignments", 403);
    }

    const questions = await db
      .select()
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, submission.assignmentId))
      .orderBy(assignmentQuestions.orderIndex);

    const answers = await db
      .select()
      .from(assignmentAnswers)
      .where(eq(assignmentAnswers.submissionId, submission.id));

    return successResponse({
      ...submission,
      answers: questions.map((q) => {
        const answer = answers.find((a) => a.questionId === q.id);
        return {
          questionId: q.id,
          questionText: q.questionText,
          questionType: q.questionType,
          options: q.options,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          answer: answer?.answer ?? null,
          isCorrect: answer?.isCorrect ?? false,
          pointsAwarded: answer?.pointsAwarded ?? 0,
          pointsPossible: answer?.pointsPossible ?? (q.points || 1),
        };
      }),
    });
  } catch (error) {
    console.error("Get submission error:", error);
    return errorResponse(clientSafeErrorMessage(error, "The submission could not be loaded. Please retry."), 503);
  }
}
