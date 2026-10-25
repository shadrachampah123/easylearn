import { NextResponse, type NextRequest } from "next/server";
import { evaluateCsrfRequestForRequest } from "@/lib/csrf";

/**
 * Cross-site request forgery protection for the API.
 *
 * This is the `proxy` file (formerly `middleware`): Next.js 16 renamed the
 * convention and deprecated the old name. The file lives under the current
 * convention so that a future Next.js upgrade cannot quietly stop running the
 * cross-site check — the security control must not depend on a convention that
 * is on its way out. The export is a default function, which is the contract
 * Next.js 16 expects from a `proxy` file.
 *
 * The browser session is an `httpOnly` cookie, and a cookie is attached to a
 * cross-site request as well as a same-origin one. A foreign page can therefore
 * make the browser perform a state-changing request against this API unless the
 * request is checked.
 *
 * The check lives in ONE place — here — so a new route cannot forget it. The
 * policy itself is in `@/lib/csrf` and is documented there; in summary:
 *
 *   - a state-changing request must come from this application's own origin
 *     (`Origin`, or `Sec-Fetch-Site` when `Origin` is absent);
 *   - a request with neither header is REFUSED, not allowed;
 *   - a request that carries `Authorization: Bearer` AND no session cookie is a
 *     deliberately supported non-browser client and is not origin-checked. A browser
 *     cannot set that header cross-site without a CORS preflight, and this
 *     application does not enable CORS. A request that carries the session cookie as
 *     well is a browser request and is ALWAYS origin-checked.
 *
 * `GET`, `HEAD` and `OPTIONS` are not state-changing and pass straight through.
 */

export const config = {
  // Every API route. The policy itself decides which methods are checked.
  matcher: ["/api/:path*"],
};

export default function proxy(request: NextRequest) {
  const decision = evaluateCsrfRequestForRequest(request);

  if (decision.allowed) {
    return NextResponse.next();
  }

  return NextResponse.json(
    {
      success: false,
      error: decision.reason || "This request was refused by the cross-site request policy.",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  );
}
