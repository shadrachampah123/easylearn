import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  submissions, assignments, assignmentAnswers, assignmentQuestions,
  users, parentLearners,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

// GET: View results (role-aware)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const { id: assignmentId } = await params;
    const learnerId = request.nextUrl.searchParams.get("learnerId");

    // Check assignment exists
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);

    if (!assignment) return notFoundResponse("Assignment");

    // GET QUESTIONS (for context)
    const questions = await db
      .select()
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, assignmentId))
      .orderBy(assignmentQuestions.orderIndex);

    // === LEARNER: View their own results ===
    if (payload.role === "learner") {
      const [submission] = await db
        .select()
        .from(submissions)
        .where(and(
          eq(submissions.assignmentId, assignmentId),
          eq(submissions.learnerId, payload.userId)
        ))
        .limit(1);

      if (!submission) {
        return successResponse({ message: "No submission found", hasSubmitted: false });
      }

      // Get per-question answers with correct answers
      const answers = await db
        .select()
        .from(assignmentAnswers)
        .where(eq(assignmentAnswers.submissionId, submission.id));

      // Build detailed result
      const detailedAnswers = answers.map((ans) => {
        const question = questions.find((q) => q.id === ans.questionId);
        return {
          questionId: ans.questionId,
          questionText: question?.questionText || "",
          questionType: question?.questionType,
          answer: ans.answer,
          isCorrect: ans.isCorrect,
          pointsAwarded: ans.pointsAwarded,
          pointsPossible: ans.pointsPossible,
          correctAnswer: question?.correctAnswer || null,
          explanation: question?.explanation || null,
          options: question?.options || null,
        };
      });

      return successResponse({
        hasSubmitted: true,
        submission,
        assignment: { title: assignment.title, maxScore: assignment.maxScore },
        score: submission.score,
        maxScore: submission.maxScore,
        percentage: submission.percentage,
        answers: detailedAnswers,
      });
    }

    // === TEACHER/ADMIN: View all student results ===
    if (["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      // If specific learner requested, show detail
      if (learnerId) {
        const [submission] = await db
          .select()
          .from(submissions)
          .where(and(
            eq(submissions.assignmentId, assignmentId),
            eq(submissions.learnerId, learnerId)
          ))
          .limit(1);

        if (!submission) {
          return successResponse({ message: "No submission for this learner", hasSubmitted: false });
        }

        const answers = await db
          .select()
          .from(assignmentAnswers)
          .where(eq(assignmentAnswers.submissionId, submission.id));

        const [learner] = await db
          .select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, learnerId))
          .limit(1);

        const detailedAnswers = answers.map((ans) => {
          const question = questions.find((q) => q.id === ans.questionId);
          return {
            questionId: ans.questionId,
            questionText: question?.questionText || "",
            questionType: question?.questionType,
            answer: ans.answer,
            isCorrect: ans.isCorrect,
            pointsAwarded: ans.pointsAwarded,
            pointsPossible: ans.pointsPossible,
            correctAnswer: question?.correctAnswer || null,
            explanation: question?.explanation || null,
          };
        });

        return successResponse({
          hasSubmitted: true,
          learner: learner || {},
          submission,
          score: submission.score,
          maxScore: submission.maxScore,
          percentage: submission.percentage,
          answers: detailedAnswers,
          questions,
        });
      }

      // Summary view: all submissions
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
        .leftJoin(users, eq(submissions.learnerId, users.id))
        .where(eq(submissions.assignmentId, assignmentId))
        .orderBy(desc(submissions.submittedAt));

      return successResponse({
        assignment: { title: assignment.title, maxScore: assignment.maxScore },
        totalSubmissions: allSubmissions.length,
        graded: allSubmissions.filter((s) => s.status === "graded").length,
        averagePercentage: allSubmissions.length > 0
          ? Math.round(allSubmissions.reduce((sum, s) => sum + (s.percentage || 0), 0) / allSubmissions.length)
          : 0,
        submissions: allSubmissions,
      });
    }

    // === PARENT: View their child's results ===
    if (payload.role === "parent") {
      if (!learnerId) {
        return errorResponse("Learner ID is required for parent view");
      }

      // Verify parent-child relationship
      const [relationship] = await db
        .select()
        .from(parentLearners)
        .where(and(
          eq(parentLearners.parentId, payload.userId),
          eq(parentLearners.learnerId, learnerId)
        ))
        .limit(1);

      if (!relationship) {
        return errorResponse("This learner is not linked to your account", 403);
      }

      const [submission] = await db
        .select()
        .from(submissions)
        .where(and(
          eq(submissions.assignmentId, assignmentId),
          eq(submissions.learnerId, learnerId)
        ))
        .limit(1);

      if (!submission) {
        return successResponse({ hasSubmitted: false, message: "No submission found for your child" });
      }

      const answers = await db
        .select()
        .from(assignmentAnswers)
        .where(eq(assignmentAnswers.submissionId, submission.id));

      const [learner] = await db
        .select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, learnerId))
        .limit(1);

      const detailedAnswers = answers.map((ans) => {
        const question = questions.find((q) => q.id === ans.questionId);
        return {
          questionId: ans.questionId,
          questionText: question?.questionText || "",
          answer: ans.answer,
          isCorrect: ans.isCorrect,
          pointsAwarded: ans.pointsAwarded,
          pointsPossible: ans.pointsPossible,
          correctAnswer: question?.correctAnswer || null,
        };
      });

      return successResponse({
        hasSubmitted: true,
        learner: learner || {},
        submission,
        score: submission.score,
        maxScore: submission.maxScore,
        percentage: submission.percentage,
        answers: detailedAnswers,
      });
    }

    return errorResponse("Access denied", 403);
  } catch (error) {
    console.error("Get assignment results error:", error);
    return errorResponse("Internal server error", 500);
  }
}
