import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  users,
  classes,
  subjects,
  assignments,
  submissions,
  attendance,
  announcements,
  resources,
  learnerClasses,
  teacherClasses,
  activityLogs,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc, and, gte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getOverridesForDashboard, applyOverrides } from "@/lib/dashboard-overrides";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    // Live metrics
    const [totalTeachers] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "teacher"));
    const [totalLearners] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "learner"));
    const [totalParents] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "parent"));
    const [totalClasses] = await db.select({ count: sql<number>`count(*)` }).from(classes);
    const [totalSubjects] = await db.select({ count: sql<number>`count(*)` }).from(subjects);
    const [totalAssignments] = await db.select({ count: sql<number>`count(*)` }).from(assignments);
    const [totalResources] = await db.select({ count: sql<number>`count(*)` }).from(resources);
    const [totalAnnouncements] = await db.select({ count: sql<number>`count(*)` }).from(announcements);

    // Attendance overview by level
    const attendanceByLevel = await db
      .select({
        level: classes.level,
        total: sql<number>`count(${attendance.id})`,
        present: sql<number>`count(*) FILTER (WHERE ${attendance.isPresent} = true)`,
      })
      .from(attendance)
      .leftJoin(classes, eq(attendance.classId, classes.id))
      .groupBy(classes.level);

    const attendanceOverview = attendanceByLevel.map((row) => ({
      level: row.level,
      total: Number(row.total),
      present: Number(row.present),
      pct: Number(row.total) > 0 ? Math.round((Number(row.present) / Number(row.total)) * 100) : 0,
    }));

    // If no attendance data, return empty
    // Top performing classes by average submission percentage
    const classPerformance = await db
      .select({
        classId: classes.id,
        className: classes.name,
        avgScore: sql<number>`COALESCE(AVG(${submissions.percentage}), 0)`,
        totalSubmissions: sql<number>`count(${submissions.id})`,
      })
      .from(classes)
      .leftJoin(assignments, eq(assignments.classId, classes.id))
      .leftJoin(submissions, eq(submissions.assignmentId, assignments.id))
      .groupBy(classes.id, classes.name)
      .orderBy(sql`COALESCE(AVG(${submissions.percentage}), 0) DESC`)
      .limit(5);

    const topClasses = classPerformance.map((c) => ({
      classId: c.classId,
      className: c.className,
      avg: Math.round(Number(c.avgScore)),
      submissions: Number(c.totalSubmissions),
    }));

    // Recent activity from activity_logs
    const actorAlias = alias(users, "actor");
    const recentActivity = await db
      .select({
        id: activityLogs.id,
        action: activityLogs.action,
        entityType: activityLogs.entityType,
        entityId: activityLogs.entityId,
        description: activityLogs.description,
        createdAt: activityLogs.createdAt,
        actorFirstName: actorAlias.firstName,
        actorLastName: actorAlias.lastName,
        actorRole: actorAlias.role,
      })
      .from(activityLogs)
      .leftJoin(actorAlias, eq(activityLogs.userId, actorAlias.id))
      .orderBy(desc(activityLogs.createdAt))
      .limit(10);

    const activityFeed = recentActivity.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      description: a.description || `${a.action} ${a.entityType || "record"}`,
      actor: a.actorFirstName ? `${a.actorFirstName} ${a.actorLastName}` : "System",
      actorRole: a.actorRole,
      timestamp: a.createdAt,
    }));

    // Live data structure for overrides
    const liveData = {
      admin_total_teachers: { value: Number(totalTeachers.count), label: "Total Teachers", icon: "👩‍🏫", color: "bg-blue-100" },
      admin_total_learners: { value: Number(totalLearners.count), label: "Total Learners", icon: "🎓", color: "bg-green-100" },
      admin_total_parents: { value: Number(totalParents.count), label: "Total Parents", icon: "👨‍👩‍👧", color: "bg-purple-100" },
      admin_total_classes: { value: Number(totalClasses.count), label: "Classes", icon: "🏫", color: "bg-orange-100" },
      admin_total_subjects: { value: Number(totalSubjects.count), label: "Subjects", icon: "📚", color: "bg-pink-100" },
      admin_total_assignments: { value: Number(totalAssignments.count), label: "Assignments", icon: "📝", color: "bg-yellow-100" },
      admin_total_resources: { value: Number(totalResources.count), label: "Resources", icon: "📚", color: "bg-cyan-100" },
      admin_total_announcements: { value: Number(totalAnnouncements.count), label: "Announcements", icon: "📢", color: "bg-indigo-100" },
    };

    // Fetch overrides
    const overrides = await getOverridesForDashboard("admin");
    const mergedStats = applyOverrides(liveData, overrides);

    return successResponse({
      stats: mergedStats,
      rawStats: {
        teachers: Number(totalTeachers.count),
        learners: Number(totalLearners.count),
        parents: Number(totalParents.count),
        classes: Number(totalClasses.count),
        subjects: Number(totalSubjects.count),
        assignments: Number(totalAssignments.count),
        resources: Number(totalResources.count),
        announcements: Number(totalAnnouncements.count),
      },
      attendanceOverview: attendanceOverview.length > 0 ? attendanceOverview : [],
      topClasses: topClasses.filter(c => c.submissions > 0),
      recentActivity: activityFeed,
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    return errorResponse("Internal server error", 500);
  }
}
