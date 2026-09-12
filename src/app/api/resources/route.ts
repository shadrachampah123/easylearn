import { NextRequest } from "next/server";
import { db } from "@/db";
import { isSchemaOutOfDate, legacyInsert } from "@/lib/schema-resilience";
import { resources, classes, subjects, users } from "@/db/schema";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { eq, desc, and, ilike, or, isNull, sql } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  hasSchoolStaffRole,
  isClassInSchool,
  sqlUserInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const classId = request.nextUrl.searchParams.get("classId");
    const subjectId = request.nextUrl.searchParams.get("subjectId");
    const type = request.nextUrl.searchParams.get("type");
    const search = request.nextUrl.searchParams.get("search");

    /* Phase 2D: prefer direct school_id, fallback to uploader membership for legacy NULL rows */
    let useDirectRes = true;
    try {
      await db.execute(sql`select "school_id" from "resources" limit 0`);
    } catch {
      useDirectRes = false;
    }
    const conditions = useDirectRes
      ? [
          or(
            eq(resources.schoolId, ctx.schoolId),
            and(isNull(resources.schoolId), sqlUserInSchool(ctx.schoolId, resources.teacherId))
          ),
        ]
      : [sqlUserInSchool(ctx.schoolId, resources.teacherId)];

    if (ctx.school.role === "teacher") {
      conditions.push(eq(resources.teacherId, ctx.userId));
    }

    if (ctx.school.role === "learner" || ctx.school.role === "parent") {
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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolStaffRole(ctx)) {
      return errorResponse("Only teachers can upload resources", 403);
    }

    const body = await request.json();
    const { title, description, type, fileUrl, fileSize, subjectId, classId, termId, topic, week, isPinned } = body;

    if (!title || !type) {
      return errorResponse("Title and type are required");
    }

    /* Phase 2C: a resource may only point at a class of the caller's school. */
    if (classId && !(await isClassInSchool(ctx.schoolId, classId))) {
      return notFoundResponse("Class");
    }

    const isApproved = hasSchoolAdminExtendedRole(ctx);

    let newResource;
    try {
      [newResource] = await db.insert(resources).values({
        schoolId: ctx.schoolId,
        title,
        description: description || null,
        type,
        fileUrl: fileUrl?.trim() || null,
        fileSize: fileSize || null,
        subjectId: subjectId || null,
        classId: classId || null,
        teacherId: ctx.userId,
        termId: termId || null,
        topic: topic || null,
        week: week || null,
        isPinned: isPinned || false,
        isApproved,
      }).returning();
    } catch (error) {
      // Phase 2E (Step 1) — narrow legacy compatibility ONLY: the fallback below may run
      // when this database predates migration 0016 (school_id column/table missing).
      // Any other error (constraint violation, transient DB failure, bad input) is
      // rethrown so a row can never be written without a school.
      if (!isSchemaOutOfDate(error)) throw error;
      [newResource] = await legacyInsert(db, "resources", {
        title,
        description: description || null,
        type,
        fileUrl: fileUrl?.trim() || null,
        fileSize: fileSize || null,
        subjectId: subjectId || null,
        classId: classId || null,
        teacherId: ctx.userId,
        termId: termId || null,
        topic: topic || null,
        week: week || null,
        isPinned: isPinned || false,
        isApproved,
      }, ["id", "title", "description", "type", "fileUrl", "fileSize", "subjectId", "classId", "teacherId", "termId", "topic", "week", "isPinned", "isApproved", "createdAt"]);
    }

    await logActivity({
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      action: "create",
      entityType: "resource",
      entityId: newResource.id,
      description: `Uploaded resource ${newResource.title}`,
      details: JSON.stringify({ title: newResource.title, type: newResource.type }),
    });

    return successResponse(newResource, 201);
  } catch (error) {
    console.error("Create resource error:", error);
    return errorResponse("Internal server error", 500);
  }
}
