import { db } from "@/db";
import {
  classes,
  learnerClasses,
  parentLearners,
  teacherClasses,
  users,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export const ADMIN_ROLES = ["super_admin", "school_admin"] as const;
export const ADMIN_EXTENDED_ROLES = ["super_admin", "school_admin", "head_teacher"] as const;
export const TEACHER_ROLES = ["teacher", "head_teacher"] as const;

export function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

export function isAdminExtendedRole(role: string): boolean {
  return (ADMIN_EXTENDED_ROLES as readonly string[]).includes(role);
}

export function isTeacherRole(role: string): boolean {
  return (TEACHER_ROLES as readonly string[]).includes(role);
}

export async function isParentLinkedToLearner(parentId: string, learnerId: string): Promise<boolean> {
  const [link] = await db
    .select({ id: parentLearners.id })
    .from(parentLearners)
    .where(and(eq(parentLearners.parentId, parentId), eq(parentLearners.learnerId, learnerId)))
    .limit(1);
  return !!link;
}

export async function getParentLinkedLearnerIds(parentId: string): Promise<Set<string>> {
  const rows = await db
    .select({ learnerId: parentLearners.learnerId })
    .from(parentLearners)
    .where(eq(parentLearners.parentId, parentId));
  return new Set(rows.map((r) => r.learnerId));
}

export async function getTeacherAccessibleClassIds(teacherId: string): Promise<Set<string>> {
  const assigned = await db
    .select({ classId: teacherClasses.classId })
    .from(teacherClasses)
    .where(eq(teacherClasses.teacherId, teacherId));
  const homeroom = await db
    .select({ id: classes.id })
    .from(classes)
    .where(eq(classes.classTeacherId, teacherId));
  const ids = new Set<string>();
  assigned.forEach((r) => ids.add(r.classId));
  homeroom.forEach((r) => ids.add(r.id));
  return ids;
}

export async function canTeacherAccessClass(teacherId: string, classId: string): Promise<boolean> {
  // Check teacher_classes assignment
  const [assigned] = await db
    .select({ id: teacherClasses.id })
    .from(teacherClasses)
    .where(and(eq(teacherClasses.teacherId, teacherId), eq(teacherClasses.classId, classId)))
    .limit(1);
  if (assigned) return true;

  // Check homeroom teacher
  const [homeroom] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.id, classId), eq(classes.classTeacherId, teacherId)))
    .limit(1);
  return !!homeroom;
}

/**
 * Get learners that a teacher can access based SOLELY on current teaching relationship
 * (class assignment), NOT on historical assignment/quiz activity.
 * 
 * This is the strongest legitimate relationship from existing schema:
 * - Teacher is assigned to class via teacher_classes, OR
 * - Teacher is homeroom teacher via classes.classTeacherId, AND
 * - Learner is enrolled in that class via learnerClasses
 */
export async function getTeacherAccessibleLearnerIds(teacherId: string): Promise<Set<string>> {
  const classIds = await getTeacherAccessibleClassIds(teacherId);
  if (classIds.size === 0) return new Set();

  const enrolled = await db
    .select({ learnerId: learnerClasses.learnerId })
    .from(learnerClasses)
    .where(inArray(learnerClasses.classId, Array.from(classIds)));

  return new Set(enrolled.map((r) => r.learnerId));
}

/**
 * Pure logic for testing: given sets, determine if teacher can access learner
 * This allows unit testing without DB
 */
export function canTeacherAccessLearnerPure(
  teacherClassIds: Set<string>,
  learnerEnrollments: Map<string, Set<string>>, // learnerId -> set of classIds they are enrolled in
  learnerId: string
): boolean {
  const learnerClasses = learnerEnrollments.get(learnerId);
  if (!learnerClasses) return false;
  for (const classId of learnerClasses) {
    if (teacherClassIds.has(classId)) return true;
  }
  return false;
}

export async function canAccessLearner(
  payload: { userId: string; role: string },
  learnerId: string
): Promise<boolean> {
  if (!learnerId) return false;
  if (payload.userId === learnerId) return true;
  if (isAdminExtendedRole(payload.role)) return true;

  if (payload.role === "teacher") {
    // STRICT: Teacher access based ONLY on current class teaching relationship
    // NOT on historical assignment/quiz activity (which could grant access to unrelated learners)
    // This uses the strongest legitimate relationship: teacher_classes + classTeacherId + learnerClasses
    const accessibleLearnerIds = await getTeacherAccessibleLearnerIds(payload.userId);
    return accessibleLearnerIds.has(learnerId);
  }

  if (payload.role === "head_teacher") {
    // head_teacher is considered admin extended for reporting, but for learner access
    // we treat them as admin (school-wide) per existing role model
    // See SECURITY_PHASE1.md for documentation
    return true;
  }

  if (payload.role === "parent") {
    return await isParentLinkedToLearner(payload.userId, learnerId);
  }

  // Learner already checked own id, others denied
  return false;
}

export async function canAccessLearners(
  payload: { userId: string; role: string },
  learnerIds: string[]
): Promise<boolean> {
  // For bulk checks, ensure payload can access all listed learnerIds
  for (const id of learnerIds) {
    if (!(await canAccessLearner(payload, id))) return false;
  }
  return true;
}

// For enrollment listing: get allowed learnerIds for a given user
export async function getAllowedLearnerIdsForEnrollment(payload: { userId: string; role: string }): Promise<Set<string> | "all"> {
  if (isAdminExtendedRole(payload.role)) {
    return "all";
  }
  if (payload.role === "teacher") {
    // STRICT: Only learners enrolled in teacher's classes
    return await getTeacherAccessibleLearnerIds(payload.userId);
  }
  if (payload.role === "head_teacher") {
    return "all";
  }
  if (payload.role === "parent") {
    return await getParentLinkedLearnerIds(payload.userId);
  }
  if (payload.role === "learner") {
    return new Set([payload.userId]);
  }
  return new Set();
}

export async function getAllowedClassIdsForTeacher(payload: { userId: string; role: string }): Promise<Set<string> | "all"> {
  if (isAdminExtendedRole(payload.role)) return "all";
  if (payload.role === "teacher" || payload.role === "head_teacher") {
    return await getTeacherAccessibleClassIds(payload.userId);
  }
  return new Set();
}

// Pure functions for testing without DB
export function isParentLinkedPure(
  parentLinks: Map<string, Set<string>>, // parentId -> set of learnerIds
  parentId: string,
  learnerId: string
): boolean {
  const linked = parentLinks.get(parentId);
  return linked ? linked.has(learnerId) : false;
}

export function canAccessLearnerPure(
  payload: { userId: string; role: string },
  learnerId: string,
  parentLinks: Map<string, Set<string>>,
  teacherClassMap: Map<string, Set<string>>, // teacherId -> classIds
  learnerEnrollments: Map<string, Set<string>> // learnerId -> classIds
): boolean {
  if (!learnerId) return false;
  if (payload.userId === learnerId) return true;
  if (isAdminExtendedRole(payload.role)) return true;

  if (payload.role === "teacher") {
    const teacherClasses = teacherClassMap.get(payload.userId);
    if (!teacherClasses) return false;
    return canTeacherAccessLearnerPure(teacherClasses, learnerEnrollments, learnerId);
  }

  if (payload.role === "head_teacher") {
    return true;
  }

  if (payload.role === "parent") {
    return isParentLinkedPure(parentLinks, payload.userId, learnerId);
  }

  return false;
}
