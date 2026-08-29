import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { parentLearners, users } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { eq, and, or, ilike, desc, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { RELATIONSHIP_OPTIONS, normalizeRelationship } from "@/lib/relationships";
import {
  isMissingColumn,
  isMissingRelation,
  isUniqueViolation,
  schemaAwareErrorMessage,
  ensureUserIdentityColumns,
} from "@/lib/schema-resilience";
import { UUID_PATTERN } from "@/lib/dashboard-overrides";

const ADMIN_ROLES = ["super_admin", "school_admin", "head_teacher"];

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/** Unknown or oversized relationship strings are rejected instead of silently stored. */
function parseRelationship(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: "guardian" };
  const normalized = normalizeRelationship(raw);
  if (!normalized || !(RELATIONSHIP_OPTIONS as readonly string[]).includes(normalized as (typeof RELATIONSHIP_OPTIONS)[number])) {
    return { ok: false, message: `relationship must be one of: ${RELATIONSHIP_OPTIONS.join(", ")}` };
  }
  return { ok: true, value: normalized };
}

/**
 * GET /api/parent-learners
 * Query params: parentId, learnerId, search (either side of the pair), limit.
 */
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const url = request.nextUrl;
    const parentId = url.searchParams.get("parentId");
    const learnerId = url.searchParams.get("learnerId");
    const search = url.searchParams.get("search");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "500") || 500, 1000);

    if (parentId && !isUuid(parentId)) return errorResponse("parentId must be a uuid", 400);
    if (learnerId && !isUuid(learnerId)) return errorResponse("learnerId must be a uuid", 400);

    // Parents may only read their own links; admins can read any.
    const isAdmin = ADMIN_ROLES.includes(payload.role);
    if (!isAdmin && payload.role !== "parent" && payload.role !== "learner") {
      return errorResponse("Forbidden", 403);
    }

    const parentAlias = alias(users, "link_parent");
    const learnerAlias = alias(users, "link_learner");

    const conditions = [];
    if (!isAdmin && payload.role === "parent") conditions.push(eq(parentLearners.parentId, payload.userId));
    if (!isAdmin && payload.role === "learner") conditions.push(eq(parentLearners.learnerId, payload.userId));
    if (parentId) conditions.push(eq(parentLearners.parentId, parentId));
    if (learnerId) conditions.push(eq(parentLearners.learnerId, learnerId));
    if (search) {
      conditions.push(
        or(
          ilike(parentAlias.firstName, `%${search}%`),
          ilike(parentAlias.lastName, `%${search}%`),
          ilike(learnerAlias.firstName, `%${search}%`),
          ilike(learnerAlias.lastName, `%${search}%`)
        )!
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const baseFields = {
      id: parentLearners.id,
      parentId: parentLearners.parentId,
      learnerId: parentLearners.learnerId,
      relationship: parentLearners.relationship,
      createdAt: parentLearners.createdAt,
      parentFirstName: parentAlias.firstName,
      parentLastName: parentAlias.lastName,
      parentEmail: parentAlias.email,
      parentPhone: parentAlias.phone,
      learnerFirstName: learnerAlias.firstName,
      learnerLastName: learnerAlias.lastName,
      learnerEmail: learnerAlias.email,
      learnerActive: learnerAlias.isActive,
    };

    // `username` only exists from migration 0006 onwards: fall back to the reduced
    // projection instead of failing the whole admin linking screen.
    const fields = { ...baseFields, parentUsername: parentAlias.username, learnerUsername: learnerAlias.username };

    const queryLinks = (projection: Record<string, unknown>) =>
      db
        .select(projection as never)
        .from(parentLearners)
        .leftJoin(parentAlias, eq(parentLearners.parentId, parentAlias.id))
        .leftJoin(learnerAlias, eq(parentLearners.learnerId, learnerAlias.id))
        .where(whereClause)
        .orderBy(desc(parentLearners.createdAt))
        .limit(limit);

    let results: Record<string, unknown>[];
    let degradedMessage: string | null = null;
    try {
      results = (await queryLinks(fields)) as Record<string, unknown>[];
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      results = (await queryLinks(baseFields)) as Record<string, unknown>[];
      degradedMessage =
        "Parent/learner usernames are hidden because drizzle/0006_user_identity_columns.sql has not been applied to this database.";
    }

    if (!degradedMessage) return successResponse(results);

    return NextResponse.json({
      success: true,
      data: results,
      meta: {
        degraded: true,
        warning: { area: "parentLearners", message: degradedMessage, migration: "drizzle/0006_user_identity_columns.sql" },
      },
    });
  } catch (error) {
    console.error("Parent learners error:", error);
    if (isMissingRelation(error)) {
      // parent_learners is part of the base schema, but a partially migrated database
      // can still be missing it - an empty list keeps the admin screen usable.
      return NextResponse.json({
        success: true,
        data: [],
        meta: {
          degraded: true,
          warning: {
            area: "parentLearners",
            message: "Parent-learner links are unavailable because the parent_learners table is missing. Run `npx drizzle-kit push` (or `node run-migration.js`) to create the base tables.",
          },
        },
      });
    }
    return errorResponse(schemaAwareErrorMessage(error, "Parent links could not be loaded."), 503);
  }
}

/**
 * POST /api/parent-learners - link a parent account to a learner account (admins only).
 */
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!ADMIN_ROLES.includes(payload.role)) {
      return errorResponse("Only administrators can link parents", 403);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return errorResponse("Invalid request body", 400);
    }

    const { parentId, learnerId } = body as Record<string, unknown>;

    if (!isUuid(parentId)) return errorResponse("A valid parentId is required", 400);
    if (!isUuid(learnerId)) return errorResponse("A valid learnerId is required", 400);
    if (parentId === learnerId) return errorResponse("A parent cannot be linked to themselves", 400);

    const relationship = parseRelationship((body as Record<string, unknown>).relationship);
    if (!relationship.ok) return errorResponse(relationship.message, 400);

    const accounts = await db
      .select({ id: users.id, role: users.role, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(inArray(users.id, [parentId, learnerId]));

    const parent = accounts.find((account) => account.id === parentId);
    const learner = accounts.find((account) => account.id === learnerId);

    if (!parent) return errorResponse("Parent account not found", 404);
    if (!learner) return errorResponse("Learner account not found", 404);
    if (parent.role !== "parent" && !ADMIN_ROLES.includes(parent.role)) {
      return errorResponse("That account is not a parent", 400);
    }
    if (learner.role !== "learner") {
      return errorResponse("That account is not a learner", 400);
    }

    const [existing] = await db
      .select({ id: parentLearners.id })
      .from(parentLearners)
      .where(and(eq(parentLearners.parentId, parentId), eq(parentLearners.learnerId, learnerId)))
      .limit(1);

    if (existing) {
      return errorResponse("This parent is already linked to that learner", 409);
    }

    const [relation] = await db
      .insert(parentLearners)
      .values({
        parentId,
        learnerId,
        relationship: relationship.value,
      })
      .returning();

    await logActivity({
      userId: payload.userId,
      action: "link",
      entityType: "parent_learner",
      entityId: relation?.id,
      description: `Linked ${parent.firstName} ${parent.lastName} to ${learner.firstName} ${learner.lastName}`,
      details: JSON.stringify({ parentId, learnerId, relationship: relationship.value }),
    });

    return successResponse(relation, 201);
  } catch (error) {
    console.error("Link parent error:", error);
    if (isUniqueViolation(error)) {
      return errorResponse("This parent is already linked to that learner", 409);
    }
    return errorResponse(
      schemaAwareErrorMessage(error, "The parent link could not be saved."),
      503
    );
  }
}

/**
 * DELETE /api/parent-learners?parentId=..&learnerId=.. - remove one link (admins only).
 * Kept alongside the /:id route so either shape works from the admin UI.
 */
export async function DELETE(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!ADMIN_ROLES.includes(payload.role)) {
      return errorResponse("Only administrators can unlink parents", 403);
    }

    const parentId = request.nextUrl.searchParams.get("parentId");
    const learnerId = request.nextUrl.searchParams.get("learnerId");
    if (!isUuid(parentId) || !isUuid(learnerId)) {
      return errorResponse("parentId and learnerId are both required", 400);
    }

    const [existing] = await db
      .select({ id: parentLearners.id })
      .from(parentLearners)
      .where(and(eq(parentLearners.parentId, parentId), eq(parentLearners.learnerId, learnerId)))
      .limit(1);

    if (!existing) return errorResponse("This link does not exist", 404);

    await db
      .delete(parentLearners)
      .where(and(eq(parentLearners.parentId, parentId), eq(parentLearners.learnerId, learnerId)));

    await logActivity({
      userId: payload.userId,
      action: "unlink",
      entityType: "parent_learner",
      entityId: existing.id,
      description: `Removed a parent-learner link`,
      details: JSON.stringify({ parentId, learnerId }),
    });

    return successResponse({ message: "Link removed" });
  } catch (error) {
    console.error("Unlink parent error:", error);
    return errorResponse(schemaAwareErrorMessage(error, "The parent link could not be removed."), 503);
  }
}
