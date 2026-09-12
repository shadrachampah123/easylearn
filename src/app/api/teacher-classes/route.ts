import { NextRequest } from "next/server";
import { db } from "@/db";
import { isSchemaOutOfDate, legacyInsert } from "@/lib/schema-resilience";
import { teacherClasses, classes, subjects, users } from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  isClassInSchool,
  isUserInSchool,
  isSubjectInSchool,
  sqlTeacherClassInSchool,
} from "@/lib/tenant";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { eq, and, desc, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const classId = request.nextUrl.searchParams.get("classId");
    const teacherId = request.nextUrl.searchParams.get("teacherId");

    // Phase 2D: prefer direct school_id, fallback to relational for transition
    let useDirect = true;
    try {
      // probe if column exists by attempting a dummy query — if it throws, fallback
      await db.execute(sql`select "school_id" from "teacher_classes" limit 0`);
    } catch {
      useDirect = false;
    }

    const conditions: any[] = useDirect
      ? [eq(teacherClasses.schoolId, ctx.schoolId)]
      : [sqlTeacherClassInSchool(ctx.schoolId, teacherClasses.id)];

    if (classId) conditions.push(eq(teacherClasses.classId, classId));
    if (teacherId) conditions.push(eq(teacherClasses.teacherId, teacherId));

    // Teachers can only see their own class assignments, regardless of query parameters.
    if (ctx.school.role === "teacher") {
      conditions.push(eq(teacherClasses.teacherId, ctx.userId));
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

    if (ctx.school.role !== "teacher" || (teacherId && teacherId !== ctx.userId)) {
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
              eq(classes.classTeacherId, ctx.userId),
              eq(classes.id, classId)
            )
          : eq(classes.classTeacherId, ctx.userId)
      )
      .orderBy(desc(classes.createdAt));

    const assignedClassIds = new Set(assignments.map((assignment) => assignment.classId));
    const homeroomAssignments = homeroomClasses
      .filter((homeroomClass) => !assignedClassIds.has(homeroomClass.id))
      .map((homeroomClass) => ({
        id: `homeroom-${homeroomClass.id}`,
        teacherId: ctx.userId,
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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminExtendedRole(ctx)) {
      return errorResponse("Only administrators can assign teachers", 403);
    }

    const body = await request.json();
    const { teacherId, classId, subjectId, academicYearId } = body;

    if (!teacherId || !classId || !subjectId) {
      return errorResponse("Teacher, class, and subject are required");
    }

    /* Phase 2D: teacher, class and subject must all belong to caller's school */
    if (!(await isUserInSchool(ctx.schoolId, teacherId))) {
      return notFoundResponse("Teacher");
    }
    if (!(await isClassInSchool(ctx.schoolId, classId))) {
      return notFoundResponse("Class");
    }
    if (!(await isSubjectInSchool(ctx.schoolId, subjectId))) {
      return notFoundResponse("Subject");
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

    let assignment;
    try {
      [assignment] = await db
        .insert(teacherClasses)
        .values({
          schoolId: ctx.schoolId,
          teacherId,
          classId,
          subjectId,
          academicYearId: academicYearId || null,
        })
        .returning();
    } catch (error) {
      // Phase 2E (Step 1) — narrow legacy compatibility ONLY: the fallback below may run
      // when this database predates migration 0016 (school_id column/table missing).
      // Any other error (constraint violation, transient DB failure, bad input) is
      // rethrown so a row can never be written without a school.
      if (!isSchemaOutOfDate(error)) throw error;
      [assignment] = await legacyInsert(db, "teacher_classes", {
        teacherId,
        classId,
        subjectId,
        academicYearId: academicYearId || null,
      }, ["id", "teacherId", "classId", "subjectId", "academicYearId", "createdAt"]);
    }

    await logActivity({
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      action: "assign",
      entityType: "teacher_assignment",
      entityId: assignment.id,
      description: `Assigned teacher ${teacherId} to class ${classId}`,
    });

    return successResponse(assignment, 201);
  } catch (error) {
    console.error("Assign teacher error:", error);
    return errorResponse("Internal server error", 500);
  }
}
