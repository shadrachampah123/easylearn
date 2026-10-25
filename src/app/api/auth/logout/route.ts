import { successResponse } from "@/lib/api-helpers";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";

/**
 * Logs the browser out and revokes the current session.
 *
 * Revocation is per-user via `users.session_version`: the token's
 * `sessionVersion` claim must match the row. Logout bumps the row, so any
 * previously issued token (including a copied bearer token) is rejected on
 * next use, even though it is still inside its 24h expiry. This revokes all
 * sessions for the user; per-session revocation would require a session table.
 */
export async function POST(request?: Request) {
  // Best-effort revocation: if we can identify the user, bump their version.
  // Fail open — clearing the cookie is still the primary logout even if DB is
  // unavailable or pre-migration.
  try {
    if (request) {
      const token = getTokenFromRequest(request as Request);
    if (token) {
      const payload = await verifyToken(token);
      // verifyToken already checks version, but for logout we need to handle
      // revoked tokens too — so re-verify without version check if needed.
      // Instead, decode payload without DB check: if verify returned null due to
      // version mismatch, we still want to bump. Decode manually.
      let userId: string | undefined = payload?.userId;
      if (!userId) {
        try {
          const { jwtVerify } = await import("jose");
          const { getJwtSecret } = await import("@/lib/env");
          const { assertJwtSecretIsUsable } = await import("@/lib/jwt-policy");
          const secret = getJwtSecret();
          assertJwtSecretIsUsable(secret);
          const { payload: raw } = await jwtVerify(token, new TextEncoder().encode(secret), {
            algorithms: ["HS256"],
          });
          if (typeof raw.userId === "string") userId = raw.userId;
        } catch {}
      }
      if (userId) {
        const { db } = await import("@/db");
        const { users } = await import("@/db/schema");
        const { eq, sql } = await import("drizzle-orm");
        try {
          await db
            .update(users)
            .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
            .where(eq(users.id, userId));
        } catch {
          // Missing column pre-migration — ignore, cookie clear still happens.
        }
      }
    }
    }
  } catch {
    // Revocation failure must not prevent cookie clear.
  }

  const response = successResponse({ message: "Logged out" });

  // The cookie is cleared with the same attributes it was set with. A mismatch in
  // `path` or `sameSite` would leave the original cookie in place and the browser
  // would keep sending it.
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
