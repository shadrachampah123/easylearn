import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignmentQuestions, assignments } from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  hasSchoolAdminRole,
  hasSchoolStaffRole,
} from "@/lib/tenant";
import {
  assignmentAccessPredicate,
  toAssignmentQuestionDto,
  toStaffAssignmentQuestionDto,
} from "@/lib/assignment-access";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and } from "drizzle-orm";

const learnerQuestionSelection = {
  id: assignmentQuestions.id,
  questionType: assignmentQuestions.questionType,
  questionText: assignmentQuestions.questionText,
  options: assignmentQuestions.options,
  points: assignmentQuestions.points,
  orderIndex: assignmentQuestions.orderIndex,
};

const staffQuestionSelection = {
  ...learnerQuestionSelection,
  correctAnswer: assignmentQuestions.correctAnswer,
  explanation: assignmentQuestions.explanation,
};

async function loadAssignment(
  context: Parameters<typeof assignmentAccessPredicate>[0],
  assignmentId: string,
  learnerId?: string | null
) {
  return db
    .select({
      id: assignments.id,
      status: assignments.status,
      teacherId: assignments.teacherId,
    })
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), assignmentAccessPredicate(context, { learnerId })))
    .limit(1);
}

// GET questions for an assignment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const { id } = await params;
    const learnerId = request.nextUrl.searchParams.get("learnerId");

    // This assignment lookup is the authorization query. Parents must identify a linked
    // learner; learners are bound to their own enrollment; staff are bound to management or
    // school oversight before any question row is selected.
    const [assignment] = await loadAssignment(ctx, id, learnerId);
    if (!assignment) return notFoundResponse("Assignment");

    if (hasSchoolAdminExtendedRole(ctx) || ctx.school.role === "teacher") {
      const questions = await db
        .select(staffQuestionSelection)
        .from(assignmentQuestions)
        .where(eq(assignmentQuestions.assignmentId, id))
        .orderBy(assignmentQuestions.orderIndex);
      return successResponse(questions.map(toStaffAssignmentQuestionDto));
    }

    const questions = await db
      .select(learnerQuestionSelection)
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, id))
      .orderBy(assignmentQuestions.orderIndex);
    return successResponse(questions.map(toAssignmentQuestionDto));
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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolStaffRole(ctx)) {
      return errorResponse("Only teachers can add questions", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { questionType, questionText, options, correctAnswer, points, orderIndex, explanation } = body;

    const [assignment] = await loadAssignment(ctx, id);
    if (!assignment) return notFoundResponse("Assignment");

    // School admins/head teachers may oversee any assignment. A classroom teacher must own
    // the assignment; there is no implicit cross-teacher management grant.
    if (assignment.teacherId !== ctx.userId && !hasSchoolAdminRole(ctx)) {
      return errorResponse("You can only edit your own assignments", 403);
    }

    if (assignment.status === "published") {
      return errorResponse("Cannot add questions to a published assignment. Close it first.", 400);
    }
    if (!questionText) return errorResponse("Question text is required");

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
      .returning(staffQuestionSelection);

    return successResponse(toStaffAssignmentQuestionDto(question), 201);
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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolStaffRole(ctx)) {
      return errorResponse("Only teachers can delete questions", 403);
    }

    const { id: assignmentId } = await params;
    const questionId = new URL(request.url).searchParams.get("questionId");
    if (!questionId) return errorResponse("Question ID is required");

    const [assignment] = await loadAssignment(ctx, assignmentId);
    if (!assignment) return notFoundResponse("Assignment");
    if (assignment.teacherId !== ctx.userId && !hasSchoolAdminRole(ctx)) {
      return errorResponse("You can only edit your own assignments", 403);
    }

    // Anchor both the question and delete to the already-authorized assignment. A question
    // UUID from another assignment/school is therefore not fetched or deleted.
    const [question] = await db
      .select({ id: assignmentQuestions.id })
      .from(assignmentQuestions)
      .where(and(
        eq(assignmentQuestions.id, questionId),
        eq(assignmentQuestions.assignmentId, assignmentId)
      ))
      .limit(1);
    if (!question) return notFoundResponse("Question");

    await db
      .delete(assignmentQuestions)
      .where(and(eq(assignmentQuestions.id, questionId), eq(assignmentQuestions.assignmentId, assignmentId)));

    return successResponse({ message: "Question deleted" });
  } catch (error) {
    console.error("Delete assignment question error:", error);
    return errorResponse("Internal server error", 500);
  }
}
