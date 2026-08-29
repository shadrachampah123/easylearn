import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  users,
  assignments,
  submissions,
  attendance,
  learnerClasses,
  classes,
  parentLearners,
  announcements,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc, and } from "drizzle-orm";
import { getOverridesForDashboard, applyOverrides } from "@/lib/dashboard-overrides";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["parent", "school_admin", "super_admin"].includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    const parentId = payload.role === "parent" ? payload.userId : (request.nextUrl.searchParams.get("parentId") || payload.userId);
    const learnerIdParam = request.nextUrl.searchParams.get("learnerId");

    // Get linked children
    const links = await db
      .select({
        learnerId: parentLearners.learnerId,
        relationship: parentLearners.relationship,
      })
      .from(parentLearners)
      .where(eq(parentLearners.parentId, parentId));

    const learnerIds = links.map(l => l.learnerId);

    if (learnerIds.length === 0) {
      return successResponse({
        children: [],
        stats: {},
        message: "No children linked",
      });
    }

    // If specific learner requested, verify it's linked
    let targetLearnerId = learnerIdParam || learnerIds[0];
    if (learnerIdParam && !learnerIds.includes(learnerIdParam)) {
      return errorResponse("Learner not linked to this parent", 403);
    }

    // Get learner info
    const [learner] = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, targetLearnerId))
      .limit(1);

    // Get learner's class
    const learnerClass = await db
      .select({
        classId: learnerClasses.classId,
        className: classes.name,
        classLevel: classes.level,
      })
      .from(learnerClasses)
      .leftJoin(classes, eq(learnerClasses.classId, classes.id))
      .where(eq(learnerClasses.learnerId, targetLearnerId))
      .orderBy(desc(learnerClasses.createdAt))
      .limit(1);

    const classId = learnerClass[0]?.classId;

    // Grades - average
    const learnerSubmissions = await db
      .select({
        percentage: submissions.percentage,
        subjectId: sql<string>`(SELECT subject_id FROM assignments WHERE id = ${submissions.assignmentId})`,
      })
      .from(submissions)
      .where(and(eq(submissions.learnerId, targetLearnerId), eq(submissions.status, "graded" as any)));

    const avgGrade =
      learnerSubmissions.length > 0
        ? Math.round(learnerSubmissions.reduce((sum, s) => sum + (s.percentage || 0), 0) / learnerSubmissions.length)
        : 0;

    // Subject performance
    const subjectMap = new Map<string, { total: number; count: number; name: string }>();
    for (const sub of learnerSubmissions) {
      // Get subject name
      const subj = await db
        .select({ name: sql<string>`(SELECT name FROM subjects WHERE id = ${sub.subjectId})` })
        .from(submissions)
        .limit(1);
      // Simplified: we will aggregate by subjectId
      const key = sub.subjectId || "unknown";
      const existing = subjectMap.get(key) || { total: 0, count: 0, name: key };
      existing.total += sub.percentage || 0;
      existing.count += 1;
      subjectMap.set(key, existing);
    }

    // Better: get subject averages via join
    const subjectAverages = await db
      .select({
        subjectName: sql<string>`(SELECT name FROM subjects WHERE id = (SELECT subject_id FROM assignments WHERE id = ${submissions.assignmentId}))`,
        avg: sql<number>`AVG(${submissions.percentage})`,
      })
      .from(submissions)
      .where(and(eq(submissions.learnerId, targetLearnerId), eq(submissions.status, "graded" as any)))
      .groupBy(sql`(SELECT name FROM subjects WHERE id = (SELECT subject_id FROM assignments WHERE id = ${submissions.assignmentId}))`);

    // Attendance
    const attendanceRecords = await db
      .select({
        isPresent: attendance.isPresent,
      })
      .from(attendance)
      .where(eq(attendance.learnerId, targetLearnerId));

    const present = attendanceRecords.filter(r => r.isPresent).length;
    const totalAttendance = attendanceRecords.length;
    const attendanceRate = totalAttendance > 0 ? Math.round((present / totalAttendance) * 100) : 0;

    // Pending assignments
    let pendingCount = 0;
    if (classId) {
      const allAssignments = await db
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.classId, classId), eq(assignments.status, "published" as any)));

      const subs = await db
        .select({ assignmentId: submissions.assignmentId })
        .from(submissions)
        .where(eq(submissions.learnerId, targetLearnerId));

      const subSet = new Set(subs.map(s => s.assignmentId));
      pendingCount = allAssignments.filter(a => !subSet.has(a.id)).length;
    }

    // Class rank
    let classRank: number | null = null;
    if (classId) {
      const classmates = await db
        .select({ learnerId: learnerClasses.learnerId })
        .from(learnerClasses)
        .where(eq(learnerClasses.classId, classId));

      const ranks = await Promise.all(
        classmates.map(async (c) => {
          const subs = await db
            .select({ percentage: submissions.percentage })
            .from(submissions)
            .where(and(eq(submissions.learnerId, c.learnerId), eq(submissions.status, "graded" as any)));
          const avg = subs.length > 0 ? subs.reduce((sum, s) => sum + (s.percentage || 0), 0) / subs.length : 0;
          return { learnerId: c.learnerId, avg };
        })
      );
      ranks.sort((a, b) => b.avg - a.avg);
      const idx = ranks.findIndex(r => r.learnerId === targetLearnerId);
      if (idx >= 0) classRank = idx + 1;
    }

    // Homework due (pending assignments with due dates)
    const homeworkDue = classId
      ? await db
          .select({
            id: assignments.id,
            title: assignments.title,
            dueDate: assignments.dueDate,
          })
          .from(assignments)
          .where(and(eq(assignments.classId, classId), eq(assignments.status, "published" as any)))
          .orderBy(assignments.dueDate)
          .limit(5)
      : [];

    const filteredHomework = [];
    for (const hw of homeworkDue) {
      const sub = await db
        .select()
        .from(submissions)
        .where(and(eq(submissions.learnerId, targetLearnerId), eq(submissions.assignmentId, hw.id)))
        .limit(1);
      filteredHomework.push({
        id: hw.id,
        title: hw.title,
        due: hw.dueDate,
        status: sub.length > 0 ? sub[0].status : "pending",
      });
    }

    // Announcements
    const recentAnnouncements = await db
      .select({
        id: announcements.id,
        title: announcements.title,
        createdAt: announcements.createdAt,
      })
      .from(announcements)
      .orderBy(desc(announcements.createdAt))
      .limit(3);

    const liveData = {
      parent_average_grade: { value: `${avgGrade}%`, label: "Average Grade", icon: "📊", color: "bg-blue-100", numericValue: avgGrade },
      parent_attendance: { value: `${attendanceRate}%`, label: "Attendance", icon: "✅", color: "bg-green-100", numericValue: attendanceRate },
      parent_pending_work: { value: pendingCount, label: "Pending Work", icon: "📝", color: "bg-orange-100" },
      parent_class_rank: { value: classRank ? `#${classRank}` : "—", label: "Class Rank", icon: "🏆", color: "bg-purple-100", numericValue: classRank },
    };

    const overrides = await getOverridesForDashboard("parent", [
      { type: "parent", id: parentId },
      { type: "learner", id: targetLearnerId },
      ...(classId ? [{ type: "class", id: classId }] : []),
    ]);

    const mergedStats = applyOverrides(liveData, overrides);

    // Get all children details
    const childrenDetails = await Promise.all(
      learnerIds.map(async (lid) => {
        const [u] = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(eq(users.id, lid)).limit(1);
        const lc = await db.select({ className: classes.name }).from(learnerClasses).leftJoin(classes, eq(learnerClasses.classId, classes.id)).where(eq(learnerClasses.learnerId, lid)).limit(1);
        return {
          id: lid,
          firstName: u?.firstName,
          lastName: u?.lastName,
          email: u?.email,
          className: lc[0]?.className,
          relationship: links.find(l => l.learnerId === lid)?.relationship,
        };
      })
    );

    return successResponse({
      children: childrenDetails,
      selectedChild: learner
        ? {
            id: learner.id,
            firstName: learner.firstName,
            lastName: learner.lastName,
            className: learnerClass[0]?.className,
            classLevel: learnerClass[0]?.classLevel,
          }
        : null,
      stats: mergedStats,
      rawStats: {
        averageGrade: avgGrade,
        attendanceRate,
        pendingWork: pendingCount,
        classRank,
        present,
        totalAttendance,
      },
      subjectPerformance: subjectAverages.map(s => ({
        subject: s.subjectName,
        score: Math.round(Number(s.avg)),
      })),
      homeworkDue: filteredHomework,
      announcements: recentAnnouncements,
      attendance: {
        rate: attendanceRate,
        present,
        total: totalAttendance,
      },
    });
  } catch (error) {
    console.error("Parent dashboard error:", error);
    return errorResponse("Internal server error", 500);
  }
}
