import { NextRequest } from "next/server";
import { db } from "@/db";
import { users, classes, subjects, assignments, announcements, attendance } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const role = payload.role;

    if (role === "super_admin" || role === "school_admin") {
      const [totalTeachers] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "teacher"));
      const [totalLearners] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "learner"));
      const [totalParents] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "parent"));
      const [totalClasses] = await db.select({ count: sql<number>`count(*)` }).from(classes);
      const [totalSubjects] = await db.select({ count: sql<number>`count(*)` }).from(subjects);
      const [totalAssignments] = await db.select({ count: sql<number>`count(*)` }).from(assignments);

      return successResponse({
        teachers: Number(totalTeachers.count),
        learners: Number(totalLearners.count),
        parents: Number(totalParents.count),
        classes: Number(totalClasses.count),
        subjects: Number(totalSubjects.count),
        assignments: Number(totalAssignments.count),
      });
    }

    if (role === "teacher") {
      const [myAssignments] = await db.select({ count: sql<number>`count(*)` }).from(assignments).where(eq(assignments.teacherId, payload.userId));
      const [myAnnouncements] = await db.select({ count: sql<number>`count(*)` }).from(announcements).where(eq(announcements.authorId, payload.userId));

      return successResponse({
        assignments: Number(myAssignments.count),
        announcements: Number(myAnnouncements.count),
        classes: 0,
        resources: 0,
      });
    }

    return successResponse({ message: "Dashboard data" });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    return errorResponse("Internal server error", 500);
  }
}
