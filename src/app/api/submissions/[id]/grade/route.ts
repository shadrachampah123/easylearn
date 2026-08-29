import { NextRequest } from "next/server";
import { db } from "@/db";
import { submissions, assignments, notifications, learnerPoints } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq } from "drizzle-orm";
import { logActivity } from "@/lib/activity";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Only teachers can grade submissions", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { score, feedback } = body;

    if (score === undefined || score === null) {
      return errorResponse("Score is required");
    }

    const [submission] = await db
      .select({
        id: submissions.id,
        learnerId: submissions.learnerId,
        assignmentId: submissions.assignmentId,
        maxScore: assignments.maxScore,
        title: assignments.title,
        teacherId: assignments.teacherId,
      })
      .from(submissions)
      .leftJoin(assignments, eq(submissions.assignmentId, assignments.id))
      .where(eq(submissions.id, id))
      .limit(1);

    if (!submission) {
      return notFoundResponse("Submission");
    }

    if (payload.role === "teacher" && submission.teacherId !== payload.userId) {
      return errorResponse("You can only grade submissions for your own assignments", 403);
    }

    if (score < 0 || (submission.maxScore && score > submission.maxScore)) {
      return errorResponse(`Score must be between 0 and ${submission.maxScore}`);
    }

    const [updated] = await db
      .update(submissions)
      .set({
        score,
        feedback: feedback || null,
        status: "graded",
        gradedAt: new Date(),
      })
      .where(eq(submissions.id, id))
      .returning();

    await db.insert(notifications).values({
      userId: submission.learnerId!,
      type: "grade",
      title: "Assignment Graded",
      message: `Your submission for "${submission.title}" has been graded. Score: ${score}/${submission.maxScore}`,
      link: `/dashboard/learner/assignments/${submission.assignmentId}`,
    });

    const percentage = submission.maxScore ? (score / submission.maxScore) * 100 : 0;
    let points = 0;
    if (percentage >= 90) points = 50;
    else if (percentage >= 80) points = 40;
    else if (percentage >= 70) points = 30;
    else if (percentage >= 60) points = 20;
    else if (percentage >= 50) points = 10;

    if (points > 0) {
      await db.insert(learnerPoints).values({
        learnerId: submission.learnerId!,
        points,
        reason: `Scored ${score}/${submission.maxScore} on "${submission.title}"`,
      });
    }

    await logActivity({
      userId: payload.userId,
      action: "grade",
      entityType: "submission",
      entityId: id,
      description: `Graded submission for ${submission.title}: ${score}/${submission.maxScore}`,
      details: JSON.stringify({ assignmentId: submission.assignmentId, learnerId: submission.learnerId, score }),
    });

    return successResponse(updated);
  } catch (error) {
    console.error("Grade submission error:", error);
    return errorResponse("Internal server error", 500);
  }
}
