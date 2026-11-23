import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { getTokenFromRequest } from "@/lib/auth";
import { getJwtSecret } from "@/lib/env";
import { assertJwtSecretIsUsable } from "@/lib/jwt-policy";
import { successResponse } from "@/lib/api-helpers";

/**
 * Revoke all tokens for the signed-in user by incrementing session_version.
 * Verify the signature independently of verifyToken so an already-revoked
 * token can still trigger a bump. A failed DB write is never reported as a
 * successful server-side logout; the browser cookie is cleared either way.
 */
export async function POST(request?: Request) {
  let revocationSucceeded = true;

  try {
    const token = request ? getTokenFromRequest(request) : null;
    if (token) {
      const secret = getJwtSecret();
      assertJwtSecretIsUsable(secret);

      // Invalid, expired, or forged credentials cannot identify a user to revoke.
      let userId: string | undefined;
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
          algorithms: ["HS256"],
        });
        if (typeof payload.userId === "string" && payload.userId.length > 0) {
          userId = payload.userId;
        }
      } catch {
        userId = undefined;
      }

      if (userId) {
        const { db } = await import("@/db");
        const { users } = await import("@/db/schema");
        const { eq, sql } = await import("drizzle-orm");
        const rows = await db
          .update(users)
          .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
          .where(eq(users.id, userId))
          .returning({ id: users.id });
        revocationSucceeded = rows.length === 1;
      }
    }
  } catch (error) {
    console.error("[auth/logout] server-side session revocation failed:", error);
    revocationSucceeded = false;
  }

  const response = revocationSucceeded
    ? successResponse({ message: "Logged out" })
    : NextResponse.json(
        { success: false, error: "Your browser session was cleared, but server-side logout could not be confirmed. Please retry." },
        { status: 503 }
      );

  // Always clear the browser cookie, even when the database is unavailable.
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  return response;
}
