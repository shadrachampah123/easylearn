import { NextRequest } from "next/server";
import { getUserFromToken, getTokenFromRequest } from "@/lib/auth";
import { successResponse, unauthorizedResponse } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) return unauthorizedResponse();

  const user = await getUserFromToken(token);
  if (!user) return unauthorizedResponse();

  return successResponse({ user });
}
