import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  announcements,
  assignmentAnswers,
  assignmentCorrections,
  assignmentQuestions,
  assignments,
  attendance,
  classes,
  learnerClasses,
  quizAttempts,
  quizQuestions,
  quizzes,
  resources,
  submissions,
  teacherClasses,
  timetableEntries,
} from "@/db/schema";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { and, eq, inArray } from "drizzle-orm";
import {
  guardSchoolContext,
  isUserInSchool,
  isAcademicYearInSchool,
} from "@/lib/tenant";

const ADMIN_ROLES = ["school_admin"];

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!ADMIN_ROLES.includes(ctx.school.role)) {
      return errorResponse("Only administrators can update classes", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { name, level, capacity, classTeacherId, academicYearId } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return errorResponse("Class name is required");
    }

    // Phase 2D: direct school_id check
    let existing;
    try {
      [existing] = await db
        .select({ id: classes.id })
        .from(classes)
        .where(and(eq(classes.id, id), eq(classes.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      // Fallback for pre-0016 DB
      const { isClassInSchool } = await import("@/lib/tenant");
      if (!(await isClassInSchool(ctx.schoolId, id))) return notFoundResponse("Class");
      [existing] = await db.select({ id: classes.id }).from(classes).where(eq(classes.id, id)).limit(1);
    }

    if (!existing) return notFoundResponse("Class");

    if (classTeacherId && !(await isUserInSchool(ctx.schoolId, classTeacherId))) {
      return errorResponse("Class teacher not found", 404);
    }

    if (academicYearId) {
      const yearOk = await isAcademicYearInSchool(ctx.schoolId, academicYearId);
      if (!yearOk) return errorResponse("Academic year not found", 404);
    }

    const [updated] = await db
      .update(classes)
      .set({
        name: name !== undefined ? name.trim() : undefined,
        level: level ?? undefined,
        capacity: capacity !== undefined ? Number(capacity) : undefined,
        classTeacherId: classTeacherId !== undefined ? classTeacherId || null : undefined,
        academicYearId: academicYearId ?? undefined,
      })
      .where(and(eq(classes.id, id), eq(classes.schoolId, ctx.schoolId)))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update class error:", error);
    return errorResponse("The class could not be updated. Please retry.", 500);
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

    if (!ADMIN_ROLES.includes(ctx.school.role)) {
      return errorResponse("Only administrators can delete classes", 403);
    }

    const { id } = await params;

    let existing;
    try {
      [existing] = await db
        .select({ id: classes.id })
        .from(classes)
        .where(and(eq(classes.id, id), eq(classes.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      const { sqlClassInSchool } = await import("@/lib/tenant");
      [existing] = await db
        .select({ id: classes.id })
        .from(classes)
        .where(and(eq(classes.id, id), sqlClassInSchool(ctx.schoolId, classes.id)))
        .limit(1);
    }

    if (!existing) return notFoundResponse("Class");

    await db.transaction(async (tx) => {
      const classAssignments = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.classId, id), eq(assignments.schoolId, ctx.schoolId)));
      const assignmentIds = classAssignments.map((a) => a.id);

      if (assignmentIds.length > 0) {
        const assignmentSubmissions = await tx
          .select({ id: submissions.id })
          .from(submissions)
          .where(inArray(submissions.assignmentId, assignmentIds));
        const submissionIds = assignmentSubmissions.map((s) => s.id);
        const assignmentQuestionRows = await tx
          .select({ id: assignmentQuestions.id })
          .from(assignmentQuestions)
          .where(inArray(assignmentQuestions.assignmentId, assignmentIds));
        const assignmentQuestionIds = assignmentQuestionRows.map((q) => q.id);

        if (submissionIds.length > 0) {
          await tx.delete(assignmentAnswers).where(inArray(assignmentAnswers.submissionId, submissionIds));
        }
        if (assignmentQuestionIds.length > 0) {
          await tx.delete(assignmentAnswers).where(inArray(assignmentAnswers.questionId, assignmentQuestionIds));
        }
        await tx.delete(assignmentCorrections).where(inArray(assignmentCorrections.assignmentId, assignmentIds));
        await tx.delete(assignmentQuestions).where(inArray(assignmentQuestions.assignmentId, assignmentIds));
        if (submissionIds.length > 0) {
          await tx.delete(submissions).where(inArray(submissions.id, submissionIds));
        }
        await tx.delete(assignments).where(inArray(assignments.id, assignmentIds));
      }

      const classQuizzes = await tx
        .select({ id: quizzes.id })
        .from(quizzes)
        .where(and(eq(quizzes.classId, id), eq(quizzes.schoolId, ctx.schoolId)));
      const quizIds = classQuizzes.map((q) => q.id);

      if (quizIds.length > 0) {
        await tx.delete(quizAttempts).where(inArray(quizAttempts.quizId, quizIds));
        await tx.delete(quizQuestions).where(inArray(quizQuestions.quizId, quizIds));
        await tx.delete(quizzes).where(inArray(quizzes.id, quizIds));
      }

      try {
        await tx.update(announcements).set({ classId: null }).where(and(eq(announcements.classId, id), eq(announcements.schoolId, ctx.schoolId)));
        await tx.update(resources).set({ classId: null }).where(and(eq(resources.classId, id), eq(resources.schoolId, ctx.schoolId)));
        await tx.delete(attendance).where(and(eq(attendance.classId, id), eq(attendance.schoolId, ctx.schoolId)));
        await tx.delete(learnerClasses).where(and(eq(learnerClasses.classId, id), eq(learnerClasses.schoolId, ctx.schoolId)));
        await tx.delete(teacherClasses).where(and(eq(teacherClasses.classId, id), eq(teacherClasses.schoolId, ctx.schoolId)));
        await tx.delete(timetableEntries).where(and(eq(timetableEntries.classId, id), eq(timetableEntries.schoolId, ctx.schoolId)));
      } catch {
        await tx.update(announcements).set({ classId: null }).where(eq(announcements.classId, id));
        await tx.update(resources).set({ classId: null }).where(eq(resources.classId, id));
        await tx.delete(attendance).where(eq(attendance.classId, id));
        await tx.delete(learnerClasses).where(eq(learnerClasses.classId, id));
        await tx.delete(teacherClasses).where(eq(teacherClasses.classId, id));
        await tx.delete(timetableEntries).where(eq(timetableEntries.classId, id));
      }

      await tx.delete(classes).where(and(eq(classes.id, id), eq(classes.schoolId, ctx.schoolId)));
    });

    return successResponse({ message: "Class deleted" });
  } catch (error) {
    console.error("Delete class error:", error);
    return errorResponse("The class could not be deleted. Please retry.", 500);
  }
}
