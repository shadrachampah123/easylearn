import { NextRequest } from "next/server";
import { db } from "@/db";
import { learnerPoints, learnerAchievements, achievements, submissions, quizAttempts, attendance, users } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc, and } from "drizzle-orm";
import { canAccessLearner } from "@/lib/authorization";
import { guardSchoolContext, isUserInSchool, type SchoolAuthContext } from "@/lib/tenant";

/**
 * A `GET` must not change state.
 *
 * This route used to award achievement rows as a side effect of a `GET`, which meant
 * that a cross-site request (an `<img>` tag, a prefetch, a crawler) could write to
 * the database, and that a `GET` could not be cached or prefetched safely. The
 * read and the write are now separate: `GET` reads, `POST` awards.
 */

/**
 * The outcome of resolving the caller and the learner being asked about: either a
 * refusal response, or the context the read and the write both work from.
 */
type LearnerStatsContext =
  | { ok: false; response: Response }
  | { ok: true; ctx: SchoolAuthContext; learnerId: string };

/**
 * Resolves the caller, the learner being asked about, and the authorization checks
 * that both the read and the write share.
 */
async function resolveLearnerStatsContext(
  request: NextRequest
): Promise<LearnerStatsContext> {
  const auth = await guardSchoolContext(request);
  if (!auth.ok) return { ok: false, response: auth.response };
  const ctx = auth.context;
  const schoolRole = ctx.school.role;

  const learnerId = request.nextUrl.searchParams.get("learnerId") || ctx.userId;

  if (!["learner", "parent", "school_admin", "head_teacher", "teacher"].includes(schoolRole)) {
    return { ok: false, response: errorResponse("You are not authorized to view learner stats", 403) };
  }

  /* ── TENANT FIRST: the learner must belong to the caller's school before any
     decision is taken. ── */
  if (!(await isUserInSchool(ctx.schoolId, learnerId))) {
    return { ok: false, response: errorResponse("Learner not found", 404) };
  }

  const authorized = await canAccessLearner({ userId: ctx.userId, role: schoolRole }, learnerId);
  if (!authorized) {
    return { ok: false, response: errorResponse("You are not authorized to view stats for this learner", 403) };
  }

  return { ok: true, ctx, learnerId };
}

export async function GET(request: NextRequest) {
  try {
    const resolved = await resolveLearnerStatsContext(request);
    if (!resolved.ok) return resolved.response;
    const { ctx, learnerId } = resolved;

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

    /* Phase 2E: each activity row is additionally attributed to the caller's school, so a
       learner who belongs to several schools never folds another school's activity into
       these statistics. Gamification tables stay platform-global by design (see below). */

    // Assignment stats
    const [submissionStats] = await db
      .select({
        total: sql<number>`count(*)`,
        graded: sql<number>`count(*) FILTER (WHERE ${submissions.status} = 'graded')`,
      })
      .from(submissions)
      .where(and(
        eq(submissions.learnerId, learnerId),
        eq(submissions.schoolId, ctx.schoolId)
      ));

    // Quiz stats
    const [quizStats] = await db
      .select({
        total: sql<number>`count(*)`,
        avgScore: sql<number>`COALESCE(AVG(${quizAttempts.score}), 0)`,
      })
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.learnerId, learnerId),
        eq(quizAttempts.schoolId, ctx.schoolId),
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
        eq(attendance.schoolId, ctx.schoolId),
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

    /* The read never writes. New achievements are awarded by the POST handler. */
    const newAchievements: string[] = [];

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

/**
 * Awards the achievements the learner has earned but does not hold yet.
 *
 * This is a `POST` because it writes. A `GET` that writes is reachable by a
 * cross-site request, by a link prefetch and by a crawler, none of which should be
 * able to change a row in the database.
 */
export async function POST(request: NextRequest) {
  try {
    const resolved = await resolveLearnerStatsContext(request);
    if (!resolved.ok) return resolved.response;
    const { ctx, learnerId } = resolved;

    const [pointsResult] = await db
      .select({ total: sql<number>`COALESCE(SUM(${learnerPoints.points}), 0)` })
      .from(learnerPoints)
      .where(eq(learnerPoints.learnerId, learnerId));
    const totalPoints = Number(pointsResult.total);

    const [submissionStats] = await db
      .select({
        total: sql<number>`count(*)`,
        graded: sql<number>`count(*) FILTER (WHERE ${submissions.status} = 'graded')`,
      })
      .from(submissions)
      .where(and(
        eq(submissions.learnerId, learnerId),
        eq(submissions.schoolId, ctx.schoolId)
      ));

    const [quizStats] = await db
      .select({
        total: sql<number>`count(*)`,
        avgScore: sql<number>`COALESCE(AVG(${quizAttempts.score}), 0)`,
      })
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.learnerId, learnerId),
        eq(quizAttempts.schoolId, ctx.schoolId),
        sql`${quizAttempts.completedAt} IS NOT NULL`
      ));

    const [attendanceStats] = await db
      .select({
        present: sql<number>`count(*) FILTER (WHERE ${attendance.isPresent} = true)`,
        total: sql<number>`count(*)`,
      })
      .from(attendance)
      .where(and(
        eq(attendance.learnerId, learnerId),
        eq(attendance.schoolId, ctx.schoolId),
        sql`${attendance.date} >= CURRENT_DATE - INTERVAL '30 days'`
      ));

    const attendanceRate = attendanceStats.total > 0
      ? Math.round((Number(attendanceStats.present) / Number(attendanceStats.total)) * 100)
      : 100;

    const earnedAchievements = await db
      .select({ id: learnerAchievements.achievementId })
      .from(learnerAchievements)
      .where(eq(learnerAchievements.learnerId, learnerId));
    const allAchievements = await db.select().from(achievements);

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

    return successResponse({ new: newAchievements });
  } catch (error) {
    console.error("Learner achievement award error:", error);
    return errorResponse("Internal server error", 500);
  }
}
