import { NextRequest } from "next/server";
import { db } from "@/db";
import { isSchemaOutOfDate, legacyInsert } from "@/lib/schema-resilience";
import {
  timetableEntries,
  classes,
  subjects,
  users,
  teacherClasses,
  learnerClasses,
  parentLearners,
} from "@/db/schema";
import {
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  isClassInSchool,
  isUserInSchool,
  sqlTimetableInSchool,
} from "@/lib/tenant";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { and, asc, eq, inArray, sql, or, isNull } from "drizzle-orm";

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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const classId = request.nextUrl.searchParams.get("classId");
    const day = request.nextUrl.searchParams.get("day");
    const teacherId = request.nextUrl.searchParams.get("teacherId");

    /* Phase 2D: prefer direct school_id, fallback to relational for legacy NULL rows */
    let useDirectTT = true;
    try {
      await db.execute(sql`select "school_id" from "timetable_entries" limit 0`);
    } catch {
      useDirectTT = false;
    }
    const conditions = useDirectTT
      ? [
          or(
            eq(timetableEntries.schoolId, ctx.schoolId),
            and(isNull(timetableEntries.schoolId), sqlTimetableInSchool(ctx.schoolId, timetableEntries.id))
          ),
        ]
      : [sqlTimetableInSchool(ctx.schoolId, timetableEntries.id)];

    // Everyone only ever sees the timetable of classes they belong to.
    if (ctx.school.role === "teacher") {
      const [subjectClasses, homeroomClasses, scheduledClasses] = await Promise.all([
        // Classes the teacher teaches a subject in.
        db
          .select({ classId: teacherClasses.classId })
          .from(teacherClasses)
          .where(eq(teacherClasses.teacherId, ctx.userId)),
        // Classes the teacher is the homeroom/class teacher of.
        db
          .select({ classId: classes.id })
          .from(classes)
          .where(eq(classes.classTeacherId, ctx.userId)),
        // Admins can also assign a teacher directly on timetable rows, even when
        // there is no separate teacher_classes record yet. Once a teacher owns at
        // least one published period in a class, they should be able to open the
        // whole class timetable rather than seeing an empty timetable page.
        db
          .select({ classId: timetableEntries.classId })
          .from(timetableEntries)
          .where(eq(timetableEntries.teacherId, ctx.userId)),
      ]);

      const teacherClassIds = [
        ...new Set(
          [...subjectClasses, ...homeroomClasses, ...scheduledClasses]
            .map((row) => row.classId)
            .filter((value): value is string => Boolean(value))
        ),
      ];

      conditions.push(
        teacherClassIds.length > 0
          ? inArray(timetableEntries.classId, teacherClassIds)
          : sql`false`
      );
    } else if (ctx.school.role === "learner") {
      const ownClasses = db
        .select({ id: learnerClasses.classId })
        .from(learnerClasses)
        .where(eq(learnerClasses.learnerId, ctx.userId));

      conditions.push(inArray(timetableEntries.classId, ownClasses));
    } else if (ctx.school.role === "parent") {
      const childrenClasses = db
        .select({ id: learnerClasses.classId })
        .from(learnerClasses)
        .where(
          inArray(
            learnerClasses.learnerId,
            db
              .select({ id: parentLearners.learnerId })
              .from(parentLearners)
              .where(eq(parentLearners.parentId, ctx.userId))
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
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminExtendedRole(ctx)) {
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

    /* ── TENANT FIRST (Phase 2C review fix F1) ──
       A slot may only reference a class — and a teacher — that belong to the caller's
       school. Both are resolved through the central relational predicates, so a foreign
       (or unattributable) id is reported exactly like a missing one and can never create
       a cross-school timetable row. */
    if (!(await isClassInSchool(ctx.schoolId, classId))) {
      return notFoundResponse("Class");
    }

    if (teacherId && !(await isUserInSchool(ctx.schoolId, teacherId))) {
      return notFoundResponse("Teacher");
    }

    let newEntry;
    try {
      [newEntry] = await db
        .insert(timetableEntries)
        .values({
          schoolId: ctx.schoolId,
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
          createdBy: ctx.userId,
        })
        .returning();
    } catch (error) {
      // Phase 2E (Step 1) — narrow legacy compatibility ONLY: the fallback below may run
      // when this database predates migration 0016 (school_id column/table missing).
      // Any other error (constraint violation, transient DB failure, bad input) is
      // rethrown so a row can never be written without a school.
      if (!isSchemaOutOfDate(error)) throw error;
      [newEntry] = await legacyInsert(db, "timetable_entries", {
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
        createdBy: ctx.userId,
      }, ["id", "classId", "subjectId", "teacherId", "termId", "academicYearId", "dayOfWeek", "startTime", "endTime", "room", "color", "notes", "createdBy", "createdAt", "updatedAt"]);
    }

    return successResponse(newEntry, 201);
  } catch (error) {
    console.error("Create timetable entry error:", error);
    return errorResponse("Internal server error", 500);
  }
}
