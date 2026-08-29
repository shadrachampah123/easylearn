import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { dashboardCardOverrides } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, desc, and, or, ilike } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import {
  OVERRIDE_DASHBOARD_ROLES,
  normalizeOverrideInput,
} from "@/lib/dashboard-overrides";
import {
  ensureSchemaFeature,
  inspectDbError,
  isSchemaOutOfDate,
  toSchemaWarning,
  type SchemaWarning,
} from "@/lib/schema-resilience";

const OVERRIDES_MIGRATION = "drizzle/0004_dashboard_overrides.sql";

function adminRole(payloadRole: string) {
  return ["super_admin", "school_admin", "head_teacher"].includes(payloadRole);
}

/**
 * The overrides list powers the admin "card override" UI. A missing migration 0004 must
 * never surface as a 500 blank list, so we answer with an empty set plus a warning the
 * UI can explain (the route already tried to self-heal the table first).
 */
function degradedOverridesResponse(warning: SchemaWarning) {
  return NextResponse.json({
    success: true,
    data: [],
    meta: { degraded: true, warning },
  });
}

function overridesDisabledResponse(status: { available: boolean; repaired: boolean; migration: string }) {
  return errorResponse(
    `Card overrides are not available yet: ${status.migration} has not been applied to this database. Run \`node run-migration.js ${status.migration.split("/").pop()}\` and try again.`,
    503
  );
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const url = request.nextUrl;
    const dashboardRole = url.searchParams.get("dashboardRole");

    // Reject unknown enum literals up front: Postgres answered 22P02 which surfaced as a 500.
    if (dashboardRole && !(OVERRIDE_DASHBOARD_ROLES as readonly string[]).includes(dashboardRole)) {
      return errorResponse(
        `dashboardRole must be one of: ${OVERRIDE_DASHBOARD_ROLES.join(", ")}`,
        400
      );
    }

    const status = await ensureSchemaFeature("dashboard_card_overrides");
    if (!status.available) {
      return degradedOverridesResponse({
        area: "overrides",
        message: `Card overrides are disabled because ${OVERRIDES_MIGRATION} has not been applied to this database.`,
        migration: OVERRIDES_MIGRATION,
      });
    }

    // Only admins can create/change overrides; viewing is open to any signed-in role for
    // transparency about which dashboard cards are overridden.
    const role = payload.role;
    const isAdmin = adminRole(role);

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

    let results;
    try {
      results = await (query as any).orderBy(desc(dashboardCardOverrides.updatedAt));
    } catch (error) {
      if (isSchemaOutOfDate(error)) {
        return degradedOverridesResponse(
          toSchemaWarning("overrides", error, "Card overrides") ?? {
            area: "overrides",
            message: `Card overrides are disabled because ${OVERRIDES_MIGRATION} has not been applied.`,
            migration: OVERRIDES_MIGRATION,
          }
        );
      }
      throw error;
    }

    return NextResponse.json({
      success: true,
      data: results,
      ...(status.repaired
        ? {
            meta: {
              repaired: true,
              warning: {
                area: "overrides",
                message: `The dashboard_card_overrides table was missing and was created automatically. Please apply ${OVERRIDES_MIGRATION} properly at the next deploy.`,
                migration: OVERRIDES_MIGRATION,
                repaired: true,
              } as SchemaWarning,
            },
          }
        : {}),
    });
  } catch (error) {
    console.error("Dashboard overrides GET error:", error);
    return errorResponse(
      "Card overrides could not be loaded right now. Please retry, and check /api/health if this persists.",
      503
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!adminRole(payload.role)) {
      return errorResponse("Only admins can create overrides", 403);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return errorResponse("Invalid request body", 400);
    }

    const normalized = normalizeOverrideInput(body as Record<string, unknown>);
    if (!normalized.ok) {
      return errorResponse(
        normalized.problems.map((problem) => problem.message).join("; "),
        400
      );
    }

    const status = await ensureSchemaFeature("dashboard_card_overrides");
    if (!status.available) return overridesDisabledResponse(status);

    const values = normalized.values as Record<string, any>;

    const [created] = await db
      .insert(dashboardCardOverrides)
      .values({
        cardKey: values.cardKey,
        dashboardRole: values.dashboardRole,
        title: values.title ?? null,
        label: values.label ?? null,
        value: values.value ?? null,
        subtitle: values.subtitle ?? null,
        description: values.description ?? null,
        trend: values.trend ?? null,
        isVisible: values.isVisible ?? true,
        sortOrder: values.sortOrder ?? 0,
        isEnabled: values.isEnabled ?? true,
        overridePayload: values.overridePayload ?? null,
        scopeType: values.scopeType ?? "global",
        scopeId: values.scopeId ?? null,
        createdBy: payload.userId,
      })
      .returning();

    await logActivity({
      userId: payload.userId,
      action: "create",
      entityType: "dashboard_card_override",
      entityId: created?.id,
      description: `Created override for card ${values.cardKey} on ${values.dashboardRole} dashboard`,
      details: JSON.stringify({
        cardKey: values.cardKey,
        dashboardRole: values.dashboardRole,
        scopeType: values.scopeType,
        scopeId: values.scopeId ?? null,
      }),
    });

    return successResponse(created, 201);
  } catch (error) {
    console.error("Dashboard overrides POST error:", error);
    if (isSchemaOutOfDate(error)) {
      return overridesDisabledResponse({
        available: false,
        repaired: false,
        migration: OVERRIDES_MIGRATION,
      });
    }
    const detail = inspectDbError(error).text;
    if (detail.includes("duplicate key")) {
      return errorResponse("An override for this card already exists.", 409);
    }
    return errorResponse(
      "The override could not be saved because the database rejected it. Please check the card key and scope values.",
      400
    );
  }
}
