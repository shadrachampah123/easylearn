import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  submissions,
  assignments,
  assignmentAnswers,
  assignmentQuestions,
  users,
} from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  sqlUserInSchool,
} from "@/lib/tenant";
import {
  assignmentAccessPredicate,
  toLearnerAnswerDto,
  toStaffAssignmentQuestionDto,
} from "@/lib/assignment-access";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

const learnerSubmissionSelection = {
  id: submissions.id,
  content: submissions.content,
  attachments: submissions.attachments,
  status: submissions.status,
  score: submissions.score,
  maxScore: submissions.maxScore,
  percentage: submissions.percentage,
  feedback: submissions.feedback,
  submittedAt: submissions.submittedAt,
  gradedAt: submissions.gradedAt,
};

const staffSubmissionSelection = {
  ...learnerSubmissionSelection,
  learnerId: submissions.learnerId,
  gradedBy: submissions.gradedBy,
  learnerFirstName: users.firstName,
  learnerLastName: users.lastName,
};

const learnerQuestionSelection = {
  id: assignmentQuestions.id,
  questionType: assignmentQuestions.questionType,
  questionText: assignmentQuestions.questionText,
  options: assignmentQuestions.options,
  points: assignmentQuestions.points,
  orderIndex: assignmentQuestions.orderIndex,
};

const staffQuestionSelection = {
  ...learnerQuestionSelection,
  correctAnswer: assignmentQuestions.correctAnswer,
  explanation: assignmentQuestions.explanation,
};

function staffAnswerDto(row: {
  questionId: string;
  questionText: string;
  questionType: string;
  options: unknown;
  answer: string | null;
  isCorrect: boolean | null;
  pointsAwarded: number | null;
  pointsPossible: number | null;
  correctAnswer: string | null;
  explanation: string | null;
}) {
  return {
    questionId: row.questionId,
    questionText: row.questionText,
    questionType: row.questionType,
    options: row.options,
    answer: row.answer,
    isCorrect: row.isCorrect,
    pointsAwarded: row.pointsAwarded,
    pointsPossible: row.pointsPossible,
    correctAnswer: row.correctAnswer,
    explanation: row.explanation,
  };
}

async function learnerAnswers(submissionId: string, assignmentId: string) {
  const rows = await db
    .select({
      questionId: assignmentAnswers.questionId,
      questionText: assignmentQuestions.questionText,
      questionType: assignmentQuestions.questionType,
      options: assignmentQuestions.options,
      answer: assignmentAnswers.answer,
      isCorrect: assignmentAnswers.isCorrect,
      pointsAwarded: assignmentAnswers.pointsAwarded,
      pointsPossible: assignmentAnswers.pointsPossible,
    })
    .from(assignmentAnswers)
    .innerJoin(
      assignmentQuestions,
      and(
        eq(assignmentAnswers.questionId, assignmentQuestions.id),
        eq(assignmentQuestions.assignmentId, assignmentId)
      )
    )
    .where(eq(assignmentAnswers.submissionId, submissionId));
  return rows.map(toLearnerAnswerDto);
}

async function staffAnswers(submissionId: string, assignmentId: string) {
  const rows = await db
    .select({
      questionId: assignmentAnswers.questionId,
      questionText: assignmentQuestions.questionText,
      questionType: assignmentQuestions.questionType,
      options: assignmentQuestions.options,
      answer: assignmentAnswers.answer,
      isCorrect: assignmentAnswers.isCorrect,
      pointsAwarded: assignmentAnswers.pointsAwarded,
      pointsPossible: assignmentAnswers.pointsPossible,
      correctAnswer: assignmentQuestions.correctAnswer,
      explanation: assignmentQuestions.explanation,
    })
    .from(assignmentAnswers)
    .innerJoin(
      assignmentQuestions,
      and(
        eq(assignmentAnswers.questionId, assignmentQuestions.id),
        eq(assignmentQuestions.assignmentId, assignmentId)
      )
    )
    .where(eq(assignmentAnswers.submissionId, submissionId));
  return rows.map(staffAnswerDto);
}

// GET: View results (role-aware)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const { id: assignmentId } = await params;
    const learnerId = request.nextUrl.searchParams.get("learnerId");

    // The role/ownership/publication/enrollment/parent-link rule is in this assignment query.
    const [assignment] = await db
      .select({
        id: assignments.id,
        title: assignments.title,
        maxScore: assignments.maxScore,
        teacherId: assignments.teacherId,
      })
      .from(assignments)
      .where(and(eq(assignments.id, assignmentId), assignmentAccessPredicate(ctx, { learnerId })))
      .limit(1);
    if (!assignment) return notFoundResponse("Assignment");

    const staffView = hasSchoolAdminExtendedRole(ctx) || ctx.school.role === "teacher";
    if (!staffView) {
      const requestedLearnerId = ctx.school.role === "parent" ? learnerId : ctx.userId;
      if (!requestedLearnerId) return notFoundResponse("Assignment");

      const [submission] = await db
        .select(learnerSubmissionSelection)
        .from(submissions)
        .where(and(
          eq(submissions.assignmentId, assignmentId),
          eq(submissions.schoolId, ctx.schoolId),
          eq(submissions.learnerId, requestedLearnerId)
        ))
        .limit(1);

      if (!submission) {
        return successResponse({
          message: ctx.school.role === "parent" ? "No submission found for your child" : "No submission found",
          hasSubmitted: false,
        });
      }

      const answers = await learnerAnswers(submission.id, assignmentId);
      return successResponse({
        hasSubmitted: true,
        submission,
        assignment: { title: assignment.title, maxScore: assignment.maxScore },
        score: submission.score,
        maxScore: submission.maxScore,
        percentage: submission.percentage,
        answers,
      });
    }

    // Teachers (their own assignments) and designated school administrators/head teachers may
    // read full answer keys for this authorized assignment.
    const questions = await db
      .select(staffQuestionSelection)
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, assignmentId))
      .orderBy(assignmentQuestions.orderIndex);

    if (learnerId) {
      const [submission] = await db
        .select(staffSubmissionSelection)
        .from(submissions)
        .leftJoin(users, and(eq(submissions.learnerId, users.id), sqlUserInSchool(ctx.schoolId, users.id)))
        .where(and(
          eq(submissions.assignmentId, assignmentId),
          eq(submissions.schoolId, ctx.schoolId),
          eq(submissions.learnerId, learnerId),
          sqlUserInSchool(ctx.schoolId, submissions.learnerId)
        ))
        .limit(1);

      if (!submission) return successResponse({ message: "No submission for this learner", hasSubmitted: false });

      const answers = await staffAnswers(submission.id, assignmentId);
      return successResponse({
        hasSubmitted: true,
        learner: {
          id: submission.learnerId,
          firstName: submission.learnerFirstName,
          lastName: submission.learnerLastName,
        },
        submission,
        score: submission.score,
        maxScore: submission.maxScore,
        percentage: submission.percentage,
        answers,
        questions: questions.map(toStaffAssignmentQuestionDto),
      });
    }

    const allSubmissions = await db
      .select({
        id: submissions.id,
        learnerId: submissions.learnerId,
        learnerFirstName: users.firstName,
        learnerLastName: users.lastName,
        score: submissions.score,
        maxScore: submissions.maxScore,
        percentage: submissions.percentage,
        status: submissions.status,
        submittedAt: submissions.submittedAt,
        gradedAt: submissions.gradedAt,
      })
      .from(submissions)
      .leftJoin(users, and(eq(submissions.learnerId, users.id), sqlUserInSchool(ctx.schoolId, users.id)))
      .where(and(
        eq(submissions.assignmentId, assignmentId),
        eq(submissions.schoolId, ctx.schoolId),
        sqlUserInSchool(ctx.schoolId, submissions.learnerId)
      ))
      .orderBy(desc(submissions.submittedAt));

    return successResponse({
      assignment: { title: assignment.title, maxScore: assignment.maxScore },
      totalSubmissions: allSubmissions.length,
      graded: allSubmissions.filter((row) => row.status === "graded").length,
      averagePercentage: allSubmissions.length > 0
        ? Math.round(allSubmissions.reduce((sum, row) => sum + (row.percentage || 0), 0) / allSubmissions.length)
        : 0,
      submissions: allSubmissions,
    });
  } catch (error) {
    console.error("Get assignment results error:", error);
    return errorResponse("Internal server error", 500);
  }
}
