import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { parentLearners } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { eq } from "drizzle-orm";
import { RELATIONSHIP_OPTIONS, normalizeRelationship } from "@/lib/relationships";
import { isMissingRelation, clientSafeErrorMessage } from "@/lib/schema-resilience";
import { UUID_PATTERN } from "@/lib/dashboard-overrides";

const ADMIN_ROLES = ["super_admin", "school_admin", "head_teacher"];

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) return { error: unauthorizedResponse() as Response };
  const payload = await verifyToken(token);
  if (!payload) return { error: unauthorizedResponse() as Response };
  if (!ADMIN_ROLES.includes(payload.role)) {
    return { error: errorResponse("Only administrators can change parent links", 403) as Response };
  }
  return { payload };
}

function parseId(rawId: string): string | null {
  const id = decodeURIComponent(rawId || "").trim();
  return UUID_PATTERN.test(id) ? id : null;
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

    const { id } = await params;
    const linkId = parseId(id);
    if (!linkId) return errorResponse("Link id must be a uuid", 400);

    const link = await findLink(linkId);
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
    const payload = auth.payload!;

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

    const link = await findLink(linkId);
    if (!link) return notFoundResponse("Parent link");

    const [updated] = await db
      .update(parentLearners)
      .set({ relationship: normalized })
      .where(eq(parentLearners.id, linkId))
      .returning();

    await logActivity({
      userId: payload.userId,
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
    const payload = auth.payload!;

    const { id } = await params;
    const linkId = parseId(id);
    if (!linkId) return errorResponse("Link id must be a uuid", 400);

    const link = await findLink(linkId);
    if (!link) return notFoundResponse("Parent link");

    await db.delete(parentLearners).where(eq(parentLearners.id, linkId));

    await logActivity({
      userId: payload.userId,
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
