import { NextRequest } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, desc, sql } from "drizzle-orm";

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

// Mark notifications as read
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
      for (const id of notificationIds) {
        await db
          .update(notifications)
          .set({ isRead: true })
          .where(eq(notifications.id, id));
      }
    }

    return successResponse({ message: "Notifications marked as read" });
  } catch (error) {
    console.error("Mark notifications error:", error);
    return errorResponse("Internal server error", 500);
  }
}
