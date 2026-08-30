import { db } from "@/db";
import {
  assignments,
  classes,
  learnerClasses,
  quizAttempts,
  quizzes,
  submissions,
  teacherClasses,
  users,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

export const STAFF_REPORT_ROLES = ["super_admin", "school_admin", "head_teacher", "teacher"] as const;
export const ADMIN_REPORT_ROLES = ["super_admin", "school_admin", "head_teacher"] as const;

/**
 * Return the learners a staff member can report on.
 *
 * Administrators can report on every learner. Teachers are limited to enrolled learners
 * in classes they teach (or manage) and learners who have interacted with one of their
 * assignments or quizzes. The activity fallback matters for schools that have not yet
 * populated teacher_classes but already have assessment results.
 */
export async function getAccessibleLearnerIds(payload: { userId: string; role: string }) {
  if (ADMIN_REPORT_ROLES.includes(payload.role as (typeof ADMIN_REPORT_ROLES)[number])) {
    const learners = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "learner"));
    return new Set(learners.map((learner) => learner.id));
  }

  const assignedClasses = await db
    .select({ classId: teacherClasses.classId })
    .from(teacherClasses)
    .where(eq(teacherClasses.teacherId, payload.userId));
  const homeroomClasses = await db
    .select({ classId: classes.id })
    .from(classes)
    .where(eq(classes.classTeacherId, payload.userId));
  const classIds = [...new Set([
    ...assignedClasses.map((row) => row.classId),
    ...homeroomClasses.map((row) => row.classId),
  ])];

  const ids = new Set<string>();
  if (classIds.length > 0) {
    const enrolled = await db
      .select({ learnerId: learnerClasses.learnerId })
      .from(learnerClasses)
      .where(inArray(learnerClasses.classId, classIds));
    enrolled.forEach((row) => ids.add(row.learnerId));
  }

  const assignmentLearners = await db
    .select({ learnerId: submissions.learnerId })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
    .where(eq(assignments.teacherId, payload.userId));
  assignmentLearners.forEach((row) => ids.add(row.learnerId));

  const quizLearners = await db
    .select({ learnerId: quizAttempts.learnerId })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .where(eq(quizzes.teacherId, payload.userId));
  quizLearners.forEach((row) => ids.add(row.learnerId));

  return ids;
}
