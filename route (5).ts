import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignments, classes, subjects, users, submissions } from "@/db/schema";
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
    const status = request.nextUrl.searchParams.get("status");

    let query = db
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
      .orderBy(desc(assignments.createdAt))
      .$dynamic();

    // For teachers, show their own assignments
    if (payload.role === "teacher") {
      query = query.where(eq(assignments.teacherId, payload.userId));
    }

    // Filter by class
    if (classId) {
      query = query.where(eq(assignments.classId, classId));
    }

    // Filter by subject
    if (subjectId) {
      query = query.where(eq(assignments.subjectId, subjectId));
    }

    // Filter by status
    if (status) {
      query = query.where(eq(assignments.status, status as "draft" | "published" | "closed"));
    }

    const results = await query.limit(50);

    // For learners, add submission status
    if (payload.role === "learner") {
      const assignmentsWithStatus = await Promise.all(
        results.map(async (assignment) => {
          const [submission] = await db
            .select({ id: submissions.id, status: submissions.status, score: submissions.score })
            .from(submissions)
            .where(and(
              eq(submissions.assignmentId, assignment.id),
              eq(submissions.learnerId, payload.userId)
            ))
            .limit(1);
          return { ...assignment, submission: submission || null };
        })
      );
      return successResponse(assignmentsWithStatus);
    }

    return successResponse(results);
  } catch (error) {
    console.error("Assignments list error:", error);
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
      return errorResponse("Only teachers can create assignments", 403);
    }

    const body = await request.json();
    const { title, description, instructions, classId, subjectId, termId, dueDate, maxScore, allowLate, attachments, status } = body;

    if (!title || !classId || !subjectId) {
      return errorResponse("Title, class, and subject are required");
    }

    const [newAssignment] = await db.insert(assignments).values({
      title,
      description: description || null,
      instructions: instructions || null,
      classId,
      subjectId,
      teacherId: payload.userId,
      termId: termId || null,
      dueDate: dueDate ? new Date(dueDate) : null,
      maxScore: maxScore || 100,
      allowLate: allowLate || false,
      attachments: attachments || null,
      status: status || "draft",
    }).returning();

    return successResponse(newAssignment, 201);
  } catch (error) {
    console.error("Create assignment error:", error);
    return errorResponse("Internal server error", 500);
  }
}
