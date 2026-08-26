import { NextRequest } from "next/server";
import { db } from "@/db";
import { learnerClasses, users, classes } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, and, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const classId = request.nextUrl.searchParams.get("classId");
    const learnerId = request.nextUrl.searchParams.get("learnerId");

    const conditions = [];
    if (classId) conditions.push(eq(learnerClasses.classId, classId));
    if (learnerId) conditions.push(eq(learnerClasses.learnerId, learnerId));

    const whereClause = conditions.length > 0
      ? conditions.reduce((a, b) => and(a, b)!)
      : undefined;

    const results = await db
      .select({
        id: learnerClasses.id,
        learnerId: learnerClasses.learnerId,
        classId: learnerClasses.classId,
        academicYearId: learnerClasses.academicYearId,
        createdAt: learnerClasses.createdAt,
        learnerFirstName: users.firstName,
        learnerLastName: users.lastName,
        learnerEmail: users.email,
        className: classes.name,
        classLevel: classes.level,
      })
      .from(learnerClasses)
      .leftJoin(users, eq(learnerClasses.learnerId, users.id))
      .leftJoin(classes, eq(learnerClasses.classId, classes.id))
      .where(whereClause)
      .orderBy(desc(learnerClasses.createdAt));

    return successResponse(results);
  } catch (error) {
    console.error("Enrollments error:", error);
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
      return errorResponse("Only administrators can enroll learners", 403);
    }

    const body = await request.json();
    const { learnerId, classId, academicYearId } = body;

    if (!learnerId || !classId) {
      return errorResponse("Learner and class are required");
    }

    // Check for duplicate
    const existing = await db
      .select({ id: learnerClasses.id })
      .from(learnerClasses)
      .where(and(
        eq(learnerClasses.learnerId, learnerId),
        eq(learnerClasses.classId, classId)
      ))
      .limit(1);

    if (existing.length > 0) {
      return errorResponse("This learner is already enrolled in this class");
    }

    const [enrollment] = await db.insert(learnerClasses).values({
      learnerId,
      classId,
      academicYearId: academicYearId || null,
    }).returning();

    return successResponse(enrollment, 201);
  } catch (error) {
    console.error("Enroll learner error:", error);
    return errorResponse("Internal server error", 500);
  }
}
