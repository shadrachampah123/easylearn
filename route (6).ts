import { NextRequest } from "next/server";
import { db } from "@/db";
import { attendance, users, classes, learnerClasses } from "@/db/schema";
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
    const date = request.nextUrl.searchParams.get("date");
    const learnerId = request.nextUrl.searchParams.get("learnerId");

    const conditions = [];

    if (classId) conditions.push(eq(attendance.classId, classId));
    if (date) conditions.push(eq(attendance.date, date));
    if (learnerId) conditions.push(eq(attendance.learnerId, learnerId));

    // Parents can only see their children's attendance
    if (payload.role === "learner") {
      conditions.push(eq(attendance.learnerId, payload.userId));
    }

    const whereClause = conditions.length > 0
      ? conditions.reduce((a, b) => and(a, b)!)
      : undefined;

    const results = await db
      .select({
        id: attendance.id,
        date: attendance.date,
        isPresent: attendance.isPresent,
        note: attendance.note,
        createdAt: attendance.createdAt,
        learnerFirstName: users.firstName,
        learnerLastName: users.lastName,
        learnerId: attendance.learnerId,
        className: classes.name,
      })
      .from(attendance)
      .leftJoin(users, eq(attendance.learnerId, users.id))
      .leftJoin(classes, eq(attendance.classId, classes.id))
      .where(whereClause)
      .orderBy(desc(attendance.date))
      .limit(200);

    return successResponse(results);
  } catch (error) {
    console.error("Attendance list error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher", "teacher"].includes(payload.role)) {
      return errorResponse("Only teachers can mark attendance", 403);
    }

    const body = await request.json();
    const { classId, date, records } = body;

    if (!classId || !date || !records || !Array.isArray(records)) {
      return errorResponse("Class ID, date, and attendance records are required");
    }

    // Delete existing attendance for this class/date
    await db
      .delete(attendance)
      .where(and(
        eq(attendance.classId, classId),
        eq(attendance.date, date)
      ));

    // Insert new attendance records
    const attendanceRecords = records.map((r: { learnerId: string; isPresent: boolean; note?: string }) => ({
      learnerId: r.learnerId,
      classId,
      date,
      isPresent: r.isPresent,
      note: r.note || null,
      markedById: payload.userId,
    }));

    if (attendanceRecords.length > 0) {
      await db.insert(attendance).values(attendanceRecords);
    }

    return successResponse({ message: "Attendance saved", count: attendanceRecords.length }, 201);
  } catch (error) {
    console.error("Save attendance error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// Get learners for a class (to show attendance form)
export async function PUT(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const body = await request.json();
    const { classId } = body;

    if (!classId) {
      return errorResponse("Class ID is required");
    }

    // Get all learners enrolled in this class
    const learners = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(learnerClasses)
      .leftJoin(users, eq(learnerClasses.learnerId, users.id))
      .where(eq(learnerClasses.classId, classId));

    return successResponse(learners);
  } catch (error) {
    console.error("Get class learners error:", error);
    return errorResponse("Internal server error", 500);
  }
}
