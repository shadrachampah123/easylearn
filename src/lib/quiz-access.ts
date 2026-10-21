/**
 * Who may read or sit a quiz, and what they are allowed to see.
 *
 * ── Why this module exists ────────────────────────────────────────────────────────────
 * The quiz routes each carried their own idea of "may this caller open this quiz", and
 * two of those ideas were wrong in the fail-open direction:
 *
 *   1. The enrollment rule was `enrolled.length > 0 && !enrolled.some(…)`. A learner with
 *      NO enrollment rows therefore passed the check and could read and start any
 *      published quiz in their school — while the quiz LIST already refused exactly that
 *      learner. The detail route and the attempt routes were a bypass of the list.
 *   2. The answer-key redaction and the published check were applied only to
 *      `role === "learner"`. A parent in the same school received every `correctAnswer`
 *      and could read unpublished drafts.
 *
 * The rules now live in ONE place, so the quiz detail route, the attempt routes and the
 * mid-game answer check cannot drift apart again:
 *
 *   LEARNER  the quiz must be published AND the learner must be enrolled in the quiz's
 *            class, within the caller's school. No answer key.
 *   PARENT   the quiz must be published. No answer key. A parent is not a learner: the
 *            parent's own child may be enrolled, but the parent's session is not a
 *            learner's session, and the answer key is not theirs to read.
 *   TEACHER  the teacher may open their own quizzes, published or not (a draft has to
 *            be previewable). A teacher may not open another teacher's quiz.
 *   HEAD TEACHER / SCHOOL ADMIN  every quiz of their school, published or not.
 *
 * Every check is fail-closed: an unknown role, a missing enrollment row and an
 * unpublished quiz are all refusals, never silent allowances.
 */

import { db } from "@/db";
import { learnerClasses } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { isUuid } from "@/lib/tenant";

/** The audiences a quiz can be opened by. */
export type QuizAudience = "learner" | "parent" | "staff";

/**
 * Maps a school role to the audience it belongs to.
 *
 * Returns `null` for a role that is not a school role at all; the caller must then
 * refuse the request rather than fall back to a permissive default.
 */
export function quizAudienceForRole(role: unknown): QuizAudience | null {
  switch (role) {
    case "learner":
      return "learner";
    case "parent":
      return "parent";
    case "teacher":
    case "head_teacher":
    case "school_admin":
      return "staff";
    default:
      return null;
  }
}

/** The outcome of the read policy. */
export type QuizReadAccess = {
  /** Whether the caller may open the quiz at all. */
  allowed: boolean;
  /** The status to answer with when the request is refused. */
  status: number;
  /** The message to answer with when the request is refused. */
  reason: string;
  /**
   * Whether the response may contain `correctAnswer`.
   *
   * Only the staff roles may see the key: the quiz is their own teaching material and
   * they need it to mark the work. A learner must never receive it — the client grades
   * against the server, and a key in the payload is a key in the browser. A parent must
   * never receive it either: a parent is not the person sitting the quiz.
   */
  revealAnswerKeys: boolean;
};

const REFUSED_LEARNER_DRAFT = "This quiz has not been published by your teacher yet";
const REFUSED_WRONG_CLASS = "This quiz was set for a different class";
const REFUSED_NOT_OWN_QUIZ = "You can only view your own quizzes";
const REFUSED_UNKNOWN_ROLE = "You may not view this quiz";
const REFUSED_CREATE_NOT_STAFF = "Only teachers can create quizzes";
const REFUSED_EDIT_NOT_AUTHORIZED = "You can only edit your own quizzes";
const REFUSED_DELETE_NOT_AUTHORIZED = "You can only delete your own quizzes";

export type QuizMutationAction = "create" | "edit" | "delete";

export type QuizMutationAccess = {
  allowed: boolean;
  status: number;
  reason: string;
};

/**
 * Decides whether a caller with a verified current school membership role (`ctx.school.role`)
 * may create, edit/publish, or delete a quiz in that selected school.
 *
 * Historical ownership (`quiz.teacherId === ctx.userId`) never authorizes a caller whose
 * current membership role in the selected school is no longer staff.
 */
export function evaluateQuizMutationAccess(input: {
  role: unknown;
  isOwner: boolean;
  action: QuizMutationAction;
}): QuizMutationAccess {
  if (quizAudienceForRole(input.role) !== "staff") {
    const reason =
      input.action === "create"
        ? REFUSED_CREATE_NOT_STAFF
        : input.action === "edit"
          ? REFUSED_EDIT_NOT_AUTHORIZED
          : REFUSED_DELETE_NOT_AUTHORIZED;
    return { allowed: false, status: 403, reason };
  }

  if (input.action === "create") {
    return { allowed: true, status: 200, reason: "" };
  }

  if (input.isOwner || input.role === "school_admin") {
    return { allowed: true, status: 200, reason: "" };
  }

  return {
    allowed: false,
    status: 403,
    reason: input.action === "edit" ? REFUSED_EDIT_NOT_AUTHORIZED : REFUSED_DELETE_NOT_AUTHORIZED,
  };
}

/**
 * Decides whether the caller may open the quiz, and whether the answer key may be
 * included in the response.
 *
 * The decision is pure: it takes the facts that were read from the database and returns
 * the decision, so it can be exercised directly by the test suite.
 */
export function evaluateQuizReadAccess(input: {
  /** The caller's role in the school (`ctx.school.role`). */
  role: unknown;
  /** Whether the caller is the teacher who created the quiz. */
  isOwner: boolean;
  /** Whether the quiz is published. */
  isPublished: boolean;
  /**
   * Whether the caller is enrolled in the quiz's class, within the caller's school.
   * Only meaningful for a learner; ignored for the other roles.
   */
  isEnrolled: boolean;
}): QuizReadAccess {
  const audience = quizAudienceForRole(input.role);

  if (audience === null) {
    return {
      allowed: false,
      status: 403,
      reason: REFUSED_UNKNOWN_ROLE,
      revealAnswerKeys: false,
    };
  }

  if (audience === "learner") {
    if (!input.isPublished) {
      return { allowed: false, status: 403, reason: REFUSED_LEARNER_DRAFT, revealAnswerKeys: false };
    }
    if (!input.isEnrolled) {
      return { allowed: false, status: 403, reason: REFUSED_WRONG_CLASS, revealAnswerKeys: false };
    }
    return { allowed: true, status: 200, reason: "", revealAnswerKeys: false };
  }

  if (audience === "parent") {
    if (!input.isPublished) {
      return { allowed: false, status: 403, reason: REFUSED_LEARNER_DRAFT, revealAnswerKeys: false };
    }
    return { allowed: true, status: 200, reason: "", revealAnswerKeys: false };
  }

  /* Staff. A teacher owns the quizzes they created; the other staff roles supervise the
     whole school and may open any of its quizzes. */
  if (input.role === "teacher" && !input.isOwner) {
    return { allowed: false, status: 403, reason: REFUSED_NOT_OWN_QUIZ, revealAnswerKeys: false };
  }
  return { allowed: true, status: 200, reason: "", revealAnswerKeys: true };
}

/**
 * Canonical answer normalization shared across instant question checks, final quiz
 * submissions, and auto-graded assignment questions.
 *
 * Non-scalar inputs (`null`, `undefined`, arrays, objects) and whitespace-only strings
 * normalize to `""` and never match any answer key (preventing `expected.includes("")`).
 */
export function normalizeQuizAnswer(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    return "";
  }
  return String(raw).trim().toLowerCase();
}

export function calculateQuizRewardPoints(percentage: number): number {
  if (percentage >= 90) return 100;
  if (percentage >= 80) return 80;
  if (percentage >= 70) return 60;
  if (percentage >= 60) return 40;
  if (percentage >= 50) return 20;
  return 0;
}

export function gradeQuizQuestionAnswer(input: {
  questionType: string;
  learnerAnswer: unknown;
  correctAnswer: string | null | undefined;
  points: number | null | undefined;
}): {
  isCorrect: boolean;
  pointsAwarded: number;
  questionPoints: number;
  storedAnswer: string;
} {
  const questionPoints = input.points || 1;
  const storedAnswer =
    typeof input.learnerAnswer === "string"
      ? input.learnerAnswer
      : typeof input.learnerAnswer === "number" || typeof input.learnerAnswer === "boolean"
        ? String(input.learnerAnswer)
        : "";
  const normalizedLearner = normalizeQuizAnswer(input.learnerAnswer);
  const normalizedCorrect = normalizeQuizAnswer(input.correctAnswer);

  let isCorrect = false;
  if (normalizedLearner.length > 0 && normalizedCorrect.length > 0) {
    switch (input.questionType) {
      case "essay":
      case "matching":
        isCorrect = false;
        break;
      case "fill_blank":
        isCorrect =
          normalizedLearner === normalizedCorrect ||
          normalizedCorrect.includes(normalizedLearner);
        break;
      case "mcq":
      case "true_false":
      case "short_answer":
      default:
        isCorrect = normalizedLearner === normalizedCorrect;
        break;
    }
  }

  return {
    isCorrect,
    pointsAwarded: isCorrect ? questionPoints : 0,
    questionPoints,
    storedAnswer,
  };
}

/**
 * Is the learner enrolled in this class, in this school?
 *
 * The enrollment is looked up through `learner_classes.school_id`, so an enrollment that
 * belongs to another school never satisfies the check. A learner with no enrollment row
 * at all is NOT enrolled — the previous "no enrollments recorded → allow everything"
 * default was a fail-open rule and has been removed.
 */
export async function isLearnerEnrolledInClass(
  schoolId: string,
  learnerId: string,
  classId: string
): Promise<boolean> {
  if (!isUuid(schoolId) || !isUuid(learnerId) || !isUuid(classId)) return false;

  const rows = await db
    .select({ id: learnerClasses.id })
    .from(learnerClasses)
    .where(
      and(
        eq(learnerClasses.learnerId, learnerId),
        eq(learnerClasses.classId, classId),
        eq(learnerClasses.schoolId, schoolId)
      )
    )
    .limit(1);

  return rows.length > 0;
}
