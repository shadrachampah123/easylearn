import { NextRequest } from "next/server";
import { db } from "@/db";
import { users, classes, subjects, assignments, announcements, attendance } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  sqlAssignmentInSchool,
  sqlClassInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const role = ctx.school.role;

    /* Phase 2C: the administrator branch counted every row in the database. Each count is
       now restricted to the caller's school (membership for users, attribution for
       content). `subjects` has no user/class anchor and is a documented Phase 2D
       dependency — see docs/PHASE2C_TENANT_AUTHORIZATION.md. */
    if (hasSchoolAdminRole(ctx)) {
      const [totalTeachers] = await db.select({ count: sql<number>`count(*)` }).from(users)
        .where(sql`${eq(users.role, "teacher")} AND ${sqlUserInSchool(ctx.schoolId, users.id)}`);
      const [totalLearners] = await db.select({ count: sql<number>`count(*)` }).from(users)
        .where(sql`${eq(users.role, "learner")} AND ${sqlUserInSchool(ctx.schoolId, users.id)}`);
      const [totalParents] = await db.select({ count: sql<number>`count(*)` }).from(users)
        .where(sql`${eq(users.role, "parent")} AND ${sqlUserInSchool(ctx.schoolId, users.id)}`);
      const [totalClasses] = await db.select({ count: sql<number>`count(*)` }).from(classes)
        .where(sqlClassInSchool(ctx.schoolId, classes.id));
      const [totalSubjects] = await db.select({ count: sql<number>`count(*)` }).from(subjects);
      const [totalAssignments] = await db.select({ count: sql<number>`count(*)` }).from(assignments)
        .where(sqlAssignmentInSchool(ctx.schoolId, assignments.id));

      return successResponse({
        teachers: Number(totalTeachers.count),
        learners: Number(totalLearners.count),
        parents: Number(totalParents.count),
        classes: Number(totalClasses.count),
        subjects: Number(totalSubjects.count),
        assignments: Number(totalAssignments.count),
      });
    }

    if (role === "teacher") {
      const [myAssignments] = await db.select({ count: sql<number>`count(*)` }).from(assignments).where(eq(assignments.teacherId, ctx.userId));
      const [myAnnouncements] = await db.select({ count: sql<number>`count(*)` }).from(announcements).where(eq(announcements.authorId, ctx.userId));

      return successResponse({
        assignments: Number(myAssignments.count),
        announcements: Number(myAnnouncements.count),
        classes: 0,
        resources: 0,
      });
    }

    return successResponse({ message: "Dashboard data" });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    return errorResponse("Internal server error", 500);
  }
}
