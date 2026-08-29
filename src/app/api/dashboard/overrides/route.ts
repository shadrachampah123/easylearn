import { NextRequest } from "next/server";
import { db } from "@/db";
import { dashboardCardOverrides } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, desc, and, or, ilike } from "drizzle-orm";
import { logActivity } from "@/lib/activity";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    // Only admins can view all overrides, but we allow teachers to see their own role overrides? Requirement says only admins can create/change, but viewing is for admin UI.
    // For transparency, allow any authenticated to read overrides for their dashboard role
    const role = payload.role;
    const isAdmin = ["super_admin", "school_admin", "head_teacher"].includes(role);

    const url = request.nextUrl;
    const dashboardRole = url.searchParams.get("dashboardRole");
    const cardKey = url.searchParams.get("cardKey");
    const search = url.searchParams.get("search");

    let query = db.select().from(dashboardCardOverrides).$dynamic();

    const conditions: any[] = [];

    if (dashboardRole) {
      conditions.push(eq(dashboardCardOverrides.dashboardRole, dashboardRole as any));
    }

    if (cardKey) {
      conditions.push(eq(dashboardCardOverrides.cardKey, cardKey));
    }

    if (search) {
      conditions.push(
        or(
          ilike(dashboardCardOverrides.cardKey, `%${search}%`),
          ilike(dashboardCardOverrides.title, `%${search}%`),
          ilike(dashboardCardOverrides.label, `%${search}%`)
        )
      );
    }

    // Non-admins can only see overrides for their dashboard
    if (!isAdmin) {
      const roleMap: Record<string, string> = {
        teacher: "teacher",
        learner: "learner",
        parent: "parent",
      };
      const allowedRole = roleMap[role] || "global";
      conditions.push(
        or(
          eq(dashboardCardOverrides.dashboardRole, allowedRole as any),
          eq(dashboardCardOverrides.dashboardRole, "global" as any)
        )
      );
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const results = await (query as any).orderBy(desc(dashboardCardOverrides.updatedAt));

    return successResponse(results);
  } catch (error) {
    console.error("Dashboard overrides GET error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Only admins can create overrides", 403);
    }

    const body = await request.json();
    const {
      cardKey,
      dashboardRole = "global",
      title,
      label,
      value,
      subtitle,
      description,
      trend,
      isVisible = true,
      sortOrder = 0,
      isEnabled = true,
      overridePayload,
      scopeType = "global",
      scopeId = null,
    } = body;

    if (!cardKey) {
      return errorResponse("cardKey is required", 400);
    }

    const [created] = await db
      .insert(dashboardCardOverrides)
      .values({
        cardKey,
        dashboardRole: dashboardRole as any,
        title: title || null,
        label: label || null,
        value: value !== undefined ? String(value) : null,
        subtitle: subtitle || null,
        description: description || null,
        trend: trend || null,
        isVisible: Boolean(isVisible),
        sortOrder: Number(sortOrder) || 0,
        isEnabled: Boolean(isEnabled),
        overridePayload: overridePayload || null,
        scopeType: scopeType as any,
        scopeId: scopeId || null,
        createdBy: payload.userId,
      })
      .returning();

    await logActivity({
      userId: payload.userId,
      action: "create",
      entityType: "dashboard_card_override",
      entityId: created.id,
      description: `Created override for card ${cardKey} on ${dashboardRole} dashboard`,
      details: JSON.stringify({ cardKey, dashboardRole, scopeType, scopeId }),
    });

    return successResponse(created, 201);
  } catch (error) {
    console.error("Dashboard overrides POST error:", error);
    return errorResponse("Internal server error", 500);
  }
}
