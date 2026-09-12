import { NextRequest } from "next/server";
import { db } from "@/db";
import { classes } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { desc } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  isUserInSchool,
  sqlClassInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    /* Phase 2C: classes have no `school_id` in this phase, so ownership is resolved through
       the class's people (homeroom teacher, assigned teachers, enrolled learners). A class
       that is reachable from another school — or from nobody yet — is NOT listed. That is
       the fail-closed rule of the brief: content that cannot be attributed to the caller's
       school is denied. Phase 2D adds `classes.school_id` and makes this exact and cheap. */
    const results = await db
      .select()
      .from(classes)
      .where(sqlClassInSchool(ctx.schoolId, classes.id))
      .orderBy(desc(classes.createdAt));

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

    /* Phase 2C: the homeroom teacher of a class of this school must be a member of this
       school. This is also what gives the new class a tenant anchor (see GET above). */
    if (classTeacherId && !(await isUserInSchool(ctx.schoolId, classTeacherId))) {
      return errorResponse("Class teacher not found", 404);
    }

    const [newClass] = await db.insert(classes).values({
      name,
      level,
      capacity: capacity || 40,
      classTeacherId: classTeacherId || null,
      academicYearId: academicYearId || null,
    }).returning();

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
