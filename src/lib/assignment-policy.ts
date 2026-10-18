export type AssignmentPolicyRole =
  | "school_admin"
  | "head_teacher"
  | "teacher"
  | "learner"
  | "parent"
  | string;

export type AssignmentPolicyDecision =
  | "manage-full"
  | "oversight-full"
  | "published-content"
  | "denied";

/**
 * Pure policy mirror for tests and review. Database-backed routes enforce the same decision
 * with SQL predicates in `assignment-access.ts`; these inputs are never client authority.
 *
 * The mirror must state exactly what the routes enforce. A rule that no route implements
 * must not appear here as a grant: a mirror that hands out access the database-backed
 * routes never grant is a mirror that misleads every reader who trusts it.
 */
export function assignmentPolicyDecision(input: {
  role: AssignmentPolicyRole;
  ownsAssignment?: boolean;
  /**
   * RESERVED — no route and no schema column populates this today. The enforced teacher
   * rule is ownership only, so this flag is deliberately ignored here (see the note on
   * `assignmentPolicyDecision`). It stays in the input type so the intended capability
   * remains visible and has an obvious place to be wired when it is implemented.
   */
  explicitlyAuthorized?: boolean;
  published?: boolean;
  enrolled?: boolean;
  parentLinked?: boolean;
  sameSchool?: boolean;
}): AssignmentPolicyDecision {
  if (input.sameSchool === false) return "denied";

  if (input.role === "school_admin" || input.role === "head_teacher") {
    return "oversight-full";
  }

  if (input.role === "teacher") {
    /* Ownership only — the same rule `assignment-access.ts` enforces with
       `eq(assignments.teacherId, context.userId)`. */
    return input.ownsAssignment === true ? "manage-full" : "denied";
  }

  if (input.role === "learner") {
    return input.published === true && input.enrolled === true
      ? "published-content"
      : "denied";
  }

  if (input.role === "parent") {
    return input.published === true && input.enrolled === true && input.parentLinked === true
      ? "published-content"
      : "denied";
  }

  return "denied";
}
