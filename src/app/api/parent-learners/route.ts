import { NextRequest } from "next/server";
import { db } from "@/db";
import { parentLearners, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const parentId = request.nextUrl.searchParams.get("parentId");
    const learnerId = request.nextUrl.searchParams.get("learnerId");

    const conditions = [];
    if (parentId) conditions.push(eq(parentLearners.parentId, parentId));
    if (learnerId) conditions.push(eq(parentLearners.learnerId, learnerId));

    const whereClause = conditions.length > 0
      ? conditions.reduce((a, b) => and(a, b)!)
      : undefined;

    const results = await db
      .select({
        id: parentLearners.id,
        parentId: parentLearners.parentId,
        learnerId: parentLearners.learnerId,
        relationship: parentLearners.relationship,
        parentFirstName: users.firstName,
        parentLastName: users.lastName,
        parentEmail: users.email,
        createdAt: parentLearners.createdAt,
      })
      .from(parentLearners)
      .leftJoin(users, eq(parentLearners.parentId, users.id))
      .where(whereClause)
      .orderBy(desc(parentLearners.createdAt));

    return successResponse(results);
  } catch (error) {
    console.error("Parent learners error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Only administrators can link parents", 403);
    }

    const body = await request.json();
    const { parentId, learnerId, relationship } = body;

    if (!parentId || !learnerId) {
      return errorResponse("Parent and learner are required");
    }

    // Check for duplicate
    const existing = await db
      .select({ id: parentLearners.id })
      .from(parentLearners)
      .where(and(
        eq(parentLearners.parentId, parentId),
        eq(parentLearners.learnerId, learnerId)
      ))
      .limit(1);

    if (existing.length > 0) {
      return errorResponse("This relationship already exists");
    }

    const [relation] = await db.insert(parentLearners).values({
      parentId,
      learnerId,
      relationship: relationship || "parent",
    }).returning();

    return successResponse(relation, 201);
  } catch (error) {
    console.error("Link parent error:", error);
    return errorResponse("Internal server error", 500);
  }
}
