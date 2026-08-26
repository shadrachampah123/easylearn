import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignments, classes, subjects, users, submissions } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and } from "drizzle-orm";

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

    const [assignment] = await db
      .select({
        id: assignments.id,
        title: assignments.title,
        description: assignments.description,
        instructions: assignments.instructions,
        status: assignments.status,
        dueDate: assignments.dueDate,
        maxScore: assignments.maxScore,
        allowLate: assignments.allowLate,
        attachments: assignments.attachments,
        createdAt: assignments.createdAt,
        classId: assignments.classId,
        subjectId: assignments.subjectId,
        teacherId: assignments.teacherId,
        className: classes.name,
        classLevel: classes.level,
        subjectName: subjects.name,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
      })
      .from(assignments)
      .leftJoin(classes, eq(assignments.classId, classes.id))
      .leftJoin(subjects, eq(assignments.subjectId, subjects.id))
      .leftJoin(users, eq(assignments.teacherId, users.id))
      .where(eq(assignments.id, id))
      .limit(1);

    if (!assignment) {
      return notFoundResponse("Assignment");
    }

    // Get submissions count for teachers
    if (payload.role === "teacher" || payload.role === "super_admin") {
      const submissionsList = await db
        .select({
          id: submissions.id,
          status: submissions.status,
          score: submissions.score,
          submittedAt: submissions.submittedAt,
          learnerFirstName: users.firstName,
          learnerLastName: users.lastName,
          learnerId: submissions.learnerId,
        })
        .from(submissions)
        .leftJoin(users, eq(submissions.learnerId, users.id))
        .where(eq(submissions.assignmentId, id));

      return successResponse({ ...assignment, submissions: submissionsList });
    }

    // For learners, get their own submission
    if (payload.role === "learner") {
      const [submission] = await db
        .select()
        .from(submissions)
        .where(and(
          eq(submissions.assignmentId, id),
          eq(submissions.learnerId, payload.userId)
        ))
        .limit(1);

      return successResponse({ ...assignment, mySubmission: submission || null });
    }

    return successResponse(assignment);
  } catch (error) {
    console.error("Get assignment error:", error);
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
      .select({ teacherId: assignments.teacherId })
      .from(assignments)
      .where(eq(assignments.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Assignment");

    if (existing.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only edit your own assignments", 403);
    }

    const body = await request.json();
    const { title, description, instructions, dueDate, maxScore, allowLate, attachments, status } = body;

    const [updated] = await db
      .update(assignments)
      .set({
        title,
        description,
        instructions,
        dueDate: dueDate ? new Date(dueDate) : null,
        maxScore,
        allowLate,
        attachments,
        status,
        updatedAt: new Date(),
      })
      .where(eq(assignments.id, id))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update assignment error:", error);
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
      .select({ teacherId: assignments.teacherId })
      .from(assignments)
      .where(eq(assignments.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Assignment");

    if (existing.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only delete your own assignments", 403);
    }

    await db.delete(assignments).where(eq(assignments.id, id));

    return successResponse({ message: "Assignment deleted" });
  } catch (error) {
    console.error("Delete assignment error:", error);
    return errorResponse("Internal server error", 500);
  }
}
