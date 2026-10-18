import { and, eq, sql, type SQL } from "drizzle-orm";
import { assignments } from "@/db/schema";
import {
  hasSchoolAdminExtendedRole,
  isUuid,
  sqlAssignmentInSchool,
  type SchoolAuthContext,
} from "@/lib/tenant";

/**
 * Query-level authorization for assignment content. A route must put this predicate in the
 * assignment SELECT itself; fetching an assignment first and checking its role in JavaScript
 * is not sufficient because the query can otherwise expose a foreign row through joins or
 * error paths.
 */
export function assignmentAccessPredicate(
  context: SchoolAuthContext,
  options: { learnerId?: string | null } = {}
): SQL {
  const schoolScope = and(
    eq(assignments.schoolId, context.schoolId),
    sqlAssignmentInSchool(context.schoolId, assignments.id)
  )!;

  if (hasSchoolAdminExtendedRole(context)) {
    return schoolScope;
  }

  if (context.school.role === "teacher") {
    return and(schoolScope, eq(assignments.teacherId, context.userId))!;
  }

  if (context.school.role === "learner" && isUuid(context.userId)) {
    return and(
      schoolScope,
      eq(assignments.status, "published"),
      learnerEnrollmentPredicate(context.schoolId, context.userId)
    )!;
  }

  if (context.school.role === "parent" && isUuid(context.userId) && isUuid(options.learnerId)) {
    return and(
      schoolScope,
      eq(assignments.status, "published"),
      parentApprovedContentPredicate(context.schoolId, context.userId, options.learnerId)
    )!;
  }

  // `school_users.role` is an allowlist. Unknown roles, platform roles and parents without a
  // selected linked learner all fail closed at the SQL layer.
  return sql`false`;
}

/** A parent list may include an assignment when at least one linked child is enrolled. */
export function parentAssignmentListPredicate(
  schoolId: string,
  parentId: string
): SQL {
  return sql`exists (
    select 1
      from "parent_learners" pl
      join "learner_classes" lc
        on lc."school_id" = pl."school_id"
       and lc."learner_id" = pl."learner_id"
      join "school_users" parent_membership
        on parent_membership."school_id" = pl."school_id"
       and parent_membership."user_id" = pl."parent_id"
       and parent_membership."status" = 'active'
      join "school_users" learner_membership
        on learner_membership."school_id" = pl."school_id"
       and learner_membership."user_id" = pl."learner_id"
       and learner_membership."status" = 'active'
      join "schools" lifecycle
        on lifecycle."id" = pl."school_id"
       and lifecycle."status" = 'active'
     where pl."school_id" = ${schoolId}
       and pl."parent_id" = ${parentId}
       and lc."class_id" = "assignments"."class_id"
  )`;
}

/** A learner list may include only published assignments for enrolled classes. */
export function learnerAssignmentListPredicate(
  schoolId: string,
  learnerId: string
): SQL {
  return learnerEnrollmentPredicate(schoolId, learnerId);
}

function learnerEnrollmentPredicate(schoolId: string, learnerId: string): SQL {
  return sql`exists (
    select 1
      from "learner_classes" lc
      join "school_users" learner_membership
        on learner_membership."school_id" = lc."school_id"
       and learner_membership."user_id" = lc."learner_id"
       and learner_membership."status" = 'active'
      join "schools" lifecycle
        on lifecycle."id" = lc."school_id"
       and lifecycle."status" = 'active'
     where lc."school_id" = ${schoolId}
       and lc."learner_id" = ${learnerId}
       and lc."class_id" = "assignments"."class_id"
  )`;
}

function parentApprovedContentPredicate(
  schoolId: string,
  parentId: string,
  learnerId: string
): SQL {
  return sql`exists (
    select 1
      from "parent_learners" pl
      join "learner_classes" lc
        on lc."school_id" = pl."school_id"
       and lc."learner_id" = pl."learner_id"
      join "school_users" parent_membership
        on parent_membership."school_id" = pl."school_id"
       and parent_membership."user_id" = pl."parent_id"
       and parent_membership."status" = 'active'
      join "school_users" learner_membership
        on learner_membership."school_id" = pl."school_id"
       and learner_membership."user_id" = pl."learner_id"
       and learner_membership."status" = 'active'
      join "schools" lifecycle
        on lifecycle."id" = pl."school_id"
       and lifecycle."status" = 'active'
     where pl."school_id" = ${schoolId}
       and pl."parent_id" = ${parentId}
       and pl."learner_id" = ${learnerId}
       and lc."class_id" = "assignments"."class_id"
  )`;
}

export type AssignmentQuestionDto = {
  id: string;
  questionType: string;
  questionText: string;
  options: unknown;
  points: number | null;
  orderIndex: number | null;
};

export type StaffAssignmentQuestionDto = AssignmentQuestionDto & {
  correctAnswer: string | null;
  explanation: string | null;
};

/** Explicit learner/parent DTO. It is intentionally impossible for this object to carry keys. */
export function toAssignmentQuestionDto(row: {
  id: string;
  questionType: string;
  questionText: string;
  options: unknown;
  points: number | null;
  orderIndex: number | null;
}): AssignmentQuestionDto {
  return {
    id: row.id,
    questionType: row.questionType,
    questionText: row.questionText,
    options: row.options,
    points: row.points,
    orderIndex: row.orderIndex,
  };
}

export function toStaffAssignmentQuestionDto(row: AssignmentQuestionDto & {
  correctAnswer: string | null;
  explanation: string | null;
}): StaffAssignmentQuestionDto {
  return {
    ...toAssignmentQuestionDto(row),
    correctAnswer: row.correctAnswer,
    explanation: row.explanation,
  };
}

export function toLearnerAnswerDto(row: {
  questionId: string;
  questionText: string;
  questionType: string;
  options: unknown;
  answer: string | null;
  isCorrect: boolean | null;
  pointsAwarded: number | null;
  pointsPossible: number | null;
}): Omit<AssignmentQuestionDto, "id" | "points" | "orderIndex"> & {
  questionId: string;
  answer: string | null;
  isCorrect: boolean | null;
  pointsAwarded: number | null;
  pointsPossible: number | null;
} {
  return {
    questionId: row.questionId,
    questionType: row.questionType,
    questionText: row.questionText,
    options: row.options,
    answer: row.answer,
    isCorrect: row.isCorrect,
    pointsAwarded: row.pointsAwarded,
    pointsPossible: row.pointsPossible,
  };
}
