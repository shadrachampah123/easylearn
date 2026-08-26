import { NextRequest } from "next/server";
import { db } from "@/db";
import { subjects } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const results = await db
      .select()
      .from(subjects)
      .orderBy(desc(subjects.createdAt));

    return successResponse(results);
  } catch (error) {
    console.error("Subjects error:", error);
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
    const { name, code, departmentId, description } = body;

    if (!name) return errorResponse("Subject name is required");

    const [newSubject] = await db.insert(subjects).values({
      name,
      code: code || null,
      departmentId: departmentId || null,
      description: description || null,
    }).returning();

    return successResponse(newSubject, 201);
  } catch (error) {
    console.error("Create subject error:", error);
    return errorResponse("Internal server error", 500);
  }
}
