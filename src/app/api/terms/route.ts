import { NextRequest } from "next/server";
import { db } from "@/db";
import { terms, academicYears } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { desc, eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const results = await db
      .select({
        id: terms.id,
        name: terms.name,
        academicYearId: terms.academicYearId,
        startDate: terms.startDate,
        endDate: terms.endDate,
        isCurrent: terms.isCurrent,
        academicYearName: academicYears.name,
      })
      .from(terms)
      .leftJoin(academicYears, eq(terms.academicYearId, academicYears.id))
      .orderBy(desc(terms.startDate));

    return successResponse(results);
  } catch (error) {
    console.error("Terms error:", error);
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
      return errorResponse("Only administrators can create terms", 403);
    }

    const body = await request.json();
    const { name, academicYearId, startDate, endDate, isCurrent } = body;

    if (!name || !academicYearId || !startDate || !endDate) {
      return errorResponse("Name, academic year, start date, and end date are required");
    }

    if (isCurrent) {
      await db.update(terms).set({ isCurrent: false });
    }

    const [newTerm] = await db.insert(terms).values({
      name,
      academicYearId,
      startDate,
      endDate,
      isCurrent: isCurrent || false,
    }).returning();

    return successResponse(newTerm, 201);
  } catch (error) {
    console.error("Create term error:", error);
    return errorResponse("Internal server error", 500);
  }
}
