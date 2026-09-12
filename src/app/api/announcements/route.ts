import { NextRequest } from "next/server";
import { db } from "@/db";
import { announcements, users } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { desc, eq, or, and, isNull, sql } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolRole,
  isClassInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

/**
 * Phase 2C — announcements belong to the school of their AUTHOR.
 *
 * The authenticated branch filters on `author ∈ caller's school` as a SQL predicate, so a
 * private announcement of another school can never appear in a response. The `?public=true`
 * branch is deliberately NOT school-private (see docs/PHASE2C_TENANT_AUTHORIZATION.md):
 * `is_public` means "published to the public website" in the existing design, that website
 * is currently platform-wide and single-school, and scoping it per school site is a Phase
 * 2E/2H (tenant-resolution/branding) concern. It is not extended here and it exposes only
 * rows the application already publishes unauthenticated.
 *
 * Writes require a school context and an authoring role, and a targeted class (when given)
 * must belong to the caller's school.
 */
export async function GET(request: NextRequest) {
  try {
    const isPublic = request.nextUrl.searchParams.get("public") === "true";

    // Public announcements can be accessed without authentication for marketing website
    if (isPublic) {
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
        .where(eq(announcements.isPublic, true))
        .orderBy(desc(announcements.isPinned), desc(announcements.createdAt))
        .limit(20);

      return successResponse(results);
    }

    // Non-public announcements require authentication AND a school context.
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    // Phase 2D: prefer direct school_id, fallback to author membership for legacy NULL rows
    let useDirectAnn = true;
    try {
      await db.execute(sql`select "school_id" from "announcements" limit 0`);
    } catch {
      useDirectAnn = false;
    }
    const whereClause = useDirectAnn
      ? or(
          eq(announcements.schoolId, ctx.schoolId),
          and(isNull(announcements.schoolId), sqlUserInSchool(ctx.schoolId, announcements.authorId))
        )
      : sqlUserInSchool(ctx.schoolId, announcements.authorId);
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
      .where(whereClause)
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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolRole(ctx, "teacher", "head_teacher", "school_admin")) {
      return errorResponse("Only teachers and administrators can create announcements", 403);
    }

    const body = await request.json();
    const { title, content, classId, isPinned, isPublic } = body;

    if (!title || !content) {
      return errorResponse("Title and content are required");
    }

    /* A class-targeted announcement may only point at a class of the caller's school
       (fail closed: an unattributable class is refused, never assumed). */
    if (classId) {
      if (!(await isClassInSchool(ctx.schoolId, classId))) {
        return errorResponse("Class not found", 404);
      }
    }

    let announcement;
    try {
      [announcement] = await db.insert(announcements).values({
        schoolId: ctx.schoolId,
        title,
        content,
        authorId: ctx.userId,
        classId: classId || null,
        isPinned: isPinned || false,
        isPublic: isPublic || false,
      }).returning();
    } catch {
      [announcement] = await db.insert(announcements).values({
        title,
        content,
        authorId: ctx.userId,
        classId: classId || null,
        isPinned: isPinned || false,
        isPublic: isPublic || false,
      } as any).returning();
    }

    await logActivity({
      userId: ctx.userId,
      action: "create",
      entityType: "announcement",
      entityId: announcement.id,
      description: `Created announcement ${announcement.title}`,
    });

    return successResponse(announcement, 201);
  } catch (error) {
    console.error("Create announcement error:", error);
    return errorResponse("Internal server error", 500);
  }
}
