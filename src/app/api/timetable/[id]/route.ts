import { NextRequest } from "next/server";
import { db } from "@/db";
import { timetableEntries } from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  isUserInSchool,
  sqlTimetableInSchool,
} from "@/lib/tenant";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { and, eq } from "drizzle-orm";
import { TIMETABLE_DAYS } from "../route";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function isTimetableDay(value: unknown): value is (typeof TIMETABLE_DAYS)[number] {
  return (
    typeof value === "string" && TIMETABLE_DAYS.includes(value as (typeof TIMETABLE_DAYS)[number])
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminExtendedRole(ctx)) {
      return errorResponse("Only administrators can manage the timetable", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { subjectId, teacherId, dayOfWeek, startTime, endTime, room, color, notes } = body;

    if (dayOfWeek !== undefined && !isTimetableDay(dayOfWeek)) {
      return errorResponse("A valid day is required");
    }

    const start = startTime ?? undefined;
    const end = endTime ?? undefined;

    if ((start !== undefined && !TIME_PATTERN.test(start)) || (end !== undefined && !TIME_PATTERN.test(end))) {
      return errorResponse("Times must use the 24-hour HH:MM format");
    }

    const [existing] = await db
      .select({
        id: timetableEntries.id,
        classId: timetableEntries.classId,
        teacherId: timetableEntries.teacherId,
        createdBy: timetableEntries.createdBy,
        startTime: timetableEntries.startTime,
        endTime: timetableEntries.endTime,
      })
      .from(timetableEntries)
      .where(and(eq(timetableEntries.id, id), sqlTimetableInSchool(ctx.schoolId, timetableEntries.id)))
      .limit(1);

    if (!existing) return notFoundResponse("Timetable entry");

    const finalStart = start ?? existing.startTime;
    const finalEnd = end ?? existing.endTime;

    if (!TIME_PATTERN.test(finalStart) || !TIME_PATTERN.test(finalEnd)) {
      return errorResponse("Times must use the 24-hour HH:MM format");
    }

    if (toMinutes(finalEnd) <= toMinutes(finalStart)) {
      return errorResponse("The end time must be after the start time");
    }

    /* ── TENANT FIRST (Phase 2C review fix F1) ──
       Reassigning a slot to a teacher may only target an ACTIVE member of the caller's
       school; a foreign or membership-less account is reported as missing, exactly like a
       nonexistent one. The slot itself was already proved to belong to this school above.
       Clearing the teacher (`null`/`""`) stays allowed — it assigns nobody. */
    if (teacherId) {
      if (!(await isUserInSchool(ctx.schoolId, teacherId))) {
        return notFoundResponse("Teacher");
      }
    }

    const [updated] = await db
      .update(timetableEntries)
      .set({
        subjectId: subjectId !== undefined ? subjectId || null : undefined,
        teacherId: teacherId !== undefined ? teacherId || null : undefined,
        dayOfWeek: dayOfWeek ?? undefined,
        startTime: start,
        endTime: end,
        room: room !== undefined ? room?.trim() || null : undefined,
        color: color !== undefined ? color || null : undefined,
        notes: notes !== undefined ? notes?.trim() || null : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(timetableEntries.id, id), sqlTimetableInSchool(ctx.schoolId, timetableEntries.id)))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update timetable entry error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminExtendedRole(ctx)) {
      return errorResponse("Only administrators can manage the timetable", 403);
    }

    const { id } = await params;

    const [existing] = await db
      .select({
        id: timetableEntries.id,
      })
      .from(timetableEntries)
      .where(and(eq(timetableEntries.id, id), sqlTimetableInSchool(ctx.schoolId, timetableEntries.id)))
      .limit(1);

    if (!existing) return notFoundResponse("Timetable entry");

    await db.delete(timetableEntries).where(eq(timetableEntries.id, id));

    return successResponse({ message: "Timetable entry deleted" });
  } catch (error) {
    console.error("Delete timetable entry error:", error);
    return errorResponse("Internal server error", 500);
  }
}
