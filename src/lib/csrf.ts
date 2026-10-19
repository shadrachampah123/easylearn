/**
 * CSRF policy for cookie-authenticated requests.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 * The browser session is an `httpOnly` cookie. The browser attaches it to every
 * same-origin request, and — this is the point — it also attaches it to a
 * cross-site request. A cookie is therefore "ambient" authority: a page on
 * another origin can cause the browser to send it, even though that page cannot
 * read the response.
 *
 * Before the session moved to a cookie, the browser sent the token in an
 * `Authorization` header that a cross-site page cannot set, so cross-site
 * requests carried no authority at all. Moving to the cookie removes that
 * property, so the CSRF protection has to be added at the same time. This module
 * and `src/proxy.ts` are that protection.
 *
 * ── The policy ─────────────────────────────────────────────────────────────────
 * A request is allowed when it is not state-changing, or when it is a
 * deliberately supported non-browser client, or when its origin can be shown to
 * be this application. Everything else is refused.
 *
 * 1. NOT STATE-CHANGING. `GET`, `HEAD` and `OPTIONS` never change state and are
 *    always allowed. (A `GET` that did change state would be a separate bug —
 *    the two routes that did have been converted to `POST`; see
 *    `src/app/api/messages/route.ts` and `src/app/api/learner/stats/route.ts`.)
 *
 * 2. BEARER CLIENTS. A request that carries an `Authorization: Bearer` header is
 *    allowed without an origin check. A browser cannot attach that header to a
 *    cross-site request without a CORS preflight, and this application does not
 *    enable CORS, so this path is not reachable from a foreign origin. It exists
 *    for the deliberately supported non-browser integrations (scripts, the
 *    migration runner, the development seed). It does NOT weaken the
 *    cookie-authenticated path: a request that presents the session cookie has no
 *    `Authorization` header and is always checked.
 *
 * 3. SAME-ORIGIN BROWSER REQUEST. The `Origin` header is compared against the
 *    origin the request was made to, plus any explicitly configured extra
 *    origins (`EASY_LEARN_ALLOWED_ORIGINS`). A browser sets `Origin` on every
 *    state-changing request, and a foreign page cannot forge it, so a match is
 *    proof of same-origin.
 *
 * 4. MISSING HEADERS. When `Origin` is absent the request is still checked
 *    against `Sec-Fetch-Site`, which a browser also sets. If neither header
 *    carries usable information the request is REFUSED. Failing open here would
 *    make "no Origin header" a way to bypass the check, which is precisely the
 *    case an attacker would try to construct.
 *
 * `SameSite=Lax` on the session cookie is a second line of defence, not the
 * control itself: it blocks a cross-site `POST`, but it does not stop a
 * same-site attack from a sibling subdomain, and it is a browser default rather
 * than something this application can reason about. It is deliberately left at
 * `Lax` — see `docs/SECURITY_AUTHENTICATION.md`.
 */

/** Methods that may change state and therefore need the origin check. */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** The environment variable holding extra origins that are allowed to call the API. */
export const ALLOWED_ORIGINS_ENV = "EASY_LEARN_ALLOWED_ORIGINS";

export interface CsrfDecision {
  /** True when the request may proceed. */
  allowed: boolean;
  /** Why the request was refused. Never contains a credential. */
  reason?: string;
  /** Which rule decided the outcome — useful in logs and in tests. */
  rule: "method" | "bearer" | "same-origin" | "missing-origin" | "cross-origin";
}

function firstValue(header: string | null): string | null {
  if (!header) return null;
  const value = header.split(",")[0]?.trim();
  return value ? value : null;
}

/**
 * The origin the request was addressed to, reconstructed from the request's own
 * headers. Behind a proxy the public scheme and host arrive in
 * `x-forwarded-proto` / `x-forwarded-host`; the `Host` header and the request URL
 * are the fallbacks.
 */
export function getRequestOrigin(request: Request): string | null {
  const headers = request.headers;
  const host = firstValue(headers.get("x-forwarded-host")) || firstValue(headers.get("host"));
  if (!host) return null;

  let protocol: string;
  const forwardedProto = firstValue(headers.get("x-forwarded-proto"));
  if (forwardedProto) {
    protocol = forwardedProto;
  } else {
    try {
      protocol = new URL(request.url).protocol.replace(/:$/, "");
    } catch {
      protocol = process.env.NODE_ENV === "production" ? "https" : "http";
    }
  }

  return `${protocol}://${host}`;
}

/** The extra origins this deployment explicitly allows. */
export function getConfiguredAllowedOrigins(): string[] {
  const raw = process.env[ALLOWED_ORIGINS_ENV];
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Compares two origins by scheme and host, ignoring path, query and default ports. */
export function isSameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol && left.host === right.host;
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}

/** True when the method may change state. */
export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

/**
 * Decides whether a request may proceed.
 *
 * `origin` and `fetchSite` are parameters so the policy can be exercised directly
 * by the test suite without constructing a real `Request`.
 */
export function evaluateCsrfRequest(options: {
  method: string;
  origin: string | null;
  fetchSite: string | null;
  hasBearerAuthorization: boolean;
  requestOrigin?: string | null;
  allowedOrigins?: string[];
}): CsrfDecision {
  if (!isStateChangingMethod(options.method)) {
    return { allowed: true, rule: "method" };
  }

  if (options.hasBearerAuthorization) {
    // A deliberately supported non-browser client. See rule 2 in the module comment.
    return { allowed: true, rule: "bearer" };
  }

  const requestOrigin = options.requestOrigin ?? null;
  const allowed = [
    ...(requestOrigin ? [requestOrigin] : []),
    ...(options.allowedOrigins ?? getConfiguredAllowedOrigins()),
  ];

  if (options.origin) {
    const matches = allowed.some((candidate) => isSameOrigin(candidate, options.origin!));
    if (matches) return { allowed: true, rule: "same-origin" };
    return {
      allowed: false,
      rule: "cross-origin",
      reason: "This request did not come from the application's own origin.",
    };
  }

  // No `Origin` header. Fall back to `Sec-Fetch-Site`, which the browser also
  // sets, and refuse when it says the request came from somewhere else.
  const fetchSite = options.fetchSite ? options.fetchSite.toLowerCase() : null;
  if (fetchSite === "same-origin" || fetchSite === "none") {
    return { allowed: true, rule: "same-origin" };
  }
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return {
      allowed: false,
      rule: "cross-origin",
      reason: "This request did not come from the application's own origin.",
    };
  }

  // Neither header carries usable information: refuse rather than guess.
  return {
    allowed: false,
    rule: "missing-origin",
    reason:
      "This request did not include an origin that could be verified, so it was refused.",
  };
}

/** Convenience wrapper that reads the decision inputs from a real request. */
export function evaluateCsrfRequestForRequest(request: Request): CsrfDecision {
  const authorization = request.headers.get("authorization");
  const hasBearerAuthorization = Boolean(authorization && /^bearer\s+/i.test(authorization));

  return evaluateCsrfRequest({
    method: request.method,
    origin: request.headers.get("origin"),
    fetchSite: request.headers.get("sec-fetch-site"),
    hasBearerAuthorization,
    requestOrigin: getRequestOrigin(request),
  });
}
