import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignments, submissions, quizAttempts, attendance, users, classes, learnerClasses } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, sql, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    // Assignment completion stats
    const [{ totalAssignments, publishedAssignments, totalSubmissions, gradedSubmissions }] = await db
      .select({
        totalAssignments: sql<number>`count(*)`,
        publishedAssignments: sql<number>`count(*) FILTER (WHERE ${assignments.status} = 'published')`,
        totalSubmissions: sql<number>`(SELECT count(*) FROM ${submissions})`,
        gradedSubmissions: sql<number>`(SELECT count(*) FROM ${submissions} WHERE status = 'graded')`,
      })
      .from(assignments);

    // Quiz performance
    const [{ quizAttemptsCount, avgQuizScore }] = await db
      .select({
        quizAttemptsCount: sql<number>`count(*)`,
        avgQuizScore: sql<number>`COALESCE(AVG(${quizAttempts.score}), 0)`,
      })
      .from(quizAttempts);

    // Attendance stats
    const [{ totalAttendance, presentAttendance }] = await db
      .select({
        totalAttendance: sql<number>`count(*)`,
        presentAttendance: sql<number>`count(*) FILTER (WHERE ${attendance.isPresent} = true)`,
      })
      .from(attendance);

    const attendanceRate = totalAttendance > 0
      ? Math.round((Number(presentAttendance) / Number(totalAttendance)) * 100)
      : 0;

    // Learner count
    const [{ learnerCount }] = await db
      .select({ learnerCount: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.role, "learner"));

    // Class distribution
    const classDistribution = await db
      .select({
        className: classes.name,
        classLevel: classes.level,
        learnerCount: sql<number>`count(${learnerClasses.learnerId})`,
      })
      .from(classes)
      .leftJoin(learnerClasses, eq(classes.id, learnerClasses.classId))
      .groupBy(classes.id)
      .orderBy(classes.name);

    return successResponse({
      overview: {
        totalAssignments: Number(totalAssignments),
        publishedAssignments: Number(publishedAssignments),
        totalSubmissions: Number(totalSubmissions),
        gradedSubmissions: Number(gradedSubmissions),
        submissionRate: totalAssignments > 0 ? Math.round((Number(totalSubmissions) / (Number(learnerCount) * Math.max(1, Number(publishedAssignments)))) * 100) : 0,
      },
      quizzes: {
        totalAttempts: Number(quizAttemptsCount),
        averageScore: Math.round(Number(avgQuizScore)),
      },
      attendance: {
        rate: attendanceRate,
        total: Number(totalAttendance),
        present: Number(presentAttendance),
      },
      learners: {
        total: Number(learnerCount),
        classDistribution,
      },
    });
  } catch (error) {
    console.error("Reports error:", error);
    return errorResponse("Internal server error", 500);
  }
}
