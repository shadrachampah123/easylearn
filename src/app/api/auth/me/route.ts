import { NextRequest } from "next/server";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { getDatabaseErrorMessage } from "@/lib/database-errors";
import { getDatabaseConfigurationProblem, getJwtConfigurationProblem } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const configurationProblem =
      getDatabaseConfigurationProblem() || getJwtConfigurationProblem();
    if (configurationProblem) {
      return errorResponse(configurationProblem, 503);
    }

    // Phase 2B: the authenticated context (token → user row → school memberships) is built
    // by the central tenant module so this route reports the same trusted, database-derived
    // school context the rest of the API will use. `@/lib/tenant` is imported lazily so a
    // deployment with no DATABASE_URL still answers 503 here instead of failing at import.
    const { resolveAuthContext, toSchoolSummary, AuthContextError } = await import("@/lib/tenant");

    let context;
    try {
      context = await resolveAuthContext(request);
    } catch (error) {
      // Same generic 401 the route has always returned for a missing, invalid, expired
      // session or a deactivated account — no reason is disclosed to the caller.
      if (error instanceof AuthContextError) return unauthorizedResponse();
      throw error;
    }

    const response = successResponse({
      user: context.user,
      // Additive Phase 2B context. Server-derived; a client cannot influence it by sending
      // a school id back.
      school: toSchoolSummary(context.school),
      schools: context.memberships.map((membership) => toSchoolSummary(membership)),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("Current user error:", error);
    return errorResponse(getDatabaseErrorMessage(error), 503);
  }
}
