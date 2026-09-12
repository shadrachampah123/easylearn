import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignmentCorrections, assignmentQuestions, assignments, users } from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  hasSchoolStaffRole,
  sqlAssignmentInSchool,
} from "@/lib/tenant";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

// GET corrections for an assignment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const { id } = await params;

    const corrections = await db
      .select({
        id: assignmentCorrections.id,
        questionId: assignmentCorrections.questionId,
        correctionText: assignmentCorrections.correctionText,
        postedAt: assignmentCorrections.postedAt,
        postedBy: assignmentCorrections.postedBy,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
        questionText: assignmentQuestions.questionText,
      })
      .from(assignmentCorrections)
      .leftJoin(assignmentQuestions, eq(assignmentCorrections.questionId, assignmentQuestions.id))
      .leftJoin(users, eq(assignmentCorrections.postedBy, users.id))
      .where(eq(assignmentCorrections.assignmentId, id))
      .orderBy(desc(assignmentCorrections.postedAt));

    return successResponse(corrections);
  } catch (error) {
    console.error("Get corrections error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// POST: Teacher posts a correction
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolStaffRole(ctx)) {
      return errorResponse("Only teachers can post corrections", 403);
    }

    const { id: assignmentId } = await params;
    const body = await request.json();
    const { questionId, correctionText } = body;

    // Check assignment exists
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(and(eq(assignments.id, assignmentId), sqlAssignmentInSchool(ctx.schoolId, assignments.id)))
      .limit(1);

    if (!assignment) return notFoundResponse("Assignment");

    // Only the assignment's teacher (or admin) can post corrections
    if (assignment.teacherId !== ctx.userId && !hasSchoolAdminRole(ctx)) {
      return errorResponse("You can only post corrections on your own assignments", 403);
    }

    // If a questionId is provided, verify it belongs to this assignment
    if (questionId) {
      const [question] = await db
        .select()
        .from(assignmentQuestions)
        .where(eq(assignmentQuestions.id, questionId))
        .limit(1);

      if (!question) return notFoundResponse("Question");
      if (question.assignmentId !== assignmentId) {
        return errorResponse("Question does not belong to this assignment");
      }
    }

    if (!correctionText || !correctionText.trim()) {
      return errorResponse("Correction text is required");
    }

    const [correction] = await db
      .insert(assignmentCorrections)
      .values({
        assignmentId,
        questionId: questionId || null,
        correctionText: correctionText.trim(),
        postedBy: ctx.userId,
      })
      .returning();

    return successResponse(correction, 201);
  } catch (error) {
    console.error("Post correction error:", error);
    return errorResponse("Internal server error", 500);
  }
}
