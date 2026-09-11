import { NextRequest } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, desc, sql, and, inArray } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const results = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, payload.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    // Get unread count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(eq(notifications.userId, payload.userId));

    const [{ unread }] = await db
      .select({ unread: sql<number>`count(*)` })
      .from(notifications)
      .where(sql`${notifications.userId} = ${payload.userId} AND ${notifications.isRead} = false`);

    return successResponse({
      notifications: results,
      total: Number(count),
      unread: Number(unread),
    });
  } catch (error) {
    console.error("Notifications error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// Mark notifications as read - secured to only allow updating own notifications
export async function PUT(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const body = await request.json();
    const { notificationIds, markAll } = body;

    if (markAll) {
      await db
        .update(notifications)
        .set({ isRead: true })
        .where(eq(notifications.userId, payload.userId));
    } else if (notificationIds && Array.isArray(notificationIds)) {
      if (notificationIds.length === 0) {
        return errorResponse("No notification IDs provided", 400);
      }
      // Verify ownership: only update notifications belonging to the authenticated user
      // This prevents IDOR where user supplies another user's notification ID
      await db
        .update(notifications)
        .set({ isRead: true })
        .where(and(
          eq(notifications.userId, payload.userId),
          inArray(notifications.id, notificationIds)
        ));

      // Optionally, we could check if any of the supplied IDs did not belong to the user
      // and return 403, but silently ignoring is also safe and doesn't leak existence.
      // For stricter security, verify all IDs belong to user:
      const owned = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(
          eq(notifications.userId, payload.userId),
          inArray(notifications.id, notificationIds)
        ));
      const ownedIds = new Set(owned.map((n) => n.id));
      const unauthorizedIds = notificationIds.filter((id: string) => !ownedIds.has(id));
      if (unauthorizedIds.length > 0 && ownedIds.size === 0) {
        // If none of the IDs belong to user, it might be an attempt to modify others
        // We still return success for owned (none), but we don't expose existence
        // For audit, we could log, but not required for Phase 1
      }
    } else {
      return errorResponse("notificationIds array or markAll flag is required", 400);
    }

    return successResponse({ message: "Notifications marked as read" });
  } catch (error) {
    console.error("Mark notifications error:", error);
    return errorResponse("Internal server error", 500);
  }
}
