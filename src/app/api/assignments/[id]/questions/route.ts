import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignmentQuestions, assignments } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and } from "drizzle-orm";

// GET questions for an assignment
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

    // Check assignment exists
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
      .limit(1);

    if (!assignment) return notFoundResponse("Assignment");

    // Get questions
    const questions = await db
      .select()
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, id));

    // Hide correct answers from learners
    if (payload.role === "learner") {
      return successResponse(
        questions.map((q) => ({ ...q, correctAnswer: null, explanation: null }))
      );
    }

    return successResponse(questions);
  } catch (error) {
    console.error("Get assignment questions error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// POST: Add a question to an assignment
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
      return errorResponse("Only teachers can add questions", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { questionType, questionText, options, correctAnswer, points, orderIndex, explanation } = body;

    // Check assignment exists and belongs to teacher
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
      .limit(1);

    if (!assignment) return notFoundResponse("Assignment");

    if (assignment.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only edit your own assignments", 403);
    }

    if (assignment.status === "published") {
      return errorResponse("Cannot add questions to a published assignment. Close it first.", 400);
    }

    if (!questionText) {
      return errorResponse("Question text is required");
    }

    const [question] = await db
      .insert(assignmentQuestions)
      .values({
        assignmentId: id,
        questionType: questionType || "mcq",
        questionText,
        options: options || null,
        correctAnswer: correctAnswer || null,
        points: points || 1,
        orderIndex: orderIndex || 0,
        explanation: explanation || null,
      })
      .returning();

    return successResponse(question, 201);
  } catch (error) {
    console.error("Add assignment question error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// DELETE a question from an assignment
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Only teachers can delete questions", 403);
    }

    const { id: assignmentId } = await params;
    const url = new URL(request.url);
    const questionId = url.searchParams.get("questionId");

    if (!questionId) return errorResponse("Question ID is required");

    const [question] = await db
      .select({ assignmentId: assignmentQuestions.assignmentId })
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.id, questionId))
      .limit(1);

    if (!question) return notFoundResponse("Question");

    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);

    if (!assignment) return notFoundResponse("Assignment");

    if (assignment.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only edit your own assignments", 403);
    }

    await db.delete(assignmentQuestions).where(eq(assignmentQuestions.id, questionId));

    return successResponse({ message: "Question deleted" });
  } catch (error) {
    console.error("Delete assignment question error:", error);
    return errorResponse("Internal server error", 500);
  }
}
