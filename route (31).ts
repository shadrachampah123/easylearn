import { NextRequest } from "next/server";
import { db } from "@/db";
import { teacherClasses } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq } from "drizzle-orm";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    const { id } = await params;

    const [existing] = await db
      .select({ id: teacherClasses.id })
      .from(teacherClasses)
      .where(eq(teacherClasses.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Assignment");

    await db.delete(teacherClasses).where(eq(teacherClasses.id, id));

    return successResponse({ message: "Teacher assignment removed" });
  } catch (error) {
    console.error("Delete teacher class error:", error);
    return errorResponse("Internal server error", 500);
  }
}
