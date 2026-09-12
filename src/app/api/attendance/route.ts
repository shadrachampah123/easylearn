import { NextRequest } from "next/server";
import { db } from "@/db";
import { attendance, users, classes, learnerClasses, parentLearners } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  canAccessLearner,
  canTeacherAccessClass,
  getParentLinkedLearnerIds,
  getTeacherAccessibleClassIds,
} from "@/lib/authorization";
import {
  getLearnerIdsInSchool,
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  hasSchoolRole,
  isClassInSchool,
  isUserInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

/**
 * Attendance authorization model (Phase 1, documented per Phase 1 review) — PRESERVED:
 * 
 * - school_admin, head_teacher: Considered school administrators with school-wide
 *   attendance access per existing EasyLearn role model. For attendance, head_teacher
 *   retains school-wide administration to mark/view any class. This is INTENTIONAL per
 *   existing role model and is explicitly tested. Phase 2C does not weaken it: the
 *   school-wide branch is now "school-wide WITHIN the caller's own school".
 * 
 * - teacher: Restricted to classes they are assigned to teach via teacher_classes or
 *   classes.classTeacherId. Cannot mark attendance for unrelated classes.
 * 
 * - parent: Only linked children via parent_learners
 * - learner: Own only
 *
 * Phase 2C layers TENANT authorization on top of all of it, fail closed:
 *   * every attendance row must belong to a learner of the caller's school
 *   * a `classId` / `learnerId` parameter must resolve to the caller's school (404 if not,
 *     so the endpoint cannot be used to probe another school)
 *   * writes require the class AND every learner to belong to the caller's school
 *   * role decisions come from the DB membership role, never the JWT `role` claim
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    const classId = request.nextUrl.searchParams.get("classId");
    const date = request.nextUrl.searchParams.get("date");
    const learnerIdParam = request.nextUrl.searchParams.get("learnerId");

    // Tenant boundary — attendance rows are anchored by their learner.
    const conditions: any[] = [sqlUserInSchool(ctx.schoolId, attendance.learnerId)];

    if (classId) {
      // A class of another school is reported as missing, never as forbidden.
      if (!(await isClassInSchool(ctx.schoolId, classId))) {
        return errorResponse("Class not found", 404);
      }
      conditions.push(eq(attendance.classId, classId));
    }
    if (date) conditions.push(eq(attendance.date, date));

    // Role-based authorization (Phase 1 rules, driven by the DB membership role)
    if (schoolRole === "learner") {
      // Learner can only view own attendance
      if (learnerIdParam && learnerIdParam !== ctx.userId) {
        return errorResponse("You can only view your own attendance", 403);
      }
      conditions.push(eq(attendance.learnerId, ctx.userId));
    } else if (schoolRole === "parent") {
      const linkedIds = await getParentLinkedLearnerIds(ctx.userId);
      const inSchool = await getLearnerIdsInSchool(ctx.schoolId, Array.from(linkedIds));
      if (inSchool.size === 0) {
        return successResponse([]);
      }
      if (learnerIdParam) {
        if (!inSchool.has(learnerIdParam)) {
          return errorResponse("You can only view attendance for your linked children", 403);
        }
        conditions.push(eq(attendance.learnerId, learnerIdParam));
      } else {
        conditions.push(inArray(attendance.learnerId, Array.from(inSchool)));
      }
    } else if (schoolRole === "teacher") {
      // Teacher: strictly limited to assigned classes
      if (classId) {
        const canAccessClass = await canTeacherAccessClass(ctx.userId, classId);
        if (!canAccessClass) {
          return errorResponse("You can only view attendance for classes you teach", 403);
        }
      }
      if (learnerIdParam) {
        const authorized = await canAccessLearner({ userId: ctx.userId, role: schoolRole }, learnerIdParam);
        if (!authorized) {
          return errorResponse("You can only view attendance for learners in your scope", 403);
        }
        conditions.push(eq(attendance.learnerId, learnerIdParam));
      } else {
        // If no learnerId and no classId, restrict to teacher's classes
        if (!classId) {
          const accessibleClassIds = await getTeacherAccessibleClassIds(ctx.userId);
          if (accessibleClassIds.size === 0) {
            return successResponse([]);
          }
          conditions.push(inArray(attendance.classId, Array.from(accessibleClassIds)));
        }
      }
    } else if (hasSchoolAdminExtendedRole(ctx)) {
      // school_admin, head_teacher: school-wide access per existing role model
      // head_teacher is intentionally included as admin for attendance administration
      if (learnerIdParam) {
        if (!(await isUserInSchool(ctx.schoolId, learnerIdParam))) {
          return errorResponse("Learner not found", 404);
        }
        conditions.push(eq(attendance.learnerId, learnerIdParam));
      }
      // classId already in conditions if supplied, no additional restriction
    } else {
      return errorResponse("You are not authorized to view attendance", 403);
    }

    const whereClause = conditions.reduce((a, b) => and(a, b)!);

    const results = await db
      .select({
        id: attendance.id,
        date: attendance.date,
        isPresent: attendance.isPresent,
        note: attendance.note,
        createdAt: attendance.createdAt,
        learnerFirstName: users.firstName,
        learnerLastName: users.lastName,
        learnerId: attendance.learnerId,
        className: classes.name,
        classId: attendance.classId,
      })
      .from(attendance)
      .leftJoin(users, eq(attendance.learnerId, users.id))
      .leftJoin(classes, eq(attendance.classId, classes.id))
      .where(whereClause)
      .orderBy(desc(attendance.date))
      .limit(200);

    return successResponse(results);
  } catch (error) {
    console.error("Attendance list error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    if (!hasSchoolRole(ctx, "school_admin", "head_teacher", "teacher")) {
      return errorResponse("Only teachers can mark attendance", 403);
    }

    const body = await request.json();
    const { classId, date, records } = body;

    if (!classId || !date || !records || !Array.isArray(records)) {
      return errorResponse("Class ID, date, and attendance records are required");
    }

    /* ── TENANT FIRST (brief §5): the class must belong to the caller's school before any
       Phase 1 role decision is taken. Fail closed — an unattributable class is refused. ── */
    if (!(await isClassInSchool(ctx.schoolId, classId))) {
      return errorResponse("Class not found", 404);
    }

    // Verify teacher assignment to class - only for 'teacher' role
    // head_teacher, school_admin have school-wide access per existing role model
    // This is INTENTIONAL: head_teacher is in ADMIN_ROLES for many admin routes
    if (schoolRole === "teacher") {
      const canAccess = await canTeacherAccessClass(ctx.userId, classId);
      if (!canAccess) {
        return errorResponse("You can only mark attendance for classes you are assigned to teach", 403);
      }
    }

    // Validate that all learnerIds are enrolled in this class to prevent arbitrary IDs
    const learnerIds = records.map((r: any) => r.learnerId).filter(Boolean);
    if (learnerIds.length > 0) {
      // Tenant predicate: every referenced learner must be a member of the caller's school.
      const inSchool = await getLearnerIdsInSchool(ctx.schoolId, learnerIds);
      const foreign = learnerIds.filter((id: string) => !inSchool.has(id));
      if (foreign.length > 0) {
        return errorResponse("Learner not found", 404);
      }

      const enrolled = await db
        .select({ learnerId: learnerClasses.learnerId })
        .from(learnerClasses)
        .where(and(eq(learnerClasses.classId, classId), inArray(learnerClasses.learnerId, learnerIds)));
      const enrolledSet = new Set(enrolled.map((e) => e.learnerId));
      // For teachers, require enrollment to prevent marking arbitrary learners
      // For admins/head_teacher, we still check but allow if they have legitimate reason
      if (schoolRole === "teacher") {
        const notEnrolled = learnerIds.filter((id: string) => !enrolledSet.has(id));
        if (notEnrolled.length > 0) {
          return errorResponse("Some learners are not enrolled in this class", 403);
        }
      }
    }

    // Transactional delete + insert to prevent duplicates and ensure integrity
    await db.transaction(async (tx) => {
      await tx
        .delete(attendance)
        .where(and(eq(attendance.classId, classId), eq(attendance.date, date)));

      const attendanceRecords = records.map((r: { learnerId: string; isPresent: boolean; note?: string }) => ({
        learnerId: r.learnerId,
        classId,
        date,
        isPresent: r.isPresent,
        note: r.note || null,
        markedById: ctx.userId,
      }));

      if (attendanceRecords.length > 0) {
        await tx.insert(attendance).values(attendanceRecords);
      }
    });

    await logActivity({
      userId: ctx.userId,
      action: "create",
      entityType: "attendance",
      description: `Marked attendance for class ${classId} on ${date}: ${records.filter((r: any) => r.isPresent).length}/${records.length} present`,
      details: JSON.stringify({ classId, date, count: records.length }),
    });

    return successResponse({ message: "Attendance saved", count: records.length }, 201);
  } catch (error) {
    console.error("Save attendance error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    if (!hasSchoolRole(ctx, "school_admin", "head_teacher", "teacher")) {
      return errorResponse("Only teachers and administrators can view class learners for attendance", 403);
    }

    const body = await request.json();
    const { classId } = body;

    if (!classId) {
      return errorResponse("Class ID is required");
    }

    // Tenant first: a class of another school is not visible here.
    if (!(await isClassInSchool(ctx.schoolId, classId))) {
      return errorResponse("Class not found", 404);
    }

    // Verify teacher assignment - only for 'teacher' role
    // head_teacher and admins have school-wide access per existing role model
    if (schoolRole === "teacher") {
      const canAccess = await canTeacherAccessClass(ctx.userId, classId);
      if (!canAccess) {
        return errorResponse("You can only view learners for classes you are assigned to teach", 403);
      }
    }

    const learners = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(learnerClasses)
      .leftJoin(users, eq(learnerClasses.learnerId, users.id))
      .where(and(
        eq(learnerClasses.classId, classId),
        // Belt and braces: only school members can be listed as the class's learners.
        sqlUserInSchool(ctx.schoolId, learnerClasses.learnerId)
      ));

    return successResponse(learners);
  } catch (error) {
    console.error("Get class learners error:", error);
    return errorResponse("Internal server error", 500);
  }
}
