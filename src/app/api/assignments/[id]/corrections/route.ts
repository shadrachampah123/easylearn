import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignmentCorrections, assignmentQuestions, assignments, users } from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  hasSchoolStaffRole,
  sqlUserInSchool,
} from "@/lib/tenant";
import { assignmentAccessPredicate } from "@/lib/assignment-access";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

// GET corrections for an assignment. The assignment query is also the content authorization:
// parent/learner reads require approved published content and the proper learner relationship.
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

    const [assignment] = await db
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.id, id), assignmentAccessPredicate(ctx, { learnerId })))
      .limit(1);
    if (!assignment) return notFoundResponse("Assignment");

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
      .leftJoin(
        assignmentQuestions,
        and(
          eq(assignmentCorrections.questionId, assignmentQuestions.id),
          eq(assignmentQuestions.assignmentId, id)
        )
      )
      .leftJoin(
        users,
        and(eq(assignmentCorrections.postedBy, users.id), sqlUserInSchool(ctx.schoolId, users.id))
      )
      .where(and(
        eq(assignmentCorrections.assignmentId, id),
        eq(assignmentCorrections.assignmentId, assignment.id)
      ))
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

    const [assignment] = await db
      .select({ id: assignments.id, teacherId: assignments.teacherId })
      .from(assignments)
      .where(and(eq(assignments.id, assignmentId), assignmentAccessPredicate(ctx)))
      .limit(1);
    if (!assignment) return notFoundResponse("Assignment");

    if (assignment.teacherId !== ctx.userId && !hasSchoolAdminRole(ctx)) {
      return errorResponse("You can only post corrections on your own assignments", 403);
    }

    if (questionId) {
      const [question] = await db
        .select({ id: assignmentQuestions.id })
        .from(assignmentQuestions)
        .where(and(
          eq(assignmentQuestions.id, questionId),
          eq(assignmentQuestions.assignmentId, assignmentId)
        ))
        .limit(1);
      if (!question) return notFoundResponse("Question");
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
      .returning({
        id: assignmentCorrections.id,
        assignmentId: assignmentCorrections.assignmentId,
        questionId: assignmentCorrections.questionId,
        correctionText: assignmentCorrections.correctionText,
        postedBy: assignmentCorrections.postedBy,
        postedAt: assignmentCorrections.postedAt,
      });

    return successResponse(correction, 201);
  } catch (error) {
    console.error("Post correction error:", error);
    return errorResponse("Internal server error", 500);
  }
}
