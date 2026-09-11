import { NextRequest } from "next/server";
import { db } from "@/db";
import { learnerClasses, users, classes } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  canAccessLearner,
  canTeacherAccessClass,
  getAllowedLearnerIdsForEnrollment,
  getTeacherAccessibleClassIds,
  isAdminExtendedRole,
} from "@/lib/authorization";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const classId = request.nextUrl.searchParams.get("classId");
    const learnerIdParam = request.nextUrl.searchParams.get("learnerId");

    const conditions: any[] = [];

    if (classId) conditions.push(eq(learnerClasses.classId, classId));
    if (learnerIdParam) conditions.push(eq(learnerClasses.learnerId, learnerIdParam));

    // Role-based filtering
    if (isAdminExtendedRole(payload.role)) {
      // Admins can view all, but if learnerId supplied it's already in conditions
    } else if (payload.role === "teacher" || payload.role === "head_teacher") {
      // Teacher: must be assigned to class if classId supplied
      if (classId) {
        const canAccessClass = await canTeacherAccessClass(payload.userId, classId);
        if (!canAccessClass) {
          return errorResponse("You can only view enrollments for classes you teach", 403);
        }
      }
      if (learnerIdParam) {
        const canAccess = await canAccessLearner(payload, learnerIdParam);
        if (!canAccess) {
          return errorResponse("You can only view enrollments for learners in your scope", 403);
        }
      } else {
        // No learner filter: restrict to teacher's classes
        const accessibleClassIds = await getTeacherAccessibleClassIds(payload.userId);
        if (accessibleClassIds.size === 0) {
          return successResponse([]);
        }
        if (classId) {
          // Already verified class access, no extra filter needed
        } else {
          conditions.push(inArray(learnerClasses.classId, Array.from(accessibleClassIds)));
        }
      }
    } else if (payload.role === "parent") {
      const allowed = await getAllowedLearnerIdsForEnrollment(payload);
      if (allowed === "all") {
        // shouldn't happen for parent
      } else {
        const allowedSet = allowed as Set<string>;
        if (allowedSet.size === 0) {
          return successResponse([]);
        }
        if (learnerIdParam) {
          if (!allowedSet.has(learnerIdParam)) {
            return errorResponse("You can only view enrollments for your linked children", 403);
          }
        } else {
          conditions.push(inArray(learnerClasses.learnerId, Array.from(allowedSet)));
        }
      }
    } else if (payload.role === "learner") {
      if (learnerIdParam && learnerIdParam !== payload.userId) {
        return errorResponse("You can only view your own enrollments", 403);
      }
      conditions.push(eq(learnerClasses.learnerId, payload.userId));
    } else {
      return errorResponse("You are not authorized to view enrollments", 403);
    }

    const whereClause = conditions.length > 0 ? conditions.reduce((a, b) => and(a, b)!) : undefined;

    const results = await db
      .select({
        id: learnerClasses.id,
        learnerId: learnerClasses.learnerId,
        classId: learnerClasses.classId,
        academicYearId: learnerClasses.academicYearId,
        createdAt: learnerClasses.createdAt,
        learnerFirstName: users.firstName,
        learnerLastName: users.lastName,
        learnerEmail: users.email,
        className: classes.name,
        classLevel: classes.level,
      })
      .from(learnerClasses)
      .leftJoin(users, eq(learnerClasses.learnerId, users.id))
      .leftJoin(classes, eq(learnerClasses.classId, classes.id))
      .where(whereClause)
      .orderBy(desc(learnerClasses.createdAt));

    return successResponse(results);
  } catch (error) {
    console.error("Enrollments error:", error);
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
      return errorResponse("Only administrators can enroll learners", 403);
    }

    const body = await request.json();
    const { learnerId, classId, academicYearId } = body;

    if (!learnerId || !classId) {
      return errorResponse("Learner and class are required");
    }

    // Check for duplicate
    const existing = await db
      .select({ id: learnerClasses.id })
      .from(learnerClasses)
      .where(and(
        eq(learnerClasses.learnerId, learnerId),
        eq(learnerClasses.classId, classId)
      ))
      .limit(1);

    if (existing.length > 0) {
      return errorResponse("This learner is already enrolled in this class");
    }

    const [enrollment] = await db.insert(learnerClasses).values({
      learnerId,
      classId,
      academicYearId: academicYearId || null,
    }).returning();

    await logActivity({
      userId: payload.userId,
      action: "enroll",
      entityType: "enrollment",
      entityId: enrollment.id,
      description: `Enrolled learner ${enrollment.learnerId} to class ${enrollment.classId}`,
    });

    return successResponse(enrollment, 201);
  } catch (error) {
    console.error("Enroll learner error:", error);
    return errorResponse("Internal server error", 500);
  }
}
