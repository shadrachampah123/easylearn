import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  quizzes,
  quizQuestions,
  quizAttempts,
  classes,
  subjects,
  users,
} from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolStaffRole,
  isClassInSchool,
  isSubjectInSchool,
  sqlQuizInSchool,
} from "@/lib/tenant";
import {
  evaluateQuizMutationAccess,
  evaluateQuizReadAccess,
  isLearnerEnrolledInClass,
  quizAudienceForRole,
} from "@/lib/quiz-access";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { ensureQuizImageColumn, schemaAwareErrorMessage } from "@/lib/schema-resilience";
import { eq, asc, and, sql } from "drizzle-orm";

const QUESTION_TYPES = ["mcq", "true_false", "fill_blank", "matching", "short_answer", "essay"] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    // Without quiz_questions.image_url (drizzle/0007) the `select().from(quizQuestions)`
    // below throws 42703 and the quiz page renders "Quiz not found".
    await ensureQuizImageColumn();

    const { id } = await params;

    const [quiz] = await db
      .select({
        id: quizzes.id,
        title: quizzes.title,
        description: quizzes.description,
        timeLimitMinutes: quizzes.timeLimitMinutes,
        shuffleQuestions: quizzes.shuffleQuestions,
        shuffleAnswers: quizzes.shuffleAnswers,
        showResults: quizzes.showResults,
        isPublished: quizzes.isPublished,
        maxAttempts: quizzes.maxAttempts,
        createdAt: quizzes.createdAt,
        classId: quizzes.classId,
        subjectId: quizzes.subjectId,
        teacherId: quizzes.teacherId,
        className: classes.name,
        subjectName: subjects.name,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
      })
      .from(quizzes)
      .leftJoin(classes, eq(quizzes.classId, classes.id))
      .leftJoin(subjects, eq(quizzes.subjectId, subjects.id))
      .leftJoin(users, eq(quizzes.teacherId, users.id))
      .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
      .limit(1);

    if (!quiz) {
      return notFoundResponse("Quiz");
    }

    /* ── Who may open this quiz, and what may they see? ────────────────────────
       The rules live in `@/lib/quiz-access` so that the list route, this route and
       the attempt routes cannot drift apart again. In short:
         - a learner needs a PUBLISHED quiz and an enrollment in its class;
         - a parent needs a PUBLISHED quiz and never sees the answer key;
         - a teacher may open their own quizzes (drafts included);
         - the other staff roles may open every quiz of their school.
       The enrollment is read with the caller's school, so an enrollment that belongs
       to another school never satisfies it. */
    const audience = quizAudienceForRole(ctx.school.role);
    const isEnrolled =
      audience === "learner"
        ? await isLearnerEnrolledInClass(ctx.schoolId, ctx.userId, quiz.classId)
        : false;

    const access = evaluateQuizReadAccess({
      role: ctx.school.role,
      isOwner: quiz.teacherId === ctx.userId,
      isPublished: quiz.isPublished === true,
      isEnrolled,
    });

    if (!access.allowed) {
      return errorResponse(access.reason, access.status);
    }

    const isStaff = hasSchoolStaffRole(ctx);

    // Get questions
    let questions = await db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, id))
      .orderBy(asc(quizQuestions.orderIndex));

    // Anyone who is not staff (a learner, a parent) never receives the answer key.
    if (!access.revealAnswerKeys) {
      questions = questions.map((q) => ({
        ...q,
        correctAnswer: null, // Hide correct answer from learners and parents
      }));

      // Shuffle if enabled
      if (quiz.shuffleQuestions) {
        questions = [...questions].sort(() => Math.random() - 0.5);
      }
    }

    const attempts = await db
      .select({ count: sql<number>`count(*)` })
      .from(quizAttempts)
      .where(and(
        eq(quizAttempts.quizId, id),
        isStaff
          ? sql`true`
          : and(eq(quizAttempts.learnerId, ctx.userId), sql`${quizAttempts.completedAt} IS NOT NULL`)
      ));

    return successResponse({
      ...quiz,
      questions,
      attemptsUsed: Number(attempts[0]?.count ?? 0),
      isOwner: quiz.teacherId === ctx.userId,
    });
  } catch (error) {
    console.error("Get quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be loaded. Please retry."),
      503
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    await ensureQuizImageColumn();

    const { id } = await params;

    // Check ownership
    const [existing] = await db
      .select({
        teacherId: quizzes.teacherId,
        isPublished: quizzes.isPublished,
      })
      .from(quizzes)
      .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
      .limit(1);

    if (!existing) return notFoundResponse("Quiz");

    const editAccess = evaluateQuizMutationAccess({
      role: ctx.school.role,
      isOwner: existing.teacherId === ctx.userId,
      action: "edit",
    });
    if (!editAccess.allowed) {
      return errorResponse(editAccess.reason, editAccess.status);
    }

    const body = await request.json();
    const {
      title,
      description,
      classId,
      subjectId,
      timeLimitMinutes,
      shuffleQuestions,
      shuffleAnswers,
      showResults,
      maxAttempts,
      isPublished,
      questions,
    } = body;

    const replacesQuestions = Array.isArray(questions);
    const [{ questionCount }] = await db
      .select({ questionCount: sql<number>`count(*)` })
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, id));
    const [{ attemptCount }] = await db
      .select({ attemptCount: sql<number>`count(*)` })
      .from(quizAttempts)
      .where(eq(quizAttempts.quizId, id));

    // Attempts store their answers keyed by question id, so replacing the question set
    // would silently orphan every result recorded so far. The editor therefore keeps
    // questions read-only once a learner has started this quiz.
    if (replacesQuestions && Number(attemptCount) > 0) {
      return errorResponse(
        "Learners have already attempted this quiz, so its questions can no longer be replaced. Update the quiz details or create a new quiz instead.",
        409
      );
    }

    const questionRows = replacesQuestions
      ? questions
        .filter((q: { questionText?: string }) => typeof q?.questionText === "string" && q.questionText.trim())
        .map((q: {
          questionType: string;
          questionText: string;
          options?: unknown;
          correctAnswer?: string;
          points?: number;
          imageUrl?: string | null;
        }, idx: number) => ({
          quizId: id,
          questionType: (QUESTION_TYPES.includes(q.questionType as (typeof QUESTION_TYPES)[number])
            ? q.questionType
            : "mcq") as (typeof QUESTION_TYPES)[number],
          questionText: q.questionText.trim(),
          imageUrl: typeof q.imageUrl === "string" && q.imageUrl.trim() ? q.imageUrl.trim() : null,
          options: q.options ?? null,
          correctAnswer: q.correctAnswer || null,
          points: q.points || 1,
          orderIndex: idx,
        }))
      : null;

    const nextPublished = isPublished === undefined ? existing.isPublished : Boolean(isPublished);
    const nextQuestionCount = questionRows ? questionRows.length : Number(questionCount);
    if (nextPublished && nextQuestionCount === 0) {
      return errorResponse("Add at least one question before publishing this quiz to learners");
    }

    /* ── TENANT FIRST (Phase 2C review fix F1) ──
       Moving a quiz to another class or subject may only target records of the caller's
       selected school. Reject cross-school or empty foreign keys before mutating. */
    if (classId !== undefined) {
      if (!classId || !(await isClassInSchool(ctx.schoolId, classId))) {
        return notFoundResponse("Class");
      }
    }
    if (subjectId !== undefined) {
      if (!subjectId || !(await isSubjectInSchool(ctx.schoolId, subjectId))) {
        return notFoundResponse("Subject");
      }
    }

    // Only the fields the caller actually sent are written, so a publish toggle can no
    // longer wipe the quiz title/description by omitting them.
    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (classId !== undefined) updates.classId = classId;
    if (subjectId !== undefined) updates.subjectId = subjectId;
    if (timeLimitMinutes !== undefined) updates.timeLimitMinutes = timeLimitMinutes;
    if (shuffleQuestions !== undefined) updates.shuffleQuestions = shuffleQuestions;
    if (shuffleAnswers !== undefined) updates.shuffleAnswers = shuffleAnswers;
    if (showResults !== undefined) updates.showResults = showResults;
    if (maxAttempts !== undefined) updates.maxAttempts = maxAttempts;
    if (isPublished !== undefined) updates.isPublished = Boolean(isPublished);

    if (Object.keys(updates).length > 0 || replacesQuestions) {
      const mutated = await db.transaction(async (tx) => {
        const [scopedQuiz] = await tx
          .select({ id: quizzes.id })
          .from(quizzes)
          .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
          .limit(1);
        if (!scopedQuiz) return false;

        if (Object.keys(updates).length > 0) {
          await tx
            .update(quizzes)
            .set(updates)
            .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)));
        }

        if (replacesQuestions) {
          await tx.delete(quizQuestions).where(eq(quizQuestions.quizId, id));

          if (questionRows && questionRows.length > 0) {
            await tx.insert(quizQuestions).values(questionRows);
          }
        }

        return true;
      });

      if (!mutated) return notFoundResponse("Quiz");
    }

    const [updated] = await db
      .select()
      .from(quizzes)
      .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
      .limit(1);

    if (!updated) return notFoundResponse("Quiz");

    return successResponse(updated);
  } catch (error) {
    console.error("Update quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be updated. Please retry."),
      503
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const { id } = await params;

    const [existing] = await db
      .select({ teacherId: quizzes.teacherId })
      .from(quizzes)
      .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
      .limit(1);

    if (!existing) return notFoundResponse("Quiz");

    const deleteAccess = evaluateQuizMutationAccess({
      role: ctx.school.role,
      isOwner: existing.teacherId === ctx.userId,
      action: "delete",
    });
    if (!deleteAccess.allowed) {
      return errorResponse(deleteAccess.reason, deleteAccess.status);
    }

    // Attempts reference the quiz, so clear the whole tree atomically after confirming scope.
    const deleted = await db.transaction(async (tx) => {
      const [scopedQuiz] = await tx
        .select({ id: quizzes.id })
        .from(quizzes)
        .where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)))
        .limit(1);
      if (!scopedQuiz) return false;

      await tx.delete(quizAttempts).where(eq(quizAttempts.quizId, id));
      await tx.delete(quizQuestions).where(eq(quizQuestions.quizId, id));
      await tx.delete(quizzes).where(and(eq(quizzes.id, id), sqlQuizInSchool(ctx.schoolId, quizzes.id)));
      return true;
    });

    if (!deleted) return notFoundResponse("Quiz");

    return successResponse({ message: "Quiz deleted" });
  } catch (error) {
    console.error("Delete quiz error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The quiz could not be deleted. Please retry."),
      503
    );
  }
}
