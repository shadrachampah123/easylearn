import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { getTokenFromRequest } from "@/lib/auth";
import { getJwtSecret } from "@/lib/env";
import { assertJwtSecretIsUsable } from "@/lib/jwt-policy";
import { successResponse } from "@/lib/api-helpers";

export async function POST(request?: Request) {
  let revocationSucceeded = true;
  try {
    const token = request ? getTokenFromRequest(request) : null;
    if (token) {
      const secret = getJwtSecret();
      assertJwtSecretIsUsable(secret);
      let userId: string | undefined;
      let tokenSessionVersion: number | undefined;
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
        if (typeof payload.userId === "string" && payload.userId.length > 0) {
          userId = payload.userId;
          // Match verifyToken(): legacy tokens without a valid integer claim are version zero.
          tokenSessionVersion =
            typeof payload.sessionVersion === "number" && Number.isInteger(payload.sessionVersion)
              ? payload.sessionVersion
              : 0;
        }
      } catch {
        userId = undefined;
        tokenSessionVersion = undefined;
      }
      if (userId && tokenSessionVersion !== undefined) {
        const { db } = await import("@/db");
        const { users } = await import("@/db/schema");
        const { and, eq, sql } = await import("drizzle-orm");
        const rows = await db.update(users)
          .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
          .where(and(eq(users.id, userId), eq(users.sessionVersion, tokenSessionVersion)))
          .returning({ id: users.id });
        if (rows.length === 0) {
          const [currentUser] = await db.select({ sessionVersion: users.sessionVersion })
            .from(users).where(eq(users.id, userId)).limit(1);
          revocationSucceeded = currentUser !== undefined && currentUser.sessionVersion > tokenSessionVersion;
        } else {
          revocationSucceeded = rows.length === 1;
        }
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
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", maxAge: 0, path: "/",
  });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  return response;
}
