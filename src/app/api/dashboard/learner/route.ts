import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  users,
  assignments,
  submissions,
  quizAttempts,
  attendance,
  learnerClasses,
  classes,
  announcements,
  resources,
  learnerPoints,
  learnerAchievements,
  achievements,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc, and, gte, lte } from "drizzle-orm";
import { getOverridesForDashboard, applyOverrides } from "@/lib/dashboard-overrides";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const learnerId = request.nextUrl.searchParams.get("learnerId") || payload.userId;

    // Learners can only view own, parents can view their children, teachers/admins can view any
    if (payload.role === "learner" && learnerId !== payload.userId) {
      return errorResponse("Forbidden", 403);
    }

    if (payload.role === "parent") {
      // Check parent-learner link
      const { parentLearners } = await import("@/db/schema");
      const link = await db
        .select()
        .from(parentLearners)
        .where(and(eq(parentLearners.parentId, payload.userId), eq(parentLearners.learnerId, learnerId)))
        .limit(1);
      if (link.length === 0) {
        return errorResponse("Forbidden - not linked to this learner", 403);
      }
    }

    // Get learner's class
    const learnerClass = await db
      .select({
        classId: learnerClasses.classId,
        className: classes.name,
        classLevel: classes.level,
      })
      .from(learnerClasses)
      .leftJoin(classes, eq(learnerClasses.classId, classes.id))
      .where(eq(learnerClasses.learnerId, learnerId))
      .orderBy(desc(learnerClasses.createdAt))
      .limit(1);

    const classId = learnerClass[0]?.classId;

    // Assignments stats
    const allAssignments = classId
      ? await db
          .select({ id: assignments.id, dueDate: assignments.dueDate, status: assignments.status })
          .from(assignments)
          .where(and(eq(assignments.classId, classId), eq(assignments.status, "published" as any)))
      : [];

    const learnerSubmissions = await db
      .select({
        id: submissions.id,
        assignmentId: submissions.assignmentId,
        status: submissions.status,
        score: submissions.score,
        percentage: submissions.percentage,
      })
      .from(submissions)
      .where(eq(submissions.learnerId, learnerId));

    const submissionMap = new Map(learnerSubmissions.map(s => [s.assignmentId, s]));

    const pendingAssignments = allAssignments.filter(a => {
      const sub = submissionMap.get(a.id);
      return !sub || sub.status === "pending";
    });

    const completedSubmissions = learnerSubmissions.filter(s => s.status !== "pending");

    // Average score
    const gradedSubmissions = learnerSubmissions.filter(s => s.status === "graded" && s.percentage !== null);
    const avgScore =
      gradedSubmissions.length > 0
        ? Math.round(gradedSubmissions.reduce((sum, s) => sum + (s.percentage || 0), 0) / gradedSubmissions.length)
        : 0;

    // Class rank (simplified: average percentage vs classmates)
    let classRank: number | null = null;
    if (classId) {
      const classmates = await db
        .select({ learnerId: learnerClasses.learnerId })
        .from(learnerClasses)
        .where(eq(learnerClasses.classId, classId));

      const ranks = await Promise.all(
        classmates.map(async (c) => {
          const subs = await db
            .select({ percentage: submissions.percentage })
            .from(submissions)
            .where(and(eq(submissions.learnerId, c.learnerId), eq(submissions.status, "graded" as any)));
          const avg =
            subs.length > 0
              ? subs.reduce((sum, s) => sum + (s.percentage || 0), 0) / subs.length
              : 0;
          return { learnerId: c.learnerId, avg };
        })
      );

      ranks.sort((a, b) => b.avg - a.avg);
      const idx = ranks.findIndex(r => r.learnerId === learnerId);
      if (idx >= 0) classRank = idx + 1;
    }

    // Upcoming deadlines (next 7 days)
    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(now.getDate() + 7);

    const upcomingDeadlines = classId
      ? await db
          .select({
            id: assignments.id,
            title: assignments.title,
            dueDate: assignments.dueDate,
            subjectName: sql<string>`(SELECT name FROM subjects WHERE id = ${assignments.subjectId})`,
          })
          .from(assignments)
          .where(
            and(
              eq(assignments.classId, classId),
              eq(assignments.status, "published" as any),
              gte(assignments.dueDate, now),
              lte(assignments.dueDate, nextWeek)
            )
          )
          .orderBy(assignments.dueDate)
          .limit(5)
      : [];

    // Recent grades
    const recentGrades = await db
      .select({
        id: submissions.id,
        score: submissions.score,
        maxScore: submissions.maxScore,
        percentage: submissions.percentage,
        gradedAt: submissions.gradedAt,
        assignmentTitle: sql<string>`(SELECT title FROM assignments WHERE id = ${submissions.assignmentId})`,
        subjectName: sql<string>`(SELECT s.name FROM assignments a JOIN subjects s ON a.subject_id = s.id WHERE a.id = ${submissions.assignmentId})`,
      })
      .from(submissions)
      .where(and(eq(submissions.learnerId, learnerId), eq(submissions.status, "graded" as any)))
      .orderBy(desc(submissions.gradedAt))
      .limit(4);

    // Points and level
    const [pointsResult] = await db
      .select({ total: sql<number>`COALESCE(SUM(${learnerPoints.points}), 0)` })
      .from(learnerPoints)
      .where(eq(learnerPoints.learnerId, learnerId));

    const totalPoints = Number(pointsResult.total);
    const level = Math.floor(totalPoints / 100) + 1;
    const levelProgress = totalPoints % 100;

    // Badges
    const earned = await db
      .select({
        id: achievements.id,
        name: achievements.name,
        icon: achievements.icon,
      })
      .from(learnerAchievements)
      .leftJoin(achievements, eq(learnerAchievements.achievementId, achievements.id))
      .where(eq(learnerAchievements.learnerId, learnerId))
      .limit(6);

    const liveData = {
      learner_pending_assignments: { value: pendingAssignments.length, label: "Pending Assignments", icon: "📝", color: "bg-orange-100" },
      learner_completed: { value: completedSubmissions.length, label: "Completed", icon: "✅", color: "bg-green-100" },
      learner_average_score: { value: `${avgScore}%`, label: "Average Score", icon: "📊", color: "bg-blue-100", numericValue: avgScore },
      learner_class_rank: { value: classRank ? `#${classRank}` : "—", label: "Class Rank", icon: "🏆", color: "bg-yellow-100", numericValue: classRank },
      learner_total_points: { value: totalPoints, label: "Total Points", icon: "⭐", color: "bg-purple-100" },
      learner_level: { value: level, label: "Level", icon: "🎓", color: "bg-indigo-100" },
    };

    const overrides = await getOverridesForDashboard("learner", [
      { type: "learner", id: learnerId },
      ...(classId ? [{ type: "class", id: classId }] : []),
    ]);

    const mergedStats = applyOverrides(liveData, overrides);

    return successResponse({
      stats: mergedStats,
      rawStats: {
        pending: pendingAssignments.length,
        completed: completedSubmissions.length,
        averageScore: avgScore,
        classRank,
        totalPoints,
        level,
        levelProgress,
        className: learnerClass[0]?.className || null,
        classLevel: learnerClass[0]?.classLevel || null,
      },
      upcomingDeadlines: upcomingDeadlines.map(d => ({
        id: d.id,
        title: d.title,
        subject: d.subjectName,
        due: d.dueDate,
        urgency: d.dueDate && new Date(d.dueDate).getTime() - now.getTime() < 24 * 60 * 60 * 1000 ? "urgent" : "normal",
      })),
      recentGrades: recentGrades.map(g => ({
        id: g.id,
        title: g.assignmentTitle,
        subject: g.subjectName,
        score: g.score,
        maxScore: g.maxScore,
        percentage: g.percentage,
        gradedAt: g.gradedAt,
      })),
      badges: earned,
      points: {
        total: totalPoints,
        level,
        levelProgress,
        pointsToNext: 100 - levelProgress,
      },
    });
  } catch (error) {
    console.error("Learner dashboard error:", error);
    return errorResponse("Internal server error", 500);
  }
}
