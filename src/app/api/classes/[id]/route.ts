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
  getClassSchoolIds,
  guardSchoolContext,
  isUserInSchool,
  sqlClassInSchool,
} from "@/lib/tenant";

/** Phase 1 admin group. `super_admin` is a platform role with no school membership, so it
 *  cannot pass the Phase 2C school gate for a school-owned class. */
const ADMIN_ROLES = ["school_admin"];

/** True only when the class resolves to EXACTLY this school (see `isClassInSchool`). */
async function hasSchoolClassAccess(schoolId: string, classId: string): Promise<boolean> {
  const schools = await getClassSchoolIds(classId);
  return schools.size === 1 && schools.has(schoolId);
}

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

    /* Phase 2C: the target class must belong to the caller's school (fail closed), and a
       new homeroom teacher must be a member of it too. */
    if (!(await hasSchoolClassAccess(ctx.schoolId, id))) {
      return notFoundResponse("Class");
    }

    if (classTeacherId && !(await isUserInSchool(ctx.schoolId, classTeacherId))) {
      return errorResponse("Class teacher not found", 404);
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
      .where(eq(classes.id, id))
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

    /* Phase 2C: another school's class is "not found" — and the cascade below can therefore
       never be run against it. */
    const [existing] = await db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.id, id), sqlClassInSchool(ctx.schoolId, classes.id)))
      .limit(1);

    if (!existing) return notFoundResponse("Class");

    // Several legacy foreign keys use ON DELETE NO ACTION. Clean up the dependent
    // content explicitly so an administrator can remove a class at any point rather
    // than receiving a database constraint error halfway through the operation.
    await db.transaction(async (tx) => {
      const classAssignments = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(eq(assignments.classId, id));
      const assignmentIds = classAssignments.map((assignment) => assignment.id);

      if (assignmentIds.length > 0) {
        const assignmentSubmissions = await tx
          .select({ id: submissions.id })
          .from(submissions)
          .where(inArray(submissions.assignmentId, assignmentIds));
        const submissionIds = assignmentSubmissions.map((submission) => submission.id);
        const assignmentQuestionRows = await tx
          .select({ id: assignmentQuestions.id })
          .from(assignmentQuestions)
          .where(inArray(assignmentQuestions.assignmentId, assignmentIds));
        const assignmentQuestionIds = assignmentQuestionRows.map((question) => question.id);

        if (submissionIds.length > 0) {
          await tx.delete(assignmentAnswers).where(inArray(assignmentAnswers.submissionId, submissionIds));
        }
        if (assignmentQuestionIds.length > 0) {
          // Answers reference both submissions and questions. Remove by question
          // too, so even malformed/partial historical submissions cannot block the delete.
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
        .where(eq(quizzes.classId, id));
      const quizIds = classQuizzes.map((quiz) => quiz.id);

      if (quizIds.length > 0) {
        await tx.delete(quizAttempts).where(inArray(quizAttempts.quizId, quizIds));
        await tx.delete(quizQuestions).where(inArray(quizQuestions.quizId, quizIds));
        await tx.delete(quizzes).where(inArray(quizzes.id, quizIds));
      }

      await tx.update(announcements).set({ classId: null }).where(eq(announcements.classId, id));
      await tx.update(resources).set({ classId: null }).where(eq(resources.classId, id));
      await tx.delete(attendance).where(eq(attendance.classId, id));
      await tx.delete(learnerClasses).where(eq(learnerClasses.classId, id));
      await tx.delete(teacherClasses).where(eq(teacherClasses.classId, id));
      await tx.delete(timetableEntries).where(eq(timetableEntries.classId, id));
      await tx.delete(classes).where(and(eq(classes.id, id), sqlClassInSchool(ctx.schoolId, classes.id)));
    });

    return successResponse({ message: "Class deleted" });
  } catch (error) {
    console.error("Delete class error:", error);
    return errorResponse("The class could not be deleted. Please retry.", 500);
  }
}
