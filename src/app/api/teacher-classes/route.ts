import { NextRequest } from "next/server";
import { db } from "@/db";
import { teacherClasses, classes, subjects, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const classId = request.nextUrl.searchParams.get("classId");
    const teacherId = request.nextUrl.searchParams.get("teacherId");

    const conditions = [];
    if (classId) conditions.push(eq(teacherClasses.classId, classId));
    if (teacherId) conditions.push(eq(teacherClasses.teacherId, teacherId));

    // Teachers can only see their own class assignments, regardless of query parameters.
    if (payload.role === "teacher") {
      conditions.push(eq(teacherClasses.teacherId, payload.userId));
    }

    const whereClause = conditions.length > 0
      ? conditions.reduce((a, b) => and(a, b)!)
      : undefined;

    const assignments = await db
      .select({
        id: teacherClasses.id,
        teacherId: teacherClasses.teacherId,
        classId: teacherClasses.classId,
        subjectId: teacherClasses.subjectId,
        academicYearId: teacherClasses.academicYearId,
        createdAt: teacherClasses.createdAt,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
        teacherEmail: users.email,
        className: classes.name,
        classLevel: classes.level,
        subjectName: subjects.name,
      })
      .from(teacherClasses)
      .leftJoin(users, eq(teacherClasses.teacherId, users.id))
      .leftJoin(classes, eq(teacherClasses.classId, classes.id))
      .leftJoin(subjects, eq(teacherClasses.subjectId, subjects.id))
      .where(whereClause)
      .orderBy(desc(teacherClasses.createdAt));

    if (payload.role !== "teacher" || (teacherId && teacherId !== payload.userId)) {
      return successResponse(assignments);
    }

    // A class teacher may not have a subject-level teacher_classes record.
    // Include those homeroom classes so they can still access their class list.
    const homeroomClasses = await db
      .select({
        id: classes.id,
        name: classes.name,
        level: classes.level,
        academicYearId: classes.academicYearId,
        createdAt: classes.createdAt,
      })
      .from(classes)
      .where(
        classId
          ? and(
              eq(classes.classTeacherId, payload.userId),
              eq(classes.id, classId)
            )
          : eq(classes.classTeacherId, payload.userId)
      )
      .orderBy(desc(classes.createdAt));

    const assignedClassIds = new Set(assignments.map((assignment) => assignment.classId));
    const homeroomAssignments = homeroomClasses
      .filter((homeroomClass) => !assignedClassIds.has(homeroomClass.id))
      .map((homeroomClass) => ({
        id: `homeroom-${homeroomClass.id}`,
        teacherId: payload.userId,
        classId: homeroomClass.id,
        subjectId: null,
        academicYearId: homeroomClass.academicYearId,
        createdAt: homeroomClass.createdAt,
        teacherFirstName: null,
        teacherLastName: null,
        teacherEmail: null,
        className: homeroomClass.name,
        classLevel: homeroomClass.level,
        subjectName: "Homeroom Teacher",
      }));

    return successResponse([...assignments, ...homeroomAssignments]);
  } catch (error) {
    console.error("Teacher classes error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Only administrators can assign teachers", 403);
    }

    const body = await request.json();
    const { teacherId, classId, subjectId, academicYearId } = body;

    if (!teacherId || !classId || !subjectId) {
      return errorResponse("Teacher, class, and subject are required");
    }

    // Check for duplicate
    const existing = await db
      .select({ id: teacherClasses.id })
      .from(teacherClasses)
      .where(and(
        eq(teacherClasses.teacherId, teacherId),
        eq(teacherClasses.classId, classId),
        eq(teacherClasses.subjectId, subjectId)
      ))
      .limit(1);

    if (existing.length > 0) {
      return errorResponse("This teacher is already assigned to this class/subject");
    }

    const [assignment] = await db.insert(teacherClasses).values({
      teacherId,
      classId,
      subjectId,
      academicYearId: academicYearId || null,
    }).returning();

    return successResponse(assignment, 201);
  } catch (error) {
    console.error("Assign teacher error:", error);
    return errorResponse("Internal server error", 500);
  }
}
