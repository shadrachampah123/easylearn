import { and, eq, sql, type SQL } from "drizzle-orm";
import { assignments } from "@/db/schema";
import {
  hasSchoolAdminExtendedRole,
  isUuid,
  sqlAssignmentInSchool,
  sqlAssignmentScope,
  type SchoolAuthContext,
} from "@/lib/tenant";

/**
 * The role rules of the assignment policy, applied on top of a resolved school scope.
 *
 * The school scope is injected rather than computed here so that the same role rules can be
 * used with a schema-aware scope and with the plain migrated-schema scope. Fail-closed by
 * construction: any role that is not explicitly granted access resolves to `false`.
 *
 * SCHEMA PREREQUISITE (measured, not assumed — see
 * `tests/assignment-schema-prerequisite.test.ts`):
 *
 *   - The SCHOOL-SCOPE layer is schema-aware. `sqlSchoolRowInSchool()` and the relational
 *     attribution it falls back to never read a content table's `school_id`; they attribute a
 *     row through `school_users.school_id` (added by migration 0013) and the relational
 *     ownership chain. The school scope therefore works on a pre-0016 schema.
 *   - The LEARNER and PARENT role predicates DO require migration 0016: they read
 *     `learner_classes.school_id` and `parent_learners.school_id`, which that migration adds.
 *     On a pre-0016 schema they fail closed with a missing-column error, so no row is ever
 *     returned — but the request errors rather than degrading to an empty list.
 *   - The TEACHER and SCHOOL-ADMIN/HEAD-TEACHER role predicates need only the school scope,
 *     so they work on a pre-0016 schema.
 *
 * In short: migration 0016 is a prerequisite for learner and parent assignment access, and
 * the supported schema versions are 0016 and later (0017 makes `school_id` NOT NULL, 0018
 * adds the composite tenant foreign keys). Migration 0016 is applied by the ordinary
 * `node run-migration.js` chain, so a deployment that has run the chain is on a supported
 * version.
 */
function assignmentRolePredicate(
  context: SchoolAuthContext,
  options: { learnerId?: string | null },
  schoolScope: SQL
): SQL {
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

/**
 * Query-level authorization for assignment content. A route must put this predicate in the
 * assignment SELECT itself; fetching an assignment first and checking its role in JavaScript
 * is not sufficient because the query can otherwise expose a foreign row through joins or
 * error paths.
 *
 * This synchronous form always references `assignments.school_id` and therefore requires
 * migration 0016 for EVERY role. Routes should prefer `resolveAssignmentAccessPredicate`,
 * which resolves the school scope schema-aware and so also works for the teacher and
 * school-administrator roles on a pre-0016 schema (the learner and parent role predicates
 * still require migration 0016 — see the schema prerequisite note above).
 */
export function assignmentAccessPredicate(
  context: SchoolAuthContext,
  options: { learnerId?: string | null } = {}
): SQL {
  const schoolScope = and(
    eq(assignments.schoolId, context.schoolId),
    sqlAssignmentInSchool(context.schoolId, assignments.id)
  )!;

  return assignmentRolePredicate(context, options, schoolScope);
}

/**
 * SCHEMA-AWARE query-level authorization for assignment content.
 *
 * This is the predicate the assignment routes use. It keeps PR #31's role rules (teacher
 * ownership, school-administrator/head-teacher oversight, published+enrolled learner access,
 * explicitly linked parent access) and layers them over PR #30's schema-aware school scope.
 *
 * SCHEMA PREREQUISITE: migration 0016 for the learner and parent roles (their predicates read
 * `learner_classes.school_id` / `parent_learners.school_id`). The school scope itself is
 * schema-aware, so the teacher and school-administrator roles also work on a pre-0016 schema.
 * On a pre-0016 schema the learner and parent paths fail CLOSED with a missing-column error
 * rather than returning rows — never a leak, but a request error rather than an empty result.
 * See the schema prerequisite note at the top of this file and
 * `tests/assignment-schema-prerequisite.test.ts`.
 */
export async function resolveAssignmentAccessPredicate(
  context: SchoolAuthContext,
  options: { learnerId?: string | null } = {}
): Promise<SQL> {
  const schoolScope = await sqlAssignmentScope(context.schoolId, assignments.id);
  return assignmentRolePredicate(context, options, schoolScope);
}

/**
 * SCHEMA-AWARE authorization for the assignment LIST.
 *
 * Learners and parents only ever see published content they are entitled to; teachers only
 * see the assignments they own; school administrators and head teachers see every assignment
 * of their school. Every branch is additionally constrained by the school scope.
 */
export async function resolveAssignmentListPredicate(
  context: SchoolAuthContext
): Promise<SQL> {
  const schoolScope = await sqlAssignmentScope(context.schoolId, assignments.id);

  if (context.school.role === "parent") {
    return and(
      schoolScope,
      eq(assignments.status, "published"),
      parentAssignmentListPredicate(context.schoolId, context.userId)
    )!;
  }

  if (context.school.role === "learner") {
    return and(
      schoolScope,
      eq(assignments.status, "published"),
      learnerAssignmentListPredicate(context.schoolId, context.userId)
    )!;
  }

  if (context.school.role === "teacher") {
    return and(schoolScope, eq(assignments.teacherId, context.userId))!;
  }

  if (hasSchoolAdminExtendedRole(context)) {
    return schoolScope;
  }

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
