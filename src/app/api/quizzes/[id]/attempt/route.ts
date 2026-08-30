import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  quizzes,
  quizQuestions,
  quizAttempts,
  notifications,
  learnerPoints,
  learnerClasses,
  users,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { ensureQuizImageColumn, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, and, sql, desc } from "drizzle-orm";

// Start a quiz attempt
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
      return errorResponse("Only learners can take quizzes", 403);
    }

    const { id } = await params;

    // Get quiz
    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.id, id))
      .limit(1);

    if (!quiz) return notFoundResponse("Quiz");
    if (!quiz.isPublished) return errorResponse("This quiz is not available");

    // Only learners enrolled in the quiz's class may sit it.
    const enrolled = await db
      .select({ classId: learnerClasses.classId })
      .from(learnerClasses)
      .where(eq(learnerClasses.learnerId, payload.userId));
    if (enrolled.length > 0 && !enrolled.some((row) => row.classId === quiz.classId)) {
      return errorResponse("This quiz was set for a different class", 403);
    }

    // Check existing attempts
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.quizId, id),
        eq(quizAttempts.learnerId, payload.userId)
      ));

    if (quiz.maxAttempts && Number(count) >= quiz.maxAttempts) {
      return errorResponse(`Maximum attempts (${quiz.maxAttempts}) reached for this quiz`);
    }

    // Check for incomplete attempt
    const [incompleteAttempt] = await db
      .select()
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.quizId, id),
        eq(quizAttempts.learnerId, payload.userId),
        sql`${quizAttempts.completedAt} IS NULL`
      ))
      .limit(1);

    if (incompleteAttempt) {
      return successResponse({
        attempt: incompleteAttempt,
        message: "Resuming existing attempt",
      });
    }

    // Create new attempt
    const [newAttempt] = await db.insert(quizAttempts).values({
      quizId: id,
      learnerId: payload.userId,
      answers: {},
      startedAt: new Date(),
    }).returning();

    return successResponse({ attempt: newAttempt }, 201);
  } catch (error) {
    console.error("Start quiz attempt error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz attempt could not be started. Please retry."),
      503
    );
  }
}

// Submit quiz answers
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (payload.role !== "learner") {
      return errorResponse("Only learners can submit quizzes", 403);
    }

    // The grading read below pulls every quiz_questions column, so the optional
    // image_url column has to exist first.
    await ensureQuizImageColumn();

    const { id } = await params;
    const body = await request.json();
    const { attemptId, answers } = body;

    if (!attemptId || !answers) {
      return errorResponse("Attempt ID and answers are required");
    }

    // Get attempt
    const [attempt] = await db
      .select()
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.id, attemptId),
        eq(quizAttempts.quizId, id),
        eq(quizAttempts.learnerId, payload.userId)
      ))
      .limit(1);

    if (!attempt) return notFoundResponse("Quiz attempt");
    if (attempt.completedAt) return errorResponse("This attempt has already been submitted");

    // Get quiz and questions for grading
    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.id, id))
      .limit(1);

    if (!quiz) return notFoundResponse("Quiz");

    const questions = await db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, id));

    // Auto-grade the quiz
    let totalScore = 0;
    let maxScore = 0;
    const gradedAnswers: Record<string, { answer: string; correct: boolean; points: number; correctAnswer: string | null }> = {};

    for (const question of questions) {
      const questionPoints = question.points || 1;
      maxScore += questionPoints;

      const learnerAnswer = answers[question.id];
      let isCorrect = false;

      if (learnerAnswer && question.correctAnswer) {
        // Normalize answers for comparison
        const normalizedLearnerAnswer = String(learnerAnswer).trim().toLowerCase();
        const normalizedCorrectAnswer = String(question.correctAnswer).trim().toLowerCase();

        switch (question.questionType) {
          case "mcq":
          case "true_false":
            isCorrect = normalizedLearnerAnswer === normalizedCorrectAnswer;
            break;
          case "fill_blank":
            // Allow some flexibility for fill in the blank
            isCorrect = normalizedLearnerAnswer === normalizedCorrectAnswer ||
                        normalizedCorrectAnswer.includes(normalizedLearnerAnswer);
            break;
          case "short_answer":
            // For short answer, check if key words match
            isCorrect = normalizedLearnerAnswer === normalizedCorrectAnswer;
            break;
          case "essay":
          case "matching":
            // These require manual grading, give 0 for now
            isCorrect = false;
            break;
          default:
            isCorrect = normalizedLearnerAnswer === normalizedCorrectAnswer;
        }
      }

      if (isCorrect) {
        totalScore += questionPoints;
      }

      gradedAnswers[question.id] = {
        answer: learnerAnswer || "",
        correct: isCorrect,
        points: isCorrect ? questionPoints : 0,
        correctAnswer: quiz.showResults ? question.correctAnswer : null,
      };
    }

    // Calculate percentage
    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

    // Update attempt with results
    const [updatedAttempt] = await db
      .update(quizAttempts)
      .set({
        answers: gradedAnswers,
        score: totalScore,
        completedAt: new Date(),
      })
      .where(eq(quizAttempts.id, attemptId))
      .returning();

    // Create notification
    await db.insert(notifications).values({
      userId: payload.userId,
      type: "quiz",
      title: "Quiz Completed",
      message: `You scored ${totalScore}/${maxScore} (${percentage}%) on "${quiz.title}"`,
      link: `/dashboard/learner/quizzes/${id}`,
    });

    // Award points based on performance
    let points = 0;
    if (percentage >= 90) points = 100;
    else if (percentage >= 80) points = 80;
    else if (percentage >= 70) points = 60;
    else if (percentage >= 60) points = 40;
    else if (percentage >= 50) points = 20;

    if (points > 0) {
      await db.insert(learnerPoints).values({
        learnerId: payload.userId,
        points,
        reason: `Scored ${percentage}% on quiz "${quiz.title}"`,
      });
    }

    // Kahoot-style podium: the best scores on this quiz, with the learner's own row flagged.
    const leaderboard = await db
      .select({
        learnerId: quizAttempts.learnerId,
        score: quizAttempts.score,
        completedAt: quizAttempts.completedAt,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(quizAttempts)
      .leftJoin(users, eq(quizAttempts.learnerId, users.id))
      .where(and(
        eq(quizAttempts.quizId, id),
        sql`${quizAttempts.completedAt} IS NOT NULL`
      ))
      .orderBy(desc(sql`COALESCE(${quizAttempts.score}, 0)`))
      .limit(10);

    const bestScorePerLearner = new Map<string, { name: string; score: number; isMe: boolean }>();
    for (const row of leaderboard) {
      const name = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Learner";
      const entry = { name, score: row.score ?? 0, isMe: row.learnerId === payload.userId };
      const existing = bestScorePerLearner.get(row.learnerId);
      if (!existing || entry.score > existing.score) bestScorePerLearner.set(row.learnerId, entry);
    }

    const podium = [...bestScorePerLearner.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((entry, index) => ({ rank: index + 1, ...entry }));

    const myRank = [...bestScorePerLearner.values()]
      .sort((a, b) => b.score - a.score)
      .findIndex((entry) => entry.isMe);

    return successResponse({
      attempt: updatedAttempt,
      results: {
        score: totalScore,
        maxScore,
        percentage,
        pointsEarned: points,
        answers: quiz.showResults ? gradedAnswers : undefined,
        podium,
        rank: myRank >= 0 ? myRank + 1 : null,
      },
    });
  } catch (error) {
    console.error("Submit quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be submitted. Please retry."),
      503
    );
  }
}
