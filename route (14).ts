import { NextRequest } from "next/server";
import { db } from "@/db";
import { departments, subjects } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, desc, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const results = await db
      .select({
        id: departments.id,
        name: departments.name,
        description: departments.description,
        headId: departments.headId,
        createdAt: departments.createdAt,
      })
      .from(departments)
      .orderBy(desc(departments.createdAt));

    // Add subject count for each department
    const departmentsWithCounts = await Promise.all(
      results.map(async (dept) => {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(subjects)
          .where(eq(subjects.departmentId, dept.id));
        return { ...dept, subjectCount: Number(count) };
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
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("Only administrators can create departments", 403);
    }

    const body = await request.json();
    const { name, description, headId } = body;

    if (!name) return errorResponse("Department name is required");

    const [newDepartment] = await db.insert(departments).values({
      name,
      description: description || null,
      headId: headId || null,
    }).returning();

    return successResponse(newDepartment, 201);
  } catch (error) {
    console.error("Create department error:", error);
    return errorResponse("Internal server error", 500);
  }
}
