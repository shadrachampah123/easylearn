import { db } from "@/db";
import {
  classes,
  learnerClasses,
  parentLearners,
  teacherClasses,
  users,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getAccessibleLearnerIds as getReportAccessibleLearnerIds, ADMIN_REPORT_ROLES } from "@/lib/report-access";

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

export async function canAccessLearner(
  payload: { userId: string; role: string },
  learnerId: string
): Promise<boolean> {
  if (!learnerId) return false;
  if (payload.userId === learnerId) return true;
  if (isAdminExtendedRole(payload.role)) return true;

  if (payload.role === "teacher" || payload.role === "head_teacher") {
    // Use existing report-access logic which includes enrolled learners, assignment learners, quiz learners
    const accessible = await getReportAccessibleLearnerIds(payload);
    if (accessible.has(learnerId)) return true;
    // Fallback: check if teacher teaches any class where learner is enrolled
    // Already covered by getAccessibleLearnerIds, but keep explicit check
    return false;
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
  if (payload.role === "teacher" || payload.role === "head_teacher") {
    return await getReportAccessibleLearnerIds(payload);
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
