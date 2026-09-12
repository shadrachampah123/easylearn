import { NextRequest } from "next/server";
import { db } from "@/db";
import { learnerPoints, learnerAchievements, achievements, submissions, quizAttempts, attendance, users } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc, and } from "drizzle-orm";
import { canAccessLearner } from "@/lib/authorization";
import { guardSchoolContext, isUserInSchool } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;
    const schoolRole = ctx.school.role;

    const learnerId = request.nextUrl.searchParams.get("learnerId") || ctx.userId;

    if (!["learner", "parent", "school_admin", "head_teacher", "teacher"].includes(schoolRole)) {
      return errorResponse("You are not authorized to view learner stats", 403);
    }

    /* ── TENANT FIRST: this route both reads statistics and WRITES achievement rows, so the
       learner must belong to the caller's school before any Phase 1 decision is taken. ── */
    if (!(await isUserInSchool(ctx.schoolId, learnerId))) {
      return errorResponse("Learner not found", 404);
    }

    const authorized = await canAccessLearner({ userId: ctx.userId, role: schoolRole }, learnerId);
    if (!authorized) {
      return errorResponse("You are not authorized to view stats for this learner", 403);
    }

    // Get total points
    const [pointsResult] = await db
      .select({ total: sql<number>`COALESCE(SUM(${learnerPoints.points}), 0)` })
      .from(learnerPoints)
      .where(eq(learnerPoints.learnerId, learnerId));

    const totalPoints = Number(pointsResult.total);

    // Calculate level (100 points per level)
    const level = Math.floor(totalPoints / 100) + 1;
    const pointsToNextLevel = 100 - (totalPoints % 100);

    // Get earned achievements
    const earnedAchievements = await db
      .select({
        id: achievements.id,
        name: achievements.name,
        description: achievements.description,
        icon: achievements.icon,
        earnedAt: learnerAchievements.earnedAt,
      })
      .from(learnerAchievements)
      .leftJoin(achievements, eq(learnerAchievements.achievementId, achievements.id))
      .where(eq(learnerAchievements.learnerId, learnerId))
      .orderBy(desc(learnerAchievements.earnedAt));

    // Get all achievements (to show locked ones)
    const allAchievements = await db.select().from(achievements);

    // Assignment stats
    const [submissionStats] = await db
      .select({
        total: sql<number>`count(*)`,
        graded: sql<number>`count(*) FILTER (WHERE ${submissions.status} = 'graded')`,
      })
      .from(submissions)
      .where(eq(submissions.learnerId, learnerId));

    // Quiz stats
    const [quizStats] = await db
      .select({
        total: sql<number>`count(*)`,
        avgScore: sql<number>`COALESCE(AVG(${quizAttempts.score}), 0)`,
      })
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.learnerId, learnerId),
        sql`${quizAttempts.completedAt} IS NOT NULL`
      ));

    // Attendance stats (last 30 days)
    const [attendanceStats] = await db
      .select({
        present: sql<number>`count(*) FILTER (WHERE ${attendance.isPresent} = true)`,
        total: sql<number>`count(*)`,
      })
      .from(attendance)
      .where(and(
        eq(attendance.learnerId, learnerId),
        sql`${attendance.date} >= CURRENT_DATE - INTERVAL '30 days'`
      ));

    const attendanceRate = attendanceStats.total > 0
      ? Math.round((Number(attendanceStats.present) / Number(attendanceStats.total)) * 100)
      : 100;

    // Recent points history
    const recentPoints = await db
      .select()
      .from(learnerPoints)
      .where(eq(learnerPoints.learnerId, learnerId))
      .orderBy(desc(learnerPoints.createdAt))
      .limit(10);

    // Check and award new achievements
    const earnedIds = new Set(earnedAchievements.map((a) => a.id));
    const newAchievements: string[] = [];

    for (const achievement of allAchievements) {
      if (earnedIds.has(achievement.id)) continue;

      const shouldAward =
        (achievement.name === "First Login") ||
        (achievement.name === "Assignment Ace" && Number(submissionStats.graded) >= 10) ||
        (achievement.name === "Quiz Master" && Number(quizStats.total) >= 5) ||
        (achievement.name === "Bookworm" && totalPoints >= 200) ||
        (achievement.name === "Perfect Attendance" && attendanceRate === 100 && Number(attendanceStats.total) >= 20);

      if (shouldAward) {
        await db.insert(learnerAchievements).values({
          learnerId,
          achievementId: achievement.id,
        });
        newAchievements.push(achievement.name!);
      }
    }

    return successResponse({
      points: {
        total: totalPoints,
        level,
        pointsToNextLevel,
        levelProgress: (totalPoints % 100),
      },
      achievements: {
        earned: earnedAchievements,
        all: allAchievements,
        new: newAchievements,
      },
      stats: {
        assignments: {
          completed: Number(submissionStats.graded),
          total: Number(submissionStats.total),
        },
        quizzes: {
          completed: Number(quizStats.total),
          averageScore: Math.round(Number(quizStats.avgScore)),
        },
        attendance: {
          rate: attendanceRate,
          present: Number(attendanceStats.present),
          total: Number(attendanceStats.total),
        },
      },
      recentPoints,
    });
  } catch (error) {
    console.error("Learner stats error:", error);
    return errorResponse("Internal server error", 500);
  }
}
