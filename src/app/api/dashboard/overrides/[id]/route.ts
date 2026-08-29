import { NextRequest } from "next/server";
import { db } from "@/db";
import { dashboardCardOverrides } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import { UUID_PATTERN, normalizeOverrideInput } from "@/lib/dashboard-overrides";
import {
  ensureSchemaFeature,
  isSchemaOutOfDate,
  toSchemaWarning,
} from "@/lib/schema-resilience";

const OVERRIDES_MIGRATION = "drizzle/0004_dashboard_overrides.sql";

const ADMIN_ROLES = ["super_admin", "school_admin", "head_teacher"];

function notMigratedResponse(error?: unknown) {
  const warning = error ? toSchemaWarning("overrides", error, "Card overrides") : null;
  return errorResponse(
    warning?.message ??
      `Card overrides are not available yet: ${OVERRIDES_MIGRATION} has not been applied to this database. Run \`node run-migration.js ${OVERRIDES_MIGRATION.split("/").pop()}\` and try again.`,
    503
  );
}

function parseId(rawId: string): string | null {
  const id = decodeURIComponent(rawId || "").trim();
  return UUID_PATTERN.test(id) ? id : null;
}

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) return { error: unauthorizedResponse() as Response };
  const payload = await verifyToken(token);
  if (!payload) return { error: unauthorizedResponse() as Response };
  if (!ADMIN_ROLES.includes(payload.role)) {
    return { error: errorResponse("Only admins can change dashboard card overrides", 403) as Response };
  }
  return { payload };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const { id } = await params;
    const overrideId = parseId(id);
    if (!overrideId) return errorResponse("Override id must be a uuid", 400);

    const status = await ensureSchemaFeature("dashboard_card_overrides");
    if (!status.available) return notMigratedResponse();

    const [override] = await db
      .select()
      .from(dashboardCardOverrides)
      .where(eq(dashboardCardOverrides.id, overrideId))
      .limit(1);

    if (!override) return notFoundResponse("Override");

    return successResponse(override);
  } catch (error) {
    console.error("Dashboard override GET error:", error);
    if (isSchemaOutOfDate(error)) return notMigratedResponse(error);
    return errorResponse("The override could not be loaded. Please retry.", 503);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const payload = auth.payload!;

    const { id } = await params;
    const overrideId = parseId(id);
    if (!overrideId) return errorResponse("Override id must be a uuid", 400);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return errorResponse("Invalid request body", 400);
    }

    const normalized = normalizeOverrideInput(body as Record<string, unknown>, { partial: true });
    if (!normalized.ok) {
      return errorResponse(normalized.problems.map((problem) => problem.message).join("; "), 400);
    }

    const status = await ensureSchemaFeature("dashboard_card_overrides");
    if (!status.available) return notMigratedResponse();

    const [existing] = await db
      .select()
      .from(dashboardCardOverrides)
      .where(eq(dashboardCardOverrides.id, overrideId))
      .limit(1);

    if (!existing) return notFoundResponse("Override");

    const updateData: Record<string, unknown> = { ...(normalized.values as Record<string, unknown>) };
    // Nothing to do when the body carried no writable fields - avoids an empty SET error.
    if (Object.keys(updateData).length === 0) {
      return successResponse(existing);
    }
    updateData.updatedAt = new Date();

    const [updated] = await db
      .update(dashboardCardOverrides)
      .set(updateData as any)
      .where(eq(dashboardCardOverrides.id, overrideId))
      .returning();

    await logActivity({
      userId: payload.userId,
      action: "update",
      entityType: "dashboard_card_override",
      entityId: overrideId,
      description: `Updated override for card ${existing.cardKey}`,
      details: JSON.stringify({ updatedFields: Object.keys(updateData) }),
    });

    return successResponse(updated);
  } catch (error) {
    console.error("Dashboard override PUT error:", error);
    if (isSchemaOutOfDate(error)) return notMigratedResponse(error);
    return errorResponse("The override could not be saved. Please retry.", 503);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const payload = auth.payload!;

    const { id } = await params;
    const overrideId = parseId(id);
    if (!overrideId) return errorResponse("Override id must be a uuid", 400);

    const status = await ensureSchemaFeature("dashboard_card_overrides");
    if (!status.available) return notMigratedResponse();

    const [existing] = await db
      .select()
      .from(dashboardCardOverrides)
      .where(eq(dashboardCardOverrides.id, overrideId))
      .limit(1);

    if (!existing) return notFoundResponse("Override");

    await db.delete(dashboardCardOverrides).where(eq(dashboardCardOverrides.id, overrideId));

    await logActivity({
      userId: payload.userId,
      action: "delete",
      entityType: "dashboard_card_override",
      entityId: overrideId,
      description: `Deleted override for card ${existing.cardKey}`,
      details: JSON.stringify({ cardKey: existing.cardKey }),
    });

    return successResponse({ message: "Override deleted" });
  } catch (error) {
    console.error("Dashboard override DELETE error:", error);
    if (isSchemaOutOfDate(error)) return notMigratedResponse(error);
    return errorResponse("The override could not be deleted. Please retry.", 503);
  }
}
