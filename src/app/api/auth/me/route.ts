import { NextRequest } from "next/server";
import { getUserFromToken, getTokenFromRequest } from "@/lib/auth";
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

    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();

    const user = await getUserFromToken(token);
    if (!user) return unauthorizedResponse();

    const response = successResponse({ user });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("Current user error:", error);
    return errorResponse(getDatabaseErrorMessage(error), 503);
  }
}
