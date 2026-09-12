import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { parentLearners } from "@/db/schema";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import {
  getLearnerIdsInSchool,
  guardSchoolContext,
  hasSchoolAdminExtendedRole,
  type SchoolAuthContext,
} from "@/lib/tenant";
import { logActivity } from "@/lib/activity";
import { eq } from "drizzle-orm";
import { RELATIONSHIP_OPTIONS, normalizeRelationship } from "@/lib/relationships";
import { isMissingRelation, clientSafeErrorMessage } from "@/lib/schema-resilience";
import { UUID_PATTERN } from "@/lib/dashboard-overrides";

/**
 * Phase 2C: every handler needs a DB-backed school context; the membership role (never the
 * token claim) decides who may change links.
 */
async function requireAdmin(request: NextRequest) {
  const auth = await guardSchoolContext(request);
  if (!auth.ok) return { error: auth.response as Response };
  if (!hasSchoolAdminExtendedRole(auth.context)) {
    return {
      error: errorResponse("Only administrators can change parent links", 403) as Response,
    };
  }
  return { ctx: auth.context };
}

function parseId(rawId: string): string | null {
  const id = decodeURIComponent(rawId || "").trim();
  return UUID_PATTERN.test(id) ? id : null;
}

/**
 * Phase 2C: a link is only readable/changed when BOTH the parent and the learner are active
 * members of the caller's school. Otherwise it is reported as missing (no existence leak).
 */
async function findInSchoolLink(id: string, ctx: SchoolAuthContext) {
  const link = await findLink(id);
  if (!link) return null;
  const members = await getLearnerIdsInSchool(ctx.schoolId, [link.parentId, link.learnerId]);
  return members.size === 2 ? link : null;
}

async function findLink(id: string) {
  const [link] = await db
    .select({
      id: parentLearners.id,
      parentId: parentLearners.parentId,
      learnerId: parentLearners.learnerId,
      relationship: parentLearners.relationship,
    })
    .from(parentLearners)
    .where(eq(parentLearners.id, id))
    .limit(1);
  return link ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(_request);
    if (auth.error) return auth.error;
    const ctx = auth.ctx as SchoolAuthContext;

    const { id } = await params;
    const linkId = parseId(id);
    if (!linkId) return errorResponse("Link id must be a uuid", 400);

    const link = await findInSchoolLink(linkId, ctx);
    if (!link) return notFoundResponse("Parent link");

    return successResponse(link);
  } catch (error) {
    console.error("Parent link GET error:", error);
    return errorResponse(clientSafeErrorMessage(error, "Parent link could not be loaded. Please retry."), 503);
  }
}

/** PUT - change the relationship label for an existing link. */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const ctx = auth.ctx as SchoolAuthContext;

    const { id } = await params;
    const linkId = parseId(id);
    if (!linkId) return errorResponse("Link id must be a uuid", 400);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return errorResponse("Invalid request body", 400);

    const rawRelationship = (body as Record<string, unknown>).relationship;
    const normalized = normalizeRelationship(rawRelationship);
    if (
      !normalized ||
      !(RELATIONSHIP_OPTIONS as readonly string[]).includes(normalized as (typeof RELATIONSHIP_OPTIONS)[number])
    ) {
      return errorResponse(`relationship must be one of: ${RELATIONSHIP_OPTIONS.join(", ")}`, 400);
    }

    const link = await findInSchoolLink(linkId, ctx);
    if (!link) return notFoundResponse("Parent link");

    const [updated] = await db
      .update(parentLearners)
      .set({ relationship: normalized })
      .where(eq(parentLearners.id, linkId))
      .returning();

    await logActivity({
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      action: "update",
      entityType: "parent_learner",
      entityId: linkId,
      description: `Updated parent-learner relationship to ${normalized}`,
      details: JSON.stringify({ relationship: normalized }),
    });

    return successResponse(updated);
  } catch (error) {
    console.error("Parent link PUT error:", error);
    return errorResponse(clientSafeErrorMessage(error, "The relationship could not be updated. Please retry."), 503);
  }
}

/** DELETE - unlink a parent from a learner. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const ctx = auth.ctx as SchoolAuthContext;

    const { id } = await params;
    const linkId = parseId(id);
    if (!linkId) return errorResponse("Link id must be a uuid", 400);

    const link = await findInSchoolLink(linkId, ctx);
    if (!link) return notFoundResponse("Parent link");

    await db.delete(parentLearners).where(eq(parentLearners.id, linkId));

    await logActivity({
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      action: "unlink",
      entityType: "parent_learner",
      entityId: linkId,
      description: `Removed the link between a parent and learner (learner ${link.learnerId})`,
      details: JSON.stringify({ parentId: link.parentId, learnerId: link.learnerId }),
    });

    return NextResponse.json({ success: true, data: { message: "Parent unlinked" } });
  } catch (error) {
    console.error("Parent link DELETE error:", error);
    if (isMissingRelation(error)) {
      return errorResponse("The parent_learners table is missing. Run `npx drizzle-kit push`, then retry.", 503);
    }
    return errorResponse(clientSafeErrorMessage(error, "The parent link could not be removed. Please retry."), 503);
  }
}
