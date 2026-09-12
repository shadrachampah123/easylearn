import { NextRequest } from "next/server";
import { db } from "@/db";
import { submissions, assignments, quizAttempts, quizzes, subjects, classes, users } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, and, sql, desc } from "drizzle-orm";
import { canAccessLearner } from "@/lib/authorization";
import {
  guardSchoolContext,
  isUserInSchool,
  sqlClassInSchool,
} from "@/lib/tenant";

/**
 * Phase 2C — grades are tenant-authorized BEFORE the Phase 1 learner check.
 *
 * Order of decisions (brief §5):
 *   1. authenticate + resolve the database-backed school context (401/403)
 *   2. prove the requested learner is an ACTIVE member of the caller's school (404 when not,
 *      so grades of another school cannot be enumerated)
 *   3. prove each returned grade row belongs to the caller's school (SQL predicate)
 *   4. only then apply the Phase 1 `canAccessLearner` role/relationship rules
 *
 * A caller who passes the Phase 1 role check still fails on step 2 for a foreign learner,
 * and a caller whose learner is in the right school still fails on step 4 without the
 * required Phase 1 relationship.
 */

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    const learnerId = request.nextUrl.searchParams.get("learnerId") || ctx.userId;
    const subjectId = request.nextUrl.searchParams.get("subjectId");

    if (!["learner", "parent", "school_admin", "head_teacher", "teacher"].includes(schoolRole)) {
      return errorResponse("You are not authorized to view grades", 403);
    }

    /* ── Tenant authorization, BEFORE the Phase 1 role/permission check ── */
    if (!(await isUserInSchool(ctx.schoolId, learnerId))) {
      // Another school's learner is indistinguishable from a missing one.
      return errorResponse("Learner not found", 404);
    }

    // Phase 1 authorization for the requested learnerId - never trust client-supplied ID alone
    const authorized = await canAccessLearner({ userId: ctx.userId, role: schoolRole }, learnerId);
    if (!authorized) {
      return errorResponse("You are not authorized to view grades for this learner", 403);
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
        gradedBy: submissions.gradedBy,
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
        // Tenant predicate: the source assignment's class belongs to this school.
        sqlClassInSchool(ctx.schoolId, assignments.classId),
        subjectId ? eq(assignments.subjectId, subjectId) : undefined,
        schoolRole === "teacher" ? eq(assignments.teacherId, ctx.userId) : undefined
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
        gradedBy: sql<string>`'quiz'`,
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
        // Tenant predicate: the source quiz's class belongs to this school.
        sqlClassInSchool(ctx.schoolId, quizzes.classId),
        subjectId ? eq(quizzes.subjectId, subjectId) : undefined,
        schoolRole === "teacher" ? eq(quizzes.teacherId, ctx.userId) : undefined
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
