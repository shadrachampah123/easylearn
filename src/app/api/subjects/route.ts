import { NextRequest } from "next/server";
import { db } from "@/db";
import { subjects } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { desc, eq, and } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  isDepartmentInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    let results: any[];
    try {
      results = await db
        .select()
        .from(subjects)
        .where(eq(subjects.schoolId, ctx.schoolId))
        .orderBy(desc(subjects.createdAt));
    } catch {
      results = [];
    }

    return successResponse(results);
  } catch (error) {
    console.error("Subjects error:", error);
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
    const { name, code, departmentId, description } = body;

    if (!name) return errorResponse("Subject name is required");

    if (departmentId) {
      const deptOk = await isDepartmentInSchool(ctx.schoolId, departmentId);
      if (!deptOk) return errorResponse("Department not found", 404);
    }

    let newSubject;
    try {
      [newSubject] = await db
        .insert(subjects)
        .values({
          schoolId: ctx.schoolId,
          name,
          code: code || null,
          departmentId: departmentId || null,
          description: description || null,
        })
        .returning();
    } catch {
      [newSubject] = await db
        .insert(subjects)
        .values({
          name,
          code: code || null,
          departmentId: departmentId || null,
          description: description || null,
        } as any)
        .returning();
    }

    await logActivity({
      userId: ctx.userId,
      action: "create",
      entityType: "subject",
      entityId: newSubject.id,
      description: `Created subject ${name}`,
    });

    return successResponse(newSubject, 201);
  } catch (error) {
    console.error("Create subject error:", error);
    return errorResponse("Internal server error", 500);
  }
}
