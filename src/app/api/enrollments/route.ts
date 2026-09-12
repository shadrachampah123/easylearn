import { NextRequest } from "next/server";
import { db } from "@/db";
import { learnerClasses, users, classes } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  canAccessLearner,
  canTeacherAccessClass,
  getAllowedLearnerIdsForEnrollment,
  getTeacherAccessibleClassIds,
} from "@/lib/authorization";
import {
  getLearnerIdsInSchool,
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  isClassInSchool,
  isUserInSchool,
  sqlClassInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

/**
 * Phase 2C — enrollments are the classic cross-school pairing risk.
 *
 * Read: every row must satisfy BOTH sides of the tenant boundary as SQL predicates — the
 * learner is an active member of the caller's school AND the class resolves to that school
 * alone. Phase 1's role/relationship filters are applied on top, never instead.
 *
 * Write: the learner AND the referenced class are verified against the caller's school
 * before anything is inserted. An enrollment row on its own is never sufficient
 * authorization (the brief calls this out explicitly).
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    const classId = request.nextUrl.searchParams.get("classId");
    const learnerIdParam = request.nextUrl.searchParams.get("learnerId");

    // Tenant boundary — enforced in SQL, so a foreign row is never fetched.
    const conditions: any[] = [
      sqlUserInSchool(ctx.schoolId, learnerClasses.learnerId),
      sqlClassInSchool(ctx.schoolId, learnerClasses.classId),
    ];

    if (classId) conditions.push(eq(learnerClasses.classId, classId));
    if (learnerIdParam) conditions.push(eq(learnerClasses.learnerId, learnerIdParam));

    const phaseOneActor = { userId: ctx.userId, role: schoolRole };

    // Role-based filtering (Phase 1 rules, now driven by the DB membership role)
    if (hasSchoolAdminExtendedRole(ctx)) {
      // Admins can view all, but if learnerId supplied it's already in conditions
    } else if (schoolRole === "teacher") {
      // Teacher: must be assigned to class if classId supplied
      if (classId) {
        const canAccessClass = await canTeacherAccessClass(ctx.userId, classId);
        if (!canAccessClass) {
          return errorResponse("You can only view enrollments for classes you teach", 403);
        }
      }
      if (learnerIdParam) {
        const canAccess = await canAccessLearner(phaseOneActor, learnerIdParam);
        if (!canAccess) {
          return errorResponse("You can only view enrollments for learners in your scope", 403);
        }
      } else {
        // No learner filter: restrict to teacher's classes
        const accessibleClassIds = await getTeacherAccessibleClassIds(ctx.userId);
        if (accessibleClassIds.size === 0) {
          return successResponse([]);
        }
        if (!classId) {
          conditions.push(inArray(learnerClasses.classId, Array.from(accessibleClassIds)));
        }
      }
    } else if (schoolRole === "parent") {
      const allowed = await getAllowedLearnerIdsForEnrollment(phaseOneActor);
      if (allowed !== "all") {
        /* Phase 1 gave the parent their linked children; Phase 2C intersects that with the
           school's members so a legacy link to a learner in another school cannot leak. */
        const inSchool = await getLearnerIdsInSchool(ctx.schoolId, Array.from(allowed));
        if (inSchool.size === 0) {
          return successResponse([]);
        }
        if (learnerIdParam) {
          if (!inSchool.has(learnerIdParam)) {
            return errorResponse("You can only view enrollments for your linked children", 403);
          }
        } else {
          conditions.push(inArray(learnerClasses.learnerId, Array.from(inSchool)));
        }
      }
    } else if (schoolRole === "learner") {
      if (learnerIdParam && learnerIdParam !== ctx.userId) {
        return errorResponse("You can only view your own enrollments", 403);
      }
      conditions.push(eq(learnerClasses.learnerId, ctx.userId));
    } else {
      return errorResponse("You are not authorized to view enrollments", 403);
    }

    const whereClause = conditions.reduce((a, b) => and(a, b)!);

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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminExtendedRole(ctx)) {
      return errorResponse("Only administrators can enroll learners", 403);
    }

    const body = await request.json();
    const { learnerId, classId, academicYearId } = body;

    if (!learnerId || !classId) {
      return errorResponse("Learner and class are required");
    }

    /* ── Tenant boundary: BOTH sides must belong to the caller's school ──
       Checked before the duplicate lookup so a foreign class can never be probed for
       enrollment state. Both failures are reported as 404 so the endpoint cannot be used
       to enumerate another school's learners or classes. */

    if (!(await isUserInSchool(ctx.schoolId, learnerId))) {
      return errorResponse("Learner not found", 404);
    }

    if (!(await isClassInSchool(ctx.schoolId, classId))) {
      return errorResponse("Class not found", 404);
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
      userId: ctx.userId,
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
