import { successResponse } from "@/lib/api-helpers";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";

/**
 * Logs the browser out.
 *
 * WHAT THIS ACTUALLY GUARANTEES
 * -----------------------------
 * It clears the session cookie in the browser that made the request, and it
 * returns a `no-store` response so that the response cannot be cached and
 * replayed.
 *
 * WHAT IT DOES NOT GUARANTEES
 * ---------------------------
 * The session token is a stateless, signed JWT. There is no server-side session
 * store and no revocation list, so this endpoint CANNOT invalidate a token that
 * was copied out of the cookie before the logout — a token that is still inside
 * its 24-hour lifetime remains usable by whoever holds it, including a
 * deliberately supported non-browser bearer client.
 *
 * That is a real limitation, not a defect in this handler, and it is documented
 * in docs/SECURITY_AUTHENTICATION.md. Adding revocation would mean either a
 * server-side session store or a token-version column that every authenticated
 * request has to read; both are architectural changes with their own migration
 * and failure modes, and they are called out as a follow-up rather than being
 * smuggled in here.
 */
export async function POST() {
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
