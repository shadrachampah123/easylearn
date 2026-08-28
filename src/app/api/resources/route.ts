import { NextRequest } from "next/server";
import { db } from "@/db";
import { resources, classes, subjects, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, desc, and, ilike, or } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const classId = request.nextUrl.searchParams.get("classId");
    const subjectId = request.nextUrl.searchParams.get("subjectId");
    const type = request.nextUrl.searchParams.get("type");
    const search = request.nextUrl.searchParams.get("search");

    const conditions = [];

    // Teachers see their own resources
    if (payload.role === "teacher") {
      conditions.push(eq(resources.teacherId, payload.userId));
    }

    // Learners only see approved resources
    if (payload.role === "learner" || payload.role === "parent") {
      conditions.push(eq(resources.isApproved, true));
    }

    if (classId) conditions.push(eq(resources.classId, classId));
    if (subjectId) conditions.push(eq(resources.subjectId, subjectId));
    if (type) conditions.push(eq(resources.type, type as "pdf" | "docx" | "pptx" | "image" | "video" | "audio" | "link" | "zip"));
    if (search) {
      conditions.push(
        or(
          ilike(resources.title, `%${search}%`),
          ilike(resources.topic, `%${search}%`)
        )!
      );
    }

    const whereClause = conditions.length > 0
      ? conditions.reduce((a, b) => and(a, b)!)
      : undefined;

    const results = await db
      .select({
        id: resources.id,
        title: resources.title,
        description: resources.description,
        type: resources.type,
        fileUrl: resources.fileUrl,
        fileSize: resources.fileSize,
        topic: resources.topic,
        week: resources.week,
        isPinned: resources.isPinned,
        isApproved: resources.isApproved,
        createdAt: resources.createdAt,
        className: classes.name,
        subjectName: subjects.name,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
      })
      .from(resources)
      .leftJoin(classes, eq(resources.classId, classes.id))
      .leftJoin(subjects, eq(resources.subjectId, subjects.id))
      .leftJoin(users, eq(resources.teacherId, users.id))
      .where(whereClause)
      .orderBy(desc(resources.isPinned), desc(resources.createdAt))
      .limit(100);

    return successResponse(results);
  } catch (error) {
    console.error("Resources list error:", error);
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
      return errorResponse("Only teachers can upload resources", 403);
    }

    const body = await request.json();
    const { title, description, type, fileUrl, fileSize, subjectId, classId, termId, topic, week, isPinned } = body;

    if (!title || !type) {
      return errorResponse("Title and type are required");
    }

    // Auto-approve for admins
    const isApproved = ["super_admin", "school_admin", "head_teacher"].includes(payload.role);

    const [newResource] = await db.insert(resources).values({
      title,
      description: description || null,
      type,
      fileUrl: fileUrl?.trim() || null,
      fileSize: fileSize || null,
      subjectId: subjectId || null,
      classId: classId || null,
      teacherId: payload.userId,
      termId: termId || null,
      topic: topic || null,
      week: week || null,
      isPinned: isPinned || false,
      isApproved,
    }).returning();

    return successResponse(newResource, 201);
  } catch (error) {
    console.error("Create resource error:", error);
    return errorResponse("Internal server error", 500);
  }
}
