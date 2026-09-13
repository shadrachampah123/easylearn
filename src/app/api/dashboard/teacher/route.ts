import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  users,
  classes,
  assignments,
  submissions,
  resources,
  attendance,
  teacherClasses,
  learnerClasses,
  announcements,
} from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc, and } from "drizzle-orm";
import { getOverridesForDashboard, applyOverrides } from "@/lib/dashboard-overrides";
import {
  guardSchoolContext,
  hasSchoolRole,
  isUserInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolRole(ctx, "teacher", "head_teacher", "school_admin")) {
      return errorResponse("Forbidden", 403);
    }

    const teacherId = ctx.school.role === "teacher"
      ? ctx.userId
      : (request.nextUrl.searchParams.get("teacherId") || ctx.userId);

    /* Phase 2C: a staff token could previously pass ANY `teacherId`. The parameter is
       honoured only for a user who is an active member of the caller's school; anything
       else (including a user of another school) is reported as missing. */
    if (teacherId !== ctx.userId && !(await isUserInSchool(ctx.schoolId, teacherId))) {
      return errorResponse("Teacher not found", 404);
    }

    /* Phase 2E: class selection and every downstream aggregate are additionally restricted
       to `ctx.schoolId`. A teacher may hold memberships in several schools, so `teacherId`
       alone can widen this dashboard across tenants — the direct `school_id` predicate
       (NOT NULL since migration 0017) keeps it within the resolved school context. */

    // My classes (including homeroom)
    const assigned = await db
      .select({
        classId: teacherClasses.classId,
        className: classes.name,
        subjectName: sql<string>`(SELECT name FROM subjects WHERE id = ${teacherClasses.subjectId})`,
      })
      .from(teacherClasses)
      .leftJoin(classes, eq(teacherClasses.classId, classes.id))
      .where(and(eq(teacherClasses.teacherId, teacherId), eq(teacherClasses.schoolId, ctx.schoolId)));

    const homeroom = await db
      .select({
        classId: classes.id,
        className: classes.name,
      })
      .from(classes)
      .where(and(eq(classes.classTeacherId, teacherId), eq(classes.schoolId, ctx.schoolId)));

    const allClassIds = new Set<string>();
    assigned.forEach(a => { if (a.classId) allClassIds.add(a.classId); });
    homeroom.forEach(h => allClassIds.add(h.classId));

    const classIdsArray = Array.from(allClassIds);

    // Counts
    const [myAssignments] = await db
      .select({ count: sql<number>`count(*)` })
      .from(assignments)
      .where(and(eq(assignments.teacherId, teacherId), eq(assignments.schoolId, ctx.schoolId)));

    const [myResources] = await db
      .select({ count: sql<number>`count(*)` })
      .from(resources)
      .where(and(eq(resources.teacherId, teacherId), eq(resources.schoolId, ctx.schoolId)));

    let totalStudents = 0;
    if (classIdsArray.length > 0) {
      const [students] = await db
        .select({ count: sql<number>`count(DISTINCT ${learnerClasses.learnerId})` })
        .from(learnerClasses)
        .where(and(
          eq(learnerClasses.schoolId, ctx.schoolId),
          sql`${learnerClasses.classId} IN (${sql.join(classIdsArray.map(id => sql`${id}`), sql`, `)})`
        ));
      totalStudents = Number(students.count);
    }

    // Pending grading
    let pendingGrading = 0;
    if (classIdsArray.length > 0) {
      const [pending] = await db
        .select({ count: sql<number>`count(*)` })
        .from(submissions)
        .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
        .where(
          and(
            eq(assignments.teacherId, teacherId),
            eq(assignments.schoolId, ctx.schoolId),
            eq(submissions.status, "submitted" as any)
          )
        );
      pendingGrading = Number(pending.count);
    }

    // Class performance
    const classPerformance = [];
    for (const classId of classIdsArray.slice(0, 5)) {
      const [perf] = await db
        .select({
          avg: sql<number>`COALESCE(AVG(${submissions.percentage}), 0)`,
          total: sql<number>`count(${submissions.id})`,
        })
        .from(assignments)
        .leftJoin(submissions, eq(submissions.assignmentId, assignments.id))
        .where(and(eq(assignments.classId, classId), eq(assignments.schoolId, ctx.schoolId)));

      const classInfo = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1);
      const topStudent = await db
        .select({
          firstName: users.firstName,
          lastName: users.lastName,
          avg: sql<number>`AVG(${submissions.percentage})`,
        })
        .from(submissions)
        .leftJoin(users, eq(submissions.learnerId, users.id))
        .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
        .where(and(eq(assignments.classId, classId), eq(assignments.schoolId, ctx.schoolId)))
        .groupBy(users.id, users.firstName, users.lastName)
        .orderBy(sql`AVG(${submissions.percentage}) DESC`)
        .limit(1);

      classPerformance.push({
        classId,
        className: classInfo[0]?.name || "Unknown",
        avg: Math.round(Number(perf.avg)),
        submissions: Number(perf.total),
        topStudent: topStudent[0] ? `${topStudent[0].firstName} ${topStudent[0].lastName}` : null,
      });
    }

    // Pending tasks
    const pendingTasks = [
      { task: "Grade submissions", count: pendingGrading, icon: "📊", href: "/dashboard/teacher/assignments" },
    ];

    // Check attendance not marked today
    if (classIdsArray.length > 0) {
      const today = new Date().toISOString().split("T")[0];
      const [todayAttendance] = await db
        .select({ count: sql<number>`count(*)` })
        .from(attendance)
        .where(
          and(
            eq(attendance.schoolId, ctx.schoolId),
            sql`${attendance.classId} IN (${sql.join(classIdsArray.map(id => sql`${id}`), sql`, `)})`,
            eq(attendance.date, today)
          )
        );
      if (Number(todayAttendance.count) === 0) {
        pendingTasks.push({ task: "Mark attendance", count: classIdsArray.length, icon: "✅", href: "/dashboard/teacher/attendance" });
      }
    }

    const liveData = {
      teacher_my_classes: { value: classIdsArray.length, label: "My Classes", icon: "🏫", color: "bg-blue-100" },
      teacher_assignments: { value: Number(myAssignments.count), label: "Assignments", icon: "📝", color: "bg-green-100" },
      teacher_resources: { value: Number(myResources.count), label: "Resources", icon: "📚", color: "bg-orange-100" },
      teacher_students: { value: totalStudents, label: "Students", icon: "🎓", color: "bg-purple-100" },
      teacher_pending_grading: { value: pendingGrading, label: "Pending Grading", icon: "📊", color: "bg-red-100" },
    };

    const overrides = await getOverridesForDashboard("teacher", [
      { type: "teacher", id: teacherId },
      ...classIdsArray.map(id => ({ type: "class", id })),
    ], { schoolId: ctx.schoolId });
    const mergedStats = applyOverrides(liveData, overrides);

    return successResponse({
      stats: mergedStats,
      rawStats: {
        myClasses: classIdsArray.length,
        assignments: Number(myAssignments.count),
        resources: Number(myResources.count),
        students: totalStudents,
        pendingGrading,
      },
      classes: assigned.concat(homeroom.map(h => ({ classId: h.classId, className: h.className, subjectName: "Homeroom" }))),
      classPerformance: classPerformance.filter(c => c.submissions > 0),
      pendingTasks: pendingTasks.filter(t => t.count > 0),
    });
  } catch (error) {
    console.error("Teacher dashboard error:", error);
    return errorResponse("Internal server error", 500);
  }
}
