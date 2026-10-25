import { NextResponse, type NextRequest } from "next/server";
import { evaluateCsrfRequestForRequest } from "@/lib/csrf";

function generateNonce(): string {
  // Edge runtime has crypto.randomUUID, Node has crypto.randomBytes
  try {
    // @ts-ignore - Next.js edge provides global crypto
    if (typeof crypto !== "undefined" && typeof (crypto as unknown as { randomUUID?: () => string }).randomUUID === "function") {
      return (crypto as unknown as { randomUUID: () => string }).randomUUID().replace(/-/g, "");
    }
  } catch {}
  // Fallback: 16 random bytes base64
  const bytes = new Uint8Array(16);
  // @ts-ignore
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function buildCsp(nonce: string, isProduction: boolean): string {
  const scriptSrc = isProduction
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' blob:`
    : `script-src 'self' 'unsafe-eval' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' blob:`;
  const connectSrc = isProduction ? "connect-src 'self' https:" : "connect-src 'self' https: wss: ws:";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https:",
    connectSrc,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export default function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const isProduction = process.env.NODE_ENV === "production";
  const csp = buildCsp(nonce, isProduction);

  // Pass nonce to downstream handlers/layouts via request header
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-csp-nonce", nonce);

  // API routes: enforce CSRF first, then add CSP headers
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const decision = evaluateCsrfRequestForRequest(request);
    if (!decision.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: decision.reason || "This request was refused by the cross-site request policy.",
        },
        { status: 403, headers: { "Cache-Control": "no-store", "Content-Security-Policy": csp, "x-nonce": nonce } }
      );
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("x-nonce", nonce);
    return response;
  }

  // All other routes (pages, assets): set CSP via proxy, no CSRF
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-nonce", nonce);
  return response;
}
