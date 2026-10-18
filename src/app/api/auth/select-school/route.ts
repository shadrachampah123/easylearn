import { NextRequest } from "next/server";
import { createToken } from "@/lib/auth";
import { errorResponse, successResponse } from "@/lib/api-helpers";
import { getDatabaseErrorMessage } from "@/lib/database-errors";
import {
  AuthContextError,
  resolveAuthContext,
  selectSchoolForContext,
  toSchoolSummary,
} from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Select or switch the active school for this session.
 *
 * The request body is a request, not authority: `resolveAuthContext` reloads all active
 * memberships and `selectSchoolForContext` rejects any school that is not in that list.
 * The resulting v3 token is signed by the server and revalidated against the database on
 * every subsequent request, and a school whose lifecycle row is no longer `active` is not
 * part of the membership list at all.
 */
export async function POST(request: NextRequest) {
  try {
    const context = await resolveAuthContext(request);

    // A platform account has no school membership, so it can never select a tenant.
    if (context.isPlatformAdmin) {
      return errorResponse("Platform administrators do not select a school", 403);
    }

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("Invalid request body", 400);
    }

    const schoolId = (body as Record<string, unknown>).schoolId;
    if (typeof schoolId !== "string") {
      return errorResponse("A schoolId is required", 400);
    }

    let selected;
    try {
      selected = selectSchoolForContext(context, schoolId);
    } catch (error) {
      if (error instanceof AuthContextError) {
        return errorResponse(error.message, error.status);
      }
      throw error;
    }

    const token = await createToken({
      userId: context.userId,
      email: context.email ?? undefined,
      username: context.username ?? undefined,
      role: context.role,
      schoolId: selected.schoolId,
      membershipId: selected.membershipId,
    });

    const response = successResponse({
      user: context.user,
      school: toSchoolSummary(selected.school),
      schools: context.memberships.map((membership) => toSchoolSummary(membership)),
      token,
    });
    response.cookies.set("el_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof AuthContextError) {
      return errorResponse(error.message, error.status);
    }
    console.error("School selection error:", error);
    return errorResponse(getDatabaseErrorMessage(error), 503);
  }
}
