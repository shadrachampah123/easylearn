import { NextRequest } from "next/server";
import { db } from "@/db";
import { activityLogs, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { desc, eq, and, sql, gte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Only admins can view activity logs", 403);
    }

    const url = request.nextUrl;
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const entityType = url.searchParams.get("entityType");
    const action = url.searchParams.get("action");

    const conditions: any[] = [];

    if (entityType) {
      conditions.push(eq(activityLogs.entityType, entityType));
    }

    if (action) {
      conditions.push(eq(activityLogs.action, action));
    }

    // Optional: filter last 30 days by default? Let's allow all but add index usage
    // We want recent first

    const actorAlias = alias(users, "actor");

    let query = db
      .select({
        id: activityLogs.id,
        userId: activityLogs.userId,
        action: activityLogs.action,
        entityType: activityLogs.entityType,
        entityId: activityLogs.entityId,
        description: activityLogs.description,
        details: activityLogs.details,
        createdAt: activityLogs.createdAt,
        actorFirstName: actorAlias.firstName,
        actorLastName: actorAlias.lastName,
        actorRole: actorAlias.role,
        actorEmail: actorAlias.email,
      })
      .from(activityLogs)
      .leftJoin(actorAlias, eq(activityLogs.userId, actorAlias.id))
      .$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const results = await (query as any)
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit)
      .offset(offset);

    // Also get total count
    let countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(activityLogs)
      .$dynamic();

    if (conditions.length > 0) {
      countQuery = countQuery.where(and(...conditions)) as any;
    }

    const [{ count }] = await (countQuery as any);

    // Sanitize - remove details that might contain sensitive info for display, but keep description
    const sanitized = results.map((r: any) => ({
      id: r.id,
      actor: r.actorFirstName
        ? {
            id: r.userId,
            name: `${r.actorFirstName} ${r.actorLastName}`,
            firstName: r.actorFirstName,
            lastName: r.actorLastName,
            role: r.actorRole,
            email: r.actorEmail,
          }
        : r.userId
        ? { id: r.userId, name: "Unknown User" }
        : { id: null, name: "System" },
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      description: r.description,
      // details is kept but should be sanitized already at log time
      timestamp: r.createdAt,
    }));

    return successResponse({
      logs: sanitized,
      total: Number(count),
      limit,
      offset,
      hasMore: offset + limit < Number(count),
    });
  } catch (error) {
    console.error("Activity logs GET error:", error);
    return errorResponse("Internal server error", 500);
  }
}
