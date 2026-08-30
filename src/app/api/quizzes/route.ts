import { NextRequest } from "next/server";
import { db } from "@/db";
import { quizzes, quizQuestions, classes, subjects, users, quizAttempts, learnerClasses } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { ensureQuizImageColumn, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, desc, and, sql, inArray } from "drizzle-orm";

type QuestionInput = {
  questionType: string;
  questionText: string;
  options?: unknown;
  correctAnswer?: string;
  points?: number;
  imageUrl?: string | null;
};

const QUESTION_TYPES = ["mcq", "true_false", "fill_blank", "matching", "short_answer", "essay"] as const;

/** Normalise the question payloads coming from the teacher's quiz builder. */
function toQuestionRows(quizId: string, questions: QuestionInput[]) {
  return questions
    .filter((q) => q && typeof q.questionText === "string" && q.questionText.trim().length > 0)
    .map((q, idx) => ({
      quizId,
      questionType: (QUESTION_TYPES.includes(q.questionType as (typeof QUESTION_TYPES)[number])
        ? q.questionType
        : "mcq") as (typeof QUESTION_TYPES)[number],
      questionText: q.questionText.trim(),
      imageUrl: typeof q.imageUrl === "string" && q.imageUrl.trim() ? q.imageUrl.trim() : null,
      options: q.options ?? null,
      correctAnswer: q.correctAnswer || null,
      points: q.points || 1,
      orderIndex: idx,
    }));
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    // quiz_questions.image_url is only present from drizzle/0007 onwards; without it the
    // question-count subquery below is fine but every question read 500s, and the learner
    // is left with an empty list and no explanation. Repair it up front.
    await ensureQuizImageColumn();

    const classId = request.nextUrl.searchParams.get("classId");
    const subjectId = request.nextUrl.searchParams.get("subjectId");

    const conditions = [];

    if (payload.role === "teacher") {
      conditions.push(eq(quizzes.teacherId, payload.userId));
    }

    if (payload.role === "learner") {
      // Learners only ever see quizzes their teacher has published...
      conditions.push(eq(quizzes.isPublished, true));

      // ...and that were set for one of the classes they are enrolled in. When a school has
      // not recorded any enrollments yet we fall back to "all published quizzes" so the
      // page is never blank just because learner_classes is empty.
      const enrolled = await db
        .select({ classId: learnerClasses.classId })
        .from(learnerClasses)
        .where(eq(learnerClasses.learnerId, payload.userId));

      if (enrolled.length > 0) {
        conditions.push(inArray(quizzes.classId, enrolled.map((row) => row.classId)));
      }
    }

    if (classId) conditions.push(eq(quizzes.classId, classId));
    if (subjectId) conditions.push(eq(quizzes.subjectId, subjectId));

    const whereClause = conditions.length > 0
      ? conditions.reduce((a, b) => and(a, b)!)
      : undefined;

    const results = await db
      .select({
        id: quizzes.id,
        title: quizzes.title,
        description: quizzes.description,
        classId: quizzes.classId,
        subjectId: quizzes.subjectId,
        teacherId: quizzes.teacherId,
        timeLimitMinutes: quizzes.timeLimitMinutes,
        shuffleQuestions: quizzes.shuffleQuestions,
        shuffleAnswers: quizzes.shuffleAnswers,
        showResults: quizzes.showResults,
        isPublished: quizzes.isPublished,
        maxAttempts: quizzes.maxAttempts,
        createdAt: quizzes.createdAt,
        className: classes.name,
        subjectName: subjects.name,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
      })
      .from(quizzes)
      .leftJoin(classes, eq(quizzes.classId, classes.id))
      .leftJoin(subjects, eq(quizzes.subjectId, subjects.id))
      .leftJoin(users, eq(quizzes.teacherId, users.id))
      .where(whereClause)
      .orderBy(desc(quizzes.createdAt))
      .limit(50);

    // Add question count and attempt info for each quiz
    const quizzesWithDetails = await Promise.all(
      results.map(async (quiz) => {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(quizQuestions)
          .where(eq(quizQuestions.quizId, quiz.id));

        let attempt = null;
        let attemptsUsed = 0;
        if (payload.role === "learner") {
          const learnerAttempts = await db
            .select()
            .from(quizAttempts)
            .where(and(
              eq(quizAttempts.quizId, quiz.id),
              eq(quizAttempts.learnerId, payload.userId)
            ));
          attemptsUsed = learnerAttempts.length;
          attempt = learnerAttempts[0] || null;
        }

        return {
          ...quiz,
          questionCount: Number(count),
          myAttempt: attempt,
          attemptsUsed,
          attemptsLeft: quiz.maxAttempts ? Math.max(0, quiz.maxAttempts - attemptsUsed) : null,
        };
      })
    );

    return successResponse(quizzesWithDetails);
  } catch (error) {
    console.error("Quizzes list error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz list could not be loaded. Please retry."),
      503
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Only teachers can create quizzes", 403);
    }

    // Without this, every quiz insert fails on `column "image_url" ... does not exist`
    // (SQLSTATE 42703) on a database that has not run drizzle/0007 - the quiz row is
    // committed first, so the teacher ends up with a question-less quiz nobody can open.
    await ensureQuizImageColumn();

    const body = await request.json();
    const {
      title,
      description,
      classId,
      subjectId,
      termId,
      timeLimitMinutes,
      shuffleQuestions,
      shuffleAnswers,
      showResults,
      maxAttempts,
      isPublished,
      questions,
    } = body;

    if (!title || !classId || !subjectId) {
      return errorResponse("Title, class, and subject are required");
    }

    const questionRows = Array.isArray(questions) ? toQuestionRows("", questions) : [];

    // A quiz with no questions cannot be answered, so publishing it would just show learners
    // a dead card. Drafts stay allowed; publishing requires at least one question.
    const wantsPublished = isPublished !== false;
    if (wantsPublished && questionRows.length === 0) {
      return errorResponse("Add at least one question before publishing this quiz to learners");
    }

    // Create the quiz and its questions in one transaction so a failure can never leave an
    // orphan quiz behind.
    const newQuiz = await db.transaction(async (tx) => {
      const [created] = await tx.insert(quizzes).values({
        title,
        description: description || null,
        classId,
        subjectId,
        teacherId: payload.userId,
        termId: termId || null,
        timeLimitMinutes: timeLimitMinutes || null,
        shuffleQuestions: shuffleQuestions || false,
        shuffleAnswers: shuffleAnswers || false,
        showResults: showResults !== false,
        isPublished: wantsPublished,
        maxAttempts: maxAttempts || 1,
      }).returning();

      if (questionRows.length > 0) {
        await tx.insert(quizQuestions).values(questionRows.map((q) => ({ ...q, quizId: created.id })));
      }

      return created;
    });

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, newQuiz.id));

    return successResponse({ ...newQuiz, questionCount: Number(count) }, 201);
  } catch (error) {
    console.error("Create quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be created. Please retry."),
      503
    );
  }
}
