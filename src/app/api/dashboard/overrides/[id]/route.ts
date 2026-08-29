import { NextRequest } from "next/server";
import { db } from "@/db";
import { dashboardCardOverrides } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq } from "drizzle-orm";
import { logActivity } from "@/lib/activity";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const { id } = await params;
    const [override] = await db
      .select()
      .from(dashboardCardOverrides)
      .where(eq(dashboardCardOverrides.id, id))
      .limit(1);

    if (!override) return errorResponse("Override not found", 404);

    return successResponse(override);
  } catch (error) {
    console.error("Dashboard override GET error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Only admins can update overrides", 403);
    }

    const { id } = await params;
    const body = await request.json();

    const [existing] = await db
      .select()
      .from(dashboardCardOverrides)
      .where(eq(dashboardCardOverrides.id, id))
      .limit(1);

    if (!existing) return errorResponse("Override not found", 404);

    const updateData: any = {};
    const allowedFields = [
      "cardKey",
      "dashboardRole",
      "title",
      "label",
      "value",
      "subtitle",
      "description",
      "trend",
      "isVisible",
      "sortOrder",
      "isEnabled",
      "overridePayload",
      "scopeType",
      "scopeId",
    ];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        // Map camelCase to snake_case column names where needed
        const columnMap: Record<string, string> = {
          cardKey: "cardKey",
          dashboardRole: "dashboardRole",
          title: "title",
          label: "label",
          value: "value",
          subtitle: "subtitle",
          description: "description",
          trend: "trend",
          isVisible: "isVisible",
          sortOrder: "sortOrder",
          isEnabled: "isEnabled",
          overridePayload: "overridePayload",
          scopeType: "scopeType",
          scopeId: "scopeId",
        };
        const col = columnMap[field];
        if (col) {
          if (field === "value" && body[field] !== null) {
            updateData[col] = String(body[field]);
          } else if (field === "sortOrder") {
            updateData[col] = Number(body[field]) || 0;
          } else if (field === "isVisible" || field === "isEnabled") {
            updateData[col] = Boolean(body[field]);
          } else {
            updateData[col] = body[field];
          }
        }
      }
    }

    updateData.updatedAt = new Date();

    const [updated] = await db
      .update(dashboardCardOverrides)
      .set(updateData)
      .where(eq(dashboardCardOverrides.id, id))
      .returning();

    await logActivity({
      userId: payload.userId,
      action: "update",
      entityType: "dashboard_card_override",
      entityId: id,
      description: `Updated override for card ${existing.cardKey}`,
      details: JSON.stringify({ updatedFields: Object.keys(updateData) }),
    });

    return successResponse(updated);
  } catch (error) {
    console.error("Dashboard override PUT error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Only admins can delete overrides", 403);
    }

    const { id } = await params;

    const [existing] = await db
      .select()
      .from(dashboardCardOverrides)
      .where(eq(dashboardCardOverrides.id, id))
      .limit(1);

    if (!existing) return errorResponse("Override not found", 404);

    await db.delete(dashboardCardOverrides).where(eq(dashboardCardOverrides.id, id));

    await logActivity({
      userId: payload.userId,
      action: "delete",
      entityType: "dashboard_card_override",
      entityId: id,
      description: `Deleted override for card ${existing.cardKey}`,
      details: JSON.stringify({ cardKey: existing.cardKey }),
    });

    return successResponse({ message: "Override deleted" });
  } catch (error) {
    console.error("Dashboard override DELETE error:", error);
    return errorResponse("Internal server error", 500);
  }
}
