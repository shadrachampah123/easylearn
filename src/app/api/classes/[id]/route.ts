import { NextRequest } from "next/server";
import { db } from "@/db";
import { classes } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq } from "drizzle-orm";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("Only administrators can update classes", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { name, level, capacity, classTeacherId, academicYearId } = body;

    const [existing] = await db
      .select({ id: classes.id })
      .from(classes)
      .where(eq(classes.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Class");

    const [updated] = await db
      .update(classes)
      .set({
        name: name ?? undefined,
        level: level ?? undefined,
        capacity: capacity ?? undefined,
        classTeacherId: classTeacherId || null,
        academicYearId: academicYearId ?? undefined,
      })
      .where(eq(classes.id, id))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update class error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (payload.role !== "super_admin") {
      return errorResponse("Forbidden", 403);
    }

    const { id } = await params;

    await db.delete(classes).where(eq(classes.id, id));

    return successResponse({ message: "Class deleted" });
  } catch (error) {
    console.error("Delete class error:", error);
    return errorResponse("Internal server error", 500);
  }
}
