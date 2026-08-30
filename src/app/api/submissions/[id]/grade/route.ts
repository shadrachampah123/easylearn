import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  submissions,
  assignments,
  assignmentAnswers,
  assignmentQuestions,
  notifications,
  learnerPoints,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and, inArray } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import { clientSafeErrorMessage } from "@/lib/schema-resilience";

type AnswerGrade = {
  questionId: string;
  pointsAwarded?: number;
  isCorrect?: boolean;
  feedback?: string;
};

/**
 * Teacher grading for a learner's assignment submission.
 *
 * Auto-graded assignments arrive here already scored; written/essay assignments arrive with
 * `score`, `max_score` and `percentage` all NULL and a status of "submitted". The old handler
 * only wrote `score`, so a manually graded submission stayed at `82/null (null%)` and the
 * learner's grade book averaged it as 0%. Every path now records a full, self-consistent
 * grade, and re-grading is allowed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Only teachers can grade submissions", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { score, maxScore, feedback, answers } = body as {
      score?: number;
      maxScore?: number;
      feedback?: string;
      answers?: AnswerGrade[];
    };

    const [submission] = await db
      .select({
        id: submissions.id,
        learnerId: submissions.learnerId,
        assignmentId: submissions.assignmentId,
        status: submissions.status,
        score: submissions.score,
        assignmentMaxScore: assignments.maxScore,
        title: assignments.title,
        teacherId: assignments.teacherId,
      })
      .from(submissions)
      .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
      .where(eq(submissions.id, id))
      .limit(1);

    if (!submission) {
      return notFoundResponse("Submission");
    }

    if (payload.role === "teacher" && submission.teacherId !== payload.userId) {
      return errorResponse("You can only grade submissions for your own assignments", 403);
    }

    if (!submission.learnerId) {
      return errorResponse("This submission is not linked to a learner", 400);
    }

    const perQuestion = Array.isArray(answers) ? answers : [];
    const questionRows = await db
      .select({
        id: assignmentQuestions.id,
        points: assignmentQuestions.points,
      })
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, submission.assignmentId));

    const totalQuestionPoints = questionRows.reduce((sum, q) => sum + (q.points || 1), 0);

    let finalScore: number;
    let finalMax: number;

    if (perQuestion.length > 0) {
      // Grade question by question; the total is whatever the teacher awarded.
      const existingAnswers = await db
        .select({
          id: assignmentAnswers.id,
          questionId: assignmentAnswers.questionId,
          pointsPossible: assignmentAnswers.pointsPossible,
        })
        .from(assignmentAnswers)
        .where(and(
          eq(assignmentAnswers.submissionId, submission.id),
          inArray(assignmentAnswers.questionId, perQuestion.map((a) => a.questionId))
        ));

      let awarded = 0;
      for (const grade of perQuestion) {
        const row = existingAnswers.find((a) => a.questionId === grade.questionId);
        if (!row) continue;
        const possible = row.pointsPossible || 0;
        const points = Math.min(Math.max(Number(grade.pointsAwarded) || 0, 0), possible);
        awarded += points;

        await db
          .update(assignmentAnswers)
          .set({
            pointsAwarded: points,
            isCorrect: grade.isCorrect !== undefined ? Boolean(grade.isCorrect) : points >= possible && possible > 0,
          })
          .where(eq(assignmentAnswers.id, row.id));
      }

      finalScore = awarded;
      finalMax = existingAnswers.reduce((sum, a) => sum + (a.pointsPossible || 0), 0) || totalQuestionPoints;
    } else {
      finalScore = Number(score);
      finalMax = Number(maxScore ?? submission.assignmentMaxScore ?? totalQuestionPoints ?? 100);
    }

    if (!Number.isFinite(finalScore) || finalScore < 0) {
      return errorResponse("Score must be a number of 0 or more");
    }
    if (!Number.isFinite(finalMax) || finalMax <= 0) {
      return errorResponse("The maximum score for this assignment must be greater than 0");
    }
    if (finalScore > finalMax) {
      return errorResponse(`Score must be between 0 and ${finalMax}`);
    }

    const percentage = Math.round((finalScore / finalMax) * 100);
    const wasAlreadyGraded = submission.status === "graded";

    const [updated] = await db
      .update(submissions)
      .set({
        score: finalScore,
        maxScore: finalMax,
        percentage,
        feedback: feedback === undefined ? null : feedback,
        status: "graded",
        // A manual grade always overrides EasyAI's attribution (and its report).
        gradedBy: "teacher",
        aiReport: null,
        gradedAt: new Date(),
      })
      .where(eq(submissions.id, id))
      .returning();

    await db.insert(notifications).values({
      userId: submission.learnerId,
      type: "grade",
      title: wasAlreadyGraded ? "Grade Updated" : "Assignment Graded",
      message: `Your submission for "${submission.title}" was graded: ${finalScore}/${finalMax} (${percentage}%)`,
      link: `/dashboard/learner/assignments/${submission.assignmentId}`,
    });

    // Only reward XP the first time, so re-grading cannot farm points.
    if (!wasAlreadyGraded) {
      let points = 0;
      if (percentage >= 90) points = 50;
      else if (percentage >= 80) points = 40;
      else if (percentage >= 70) points = 30;
      else if (percentage >= 60) points = 20;
      else if (percentage >= 50) points = 10;

      if (points > 0) {
        await db.insert(learnerPoints).values({
          learnerId: submission.learnerId,
          points,
          reason: `Scored ${finalScore}/${finalMax} on "${submission.title}"`,
        });
      }
    }

    await logActivity({
      userId: payload.userId,
      action: "grade",
      entityType: "submission",
      entityId: id,
      description: `Graded submission for ${submission.title}: ${finalScore}/${finalMax}`,
      details: JSON.stringify({
        assignmentId: submission.assignmentId,
        learnerId: submission.learnerId,
        score: finalScore,
        maxScore: finalMax,
        percentage,
      }),
    });

    return successResponse(updated);
  } catch (error) {
    console.error("Grade submission error:", error);
    return errorResponse(clientSafeErrorMessage(error, "The submission could not be graded. Please retry."), 503);
  }
}
