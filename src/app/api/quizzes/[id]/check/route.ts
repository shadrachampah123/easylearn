import { NextRequest } from "next/server";
import { db } from "@/db";
import { quizzes, quizQuestions, quizAttempts, learnerClasses } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { ensureQuizImageColumn, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, and, sql } from "drizzle-orm";

/**
 * Kahoot-style instant feedback for one question, mid-game.
 *
 * The quiz payload sent to a learner has every `correctAnswer` stripped, so the client has
 * no way to show a real "you got it right" on its own. This endpoint grades a single answer
 * server-side for an attempt that is still in progress and returns just enough to animate
 * the answer tiles. Nothing is persisted here - the final grade is written by
 * PUT /api/quizzes/[id]/attempt.
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

    if (payload.role !== "learner") {
      return errorResponse("Only learners can answer quizzes", 403);
    }

    await ensureQuizImageColumn();

    const { id: quizId } = await params;
    const body = await request.json();
    const { attemptId, questionId, answer, elapsedMs } = body as {
      attemptId?: string;
      questionId?: string;
      answer?: string;
      elapsedMs?: number;
    };

    if (!attemptId || !questionId) {
      return errorResponse("attemptId and questionId are required");
    }

    const [quiz] = await db
      .select({
        id: quizzes.id,
        classId: quizzes.classId,
        isPublished: quizzes.isPublished,
        showResults: quizzes.showResults,
        timeLimitMinutes: quizzes.timeLimitMinutes,
      })
      .from(quizzes)
      .where(eq(quizzes.id, quizId))
      .limit(1);

    if (!quiz) return notFoundResponse("Quiz");
    if (!quiz.isPublished) return errorResponse("This quiz is not available");

    // The attempt must belong to this learner and still be open.
    const [attempt] = await db
      .select({ id: quizAttempts.id, completedAt: quizAttempts.completedAt })
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.id, attemptId),
        eq(quizAttempts.quizId, quizId),
        eq(quizAttempts.learnerId, payload.userId),
        sql`${quizAttempts.completedAt} IS NULL`
      ))
      .limit(1);

    if (!attempt) return errorResponse("Start the quiz before answering questions");

    const enrolled = await db
      .select({ classId: learnerClasses.classId })
      .from(learnerClasses)
      .where(eq(learnerClasses.learnerId, payload.userId));
    if (enrolled.length > 0 && !enrolled.some((row) => row.classId === quiz.classId)) {
      return errorResponse("This quiz was set for a different class", 403);
    }

    const [question] = await db
      .select({
        id: quizQuestions.id,
        questionType: quizQuestions.questionType,
        correctAnswer: quizQuestions.correctAnswer,
        points: quizQuestions.points,
      })
      .from(quizQuestions)
      .where(and(
        eq(quizQuestions.id, questionId),
        eq(quizQuestions.quizId, quizId)
      ))
      .limit(1);

    if (!question) return notFoundResponse("Question");

    const questionPoints = question.points || 1;
    const given = answer === undefined || answer === null ? "" : String(answer).trim().toLowerCase();
    const expected = question.correctAnswer ? String(question.correctAnswer).trim().toLowerCase() : "";

    let correct = false;
    if (given && expected) {
      switch (question.questionType) {
        case "mcq":
        case "true_false":
        case "short_answer":
        case "matching":
          correct = given === expected;
          break;
        case "fill_blank":
          correct = given === expected || expected.includes(given);
          break;
        default:
          correct = given === expected;
      }
    }

    // Kahoot speed bonus: full 1000 in the first half of the clock, tapering to 500.
    // The client tells us how long its own countdown was so the bonus matches what the
    // learner actually saw; 20s per question is the default the game screen uses.
    const windowMs = Math.min(Math.max(Number(body?.windowMs) || 20_000, 5_000), 120_000);
    const elapsed = Math.min(Math.max(Number(elapsedMs) || 0, 0), windowMs);
    const half = windowMs / 2;
    const kahootPoints = !correct
      ? 0
      : elapsed <= half
        ? 1000
        : Math.max(500, Math.round(1000 * (1 - (elapsed - half) / half)));

    return successResponse({
      correct,
      pointsAwarded: correct ? questionPoints : 0,
      pointsPossible: questionPoints,
      // Kahoot animates this number; it is not the grade.
      kahootPoints,
      // Only reveal the right answer when the teacher allows results to be shown.
      correctAnswer: quiz.showResults ? question.correctAnswer : null,
      reveal: quiz.showResults === true,
    });
  } catch (error) {
    console.error("Check quiz answer error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "That answer could not be checked. Please retry."),
      503
    );
  }
}
