import { NextRequest } from "next/server";
import { db } from "@/db";
import { assignments, submissions, assignmentQuestions, assignmentAnswers, notifications, learnerPoints } from "@/db/schema";
import {
  guardSchoolContext,
  isAssignmentInSchool,
  sqlSubmissionInSchool,
} from "@/lib/tenant";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { resolveUploadedAttachments } from "@/lib/attachment-auth";
import { ensureFileUploadSchema, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import {
  buildLearnerFeedback,
  evaluateFreeResponse,
  evaluateSubjectiveAnswer,
  getAiMaxMarks,
  isEasyAiEnabled,
  marksFromPercentage,
  partialPoints,
  type EasyAIReport,
} from "@/lib/easyai";
import { eq, and } from "drizzle-orm";

/** Learner-points reward tiers, shared by both grading paths. */
function pointsForPercentage(percentage: number): number {
  if (percentage >= 90) return 100;
  if (percentage >= 80) return 80;
  if (percentage >= 70) return 60;
  if (percentage >= 60) return 40;
  if (percentage >= 50) return 20;
  return 0;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (ctx.school.role !== "learner") {
      return errorResponse("Only learners can submit assignments", 403);
    }

    const { id: assignmentId } = await params;

    /* Phase 2C: another school's assignment does not exist for this learner. */
    if (!(await isAssignmentInSchool(ctx.schoolId, assignmentId))) {
      return notFoundResponse("Assignment");
    }
    const body = await request.json();
    const { answers, content, attachments } = body; // answers = { [questionId]: answerText }

    // allow_file_uploads lives in the schema but only 0009 adds the column.
    await ensureFileUploadSchema();

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

    /* Phase 2C: enrollment is REQUIRED. The previous "this learner has no enrollment rows at
       all, so allow" fallback was a permissive default (fail open) and has been removed. */
    const { learnerClasses } = await import("@/db/schema");
    const [enrollment] = await db
      .select({ id: learnerClasses.id })
      .from(learnerClasses)
      .where(and(eq(learnerClasses.learnerId, ctx.userId), eq(learnerClasses.classId, assignment.classId)))
      .limit(1);

    if (!enrollment) {
      return errorResponse("You are not enrolled in the class for this assignment", 403);
    }

    // Check deadline
    const isLate = assignment.dueDate && new Date() > new Date(assignment.dueDate);
    if (isLate && !assignment.allowLate) {
      return errorResponse("Late submissions are not allowed for this assignment");
    }

    /* ── File upload gate: the teacher must explicitly enable uploads ── */
    let resolvedAttachments: { fileId: string; name: string; type: string; size: number; url: string }[] = [];
    const submittedFiles = Array.isArray(attachments) ? attachments : [];
    if (submittedFiles.length > 0 && !assignment.allowFileUploads) {
      return errorResponse(
        "File uploads are not enabled for this assignment. Your teacher must allow submissions with files first.",
        403
      );
    }
    if (submittedFiles.length > 0) {
      const resolved = await resolveUploadedAttachments(submittedFiles, {
        uploaderId: ctx.userId,
        purpose: "submission",
        assignmentId,
      });
      if (!resolved.ok) {
        return errorResponse(resolved.error || "The attached files could not be verified");
      }
      resolvedAttachments = resolved.attachments;
    }

    // Check for existing submission
    const [existing] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(
        eq(submissions.assignmentId, assignmentId),
        eq(submissions.learnerId, ctx.userId)
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
    const aiEnabled = isEasyAiEnabled(assignment);
    const aiMaxMarks = getAiMaxMarks(assignment);

    // Create the submission record first
    const status = isLate ? "late" : hasQuestions ? "graded" : "submitted";
    const [submission] = await db
      .insert(submissions)
      .values({
        assignmentId,
        learnerId: ctx.userId,
        content: content || null,
        attachments: resolvedAttachments.length > 0 ? resolvedAttachments : null,
        status,
        submittedAt: new Date(),
      })
      .returning();

    if (!hasQuestions && !aiEnabled) {
      // No questions, no EasyAI — free text submission, teacher grades manually
      return successResponse({
        submission,
        message: "Assignment submitted. Your teacher will grade it.",
      });
    }

    if (!hasQuestions) {
      /* ── EasyAI: instant grading of a free-text / file submission ── */
      const report = evaluateFreeResponse({
        title: assignment.title,
        description: assignment.description,
        instructions: assignment.instructions,
        content,
        attachments: resolvedAttachments,
      });
      const score = marksFromPercentage(report.percentage, aiMaxMarks);
      const percentage = Math.round((score / aiMaxMarks) * 100);
      const feedback = buildLearnerFeedback(report, { score, maxMarks: aiMaxMarks });

      const [updatedSubmission] = await db
        .update(submissions)
        .set({
          score,
          maxScore: aiMaxMarks,
          percentage,
          status: "graded",
          gradedAt: new Date(),
          gradedBy: "easyai",
          feedback,
          aiReport: report,
        })
        .where(eq(submissions.id, submission.id))
        .returning();

      await db.insert(notifications).values({
        userId: ctx.userId,
        type: "grade",
        title: "Assignment Graded by EasyAI",
        message: `EasyAI scored you ${score}/${aiMaxMarks} (${percentage}%) on "${assignment.title}"`,
        link: `/dashboard/learner/assignments/${assignmentId}`,
      });

      const points = pointsForPercentage(percentage);
      if (points > 0) {
        await db.insert(learnerPoints).values({
          learnerId: ctx.userId,
          points,
          reason: `Scored ${percentage}% on assignment "${assignment.title}" (EasyAI)`,
        });
      }

      return successResponse({
        submission: updatedSubmission,
        results: {
          gradedBy: "easyai",
          score,
          maxScore: aiMaxMarks,
          percentage,
          pointsEarned: points,
          aiReport: report,
          answers: [],
        },
        message: `Graded instantly by EasyAI! You scored ${score}/${aiMaxMarks} (${percentage}%).`,
      });
    }

    /* ── Question-based grading (exact match, with EasyAI for subjective answers) ── */
    let totalScore = 0;
    let questionMaxScore = 0;
    const answerResults: any[] = [];

    for (const question of questions) {
      const questionPoints = question.points || 1;
      questionMaxScore += questionPoints;

      const learnerAnswer = answers?.[question.id] || "";
      let isCorrect = false;
      let pointsAwarded = 0;

      const subjective = question.questionType === "essay" || question.questionType === "short_answer";

      if (aiEnabled && subjective) {
        // EasyAI evaluates subjective answers with partial credit.
        const partialCredit = evaluateSubjectiveAnswer({
          question: question.questionText,
          answer: String(learnerAnswer || ""),
          reference: question.correctAnswer,
        });
        pointsAwarded = partialPoints(partialCredit, questionPoints);
        isCorrect = partialCredit >= 0.9;

        await db.insert(assignmentAnswers).values({
          submissionId: submission.id,
          questionId: question.id,
          learnerId: ctx.userId,
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
          gradedBy: "easyai",
          partialCredit: Math.round(partialCredit * 100) / 100,
        });
        totalScore += pointsAwarded;
        continue;
      }

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
            // Without EasyAI, essays can't be auto-graded; mark as 0, teacher will review
            isCorrect = false;
            break;
          default:
            isCorrect = normalizedLearner === normalizedCorrect;
        }
      }

      pointsAwarded = isCorrect ? questionPoints : 0;
      totalScore += pointsAwarded;

      // Save the per-question answer
      await db.insert(assignmentAnswers).values({
        submissionId: submission.id,
        questionId: question.id,
        learnerId: ctx.userId,
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

    // When EasyAI is enabled the teacher's total is the authority: raw question
    // points are scaled to the total maximum marks the AI may allocate.
    let score = totalScore;
    let maxScore = questionMaxScore;
    let aiReport: EasyAIReport | null = null;
    let feedback: string | null = null;

    if (aiEnabled) {
      const fraction = questionMaxScore > 0 ? totalScore / questionMaxScore : 0;
      score = marksFromPercentage(fraction * 100, aiMaxMarks);
      maxScore = aiMaxMarks;
      aiReport = {
        engine: "easyai",
        version: 1,
        mode: "question_set",
        percentage: Math.round(fraction * 100),
        criteria: [],
        strengths: [],
        improvements: [],
        summary: `EasyAI reviewed your subjective answers and awarded ${totalScore} of ${questionMaxScore} question points, graded against your teacher's total of ${aiMaxMarks} marks.`,
        metrics: { words: 0, sentences: 0, paragraphs: 0, attachments: 0 },
      };
      feedback = buildLearnerFeedback(aiReport, { score, maxMarks: aiMaxMarks });
    }

    const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

    // Update submission with grade
    const [updatedSubmission] = await db
      .update(submissions)
      .set({
        score,
        maxScore,
        percentage,
        status: "graded",
        gradedAt: new Date(),
        ...(aiEnabled
          ? { gradedBy: "easyai" as const, feedback, aiReport }
          : {}),
      })
      .where(eq(submissions.id, submission.id))
      .returning();

    // Create notification
    await db.insert(notifications).values({
      userId: ctx.userId,
      type: "grade",
      title: aiEnabled ? "Assignment Graded by EasyAI" : "Assignment Graded",
      message: aiEnabled
        ? `EasyAI scored you ${score}/${maxScore} (${percentage}%) on "${assignment.title}"`
        : `You scored ${score}/${maxScore} (${percentage}%) on "${assignment.title}"`,
      link: `/dashboard/learner/assignments/${assignmentId}`,
    });

    // Award learner points based on performance
    const points = pointsForPercentage(percentage);
    if (points > 0) {
      await db.insert(learnerPoints).values({
        learnerId: ctx.userId,
        points,
        reason: `Scored ${percentage}% on assignment "${assignment.title}"${aiEnabled ? " (EasyAI)" : ""}`,
      });
    }

    return successResponse({
      submission: updatedSubmission,
      results: {
        gradedBy: aiEnabled ? "easyai" : "auto",
        score,
        maxScore,
        percentage,
        pointsEarned: points,
        aiReport,
        answers: answerResults,
      },
      message: aiEnabled
        ? `Graded instantly by EasyAI! You scored ${score}/${maxScore} (${percentage}%).`
        : `Assignment auto-graded! You scored ${score}/${maxScore} (${percentage}%).`,
    });
  } catch (error) {
    console.error("Submit assignment error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "Your submission could not be saved. Please try again."),
      500
    );
  }
}
