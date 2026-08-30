import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  assignments,
  classes,
  subjects,
  users,
  submissions,
  assignmentQuestions,
  assignmentAnswers,
  assignmentCorrections,
  learnerClasses,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const { id } = await params;

    const [assignment] = await db
      .select({
        id: assignments.id,
        title: assignments.title,
        description: assignments.description,
        instructions: assignments.instructions,
        status: assignments.status,
        dueDate: assignments.dueDate,
        maxScore: assignments.maxScore,
        allowLate: assignments.allowLate,
        attachments: assignments.attachments,
        createdAt: assignments.createdAt,
        classId: assignments.classId,
        subjectId: assignments.subjectId,
        teacherId: assignments.teacherId,
        className: classes.name,
        classLevel: classes.level,
        subjectName: subjects.name,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
      })
      .from(assignments)
      .leftJoin(classes, eq(assignments.classId, classes.id))
      .leftJoin(subjects, eq(assignments.subjectId, subjects.id))
      .leftJoin(users, eq(assignments.teacherId, users.id))
      .where(eq(assignments.id, id))
      .limit(1);

    if (!assignment) {
      return notFoundResponse("Assignment");
    }

    // Teachers may only inspect and grade assignments they manage. Administrators may
    // inspect any assignment in the school.
    if (payload.role === "teacher" && assignment.teacherId !== payload.userId) {
      return errorResponse("You can only view your own assignments", 403);
    }

    // Get submissions count for teachers
    if (["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      const submissionsList = await db
        .select({
          id: submissions.id,
          status: submissions.status,
          score: submissions.score,
          maxScore: submissions.maxScore,
          percentage: submissions.percentage,
          feedback: submissions.feedback,
          // The teacher needs to read what the learner actually wrote before grading it.
          content: submissions.content,
          submittedAt: submissions.submittedAt,
          gradedAt: submissions.gradedAt,
          learnerFirstName: users.firstName,
          learnerLastName: users.lastName,
          learnerId: submissions.learnerId,
        })
        .from(submissions)
        .leftJoin(users, eq(submissions.learnerId, users.id))
        .where(eq(submissions.assignmentId, id))
        .orderBy(desc(submissions.submittedAt));

      // Get questions with correct answers for teacher view
      const questions = await db
        .select()
        .from(assignmentQuestions)
        .where(eq(assignmentQuestions.assignmentId, id))
        .orderBy(assignmentQuestions.orderIndex);

      // Learners enrolled in the class who have not handed anything in yet.
      const enrolledLearners = await db
        .select({
          learnerId: learnerClasses.learnerId,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(learnerClasses)
        .leftJoin(users, eq(learnerClasses.learnerId, users.id))
        .where(eq(learnerClasses.classId, assignment.classId));

      const submittedIds = new Set(submissionsList.map((s) => s.learnerId));
      const missing = enrolledLearners.filter((row) => !submittedIds.has(row.learnerId));

      return successResponse({
        ...assignment,
        submissions: submissionsList,
        questions,
        pendingLearners: missing,
        awaitingGrading: submissionsList.filter((s) => s.status === "submitted" || s.status === "late").length,
      });
    }

    // For learners, get their own submission
    if (payload.role === "learner") {
      const [submission] = await db
        .select()
        .from(submissions)
        .where(and(
          eq(submissions.assignmentId, id),
          eq(submissions.learnerId, payload.userId)
        ))
        .limit(1);

      // Get questions (hide correct answers unless graded)
      const questions = await db
        .select()
        .from(assignmentQuestions)
        .where(eq(assignmentQuestions.assignmentId, id));

      const showAnswers = submission && (submission.status === "graded" || submission.status === "submitted");

      // Get answers for this submission
      let answers: any[] = [];
      if (submission) {
        answers = await db
          .select()
          .from(assignmentAnswers)
          .where(eq(assignmentAnswers.submissionId, submission.id));
      }

      // Get corrections
      const corrections = await db
        .select({
          id: assignmentCorrections.id,
          questionId: assignmentCorrections.questionId,
          correctionText: assignmentCorrections.correctionText,
          postedAt: assignmentCorrections.postedAt,
          teacherName: users.firstName,
          teacherLastName: users.lastName,
        })
        .from(assignmentCorrections)
        .leftJoin(users, eq(assignmentCorrections.postedBy, users.id))
        .where(eq(assignmentCorrections.assignmentId, id))
        .orderBy(desc(assignmentCorrections.postedAt));

      const sanitizedQuestions = showAnswers
        ? questions
        : questions.map((q) => ({ ...q, correctAnswer: null, explanation: null }));

      return successResponse({
        ...assignment,
        mySubmission: submission || null,
        questions: sanitizedQuestions,
        myAnswers: answers,
        corrections,
      });
    }

    return successResponse(assignment);
  } catch (error) {
    console.error("Get assignment error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const { id } = await params;

    // Check ownership
    const [existing] = await db
      .select({ teacherId: assignments.teacherId })
      .from(assignments)
      .where(eq(assignments.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Assignment");

    if (existing.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only edit your own assignments", 403);
    }

    const body = await request.json();
    const { title, description, instructions, dueDate, maxScore, allowLate, attachments, status } = body;

    const [updated] = await db
      .update(assignments)
      .set({
        title,
        description,
        instructions,
        dueDate: dueDate ? new Date(dueDate) : null,
        maxScore,
        allowLate,
        attachments,
        status,
        updatedAt: new Date(),
      })
      .where(eq(assignments.id, id))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update assignment error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const { id } = await params;

    const [existing] = await db
      .select({ teacherId: assignments.teacherId })
      .from(assignments)
      .where(eq(assignments.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Assignment");

    if (existing.teacherId !== payload.userId && !["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("You can only delete your own assignments", 403);
    }

    await db.delete(assignments).where(eq(assignments.id, id));

    return successResponse({ message: "Assignment deleted" });
  } catch (error) {
    console.error("Delete assignment error:", error);
    return errorResponse("Internal server error", 500);
  }
}
