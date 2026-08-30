import { NextRequest } from "next/server";
import { db } from "@/db";
import { submissions, assignments, quizAttempts, quizzes, subjects, classes, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, and, sql, desc } from "drizzle-orm";
import { getAccessibleLearnerIds } from "@/lib/report-access";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const learnerId = request.nextUrl.searchParams.get("learnerId") || payload.userId;
    const subjectId = request.nextUrl.searchParams.get("subjectId");

    // Learners can only view their own grades. Teachers are scoped to the learners
    // enrolled in their classes or who have used one of their assessments; this also
    // protects the standalone grades API from cross-teacher data access.
    if (payload.role === "learner" && learnerId !== payload.userId) {
      return errorResponse("You can only view your own grades", 403);
    }
    if (payload.role === "teacher") {
      const accessibleLearners = await getAccessibleLearnerIds(payload);
      if (!accessibleLearners.has(learnerId)) {
        return errorResponse("You can only view grades for learners in your scope", 403);
      }
    }
    if (!["learner", "parent", "super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("You are not authorized to view grades", 403);
    }

    // Get assignment grades
    const assignmentGrades = await db
      .select({
        id: submissions.id,
        type: sql<string>`'assignment'`,
        title: assignments.title,
        score: submissions.score,
        maxScore: submissions.maxScore,
        percentage: submissions.percentage,
        gradedAt: submissions.gradedAt,
        feedback: submissions.feedback,
        subjectName: subjects.name,
        className: classes.name,
      })
      .from(submissions)
      .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
      .leftJoin(subjects, eq(assignments.subjectId, subjects.id))
      .leftJoin(classes, eq(assignments.classId, classes.id))
      .where(and(
        eq(submissions.learnerId, learnerId),
        eq(submissions.status, "graded"),
        subjectId ? eq(assignments.subjectId, subjectId) : undefined,
        payload.role === "teacher" ? eq(assignments.teacherId, payload.userId) : undefined
      ))
      .orderBy(desc(submissions.gradedAt));

    // Get quiz grades
    const quizGrades = await db
      .select({
        id: quizAttempts.id,
        type: sql<string>`'quiz'`,
        title: quizzes.title,
        score: quizAttempts.score,
        maxScore: sql<number>`(SELECT SUM(points) FROM quiz_questions WHERE quiz_id = ${quizAttempts.quizId})`,
        percentage: sql<number>`CASE WHEN (SELECT SUM(points) FROM quiz_questions WHERE quiz_id = ${quizAttempts.quizId}) > 0 THEN ROUND(${quizAttempts.score}::numeric * 100 / (SELECT SUM(points) FROM quiz_questions WHERE quiz_id = ${quizAttempts.quizId})) ELSE 0 END`,
        gradedAt: quizAttempts.completedAt,
        feedback: sql<string>`null`,
        subjectName: subjects.name,
        className: classes.name,
      })
      .from(quizAttempts)
      .leftJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
      .leftJoin(subjects, eq(quizzes.subjectId, subjects.id))
      .leftJoin(classes, eq(quizzes.classId, classes.id))
      .where(and(
        eq(quizAttempts.learnerId, learnerId),
        sql`${quizAttempts.completedAt} IS NOT NULL`,
        subjectId ? eq(quizzes.subjectId, subjectId) : undefined,
        payload.role === "teacher" ? eq(quizzes.teacherId, payload.userId) : undefined
      ))
      .orderBy(desc(quizAttempts.completedAt));

    // Combine and sort by date
    const allGrades = [...assignmentGrades, ...quizGrades].sort((a, b) => {
      const dateA = a.gradedAt ? new Date(a.gradedAt).getTime() : 0;
      const dateB = b.gradedAt ? new Date(b.gradedAt).getTime() : 0;
      return dateB - dateA;
    });

    // Calculate subject averages
    const subjectStats: Record<string, { total: number; max: number; count: number }> = {};
    for (const grade of allGrades) {
      const subject = grade.subjectName || "Unknown";
      if (!subjectStats[subject]) {
        subjectStats[subject] = { total: 0, max: 0, count: 0 };
      }
      subjectStats[subject].total += grade.score || 0;
      subjectStats[subject].max += Number(grade.maxScore) || 0;
      subjectStats[subject].count += 1;
    }

    const subjectAverages = Object.entries(subjectStats).map(([subject, stats]) => ({
      subject,
      average: stats.max > 0 ? Math.round((stats.total / stats.max) * 100) : 0,
      totalGrades: stats.count,
    }));

    // Overall stats
    const totalScore = allGrades.reduce((sum, g) => sum + (g.score || 0), 0);
    const totalMax = allGrades.reduce((sum, g) => sum + (Number(g.maxScore) || 0), 0);
    const overallAverage = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;

    return successResponse({
      grades: allGrades,
      subjectAverages,
      overall: {
        average: overallAverage,
        totalGrades: allGrades.length,
        totalScore,
        totalMax,
      },
    });
  } catch (error) {
    console.error("Grades error:", error);
    return errorResponse("Internal server error", 500);
  }
}
