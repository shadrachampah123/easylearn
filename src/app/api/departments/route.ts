import { NextRequest } from "next/server";
import { db } from "@/db";
import { isSchemaOutOfDate, legacyInsert } from "@/lib/schema-resilience";
import { departments, subjects } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { eq, desc, sql, and } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  isUserInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    let results: any[];
    try {
      results = await db
        .select({
          id: departments.id,
          name: departments.name,
          description: departments.description,
          headId: departments.headId,
          schoolId: departments.schoolId,
          createdAt: departments.createdAt,
        })
        .from(departments)
        .where(eq(departments.schoolId, ctx.schoolId))
        .orderBy(desc(departments.createdAt));
    } catch {
      results = [];
    }

    // Add subject count for each department (scoped to school)
    const departmentsWithCounts = await Promise.all(
      results.map(async (dept) => {
        try {
          const [{ count }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(subjects)
            .where(
              and(
                eq(subjects.departmentId, dept.id),
                eq(subjects.schoolId, ctx.schoolId)
              )
            );
          return { ...dept, subjectCount: Number(count) };
        } catch {
          const [{ count }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(subjects)
            .where(eq(subjects.departmentId, dept.id));
          return { ...dept, subjectCount: Number(count) };
        }
      })
    );

    return successResponse(departmentsWithCounts);
  } catch (error) {
    console.error("Departments error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can create departments", 403);
    }

    const body = await request.json();
    const { name, description, headId } = body;

    if (!name) return errorResponse("Department name is required");

    if (headId && !(await isUserInSchool(ctx.schoolId, headId))) {
      return errorResponse("Department head not found", 404);
    }

    let newDepartment;
    try {
      [newDepartment] = await db
        .insert(departments)
        .values({
          schoolId: ctx.schoolId,
          name,
          description: description || null,
          headId: headId || null,
        })
        .returning();
    } catch (error) {
      // Phase 2E (Step 1) — narrow legacy compatibility ONLY: the fallback below may run
      // when this database predates migration 0016 (school_id column/table missing).
      // Any other error (constraint violation, transient DB failure, bad input) is
      // rethrown so a row can never be written without a school.
      if (!isSchemaOutOfDate(error)) throw error;
      [newDepartment] = await legacyInsert(db, "departments", {
        name,
        description: description || null,
        headId: headId || null,
      }, ["id", "name", "description", "headId", "createdAt"]);
    }

    await logActivity({
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      action: "create",
      entityType: "department",
      entityId: newDepartment.id,
      description: `Created department ${name}`,
    });

    return successResponse(newDepartment, 201);
  } catch (error) {
    console.error("Create department error:", error);
    return errorResponse("Internal server error", 500);
  }
}
