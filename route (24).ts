import { NextRequest } from "next/server";
import { db } from "@/db";
import { quizzes, quizQuestions, classes, subjects, users, quizAttempts } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, desc, and, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const classId = request.nextUrl.searchParams.get("classId");
    const subjectId = request.nextUrl.searchParams.get("subjectId");

    const conditions = [];

    if (payload.role === "teacher") {
      conditions.push(eq(quizzes.teacherId, payload.userId));
    }

    if (payload.role === "learner") {
      conditions.push(eq(quizzes.isPublished, true));
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
        if (payload.role === "learner") {
          const [existingAttempt] = await db
            .select()
            .from(quizAttempts)
            .where(and(
              eq(quizAttempts.quizId, quiz.id),
              eq(quizAttempts.learnerId, payload.userId)
            ))
            .limit(1);
          attempt = existingAttempt || null;
        }

        return {
          ...quiz,
          questionCount: Number(count),
          myAttempt: attempt,
        };
      })
    );

    return successResponse(quizzesWithDetails);
  } catch (error) {
    console.error("Quizzes list error:", error);
    return errorResponse("Internal server error", 500);
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

    const body = await request.json();
    const { title, description, classId, subjectId, termId, timeLimitMinutes, shuffleQuestions, shuffleAnswers, showResults, maxAttempts, questions } = body;

    if (!title || !classId || !subjectId) {
      return errorResponse("Title, class, and subject are required");
    }

    // Create quiz
    const [newQuiz] = await db.insert(quizzes).values({
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
      isPublished: false,
      maxAttempts: maxAttempts || 1,
    }).returning();

    // Add questions if provided
    if (questions && Array.isArray(questions) && questions.length > 0) {
      const questionsToInsert = questions.map((q: { questionType: string; questionText: string; options: unknown; correctAnswer: string; points: number }, idx: number) => ({
        quizId: newQuiz.id,
        questionType: q.questionType as "mcq" | "true_false" | "fill_blank" | "matching" | "short_answer" | "essay",
        questionText: q.questionText,
        options: q.options || null,
        correctAnswer: q.correctAnswer || null,
        points: q.points || 1,
        orderIndex: idx,
      }));

      await db.insert(quizQuestions).values(questionsToInsert);
    }

    return successResponse(newQuiz, 201);
  } catch (error) {
    console.error("Create quiz error:", error);
    return errorResponse("Internal server error", 500);
  }
}
