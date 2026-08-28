import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignments, submissions, assignmentQuestions, assignmentAnswers, notifications, learnerPoints } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and } from "drizzle-orm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (payload.role !== "learner") {
      return errorResponse("Only learners can submit assignments", 403);
    }

    const { id: assignmentId } = await params;
    const body = await request.json();
    const { answers, content } = body; // answers = { [questionId]: answerText }

    // Get the assignment
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);

    if (!assignment) return notFoundResponse("Assignment");

    if (assignment.status !== "published") {
      return errorResponse("This assignment is not accepting submissions");
    }

    // Check deadline
    const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
    if (isLate && !assignment.allowLate) {
      return errorResponse("Late submissions are not allowed for this assignment");
    }

    // Check for existing submission
    const [existing] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(
        eq(submissions.assignmentId, assignmentId),
        eq(submissions.learnerId, payload.userId)
      ))
      .limit(1);

    if (existing) {
      return errorResponse("You have already submitted this assignment. You can only submit once.");
    }

    // Get all questions
    const questions = await db
      .select()
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, assignmentId))
      .orderBy(assignmentQuestions.orderIndex);

    const hasQuestions = questions.length > 0;

    // Create the submission record first
    const status = isLate ? "late" : hasQuestions ? "graded" : "submitted";
    const [submission] = await db
      .insert(submissions)
      .values({
        assignmentId,
        learnerId: payload.userId,
        content: content || null,
        status,
        submittedAt: new Date(),
      })
      .returning();

    if (!hasQuestions) {
      // No questions — free text submission, teacher grades manually
      return successResponse({
        submission,
        message: "Assignment submitted. Your teacher will grade it.",
      });
    }

    // AUTO-GRADING
    let totalScore = 0;
    let maxScore = 0;
    const answerResults: any[] = [];

    for (const question of questions) {
      const questionPoints = question.points || 1;
      maxScore += questionPoints;

      const learnerAnswer = answers?.[question.id] || "";
      let isCorrect = false;

      if (learnerAnswer && question.correctAnswer) {
        const normalizedLearner = String(learnerAnswer).trim().toLowerCase();
        const normalizedCorrect = String(question.correctAnswer).trim().toLowerCase();

        switch (question.questionType) {
          case "mcq":
          case "true_false":
            isCorrect = normalizedLearner === normalizedCorrect;
            break;
          case "fill_blank":
            isCorrect =
              normalizedLearner === normalizedCorrect ||
              normalizedCorrect.includes(normalizedLearner) ||
              normalizedLearner.includes(normalizedCorrect);
            break;
          case "short_answer":
            isCorrect = normalizedLearner === normalizedCorrect;
            break;
          case "matching":
            isCorrect = normalizedLearner === normalizedCorrect;
            break;
          case "essay":
            // Essays can't be auto-graded; mark as 0, teacher will review
            isCorrect = false;
            break;
          default:
            isCorrect = normalizedLearner === normalizedCorrect;
        }
      }

      const pointsAwarded = isCorrect ? questionPoints : 0;
      totalScore += pointsAwarded;

      // Save the per-question answer
      await db.insert(assignmentAnswers).values({
        submissionId: submission.id,
        questionId: question.id,
        learnerId: payload.userId,
        answer: learnerAnswer || null,
        isCorrect,
        pointsAwarded,
        pointsPossible: questionPoints,
      });

      answerResults.push({
        questionId: question.id,
        questionText: question.questionText,
        answer: learnerAnswer,
        isCorrect,
        pointsAwarded,
        pointsPossible: questionPoints,
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
      });
    }

    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

    // Update submission with grade
    const [updatedSubmission] = await db
      .update(submissions)
      .set({
        score: totalScore,
        maxScore,
        percentage,
        status: "graded",
        gradedAt: new Date(),
      })
      .where(eq(submissions.id, submission.id))
      .returning();

    // Create notification
    await db.insert(notifications).values({
      userId: payload.userId,
      type: "grade",
      title: "Assignment Graded",
      message: `You scored ${totalScore}/${maxScore} (${percentage}%) on "${assignment.title}"`,
      link: `/dashboard/learner/assignments/${assignmentId}`,
    });

    // Award learner points based on performance
    let points = 0;
    if (percentage >= 90) points = 100;
    else if (percentage >= 80) points = 80;
    else if (percentage >= 70) points = 60;
    else if (percentage >= 60) points = 40;
    else if (percentage >= 50) points = 20;

    if (points > 0) {
      await db.insert(learnerPoints).values({
        learnerId: payload.userId,
        points,
        reason: `Scored ${percentage}% on assignment "${assignment.title}"`,
      });
    }

    return successResponse({
      submission: updatedSubmission,
      results: {
        score: totalScore,
        maxScore,
        percentage,
        pointsEarned: points,
        answers: answerResults,
      },
      message: `Assignment auto-graded! You scored ${totalScore}/${maxScore} (${percentage}%).`,
    });
  } catch (error) {
    console.error("Submit assignment error:", error);
    return errorResponse("Internal server error", 500);
  }
}
