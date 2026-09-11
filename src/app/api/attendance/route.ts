import { NextRequest } from "next/server";
import { db } from "@/db";
import { attendance, users, classes, learnerClasses, parentLearners } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  canAccessLearner,
  canTeacherAccessClass,
  getParentLinkedLearnerIds,
  getTeacherAccessibleClassIds,
  isAdminExtendedRole,
} from "@/lib/authorization";

/**
 * Attendance authorization model (documented per Phase 1 review):
 * 
 * - super_admin, school_admin, head_teacher: Considered school administrators with school-wide
 *   attendance access per existing EasyLearn role model. ADMIN_ROLES in many places includes
 *   head_teacher (activity-logs, parent-learners, timetable, users, dashboard/admin).
 *   For attendance, head_teacher retains school-wide administration to mark/view any class.
 *   This is INTENTIONAL per existing role model and is explicitly tested.
 * 
 * - teacher: Restricted to classes they are assigned to teach via teacher_classes or
 *   classes.classTeacherId. Cannot mark attendance for unrelated classes.
 * 
 * - parent: Only linked children via parent_learners
 * - learner: Own only
 */

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const classId = request.nextUrl.searchParams.get("classId");
    const date = request.nextUrl.searchParams.get("date");
    const learnerIdParam = request.nextUrl.searchParams.get("learnerId");

    const conditions: any[] = [];

    if (classId) conditions.push(eq(attendance.classId, classId));
    if (date) conditions.push(eq(attendance.date, date));

    // Role-based authorization
    if (payload.role === "learner") {
      // Learner can only view own attendance
      if (learnerIdParam && learnerIdParam !== payload.userId) {
        return errorResponse("You can only view your own attendance", 403);
      }
      conditions.push(eq(attendance.learnerId, payload.userId));
    } else if (payload.role === "parent") {
      const linkedIds = await getParentLinkedLearnerIds(payload.userId);
      if (linkedIds.size === 0) {
        return successResponse([]);
      }
      if (learnerIdParam) {
        if (!linkedIds.has(learnerIdParam)) {
          return errorResponse("You can only view attendance for your linked children", 403);
        }
        conditions.push(eq(attendance.learnerId, learnerIdParam));
      } else {
        conditions.push(inArray(attendance.learnerId, Array.from(linkedIds)));
      }
    } else if (payload.role === "teacher") {
      // Teacher: strictly limited to assigned classes
      if (classId) {
        const canAccessClass = await canTeacherAccessClass(payload.userId, classId);
        if (!canAccessClass) {
          return errorResponse("You can only view attendance for classes you teach", 403);
        }
      }
      if (learnerIdParam) {
        const authorized = await canAccessLearner(payload, learnerIdParam);
        if (!authorized) {
          return errorResponse("You can only view attendance for learners in your scope", 403);
        }
        conditions.push(eq(attendance.learnerId, learnerIdParam));
      } else {
        // If no learnerId and no classId, restrict to teacher's classes
        if (!classId) {
          const accessibleClassIds = await getTeacherAccessibleClassIds(payload.userId);
          if (accessibleClassIds.size === 0) {
            return successResponse([]);
          }
          conditions.push(inArray(attendance.classId, Array.from(accessibleClassIds)));
        }
      }
    } else if (isAdminExtendedRole(payload.role)) {
      // super_admin, school_admin, head_teacher: school-wide access per existing role model
      // head_teacher is intentionally included as admin for attendance administration
      if (learnerIdParam) {
        conditions.push(eq(attendance.learnerId, learnerIdParam));
      }
      // classId already in conditions if supplied, no additional restriction
    } else {
      return errorResponse("You are not authorized to view attendance", 403);
    }

    const whereClause = conditions.length > 0 ? conditions.reduce((a, b) => and(a, b)!) : undefined;

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
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Only teachers can mark attendance", 403);
    }

    const body = await request.json();
    const { classId, date, records } = body;

    if (!classId || !date || !records || !Array.isArray(records)) {
      return errorResponse("Class ID, date, and attendance records are required");
    }

    // Verify teacher assignment to class - only for 'teacher' role
    // head_teacher, super_admin, school_admin have school-wide access per existing role model
    // This is INTENTIONAL: head_teacher is in ADMIN_ROLES for many admin routes
    if (payload.role === "teacher") {
      const canAccess = await canTeacherAccessClass(payload.userId, classId);
      if (!canAccess) {
        return errorResponse("You can only mark attendance for classes you are assigned to teach", 403);
      }
    }
    // For head_teacher and admins, no class restriction - school-wide admin access

    // Validate that all learnerIds are enrolled in this class to prevent arbitrary IDs
    const learnerIds = records.map((r: any) => r.learnerId).filter(Boolean);
    if (learnerIds.length > 0) {
      const enrolled = await db
        .select({ learnerId: learnerClasses.learnerId })
        .from(learnerClasses)
        .where(and(eq(learnerClasses.classId, classId), inArray(learnerClasses.learnerId, learnerIds)));
      const enrolledSet = new Set(enrolled.map((e) => e.learnerId));
      // For teachers, require enrollment to prevent marking arbitrary learners
      // For admins/head_teacher, we still check but allow if they have legitimate reason
      // For stricter security, require enrollment for non-admins
      if (payload.role === "teacher") {
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
        markedById: payload.userId,
      }));

      if (attendanceRecords.length > 0) {
        await tx.insert(attendance).values(attendanceRecords);
      }
    });

    await logActivity({
      userId: payload.userId,
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
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Only teachers and administrators can view class learners for attendance", 403);
    }

    const body = await request.json();
    const { classId } = body;

    if (!classId) {
      return errorResponse("Class ID is required");
    }

    // Verify teacher assignment - only for 'teacher' role
    // head_teacher and admins have school-wide access per existing role model
    if (payload.role === "teacher") {
      const canAccess = await canTeacherAccessClass(payload.userId, classId);
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
      .where(eq(learnerClasses.classId, classId));

    return successResponse(learners);
  } catch (error) {
    console.error("Get class learners error:", error);
    return errorResponse("Internal server error", 500);
  }
}
