import { NextRequest } from "next/server";
import { db } from "@/db";
import { teacherClasses } from "@/db/schema";
import { guardSchoolContext, hasSchoolAdminRole, sqlTeacherClassInSchool } from "@/lib/tenant";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { and, eq } from "drizzle-orm";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Forbidden", 403);
    }

    const { id } = await params;

    const [existing] = await db
      .select({ id: teacherClasses.id })
      .from(teacherClasses)
      .where(and(eq(teacherClasses.id, id), sqlTeacherClassInSchool(ctx.schoolId, teacherClasses.id)))
      .limit(1);

    if (!existing) return notFoundResponse("Assignment");

    await db
      .delete(teacherClasses)
      .where(and(eq(teacherClasses.id, id), sqlTeacherClassInSchool(ctx.schoolId, teacherClasses.id)));

    return successResponse({ message: "Teacher assignment removed" });
  } catch (error) {
    console.error("Delete teacher class error:", error);
    return errorResponse("Internal server error", 500);
  }
}
