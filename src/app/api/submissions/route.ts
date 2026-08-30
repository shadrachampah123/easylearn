import { NextRequest } from "next/server";
import { db } from "@/db";
import { submissions, assignments, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const assignmentId = request.nextUrl.searchParams.get("assignmentId");

    let query = db
      .select({
        id: submissions.id,
        content: submissions.content,
        attachments: submissions.attachments,
        status: submissions.status,
        score: submissions.score,
        maxScore: submissions.maxScore,
        percentage: submissions.percentage,
        feedback: submissions.feedback,
        submittedAt: submissions.submittedAt,
        gradedAt: submissions.gradedAt,
        createdAt: submissions.createdAt,
        assignmentId: submissions.assignmentId,
        assignmentTitle: assignments.title,
        learnerFirstName: users.firstName,
        learnerLastName: users.lastName,
        learnerId: submissions.learnerId,
      })
      .from(submissions)
      .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
      .leftJoin(users, eq(submissions.learnerId, users.id))
      .orderBy(desc(submissions.submittedAt))
      .$dynamic();

    if (payload.role === "learner") {
      query = query.where(eq(submissions.learnerId, payload.userId));
    } else if (payload.role === "teacher") {
      // Teachers only see submissions for assignments they manage.
      query = query.where(eq(assignments.teacherId, payload.userId));
    } else if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("You are not authorized to view submissions", 403);
    }

    if (assignmentId) {
      query = query.where(eq(submissions.assignmentId, assignmentId));
    }

    const results = await query.limit(100);

    return successResponse(results);
  } catch (error) {
    console.error("Submissions list error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (payload.role !== "learner") {
      return errorResponse("Only learners can submit assignments", 403);
    }

    const body = await request.json();
    const { assignmentId, content, attachments } = body;

    if (!assignmentId) {
      return errorResponse("Assignment ID is required");
    }

    // Check assignment exists and is published
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);

    if (!assignment) {
      return errorResponse("Assignment not found", 404);
    }

    if (assignment.status !== "published") {
      return errorResponse("This assignment is not accepting submissions");
    }

    // Check for existing submission
    const [existing] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(
        eq(submissions.assignmentId, assignmentId),
        eq(submissions.learnerId, payload.userId)
      ))
      .limit(1);

    if (existing) {
      // Update existing submission
      const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
      
      if (isLate && !assignment.allowLate) {
        return errorResponse("Late submissions are not allowed for this assignment");
      }

      const [updated] = await db
        .update(submissions)
        .set({
          content,
          attachments: attachments || null,
          status: isLate ? "late" : "submitted",
          submittedAt: new Date(),
        })
        .where(eq(submissions.id, existing.id))
        .returning();

      return successResponse(updated);
    }

    // Create new submission
    const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
    
    if (isLate && !assignment.allowLate) {
      return errorResponse("Late submissions are not allowed for this assignment");
    }

    const [newSubmission] = await db.insert(submissions).values({
      assignmentId,
      learnerId: payload.userId,
      content: content || null,
      attachments: attachments || null,
      status: isLate ? "late" : "submitted",
      submittedAt: new Date(),
    }).returning();

    return successResponse(newSubmission, 201);
  } catch (error) {
    console.error("Create submission error:", error);
    return errorResponse("Internal server error", 500);
  }
}
