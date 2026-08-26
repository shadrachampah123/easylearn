import { NextRequest } from "next/server";
import { db } from "@/db";
import { announcements, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { desc, eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const isPublic = request.nextUrl.searchParams.get("public") === "true";

    const results = await db
      .select({
        id: announcements.id,
        title: announcements.title,
        content: announcements.content,
        isPinned: announcements.isPinned,
        isPublic: announcements.isPublic,
        createdAt: announcements.createdAt,
        authorFirstName: users.firstName,
        authorLastName: users.lastName,
      })
      .from(announcements)
      .leftJoin(users, eq(announcements.authorId, users.id))
      .where(isPublic ? eq(announcements.isPublic, true) : undefined)
      .orderBy(desc(announcements.isPinned), desc(announcements.createdAt))
      .limit(20);

    return successResponse(results);
  } catch (error) {
    console.error("Announcements error:", error);
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
      return errorResponse("Forbidden", 403);
    }

    const body = await request.json();
    const { title, content, classId, isPinned, isPublic } = body;

    if (!title || !content) {
      return errorResponse("Title and content are required");
    }

    const [announcement] = await db.insert(announcements).values({
      title,
      content,
      authorId: payload.userId,
      classId: classId || null,
      isPinned: isPinned || false,
      isPublic: isPublic || false,
    }).returning();

    return successResponse(announcement, 201);
  } catch (error) {
    console.error("Create announcement error:", error);
    return errorResponse("Internal server error", 500);
  }
}
