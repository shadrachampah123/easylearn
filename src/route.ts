import { NextRequest } from "next/server";
import { db } from "@/db";
import { academicYears } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { desc, eq, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const results = await db
      .select()
      .from(academicYears)
      .orderBy(desc(academicYears.startDate));

    return successResponse(results);
  } catch (error) {
    console.error("Academic years error:", error);
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
      return errorResponse("Only administrators can create academic years", 403);
    }

    const body = await request.json();
    const { name, startDate, endDate, isCurrent } = body;

    if (!name || !startDate || !endDate) {
      return errorResponse("Name, start date, and end date are required");
    }

    // If setting as current, unset others
    if (isCurrent) {
      await db.update(academicYears).set({ isCurrent: false });
    }

    const [newYear] = await db.insert(academicYears).values({
      name,
      startDate,
      endDate,
      isCurrent: isCurrent || false,
    }).returning();

    return successResponse(newYear, 201);
  } catch (error) {
    console.error("Create academic year error:", error);
    return errorResponse("Internal server error", 500);
  }
}
