import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  assignments,
  attendance,
  classes,
  learnerClasses,
  quizAttempts,
  quizzes,
  submissions,
  teacherClasses,
  users,
} from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { getAccessibleLearnerIds, STAFF_REPORT_ROLES } from "@/lib/report-access";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  guardSchoolContext,
  sqlAssignmentInSchool,
  sqlClassInSchool,
  sqlQuizInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    // Phase 1 staff rule, now read from the DB membership role.
    const payload = { userId: ctx.userId, role: ctx.school.role };

    if (!STAFF_REPORT_ROLES.includes(payload.role as (typeof STAFF_REPORT_ROLES)[number])) {
      return errorResponse("Forbidden", 403);
    }

    const isTeacher = payload.role === "teacher";
    const accessibleLearnerIds = await getAccessibleLearnerIds(payload, { schoolId: ctx.schoolId });

    // Teachers see metrics only for activities they manage. Administrators retain the
    // school-wide aggregate view.
    const [assignmentTotals] = await db
      .select({
        totalAssignments: sql<number>`count(*)`,
        publishedAssignments: sql<number>`count(*) FILTER (WHERE ${assignments.status} = 'published')`,
      })
      .from(assignments)
      .where(isTeacher
        ? eq(assignments.teacherId, payload.userId)
        : sqlAssignmentInSchool(ctx.schoolId, assignments.id));

    const [submissionTotals] = await db
      .select({
        totalSubmissions: sql<number>`count(*)`,
        gradedSubmissions: sql<number>`count(*) FILTER (WHERE ${submissions.status} = 'graded')`,
      })
      .from(submissions)
      .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
      .where(isTeacher
        ? eq(assignments.teacherId, payload.userId)
        : sqlAssignmentInSchool(ctx.schoolId, assignments.id));

    const [quizTotals] = await db
      .select({
        quizAttemptsCount: sql<number>`count(*)`,
        avgQuizScore: sql<number>`COALESCE(AVG(${quizAttempts.score}), 0)`,
      })
      .from(quizAttempts)
      .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
      .where(isTeacher
        ? eq(quizzes.teacherId, payload.userId)
        : sqlQuizInSchool(ctx.schoolId, quizzes.id));

    let teacherClassIds: string[] = [];
    if (isTeacher) {
      const [assignedClasses, homeroomClasses] = await Promise.all([
        db
          .select({ classId: teacherClasses.classId })
          .from(teacherClasses)
          .where(eq(teacherClasses.teacherId, payload.userId)),
        db
          .select({ classId: classes.id })
          .from(classes)
          .where(eq(classes.classTeacherId, payload.userId)),
      ]);
      teacherClassIds = [...new Set([
        ...assignedClasses.map((row) => row.classId),
        ...homeroomClasses.map((row) => row.classId),
      ])];
    }

    const attendanceQuery = db
      .select({
        totalAttendance: sql<number>`count(*)`,
        presentAttendance: sql<number>`count(*) FILTER (WHERE ${attendance.isPresent} = true)`,
      })
      .from(attendance)
      .$dynamic();
    /* Phase 2C: the administrator branch used to aggregate the WHOLE attendance table.
       Every row is now restricted to the caller's school (its learner is a member). */
    const attendanceStats = isTeacher
      ? teacherClassIds.length > 0
        ? await attendanceQuery.where(inArray(attendance.classId, teacherClassIds))
        : await attendanceQuery.where(sql`false`)
      : await attendanceQuery.where(sqlUserInSchool(ctx.schoolId, attendance.learnerId));
    const [{ totalAttendance, presentAttendance }] = attendanceStats;

    /* Phase 2C: the administrator branch counted every learner in the database. */
    const learnerCount = isTeacher
      ? accessibleLearnerIds.size
      : Number((await db
        .select({ learnerCount: sql<number>`count(*)` })
        .from(users)
        .where(and(
          eq(users.role, "learner"),
          sqlUserInSchool(ctx.schoolId, users.id)
        )))[0]?.learnerCount ?? 0);

    const classDistributionQuery = db
      .select({
        className: classes.name,
        classLevel: classes.level,
        learnerCount: sql<number>`count(${learnerClasses.learnerId})`,
      })
      .from(classes)
      .leftJoin(learnerClasses, eq(classes.id, learnerClasses.classId))
      .$dynamic();
    const classDistribution = isTeacher
      ? teacherClassIds.length > 0
        ? await classDistributionQuery
          .where(inArray(classes.id, teacherClassIds))
          .groupBy(classes.id)
          .orderBy(asc(classes.name))
        : []
      : await classDistributionQuery
        .where(sqlClassInSchool(ctx.schoolId, classes.id))
        .groupBy(classes.id)
        .orderBy(asc(classes.name));

    const totalAssignments = Number(assignmentTotals?.totalAssignments ?? 0);
    const publishedAssignments = Number(assignmentTotals?.publishedAssignments ?? 0);
    const totalSubmissions = Number(submissionTotals?.totalSubmissions ?? 0);
    const gradedSubmissions = Number(submissionTotals?.gradedSubmissions ?? 0);
    const quizAttemptsCount = Number(quizTotals?.quizAttemptsCount ?? 0);
    const avgQuizScore = Number(quizTotals?.avgQuizScore ?? 0);
    const attendanceTotal = Number(totalAttendance ?? 0);
    const attendancePresent = Number(presentAttendance ?? 0);

    return successResponse({
      overview: {
        totalAssignments,
        publishedAssignments,
        totalSubmissions,
        gradedSubmissions,
        submissionRate: publishedAssignments > 0 && learnerCount > 0
          ? Math.round((totalSubmissions / (learnerCount * publishedAssignments)) * 100)
          : 0,
      },
      quizzes: {
        totalAttempts: quizAttemptsCount,
        averageScore: Math.round(avgQuizScore),
      },
      attendance: {
        rate: attendanceTotal > 0 ? Math.round((attendancePresent / attendanceTotal) * 100) : 0,
        total: attendanceTotal,
        present: attendancePresent,
      },
      learners: {
        total: learnerCount,
        classDistribution,
      },
    });
  } catch (error) {
    console.error("Reports error:", error);
    return errorResponse("The reports could not be loaded. Please retry.", 503);
  }
}
