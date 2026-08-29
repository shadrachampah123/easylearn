import { NextRequest } from "next/server";
import { db } from "@/db";
import { activityLogs, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { desc, eq, and, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  ensureSchemaFeature,
  isSchemaOutOfDate,
  toSchemaWarning,
} from "@/lib/schema-resilience";

const ENRICHMENT_MIGRATION = "drizzle/0005_activity_enhancements.sql";

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
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20") || 20, 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0") || 0, 0);
    const entityType = url.searchParams.get("entityType");
    const action = url.searchParams.get("action");

    const conditions: any[] = [];

    // entity_type only exists after migration 0005; filtering on it before that throws.
    const enrichment = await ensureSchemaFeature("activity_logs_enrichment");
    const canFilterByEntity = enrichment.available || enrichment.repaired;

    if (entityType && canFilterByEntity) {
      conditions.push(eq(activityLogs.entityType, entityType));
    }

    if (action) {
      conditions.push(eq(activityLogs.action, action));
    }

    const actorAlias = alias(users, "actor");

    const selected = canFilterByEntity
      ? {
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
        }
      : {
          id: activityLogs.id,
          userId: activityLogs.userId,
          action: activityLogs.action,
          entityType: sql<string>`NULL`.as("entity_type"),
          entityId: sql<string>`NULL`.as("entity_id"),
          description: sql<string>`NULL`.as("description"),
          details: activityLogs.details,
          createdAt: activityLogs.createdAt,
          actorFirstName: actorAlias.firstName,
          actorLastName: actorAlias.lastName,
          actorRole: actorAlias.role,
          actorEmail: actorAlias.email,
        };

    let query = db.select(selected).from(activityLogs).leftJoin(actorAlias, eq(activityLogs.userId, actorAlias.id)).$dynamic();
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    if (whereClause) {
      query = query.where(whereClause) as any;
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
      countQuery = countQuery.where(whereClause!) as any;
    }

    const countRows = await (countQuery as any);
    const total = Number(countRows[0]?.count ?? 0);

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
      entityType: r.entityType ?? null,
      entityId: r.entityId ?? null,
      description: r.description || describeFallback(r.action, r.details),
      // details is kept but should be sanitized already at log time
      timestamp: r.createdAt,
    }));

    return successResponse({
      logs: sanitized,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
      ...(canFilterByEntity
        ? {}
        : {
            meta: {
              degraded: true,
              warning: {
                area: "activityLogs",
                message: `Activity details are limited because ${ENRICHMENT_MIGRATION} has not been applied to this database.`,
                migration: ENRICHMENT_MIGRATION,
              },
            },
          }),
    });
  } catch (error) {
    console.error("Activity logs GET error:", error);
    if (isSchemaOutOfDate(error)) {
      // activity_logs itself is missing (fresh or partially migrated database):
      // an empty feed beats a 500 that takes the settings page down with it.
      return successResponse({
        logs: [],
        total: 0,
        limit: 20,
        offset: 0,
        hasMore: false,
        meta: {
          degraded: true,
          warning:
            toSchemaWarning("activityFeed", error, "Activity log") ??
            ({
              area: "activityLogs",
              message: `The activity log is empty because ${ENRICHMENT_MIGRATION} has not been applied.`,
              migration: ENRICHMENT_MIGRATION,
            } as never),
        },
      });
    }
    return errorResponse("The activity log could not be loaded. Please retry.", 503);
  }
}

/** Build a readable sentence for rows logged before migration 0005 added `description`. */
function describeFallback(action: string, details: string | null): string {
  const verb = (action || "activity").replace(/[_-]/g, " ");
  let entity: string | null = null;
  if (details) {
    try {
      const parsed = JSON.parse(details);
      if (parsed && typeof parsed === "object") {
        entity = parsed.entityType || parsed.name || parsed.email || null;
      }
    } catch {
      entity = details.slice(0, 60);
    }
  }
  return entity ? `${verb} ${entity}` : verb;
}
