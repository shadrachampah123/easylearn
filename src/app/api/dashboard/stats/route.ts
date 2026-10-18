import { NextRequest } from "next/server";
import { db } from "@/db";
import { users, classes, subjects, assignments, announcements, attendance } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  sqlUserHasRoleInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const role = ctx.school.role;

    /* Phase 2C: the administrator branch counted every row in the database. Each count is
       now restricted to the caller's school (membership for users, attribution for
       content). `subjects` now carries its own `school_id` (migrations 0016/0017) and is
       counted with a direct school predicate like every other table. */
    if (hasSchoolAdminRole(ctx)) {
      const [totalTeachers] = await db.select({ count: sql<number>`count(*)` }).from(users)
        .where(sqlUserHasRoleInSchool(ctx.schoolId, users.id, "teacher"));
      const [totalLearners] = await db.select({ count: sql<number>`count(*)` }).from(users)
        .where(sqlUserHasRoleInSchool(ctx.schoolId, users.id, "learner"));
      const [totalParents] = await db.select({ count: sql<number>`count(*)` }).from(users)
        .where(sqlUserHasRoleInSchool(ctx.schoolId, users.id, "parent"));
      const [totalClasses] = await db.select({ count: sql<number>`count(*)` }).from(classes)
        .where(eq(classes.schoolId, ctx.schoolId));
      const [totalSubjects] = await db.select({ count: sql<number>`count(*)` }).from(subjects)
        .where(eq(subjects.schoolId, ctx.schoolId));
      const [totalAssignments] = await db.select({ count: sql<number>`count(*)` }).from(assignments)
        .where(eq(assignments.schoolId, ctx.schoolId));

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
      const [myAssignments] = await db.select({ count: sql<number>`count(*)` }).from(assignments)
        .where(sql`${eq(assignments.teacherId, ctx.userId)} AND ${eq(assignments.schoolId, ctx.schoolId)}`);
      const [myAnnouncements] = await db.select({ count: sql<number>`count(*)` }).from(announcements)
        .where(sql`${eq(announcements.authorId, ctx.userId)} AND ${eq(announcements.schoolId, ctx.schoolId)}`);

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
