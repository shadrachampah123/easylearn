import { NextRequest } from "next/server";
import { db } from "@/db";
import { classes } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { desc, eq } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  isUserInSchool,
  isAcademicYearInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    // Phase 2D: direct school_id predicate — exact and cheap, no relational fallback needed
    let results;
    try {
      results = await db
        .select()
        .from(classes)
        .where(eq(classes.schoolId, ctx.schoolId))
        .orderBy(desc(classes.createdAt));
    } catch {
      // Fallback for DB without school_id column — use relational (Phase 2C) as degraded path
      const { sqlClassInSchool } = await import("@/lib/tenant");
      results = await db
        .select()
        .from(classes)
        .where(sqlClassInSchool(ctx.schoolId, classes.id))
        .orderBy(desc(classes.createdAt));
    }

    return successResponse(results);
  } catch (error) {
    console.error("Classes error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Forbidden", 403);
    }

    const body = await request.json();
    const { name, level, capacity, classTeacherId, academicYearId } = body;

    if (!name || !level) {
      return errorResponse("Name and level are required");
    }

    // Phase 2D: homeroom teacher must be a member of this school
    if (classTeacherId && !(await isUserInSchool(ctx.schoolId, classTeacherId))) {
      return errorResponse("Class teacher not found", 404);
    }

    if (academicYearId) {
      const yearOk = await isAcademicYearInSchool(ctx.schoolId, academicYearId);
      if (!yearOk) return errorResponse("Academic year not found", 404);
    }

    let newClass;
    try {
      [newClass] = await db
        .insert(classes)
        .values({
          schoolId: ctx.schoolId,
          name,
          level,
          capacity: capacity || 40,
          classTeacherId: classTeacherId || null,
          academicYearId: academicYearId || null,
        })
        .returning();
    } catch {
      [newClass] = await db
        .insert(classes)
        .values({
          name,
          level,
          capacity: capacity || 40,
          classTeacherId: classTeacherId || null,
          academicYearId: academicYearId || null,
        } as any)
        .returning();
    }

    await logActivity({
      userId: ctx.userId,
      action: "create",
      entityType: "class",
      entityId: newClass.id,
      description: `Created class ${name} (${level})`,
      details: JSON.stringify({ name, level }),
    });

    return successResponse(newClass, 201);
  } catch (error) {
    console.error("Create class error:", error);
    return errorResponse("Internal server error", 500);
  }
}
