import { NextRequest } from "next/server";
import { db } from "@/db";
import { departments, subjects } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq } from "drizzle-orm";

const ADMIN_ROLES = ["super_admin", "school_admin"];

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) return unauthorizedResponse();
  const payload = await verifyToken(token);
  if (!payload) return unauthorizedResponse();
  if (!ADMIN_ROLES.includes(payload.role)) {
    return errorResponse("Only administrators can manage departments", 403);
  }
  return payload;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof Response) return auth;

    const { id } = await params;
    const body = await request.json();
    const { name, description, headId } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return errorResponse("Department name is required");
    }

    const [existing] = await db
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Department");

    const [updated] = await db
      .update(departments)
      .set({
        name: name !== undefined ? name.trim() : undefined,
        description: description !== undefined ? (description?.trim() || null) : undefined,
        headId: headId !== undefined ? headId || null : undefined,
      })
      .where(eq(departments.id, id))
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
    const auth = await requireAdmin(request);
    if (auth instanceof Response) return auth;

    const { id } = await params;
    const [existing] = await db
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("Department");

    // Subjects may still be useful on their own, so preserve them and clear only
    // the optional department relationship before deleting the department.
    await db.transaction(async (tx) => {
      await tx
        .update(subjects)
        .set({ departmentId: null })
        .where(eq(subjects.departmentId, id));
      await tx.delete(departments).where(eq(departments.id, id));
    });

    return successResponse({ message: "Department deleted" });
  } catch (error) {
    console.error("Delete department error:", error);
    return errorResponse("The department could not be deleted. Please retry.", 500);
  }
}
