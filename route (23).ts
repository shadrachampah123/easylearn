import { NextRequest } from "next/server";
import { db } from "@/db";
import { quizzes, quizQuestions, classes, subjects, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, asc } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

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
        questions = questions.sort(() => Math.random() - 0.5);
      }
    }

    return successResponse({ ...quiz, questions });
  } catch (error) {
    console.error("Get quiz error:", error);
    return errorResponse("Internal server error", 500);
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

    const { id } = await params;

    // Check ownership
    const [existing] = await db
      .select({ teacherId: quizzes.teacherId })
      .from(quizzes)
      .where(eq(quizzes.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Quiz");

    if (existing.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only edit your own quizzes", 403);
    }

    const body = await request.json();
    const { title, description, timeLimitMinutes, shuffleQuestions, shuffleAnswers, showResults, maxAttempts, isPublished, questions } = body;

    const [updated] = await db
      .update(quizzes)
      .set({
        title,
        description,
        timeLimitMinutes,
        shuffleQuestions,
        shuffleAnswers,
        showResults,
        maxAttempts,
        isPublished,
      })
      .where(eq(quizzes.id, id))
      .returning();

    // Update questions if provided
    if (questions && Array.isArray(questions)) {
      // Delete existing questions
      await db.delete(quizQuestions).where(eq(quizQuestions.quizId, id));

      // Insert new questions
      if (questions.length > 0) {
        const questionsToInsert = questions.map((q: { questionType: string; questionText: string; options: unknown; correctAnswer: string; points: number }, idx: number) => ({
          quizId: id,
          questionType: q.questionType as "mcq" | "true_false" | "fill_blank" | "matching" | "short_answer" | "essay",
          questionText: q.questionText,
          options: q.options || null,
          correctAnswer: q.correctAnswer || null,
          points: q.points || 1,
          orderIndex: idx,
        }));

        await db.insert(quizQuestions).values(questionsToInsert);
      }
    }

    return successResponse(updated);
  } catch (error) {
    console.error("Update quiz error:", error);
    return errorResponse("Internal server error", 500);
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

    // Delete questions first
    await db.delete(quizQuestions).where(eq(quizQuestions.quizId, id));
    // Delete quiz
    await db.delete(quizzes).where(eq(quizzes.id, id));

    return successResponse({ message: "Quiz deleted" });
  } catch (error) {
    console.error("Delete quiz error:", error);
    return errorResponse("Internal server error", 500);
  }
}
