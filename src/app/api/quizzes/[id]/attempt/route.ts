import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  quizzes,
  quizQuestions,
  quizAttempts,
  notifications,
  learnerPoints,
  users,
} from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolStaffRole,
  isQuizInSchool,
  sqlQuizInSchool,
} from "@/lib/tenant";
import {
  calculateQuizRewardPoints,
  gradeQuizQuestionAnswer,
  isLearnerEnrolledInClass,
} from "@/lib/quiz-access";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { ensureQuizImageColumn, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, and, sql, desc, isNull } from "drizzle-orm";

// Start a quiz attempt
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (ctx.school.role !== "learner") {
      return errorResponse("Only learners can take quizzes", 403);
    }

    const { id } = await params;

    /* Phase 2C: another school's quiz does not exist for this learner. */
    if (!(await isQuizInSchool(ctx.schoolId, id))) {
      return notFoundResponse("Quiz");
    }

    // Get quiz
    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
      .limit(1);

    if (!quiz) return notFoundResponse("Quiz");
    if (!quiz.isPublished) return errorResponse("This quiz is not available");

    /* Only learners enrolled in the quiz's class may sit it.
       The enrollment is read with the caller's school, and a learner with NO enrollment
       row is not enrolled: the previous rule (`enrolled.length > 0 && …`) let a learner
       with no enrollments at all start any published quiz in their school. */
    const enrolled = await isLearnerEnrolledInClass(ctx.schoolId, ctx.userId, quiz.classId);
    if (!enrolled) {
      return errorResponse("This quiz was set for a different class", 403);
    }

    // Serialize per (quizId, learnerId) so resuming an open attempt works under default
    // maxAttempts = 1 AND concurrent first starts can never create duplicate attempt rows.
    const startOutcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}), hashtext(${ctx.userId}))`);

      const [incompleteAttempt] = await tx
        .select()
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.quizId, id),
            eq(quizAttempts.learnerId, ctx.userId),
            isNull(quizAttempts.completedAt)
          )
        )
        .limit(1);

      if (incompleteAttempt) {
        return { kind: "resumed" as const, attempt: incompleteAttempt };
      }

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.quizId, id),
            eq(quizAttempts.learnerId, ctx.userId),
            sql`${quizAttempts.completedAt} IS NOT NULL`
          )
        );

      if (quiz.maxAttempts && Number(count) >= quiz.maxAttempts) {
        return { kind: "exhausted" as const };
      }

      const [created] = await tx
        .insert(quizAttempts)
        .values({
          // Phase 2E (Step 1): the quiz was proven to belong to the caller's school
          // (isQuizInSchool + sqlQuizInSchool above), so the attempt carries that school.
          schoolId: ctx.schoolId,
          quizId: id,
          learnerId: ctx.userId,
          answers: {},
          startedAt: new Date(),
        })
        .returning();

      return { kind: "created" as const, attempt: created };
    });

    if (startOutcome.kind === "exhausted") {
      return errorResponse(`Maximum attempts (${quiz.maxAttempts}) reached for this quiz`);
    }

    if (startOutcome.kind === "resumed") {
      return successResponse({
        attempt: startOutcome.attempt,
        message: "Resuming existing attempt",
      });
    }

    return successResponse({ attempt: startOutcome.attempt }, 201);
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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (ctx.school.role !== "learner") {
      return errorResponse("Only learners can submit quizzes", 403);
    }

    // The grading read below pulls every quiz_questions column, so the optional
    // image_url column has to exist first.
    await ensureQuizImageColumn();

    const { id } = await params;
    const body = await request.json();
    const { attemptId, answers } = body;

    if (!attemptId || !answers || typeof answers !== "object" || Array.isArray(answers)) {
      return errorResponse("Attempt ID and answers are required");
    }

    // Get quiz and verify active publication + selected-school enrollment first
    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
      .limit(1);

    if (!quiz) return notFoundResponse("Quiz");

    /* ── The submit is authorized too ───────────────────────────────────────────
       Starting an attempt was not enough: the learner could have been removed from
       the class, and the teacher could have unpublished the quiz, while the attempt
       was still open. Submitting in that state graded the work and awarded the
       points. Both facts are re-read here, in the caller's school. */
    if (!quiz.isPublished) {
      return errorResponse("This quiz is no longer available", 403);
    }

    const enrolled = await isLearnerEnrolledInClass(ctx.schoolId, ctx.userId, quiz.classId);
    if (!enrolled) {
      return errorResponse("This quiz was set for a different class", 403);
    }

    const questions = await db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, id));

    const maxScore = questions.reduce((sum, question) => sum + (question.points || 1), 0);

    type GradedAnswerEntry = {
      answer: string;
      correct: boolean;
      points: number;
      correctAnswer: string | null;
    };

    const outcome = await db.transaction(async (tx) => {
      // Lock the attempt row exclusively so concurrent PUT submissions serialize cleanly:
      // exactly one transaction transitions `completed_at` from NULL and emits rewards,
      // while concurrent/repeated requests return the persisted result idempotently.
      const lockedResult = await tx.execute(sql`
        SELECT id
        FROM quiz_attempts
        WHERE id = ${attemptId}::uuid
          AND quiz_id = ${id}::uuid
          AND learner_id = ${ctx.userId}::uuid
          AND (school_id IS NULL OR school_id = ${ctx.schoolId}::uuid)
        FOR UPDATE
      `);
      const lockedRows = Array.isArray(lockedResult)
        ? lockedResult
        : (lockedResult as { rows?: unknown[] }).rows ?? [];
      if (lockedRows.length === 0) {
        return null;
      }

      const [lockedAttempt] = await tx
        .select()
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.id, attemptId),
            eq(quizAttempts.quizId, id),
            eq(quizAttempts.learnerId, ctx.userId)
          )
        )
        .limit(1);

      if (!lockedAttempt) {
        return null;
      }

      if (lockedAttempt.completedAt !== null) {
        const persistedScore = lockedAttempt.score ?? 0;
        const persistedPercentage = maxScore > 0 ? Math.round((persistedScore / maxScore) * 100) : 0;
        const persistedPoints = calculateQuizRewardPoints(persistedPercentage);
        const storedMap =
          lockedAttempt.answers && typeof lockedAttempt.answers === "object" && !Array.isArray(lockedAttempt.answers)
            ? (lockedAttempt.answers as Record<string, GradedAnswerEntry>)
            : {};
        const sanitizedStoredAnswers: Record<string, GradedAnswerEntry> = {};
        for (const question of questions) {
          const prev = storedMap[question.id];
          sanitizedStoredAnswers[question.id] = {
            answer: prev?.answer ?? "",
            correct: Boolean(prev?.correct),
            points: prev?.points ?? 0,
            correctAnswer: quiz.showResults ? question.correctAnswer : null,
          };
        }
        return {
          attempt: lockedAttempt,
          totalScore: persistedScore,
          percentage: persistedPercentage,
          points: persistedPoints,
          gradedAnswers: sanitizedStoredAnswers,
          alreadySubmitted: true,
        };
      }

      let totalScore = 0;
      const gradedAnswers: Record<string, GradedAnswerEntry> = {};

      for (const question of questions) {
        const graded = gradeQuizQuestionAnswer({
          questionType: question.questionType,
          learnerAnswer: (answers as Record<string, unknown>)[question.id],
          correctAnswer: question.correctAnswer,
          points: question.points,
        });

        totalScore += graded.pointsAwarded;
        gradedAnswers[question.id] = {
          answer: graded.storedAnswer,
          correct: graded.isCorrect,
          points: graded.pointsAwarded,
          correctAnswer: quiz.showResults ? question.correctAnswer : null,
        };
      }

      const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
      const points = calculateQuizRewardPoints(percentage);

      const [updatedAttempt] = await tx
        .update(quizAttempts)
        .set({
          answers: gradedAnswers,
          score: totalScore,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(quizAttempts.id, attemptId),
            eq(quizAttempts.quizId, id),
            eq(quizAttempts.learnerId, ctx.userId),
            isNull(quizAttempts.completedAt)
          )
        )
        .returning();

      await tx.insert(notifications).values({
        // Phase 2E (Step 1): the notification is tenant-attributed to the caller's school.
        schoolId: ctx.schoolId,
        userId: ctx.userId,
        type: "quiz",
        title: "Quiz Completed",
        message: `You scored ${totalScore}/${maxScore} (${percentage}%) on "${quiz.title}"`,
        link: `/dashboard/learner/quizzes/${id}`,
      });

      if (points > 0) {
        await tx.insert(learnerPoints).values({
          learnerId: ctx.userId,
          points,
          reason: `Scored ${percentage}% on quiz "${quiz.title}"`,
        });
      }

      return {
        attempt: updatedAttempt,
        totalScore,
        percentage,
        points,
        gradedAnswers,
        alreadySubmitted: false,
      };
    });

    if (!outcome) return notFoundResponse("Quiz attempt");

    const {
      attempt: updatedAttempt,
      totalScore,
      percentage,
      points,
      gradedAnswers,
      alreadySubmitted,
    } = outcome;

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
      const entry = { name, score: row.score ?? 0, isMe: row.learnerId === ctx.userId };
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
      alreadySubmitted,
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
