import { NextRequest } from "next/server";
import { createToken } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";
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
 * Select a school only from the caller's freshly loaded active memberships. The selected
 * membership is written into a new signed token as a revalidated hint; every subsequent
 * request still re-reads the membership and school lifecycle row.
 */
export async function POST(request: NextRequest) {
  try {
    const context = await resolveAuthContext(request);
    if (context.isPlatformAdmin) {
      return errorResponse("Platform administrators do not select a school", 403);
    }

    const body: unknown = await request.json();
    const schoolId =
      typeof body === "object" && body !== null && "schoolId" in body
        ? (body as { schoolId?: unknown }).schoolId
        : undefined;
    if (typeof schoolId !== "string") {
      return errorResponse("A schoolId is required");
    }

    const selected = selectSchoolForContext(context, schoolId);
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
