import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  quizzes,
  quizQuestions,
  quizAttempts,
  classes,
  subjects,
  users,
  learnerClasses,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { ensureQuizImageColumn, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, asc, and, sql } from "drizzle-orm";

const QUESTION_TYPES = ["mcq", "true_false", "fill_blank", "matching", "short_answer", "essay"] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    // Without quiz_questions.image_url (drizzle/0007) the `select().from(quizQuestions)`
    // below throws 42703 and the quiz page renders "Quiz not found".
    await ensureQuizImageColumn();

    const { id } = await params;

    const [quiz] = await db
      .select({
        id: quizzes.id,
        title: quizzes.title,
        description: quizzes.description,
        timeLimitMinutes: quizzes.timeLimitMinutes,
        shuffleQuestions: quizzes.shuffleQuestions,
        shuffleAnswers: quizzes.shuffleAnswers,
        showResults: quizzes.showResults,
        isPublished: quizzes.isPublished,
        maxAttempts: quizzes.maxAttempts,
        createdAt: quizzes.createdAt,
        classId: quizzes.classId,
        subjectId: quizzes.subjectId,
        teacherId: quizzes.teacherId,
        className: classes.name,
        subjectName: subjects.name,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
      })
      .from(quizzes)
      .leftJoin(classes, eq(quizzes.classId, classes.id))
      .leftJoin(subjects, eq(quizzes.subjectId, subjects.id))
      .leftJoin(users, eq(quizzes.teacherId, users.id))
      .where(eq(quizzes.id, id))
      .limit(1);

    if (!quiz) {
      return notFoundResponse("Quiz");
    }

    const isStaff = ["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role);

    if (payload.role === "learner") {
      if (!quiz.isPublished) {
        return errorResponse("This quiz has not been published by your teacher yet", 403);
      }
      const enrolled = await db
        .select({ classId: learnerClasses.classId })
        .from(learnerClasses)
        .where(eq(learnerClasses.learnerId, payload.userId));
      if (enrolled.length > 0 && !enrolled.some((row) => row.classId === quiz.classId)) {
        return errorResponse("This quiz was set for a different class", 403);
      }
    }

    // Get questions
    let questions = await db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, id))
      .orderBy(asc(quizQuestions.orderIndex));

    // For learners taking the quiz, hide correct answers
    if (payload.role === "learner") {
      questions = questions.map((q) => ({
        ...q,
        correctAnswer: null, // Hide correct answer from learners
      }));

      // Shuffle if enabled
      if (quiz.shuffleQuestions) {
        questions = [...questions].sort(() => Math.random() - 0.5);
      }
    }

    const attempts = await db
      .select({ count: sql<number>`count(*)` })
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.quizId, id),
        isStaff ? sql`true` : eq(quizAttempts.learnerId, payload.userId)
      ));

    return successResponse({
      ...quiz,
      questions,
      attemptsUsed: Number(attempts[0]?.count ?? 0),
      isOwner: quiz.teacherId === payload.userId,
    });
  } catch (error) {
    console.error("Get quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be loaded. Please retry."),
      503
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    await ensureQuizImageColumn();

    const { id } = await params;

    // Check ownership
    const [existing] = await db
      .select({
        teacherId: quizzes.teacherId,
        isPublished: quizzes.isPublished,
      })
      .from(quizzes)
      .where(eq(quizzes.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Quiz");

    if (existing.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only edit your own quizzes", 403);
    }

    const body = await request.json();
    const {
      title,
      description,
      classId,
      subjectId,
      timeLimitMinutes,
      shuffleQuestions,
      shuffleAnswers,
      showResults,
      maxAttempts,
      isPublished,
      questions,
    } = body;

    const replacesQuestions = Array.isArray(questions);
    const [{ questionCount }] = await db
      .select({ questionCount: sql<number>`count(*)` })
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, id));
    const [{ attemptCount }] = await db
      .select({ attemptCount: sql<number>`count(*)` })
      .from(quizAttempts)
      .where(eq(quizAttempts.quizId, id));

    // Attempts store their answers keyed by question id, so replacing the question set
    // would silently orphan every result recorded so far. The editor therefore keeps
    // questions read-only once a learner has started this quiz.
    if (replacesQuestions && Number(attemptCount) > 0) {
      return errorResponse(
        "Learners have already attempted this quiz, so its questions can no longer be replaced. Update the quiz details or create a new quiz instead.",
        409
      );
    }

    const questionRows = replacesQuestions
      ? questions
        .filter((q: { questionText?: string }) => typeof q?.questionText === "string" && q.questionText.trim())
        .map((q: {
          questionType: string;
          questionText: string;
          options?: unknown;
          correctAnswer?: string;
          points?: number;
          imageUrl?: string | null;
        }, idx: number) => ({
          quizId: id,
          questionType: (QUESTION_TYPES.includes(q.questionType as (typeof QUESTION_TYPES)[number])
            ? q.questionType
            : "mcq") as (typeof QUESTION_TYPES)[number],
          questionText: q.questionText.trim(),
          imageUrl: typeof q.imageUrl === "string" && q.imageUrl.trim() ? q.imageUrl.trim() : null,
          options: q.options ?? null,
          correctAnswer: q.correctAnswer || null,
          points: q.points || 1,
          orderIndex: idx,
        }))
      : null;

    const nextPublished = isPublished === undefined ? existing.isPublished : Boolean(isPublished);
    const nextQuestionCount = questionRows ? questionRows.length : Number(questionCount);
    if (nextPublished && nextQuestionCount === 0) {
      return errorResponse("Add at least one question before publishing this quiz to learners");
    }

    // Only the fields the caller actually sent are written, so a publish toggle can no
    // longer wipe the quiz title/description by omitting them.
    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (classId !== undefined) updates.classId = classId;
    if (subjectId !== undefined) updates.subjectId = subjectId;
    if (timeLimitMinutes !== undefined) updates.timeLimitMinutes = timeLimitMinutes;
    if (shuffleQuestions !== undefined) updates.shuffleQuestions = shuffleQuestions;
    if (shuffleAnswers !== undefined) updates.shuffleAnswers = shuffleAnswers;
    if (showResults !== undefined) updates.showResults = showResults;
    if (maxAttempts !== undefined) updates.maxAttempts = maxAttempts;
    if (isPublished !== undefined) updates.isPublished = Boolean(isPublished);

    if (Object.keys(updates).length > 0 || replacesQuestions) {
      await db.transaction(async (tx) => {
        if (Object.keys(updates).length > 0) {
          await tx
            .update(quizzes)
            .set(updates)
            .where(eq(quizzes.id, id));
        }

        if (replacesQuestions) {
          await tx.delete(quizQuestions).where(eq(quizQuestions.quizId, id));

          if (questionRows && questionRows.length > 0) {
            await tx.insert(quizQuestions).values(questionRows);
          }
        }
      });
    }

    const [updated] = await db.select().from(quizzes).where(eq(quizzes.id, id)).limit(1);

    return successResponse(updated);
  } catch (error) {
    console.error("Update quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be updated. Please retry."),
      503
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const { id } = await params;

    const [existing] = await db
      .select({ teacherId: quizzes.teacherId })
      .from(quizzes)
      .where(eq(quizzes.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Quiz");

    if (existing.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only delete your own quizzes", 403);
    }

    // Attempts reference the quiz, so clear the whole tree or the delete fails on the FK.
    await db.transaction(async (tx) => {
      await tx.delete(quizAttempts).where(eq(quizAttempts.quizId, id));
      await tx.delete(quizQuestions).where(eq(quizQuestions.quizId, id));
      await tx.delete(quizzes).where(eq(quizzes.id, id));
    });

    return successResponse({ message: "Quiz deleted" });
  } catch (error) {
    console.error("Delete quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be deleted. Please retry."),
      503
    );
  }
}
