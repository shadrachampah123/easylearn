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
 */
export function assignmentPolicyDecision(input: {
  role: AssignmentPolicyRole;
  ownsAssignment?: boolean;
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
    return input.ownsAssignment === true || input.explicitlyAuthorized === true
      ? "manage-full"
      : "denied";
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
