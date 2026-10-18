import { NextRequest } from "next/server";
import { createToken } from "@/lib/auth";
import { errorResponse, successResponse } from "@/lib/api-helpers";
import {
  AuthContextError,
  resolveAuthContext,
  selectSchoolForContext,
  tenantErrorResponse,
  toSchoolSummary,
} from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Select or switch the active school for this session. The request body is a request, not
 * authority: resolveAuthContext reloads all active memberships and selectSchoolForContext
 * rejects any school not in that list. The resulting v3 token is signed by the server and
 * revalidated against the database on every subsequent request.
 */
export async function POST(request: NextRequest) {
  try {
    const context = await resolveAuthContext(request);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("Invalid request body", 400);
    }

    let selected;
    try {
      selected = selectSchoolForContext(context, (body as Record<string, unknown>).schoolId);
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
      token,
      school: toSchoolSummary(selected.school),
      schools: context.memberships.map((membership) => toSchoolSummary(membership)),
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
    return tenantErrorResponse(error, "School selection could not be completed");
  }
}
