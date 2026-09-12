import { NextRequest } from "next/server";
import { db } from "@/db";
import { isSchemaOutOfDate } from "@/lib/schema-resilience";
import { departments, subjects } from "@/db/schema";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq, and } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  isUserInSchool,
} from "@/lib/tenant";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can manage departments", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { name, description, headId } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return errorResponse("Department name is required");
    }

    // Tenant check: department must belong to caller's school
    let existing;
    try {
      [existing] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, id), eq(departments.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      return notFoundResponse("Department");
    }

    if (!existing) return notFoundResponse("Department");

    if (headId && !(await isUserInSchool(ctx.schoolId, headId))) {
      return errorResponse("Department head not found", 404);
    }

    const [updated] = await db
      .update(departments)
      .set({
        name: name !== undefined ? name.trim() : undefined,
        description: description !== undefined ? (description?.trim() || null) : undefined,
        headId: headId !== undefined ? headId || null : undefined,
      })
      .where(and(eq(departments.id, id), eq(departments.schoolId, ctx.schoolId)))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update department error:", error);
    return errorResponse("The department could not be updated. Please retry.", 500);
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

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can manage departments", 403);
    }

    const { id } = await params;

    let existing;
    try {
      [existing] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, id), eq(departments.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      return notFoundResponse("Department");
    }

    if (!existing) return notFoundResponse("Department");

    // Subjects may still be useful on their own, so preserve them and clear only
    // the optional department relationship before deleting the department.
    await db.transaction(async (tx) => {
      try {
        await tx
          .update(subjects)
          .set({ departmentId: null })
          .where(and(eq(subjects.departmentId, id), eq(subjects.schoolId, ctx.schoolId)));
      } catch (error) {
        // Phase 2E (Step 1) — narrow legacy compatibility ONLY: the fallback below may run
        // when this database predates migration 0016 (school_id column/table missing).
        // Any other error (constraint violation, transient DB failure, bad input) is
        // rethrown so a row can never be written without a school.
        if (!isSchemaOutOfDate(error)) throw error;
        await tx.update(subjects).set({ departmentId: null }).where(eq(subjects.departmentId, id));
      }
      await tx.delete(departments).where(and(eq(departments.id, id), eq(departments.schoolId, ctx.schoolId)));
    });

    return successResponse({ message: "Department deleted" });
  } catch (error) {
    console.error("Delete department error:", error);
    return errorResponse("The department could not be deleted. Please retry.", 500);
  }
}
