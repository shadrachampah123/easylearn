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
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc, and } from "drizzle-orm";
import { getOverridesForDashboard, applyOverrides } from "@/lib/dashboard-overrides";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["teacher", "head_teacher", "school_admin", "super_admin"].includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    const teacherId = payload.role === "teacher" ? payload.userId : (request.nextUrl.searchParams.get("teacherId") || payload.userId);

    // My classes (including homeroom)
    const assigned = await db
      .select({
        classId: teacherClasses.classId,
        className: classes.name,
        subjectName: sql<string>`(SELECT name FROM subjects WHERE id = ${teacherClasses.subjectId})`,
      })
      .from(teacherClasses)
      .leftJoin(classes, eq(teacherClasses.classId, classes.id))
      .where(eq(teacherClasses.teacherId, teacherId));

    const homeroom = await db
      .select({
        classId: classes.id,
        className: classes.name,
      })
      .from(classes)
      .where(eq(classes.classTeacherId, teacherId));

    const allClassIds = new Set<string>();
    assigned.forEach(a => { if (a.classId) allClassIds.add(a.classId); });
    homeroom.forEach(h => allClassIds.add(h.classId));

    const classIdsArray = Array.from(allClassIds);

    // Counts
    const [myAssignments] = await db
      .select({ count: sql<number>`count(*)` })
      .from(assignments)
      .where(eq(assignments.teacherId, teacherId));

    const [myResources] = await db
      .select({ count: sql<number>`count(*)` })
      .from(resources)
      .where(eq(resources.teacherId, teacherId));

    let totalStudents = 0;
    if (classIdsArray.length > 0) {
      const [students] = await db
        .select({ count: sql<number>`count(DISTINCT ${learnerClasses.learnerId})` })
        .from(learnerClasses)
        .where(sql`${learnerClasses.classId} IN (${sql.join(classIdsArray.map(id => sql`${id}`), sql`, `)})`);
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
        .where(eq(assignments.classId, classId));

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
        .where(eq(assignments.classId, classId))
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
    ]);
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
