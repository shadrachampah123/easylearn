import { NextRequest } from "next/server";
import { db } from "@/db";
import { classes } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { desc } from "drizzle-orm";
import { logActivity } from "@/lib/activity";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const results = await db
      .select()
      .from(classes)
      .orderBy(desc(classes.createdAt));

    return successResponse(results);
  } catch (error) {
    console.error("Classes error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    const body = await request.json();
    const { name, level, capacity, classTeacherId, academicYearId } = body;

    if (!name || !level) {
      return errorResponse("Name and level are required");
    }

    const [newClass] = await db.insert(classes).values({
      name,
      level,
      capacity: capacity || 40,
      classTeacherId: classTeacherId || null,
      academicYearId: academicYearId || null,
    }).returning();

    await logActivity({
      userId: payload.userId,
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
