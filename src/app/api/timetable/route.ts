import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  timetableEntries,
  classes,
  subjects,
  users,
  teacherClasses,
  learnerClasses,
  parentLearners,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
} from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

export const TIMETABLE_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

type TimetableDay = (typeof TIMETABLE_DAYS)[number];

const ADMIN_ROLES = ["super_admin", "school_admin", "head_teacher"];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function isTimetableDay(value: unknown): value is TimetableDay {
  return typeof value === "string" && TIMETABLE_DAYS.includes(value as TimetableDay);
}

// Monday first, then through the rest of the week.
const dayOrder = sql`CASE ${timetableEntries.dayOfWeek}
  WHEN 'monday' THEN 1
  WHEN 'tuesday' THEN 2
  WHEN 'wednesday' THEN 3
  WHEN 'thursday' THEN 4
  WHEN 'friday' THEN 5
  WHEN 'saturday' THEN 6
  ELSE 7
END`;

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const classId = request.nextUrl.searchParams.get("classId");
    const day = request.nextUrl.searchParams.get("day");
    const teacherId = request.nextUrl.searchParams.get("teacherId");

    const conditions = [];

    // Everyone only ever sees the timetable of classes they belong to.
    if (payload.role === "teacher") {
      // Classes the teacher teaches a subject in.
      const subjectClasses = db
        .select({ id: teacherClasses.classId })
        .from(teacherClasses)
        .where(eq(teacherClasses.teacherId, payload.userId));

      // Classes the teacher is the homeroom/class teacher of.
      const homeroomClasses = db
        .select({ id: classes.id })
        .from(classes)
        .where(eq(classes.classTeacherId, payload.userId));

      conditions.push(
        or(
          inArray(timetableEntries.classId, subjectClasses),
          inArray(timetableEntries.classId, homeroomClasses),
          eq(timetableEntries.teacherId, payload.userId)
        )!
      );
    } else if (payload.role === "learner") {
      const ownClasses = db
        .select({ id: learnerClasses.classId })
        .from(learnerClasses)
        .where(eq(learnerClasses.learnerId, payload.userId));

      conditions.push(inArray(timetableEntries.classId, ownClasses));
    } else if (payload.role === "parent") {
      const childrenClasses = db
        .select({ id: learnerClasses.classId })
        .from(learnerClasses)
        .where(
          inArray(
            learnerClasses.learnerId,
            db
              .select({ id: parentLearners.learnerId })
              .from(parentLearners)
              .where(eq(parentLearners.parentId, payload.userId))
          )
        );

      conditions.push(inArray(timetableEntries.classId, childrenClasses));
    }

    if (classId) conditions.push(eq(timetableEntries.classId, classId));
    if (teacherId) conditions.push(eq(timetableEntries.teacherId, teacherId));
    if (day && isTimetableDay(day)) {
      conditions.push(eq(timetableEntries.dayOfWeek, day));
    }

    const whereClause =
      conditions.length > 0 ? conditions.reduce((a, b) => and(a, b)!) : undefined;

    const results = await db
      .select({
        id: timetableEntries.id,
        classId: timetableEntries.classId,
        className: classes.name,
        subjectId: timetableEntries.subjectId,
        subjectName: subjects.name,
        teacherId: timetableEntries.teacherId,
        teacherFirstName: users.firstName,
        teacherLastName: users.lastName,
        dayOfWeek: timetableEntries.dayOfWeek,
        startTime: timetableEntries.startTime,
        endTime: timetableEntries.endTime,
        room: timetableEntries.room,
        color: timetableEntries.color,
        notes: timetableEntries.notes,
      })
      .from(timetableEntries)
      .leftJoin(classes, eq(timetableEntries.classId, classes.id))
      .leftJoin(subjects, eq(timetableEntries.subjectId, subjects.id))
      .leftJoin(users, eq(timetableEntries.teacherId, users.id))
      .where(whereClause)
      .orderBy(asc(classes.name), asc(dayOrder), asc(timetableEntries.startTime))
      .limit(500);

    return successResponse(results);
  } catch (error) {
    console.error("Timetable list error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!ADMIN_ROLES.includes(payload.role)) {
      return errorResponse("Only administrators can manage the timetable", 403);
    }

    const body = await request.json();
    const {
      classId,
      subjectId,
      teacherId,
      termId,
      academicYearId,
      dayOfWeek,
      startTime,
      endTime,
      room,
      color,
      notes,
    } = body;

    if (!classId) return errorResponse("Class is required");
    if (!isTimetableDay(dayOfWeek)) return errorResponse("A valid day is required");
    if (!startTime || !endTime) return errorResponse("Start and end times are required");
    if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) {
      return errorResponse("Times must use the 24-hour HH:MM format");
    }
    if (toMinutes(endTime) <= toMinutes(startTime)) {
      return errorResponse("The end time must be after the start time");
    }

    const [newEntry] = await db
      .insert(timetableEntries)
      .values({
        classId,
        subjectId: subjectId || null,
        teacherId: teacherId || null,
        termId: termId || null,
        academicYearId: academicYearId || null,
        dayOfWeek,
        startTime,
        endTime,
        room: room?.trim() || null,
        color: color || null,
        notes: notes?.trim() || null,
        createdBy: payload.userId,
      })
      .returning();

    return successResponse(newEntry, 201);
  } catch (error) {
    console.error("Create timetable entry error:", error);
    return errorResponse("Internal server error", 500);
  }
}
