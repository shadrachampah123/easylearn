import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  assignments,
  classes,
  learnerClasses,
  quizAttempts,
  quizQuestions,
  quizzes,
  submissions,
  subjects,
  users,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getAccessibleLearnerIds, STAFF_REPORT_ROLES } from "@/lib/report-access";

interface LearnerSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  assignmentCount: number;
  quizAttemptCount: number;
  completedQuizCount: number;
  gradedCount: number;
  average: number;
}

async function loadLearnerReport(learnerId: string, payload: { userId: string; role: string }) {
  const isTeacher = payload.role === "teacher";
  const [learner] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(users)
    .where(and(eq(users.id, learnerId), eq(users.role, "learner")))
    .limit(1);

  if (!learner) return null;

  const learnerClassRows = await db
    .select({ classId: learnerClasses.classId, className: classes.name })
    .from(learnerClasses)
    .leftJoin(classes, eq(learnerClasses.classId, classes.id))
    .where(eq(learnerClasses.learnerId, learnerId));
  const assignmentActivity = await db
    .select({
      id: submissions.id,
      assignmentId: submissions.assignmentId,
      title: assignments.title,
      status: submissions.status,
      score: submissions.score,
      maxScore: sql<number>`COALESCE(${submissions.maxScore}, ${assignments.maxScore}, 0)`,
      percentage: submissions.percentage,
      submittedAt: submissions.submittedAt,
      gradedAt: submissions.gradedAt,
      dueDate: assignments.dueDate,
      assignmentStatus: assignments.status,
      className: classes.name,
      subjectName: subjects.name,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
    .leftJoin(classes, eq(assignments.classId, classes.id))
    .leftJoin(subjects, eq(assignments.subjectId, subjects.id))
    .where(and(
      eq(submissions.learnerId, learnerId),
      isTeacher ? eq(assignments.teacherId, payload.userId) : undefined
    ))
    .orderBy(desc(submissions.submittedAt));

  const quizActivity = await db
    .select({
      id: quizAttempts.id,
      quizId: quizAttempts.quizId,
      title: quizzes.title,
      score: quizAttempts.score,
      maxScore: sql<number>`COALESCE((SELECT SUM(${quizQuestions.points}) FROM ${quizQuestions} WHERE ${quizQuestions.quizId} = ${quizAttempts.quizId}), 0)`,
      percentage: sql<number>`CASE WHEN (SELECT SUM(${quizQuestions.points}) FROM ${quizQuestions} WHERE ${quizQuestions.quizId} = ${quizAttempts.quizId}) > 0 THEN ROUND(COALESCE(${quizAttempts.score}, 0)::numeric * 100 / (SELECT SUM(${quizQuestions.points}) FROM ${quizQuestions} WHERE ${quizQuestions.quizId} = ${quizAttempts.quizId})) ELSE 0 END`,
      startedAt: quizAttempts.startedAt,
      completedAt: quizAttempts.completedAt,
      className: classes.name,
      subjectName: subjects.name,
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .leftJoin(classes, eq(quizzes.classId, classes.id))
    .leftJoin(subjects, eq(quizzes.subjectId, subjects.id))
    .where(and(
      eq(quizAttempts.learnerId, learnerId),
      isTeacher ? eq(quizzes.teacherId, payload.userId) : undefined
    ))
    .orderBy(desc(quizAttempts.startedAt));

  const grades = [
    ...assignmentActivity
      .filter((activity) => activity.status === "graded" && activity.score !== null)
      .map((activity) => ({
        id: activity.id,
        type: "assignment" as const,
        title: activity.title,
        score: activity.score,
        maxScore: activity.maxScore,
        percentage: activity.percentage,
        gradedAt: activity.gradedAt,
        subjectName: activity.subjectName,
        className: activity.className,
      })),
    ...quizActivity
      .filter((activity) => activity.completedAt !== null)
      .map((activity) => ({
        id: activity.id,
        type: "quiz" as const,
        title: activity.title,
        score: activity.score,
        maxScore: Number(activity.maxScore) || 0,
        percentage: Number(activity.percentage) || 0,
        gradedAt: activity.completedAt,
        subjectName: activity.subjectName,
        className: activity.className,
      })),
  ].sort((a, b) => {
    const dateA = a.gradedAt ? new Date(a.gradedAt).getTime() : 0;
    const dateB = b.gradedAt ? new Date(b.gradedAt).getTime() : 0;
    return dateB - dateA;
  });

  const totalScore = grades.reduce((sum, grade) => sum + (grade.score || 0), 0);
  const totalMax = grades.reduce((sum, grade) => sum + (Number(grade.maxScore) || 0), 0);
  const assignmentGrades = grades.filter((grade) => grade.type === "assignment");
  const quizGrades = grades.filter((grade) => grade.type === "quiz");

  return {
    learner: {
      ...learner,
      classes: learnerClassRows.map((row) => row.className).filter(Boolean),
    },
    summary: {
      assignmentsSubmitted: assignmentActivity.length,
      assignmentsGraded: assignmentGrades.length,
      quizAttempts: quizActivity.length,
      completedQuizzes: quizGrades.length,
      totalGrades: grades.length,
      overallAverage: totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0,
      totalScore,
      totalMax,
    },
    assignments: assignmentActivity,
    quizzes: quizActivity,
    grades,
  };
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();
    if (!STAFF_REPORT_ROLES.includes(payload.role as (typeof STAFF_REPORT_ROLES)[number])) return errorResponse("Forbidden", 403);

    const learnerId = request.nextUrl.searchParams.get("learnerId");
    const isTeacher = payload.role === "teacher";
    const allowedLearnerIds = await getAccessibleLearnerIds(payload);

    if (learnerId) {
      if (!allowedLearnerIds.has(learnerId)) {
        return errorResponse("You can only view learners in your scope", 403);
      }
      const report = await loadLearnerReport(learnerId, payload);
      if (!report) return errorResponse("Learner not found", 404);
      return successResponse({ learners: [], report });
    }

    const ids = [...allowedLearnerIds];
    if (ids.length === 0) return successResponse({ learners: [], report: null });

    const learnerRows = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(inArray(users.id, ids))
      .orderBy(asc(users.lastName), asc(users.firstName));

    const summaries: LearnerSummary[] = await Promise.all(
      learnerRows.map(async (learner) => {
        const [{ assignmentCount }] = await db
          .select({ assignmentCount: sql<number>`count(*)` })
          .from(submissions)
          .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
          .where(and(
            eq(submissions.learnerId, learner.id),
            isTeacher ? eq(assignments.teacherId, payload.userId) : undefined
          ));
        const [{ quizAttemptCount }] = await db
          .select({ quizAttemptCount: sql<number>`count(*)` })
          .from(quizAttempts)
          .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
          .where(and(
            eq(quizAttempts.learnerId, learner.id),
            isTeacher ? eq(quizzes.teacherId, payload.userId) : undefined
          ));
        const [{ completedQuizCount }] = await db
          .select({ completedQuizCount: sql<number>`count(*)` })
          .from(quizAttempts)
          .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
          .where(and(
            eq(quizAttempts.learnerId, learner.id),
            sql`${quizAttempts.completedAt} IS NOT NULL`,
            isTeacher ? eq(quizzes.teacherId, payload.userId) : undefined
          ));
        const [{ gradedCount }] = await db
          .select({ gradedCount: sql<number>`count(*)` })
          .from(submissions)
          .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
          .where(and(
            eq(submissions.learnerId, learner.id),
            eq(submissions.status, "graded"),
            isTeacher ? eq(assignments.teacherId, payload.userId) : undefined
          ));
        const [{ assignmentPoints, assignmentMax }] = await db
          .select({
            assignmentPoints: sql<number>`COALESCE(SUM(${submissions.score}), 0)`,
            assignmentMax: sql<number>`COALESCE(SUM(${submissions.maxScore}), 0)`,
          })
          .from(submissions)
          .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
          .where(and(
            eq(submissions.learnerId, learner.id),
            eq(submissions.status, "graded"),
            isTeacher ? eq(assignments.teacherId, payload.userId) : undefined
          ));
        const [{ quizPoints, quizMax }] = await db
          .select({
            quizPoints: sql<number>`COALESCE(SUM(${quizAttempts.score}), 0)`,
            quizMax: sql<number>`COALESCE(SUM((SELECT SUM(${quizQuestions.points}) FROM ${quizQuestions} WHERE ${quizQuestions.quizId} = ${quizAttempts.quizId})), 0)`,
          })
          .from(quizAttempts)
          .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
          .where(and(
            eq(quizAttempts.learnerId, learner.id),
            sql`${quizAttempts.completedAt} IS NOT NULL`,
            isTeacher ? eq(quizzes.teacherId, payload.userId) : undefined
          ));

        const total = Number(assignmentPoints) + Number(quizPoints);
        const max = Number(assignmentMax) + Number(quizMax);
        return {
          ...learner,
          assignmentCount: Number(assignmentCount),
          quizAttemptCount: Number(quizAttemptCount),
          completedQuizCount: Number(completedQuizCount),
          gradedCount: Number(gradedCount),
          average: max > 0 ? Math.round((total / max) * 100) : 0,
        };
      })
    );

    return successResponse({ learners: summaries, report: null });
  } catch (error) {
    console.error("Learner reports error:", error);
    return errorResponse("The learner reports could not be loaded. Please retry.", 503);
  }
}
