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
 * 2. BEARER CLIENTS. A request that carries an `Authorization: Bearer` header AND
 *    no session cookie is allowed without an origin check. A browser cannot attach
 *    that header to a cross-site request without a CORS preflight, and this
 *    application does not enable CORS, so this path is not reachable from a foreign
 *    origin. It exists for the deliberately supported non-browser integrations
 *    (scripts, the migration runner, the development seed).
 *
 *    The carve-out is granted only when the bearer is the ONLY credential on the
 *    request. A request that also presents the session cookie is a browser request —
 *    the browser attaches that cookie to cross-site requests as well — so it is
 *    ALWAYS origin-checked, whatever else it carries. This matters because the auth
 *    layer (`getTokenFromRequest` in `@/lib/auth`) selects the session identity from
 *    the bearer token FIRST and the cookie second, so a request can carry both; the
 *    cookie is then ambient authority riding along with the identity, and skipping
 *    the origin check would hand that request the one control that protects the
 *    cookie-authenticated path. Enforcing the rule here — rather than assuming that
 *    "a request that presents the session cookie has no `Authorization` header" —
 *    also keeps the policy correct if the deployment ever enables CORS.
 *
 * 3. SAME-ORIGIN BROWSER REQUEST. The `Origin` header is compared against the
 *    origin the request was made to, plus any explicitly configured extra
 *    origins (`EASY_LEARN_ALLOWED_ORIGINS`). A browser sets `Origin` on every
 *    state-changing request, and a foreign page cannot forge it, so a match is
 *    proof of same-origin.
 *
 *    3b. THE BROWSER'S OWN ASSERTION. When the comparison above fails, and the
 *    comparison origin was DERIVED (no `EASY_LEARN_PUBLIC_ORIGIN`), and the
 *    `Origin` header's HOST is one of the hosts the request was addressed to,
 *    and the browser reports `Sec-Fetch-Site: same-origin`, the request is
 *    allowed. `same-origin` means the request's origin IS the initiator's
 *    origin, so the browser has already answered the question the derived
 *    origin was supposed to answer — about the REAL origins, not about a
 *    header a client could send. See "THE DERIVED SCHEME" below.
 *
 * 4. MISSING HEADERS. When `Origin` is absent the request is still checked
 *    against `Sec-Fetch-Site`, which a browser also sets. If neither header
 *    carries usable information the request is REFUSED. Failing open here would
 *    make "no Origin header" a way to bypass the check, which is precisely the
 *    case an attacker would try to construct.
 *
 * ── How the request's own origin is reconstructed ─────────────────────────────
 * The comparison origin is NOT guessed. It is resolved in this order:
 *
 * 1. `EASY_LEARN_PUBLIC_ORIGIN` — the deployment's canonical public origin,
 *    for example `https://app.example.com`. When it is set, it is THE origin:
 *    forwarded headers are ignored completely, and the request is compared
 *    against the configured value. This is the recommended configuration for
 *    any deployment behind a reverse proxy, a CDN or a platform edge, because
 *    it removes every question about what the edge does with the headers it
 *    forwards.
 *
 * 2. Otherwise the origin is derived from the request itself: the `Host`
 *    header and the scheme of the request URL. Forwarded headers are NOT
 *    consulted.
 *
 * 3. `EASY_LEARN_TRUST_PROXY_HEADERS=true` opts in to the forwarded headers
 *    for deployments whose edge is known to OVERWRITE (never append to)
 *    `X-Forwarded-Host` and `X-Forwarded-Proto`. With the opt-in, the host is
 *    the `Host` header plus a single-valued `x-forwarded-host`, and the
 *    scheme is `x-forwarded-proto` or the request URL's scheme, with `https`
 *    added as a candidate because a TLS-terminating edge leaves the last hop
 *    in plain HTTP.
 *
 * WHY THE DEFAULT DOES NOT TRUST THE FORWARDED HEADERS
 * The application cannot tell a client-supplied `X-Forwarded-Host` from one
 * the edge set. RFC 7239 lets a proxy APPEND to a client-supplied value, so
 * the first element of such a list is the client's; and an edge that does not
 * set the header at all leaves the client's value in place, with nothing to
 * mark it. Trusting it by default would let a client choose the origin its
 * own request is compared against — it would only have to name the origin it
 * wanted to reach. The `Host` header has no such problem: the server routes
 * on it, so it is the host this request was actually addressed to.
 *
 * A browser cannot set `x-forwarded-host` or `x-forwarded-proto` on a cross-site
 * request without a CORS preflight, and this application does not enable CORS,
 * so these headers cannot be used to forge an origin from a foreign page even
 * when the opt-in is on.
 *
 * DEPLOYMENT ASSUMPTIONS
 *   - Direct deployment (no proxy): the default works. The `Host` header is
 *     the public host and the request URL's scheme is the public scheme.
 *   - Behind an edge that preserves the `Host` header: the default works.
 *     Next.js derives the request URL's scheme from `x-forwarded-proto`, so a
 *     TLS-terminating edge already presents an `https` URL.
 *   - Behind an edge that REWRITES the `Host` header to an internal name, or
 *     that rewrites the scheme: set `EASY_LEARN_PUBLIC_ORIGIN`. Without it,
 *     the derived origin would be the internal one and every state-changing
 *     request would be refused with 403. That is a safe failure — it refuses
 *     writes — but it is an outage, so the variable must be set.
 *
 * THE DERIVED SCHEME, AND WHY RULE 3b EXISTS
 * The derived scheme is NOT fully trustworthy, and the application cannot make
 * it so. Next.js builds the request URL's scheme from `x-forwarded-proto`:
 *
 *   next/dist/server/next-server.js
 *     const protocol = req.headers["x-forwarded-proto"]?.includes("https")
 *       ? "https" : "http";
 *
 * and it KEEPS a client-supplied value instead of overwriting it — it only
 * fills the header in when it is absent:
 *
 *   next/dist/server/base-server.js
 *     req.headers["x-forwarded-proto"] ??= isHttps ? "https" : "http";
 *
 * (the synthesised value reflects the socket's TLS state, so it is the truth
 * when the client sent nothing). A client that sends
 * `X-Forwarded-Proto: https` therefore changes the scheme the application
 * derives, and a legitimate same-origin write from a browser on `http://host`
 * used to be REFUSED — a self-inflicted denial. It could never make a FOREIGN
 * origin acceptable, because the host still comes from the `Host` header,
 * which is the host the request was addressed to.
 *
 * Rule 3b removes that denial without weakening anything: the browser's own
 * `Sec-Fetch-Site: same-origin` is proof about the real origins, and it is
 * not forgeable by a page on another origin (`Sec-Fetch-Site` is a forbidden
 * header name, so only the browser sets it). A foreign origin still fails the
 * host comparison; a same-host, different-scheme browser request still fails,
 * because the browser reports `same-site` for it; and with
 * `EASY_LEARN_PUBLIC_ORIGIN` configured, rule 3b does not apply at all,
 * because the configured origin is the exact answer.
 *
 * `SameSite=Lax` on the session cookie is a second line of defence, not the
 * control itself: it blocks a cross-site `POST`, but it does not stop a
 * same-site attack from a sibling subdomain, and it is a browser default rather
 * than something this application can reason about. It is deliberately left at
 * `Lax` — see `docs/SECURITY_AUTHENTICATION.md`.
 */

import { hasSessionCookie as hasSessionCookieHeader } from "@/lib/session-cookie";

/** Methods that may change state and therefore need the origin check. */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** The environment variable holding extra origins that are allowed to call the API. */
export const ALLOWED_ORIGINS_ENV = "EASY_LEARN_ALLOWED_ORIGINS";

/**
 * The environment variable holding the deployment's canonical public origin.
 *
 * When it is set, it is the origin every state-changing request is compared
 * against, and the forwarded headers are ignored completely. See the module
 * documentation for the deployment assumptions.
 */
export const PUBLIC_ORIGIN_ENV = "EASY_LEARN_PUBLIC_ORIGIN";

/**
 * The environment variable that opts in to trusting `X-Forwarded-Host` and
 * `X-Forwarded-Proto`.
 *
 * It is OFF by default. Turn it on only when the edge in front of this
 * application is known to OVERWRITE those headers rather than append to them,
 * because the application cannot tell a client-supplied value from one the
 * edge set.
 */
export const TRUST_PROXY_HEADERS_ENV = "EASY_LEARN_TRUST_PROXY_HEADERS";

export interface CsrfDecision {
  /** True when the request may proceed. */
  allowed: boolean;
  /** Why the request was refused. Never contains a credential. */
  reason?: string;
  /** Which rule decided the outcome — useful in logs and in tests. */
  rule: "method" | "bearer" | "same-origin" | "missing-origin" | "cross-origin";
}

function allValues(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The last value of a comma-separated header.
 *
 * RFC 7239 lets a proxy *append* to a forwarded header, in which case the
 * client's own value comes first and the proxy's value comes last. The proxy's
 * value is the trustworthy one, so it is the last element that is read.
 */
function lastValue(header: string | null): string | null {
  const values = allValues(header);
  return values.length ? values[values.length - 1] : null;
}

/**
 * The forwarded host, but only when the header carries exactly one value.
 *
 * A multi-valued `x-forwarded-host` is the signature of a proxy that appended
 * to a client-supplied value, and the *first* element of such a list is the one
 * the client controls. Trusting it would let a client choose the origin the
 * request is compared against, so a multi-valued header is not trusted at all
 * and the `Host` header is used instead.
 */
function trustedForwardedHost(header: string | null): string | null {
  const values = allValues(header);
  return values.length === 1 ? values[0] : null;
}

/**
 * The scheme the request was addressed with.
 *
 * The scheme of the request URL is used, which is the scheme of the last hop.
 *
 * IMPORTANT — the request URL's scheme is NOT independent of the forwarded
 * headers. Next.js builds it from `x-forwarded-proto`:
 *
 *   next/dist/server/next-server.js
 *     const protocol = req.headers["x-forwarded-proto"]?.includes("https")
 *       ? "https" : "http";
 *
 * and it SYNTHESISES the header when it is absent
 * (`next/dist/server/base-server.js`). So in the default configuration the
 * scheme is still, in the end, a value the client can influence — but only
 * through that one header, and only in one direction:
 *
 *   - it cannot make a FOREIGN origin acceptable: the host still comes from
 *     the `Host` header, which the server routes on, so a client that names
 *     another host in `Origin` is still refused;
 *   - it can only cause a REFUSAL: a client that sends
 *     `X-Forwarded-Proto: https` to a deployment the browser reaches over
 *     plain HTTP makes the application compare the request against
 *     `https://<host>` while the browser sent `http://<host>`, and the write
 *     is refused. That is a self-inflicted denial, not a cross-origin hole,
 *     and it is the reason `EASY_LEARN_PUBLIC_ORIGIN` is the recommended
 *     configuration for any deployment behind an edge.
 *
 * `x-forwarded-proto` is consulted DIRECTLY (as opposed to through the
 * request URL) only when the deployment has opted in to trusting the
 * forwarded headers; the opt-in additionally allows a multi-valued host to
 * be distrusted entirely.
 */
function requestScheme(request: Request, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = lastValue(request.headers.get("x-forwarded-proto"));
    if (forwarded) return forwarded;
  }
  try {
    return new URL(request.url).protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

/**
 * The deployment's configured public origin, or null when it is not set.
 *
 * An unusable value is ignored rather than throwing: the consequence of a
 * misconfigured variable is that the request is compared against the derived
 * origin, which refuses a write rather than accepting a foreign one.
 */
export function getConfiguredPublicOrigin(): string | null {
  const raw = (process.env[PUBLIC_ORIGIN_ENV] || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * True when the deployment has opted in to trusting the forwarded headers.
 *
 * OFF unless `EASY_LEARN_TRUST_PROXY_HEADERS` is explicitly set to a true
 * value. See the module documentation for why this is not the default.
 */
export function trustsProxyHeaders(): boolean {
  const raw = (process.env[TRUST_PROXY_HEADERS_ENV] || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Every host this request may legitimately have been addressed to.
 *
 * The `Host` header is always included: the server routes on it, so it is the
 * host this request was actually addressed to. `x-forwarded-host` is included
 * ONLY when the deployment has opted in to trusting the forwarded headers, and
 * only when it carries exactly one value.
 */
export function getRequestHosts(request: Request): string[] {
  const headers = request.headers;
  const hosts = new Set<string>();

  const hostHeader = lastValue(headers.get("host"));
  if (hostHeader) hosts.add(hostHeader);

  if (trustsProxyHeaders()) {
    const forwardedHost = trustedForwardedHost(headers.get("x-forwarded-host"));
    if (forwardedHost) hosts.add(forwardedHost);
  }

  return [...hosts];
}

/**
 * Every origin the request may legitimately have been addressed to.
 *
 * The host and the scheme are taken from *independent* sources, so they are
 * combined as a cross-product rather than being paired up by one header. A
 * reverse proxy that publishes the public host but not the public scheme (a
 * common TLS-terminating configuration) would otherwise make the derived origin
 * `http://public-host` while the browser sends `https://public-host`, and every
 * same-origin write would be refused.
 *
 * The candidates are:
 *   - the `Host` header, always;
 *   - `x-forwarded-host`, when it carries a single value;
 *   - the scheme of `x-forwarded-proto`, or the scheme of the request URL;
 *   - plus `https` when a forwarded host was supplied without a forwarded
 *     scheme, because a TLS-terminating edge is the usual reason for that.
 */
export function getRequestOrigins(request: Request): string[] {
  const headers = request.headers;

  /* 1. The configured public origin wins outright. Forwarded headers are not
        consulted at all, so nothing a client sends can influence which origin
        a request is compared against. */
  const configured = getConfiguredPublicOrigin();
  if (configured) return [configured];

  const trustProxy = trustsProxyHeaders();

  const hosts = new Set<string>();
  const hostHeader = lastValue(headers.get("host"));
  if (hostHeader) hosts.add(hostHeader);

  const schemes = new Set<string>();
  const scheme = requestScheme(request, trustProxy);
  if (scheme) schemes.add(scheme);

  if (trustProxy) {
    const forwardedHost = trustedForwardedHost(headers.get("x-forwarded-host"));
    if (forwardedHost) {
      hosts.add(forwardedHost);
      // A forwarded host means the request came through a proxy, and the proxy
      // may have terminated TLS. The scheme that reaches this application is
      // then the scheme of the LAST hop, which is not necessarily the scheme
      // the browser used: the server synthesises `x-forwarded-proto: http` for
      // a plain internal hop even when the client spoke https to the edge.
      // The public origin is therefore also a candidate.
      //
      // This does not widen the set of HOSTS — it only lets the public scheme
      // be recognised for the host the proxy already published. A request for
      // `http://public-host` still needs the host to be ours.
      schemes.add("https");
    }
  }

  if (hosts.size === 0) return [];

  const origins: string[] = [];
  for (const s of schemes) {
    for (const h of hosts) {
      origins.push(`${s}://${h}`);
    }
  }
  return origins;
}

/**
 * The origin the request was addressed to, reconstructed from the request's own
 * headers. Behind a proxy the public scheme and host arrive in
 * `x-forwarded-proto` / `x-forwarded-host`; the `Host` header and the request URL
 * are the fallbacks.
 *
 * This is the first of `getRequestOrigins()`. Use `getRequestOrigins()` when the
 * decision has to consider every origin the request could legitimately have come
 * from.
 */
export function getRequestOrigin(request: Request): string | null {
  return getRequestOrigins(request)[0] ?? null;
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
 * Does the `Origin` header name one of the hosts this request was addressed
 * to?
 *
 * The comparison is on the HOST (host and port) and ignores the scheme. The
 * host is the part the server routes on, so it is the part that identifies
 * "this request is for us"; the scheme is compared separately, by the caller.
 */
function originHostMatches(origin: string, hosts: string[]): boolean {
  let originHost: string;
  try {
    // `URL.host` drops the default port, so `https://h:443` and `https://h`
    // compare equal — the same normalisation a browser applies.
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((host) => host.trim().toLowerCase() === originHost);
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
  /**
   * Whether the request ALSO carries the session cookie.
   *
   * A request that carries the session cookie holds ambient authority — the browser
   * attaches that cookie to cross-site requests too — so it is always origin-checked.
   * The bearer carve-out is therefore granted only when the bearer is the only
   * credential on the request. See rule 2 in the module comment.
   */
  hasSessionCookie: boolean;
  requestOrigin?: string | null;
  requestOrigins?: string[];
  /**
   * The hosts this request was addressed to (the `Host` header, plus the
   * forwarded host only under the trusted-proxy opt-in).
   */
  requestHosts?: string[];
  /**
   * True when the comparison origin was DERIVED from the request rather than
   * taken from `EASY_LEARN_PUBLIC_ORIGIN`.
   *
   * It matters because the derived SCHEME is not fully trustworthy: Next.js
   * builds the request URL from `x-forwarded-proto`, and a client can send
   * that header itself. A configured public origin has no such problem, so
   * with one configured the comparison stays exact.
   */
  originIsDerived?: boolean;
  allowedOrigins?: string[];
}): CsrfDecision {
  if (!isStateChangingMethod(options.method)) {
    return { allowed: true, rule: "method" };
  }

  if (options.hasBearerAuthorization && !options.hasSessionCookie) {
    // A deliberately supported non-browser client, and nothing else: a request that
    // ALSO carries the session cookie holds ambient authority and has to prove its
    // origin. See rule 2 in the module comment.
    return { allowed: true, rule: "bearer" };
  }

  // Every origin this request could legitimately have been addressed to. A
  // request that reached a TLS-terminating proxy may present a different host
  // and a different scheme than the pair the proxy published, so the two are
  // combined as a cross-product rather than trusted as one value.
  const requestOrigins = options.requestOrigins
    ? [...options.requestOrigins]
    : options.requestOrigin
      ? [options.requestOrigin]
      : [];
  const allowed = [
    ...requestOrigins,
    ...(options.allowedOrigins ?? getConfiguredAllowedOrigins()),
  ];

  if (options.origin) {
    const matches = allowed.some((candidate) => isSameOrigin(candidate, options.origin!));
    if (matches) return { allowed: true, rule: "same-origin" };

    /* ── The browser's own assertion ──────────────────────────────────────
       `Sec-Fetch-Site: same-origin` means the request's origin IS the
       initiator's origin. When the `Origin` header's HOST is one of the hosts
       this request was addressed to, that assertion is the browser's own proof
       of same-origin — and it is about the REAL origins, not about whatever a
       client-supplied `x-forwarded-proto` made this server derive.

       It exists for one measured reason. Next.js builds the request URL's
       scheme from `x-forwarded-proto` (next/dist/server/next-server.js), and
       it KEEPS a client-supplied value rather than overwriting it
       (next/dist/server/base-server.js: `req.headers['x-forwarded-proto'] ??=
       …`). So in the default configuration a client can make the derived
       origin `https://<host>` while the browser is on `http://<host>`, and the
       legitimate write used to be refused. This assertion restores it.

       What it does NOT weaken:
         - a foreign origin still fails: its HOST is not one of ours;
         - a same-host, different-scheme browser request still fails: the
           browser reports `Sec-Fetch-Site: same-site` for it, not
           `same-origin`;
         - with `EASY_LEARN_PUBLIC_ORIGIN` configured, this rule does not
           apply at all — the configured origin is the exact answer.
       A page on another origin cannot set `Sec-Fetch-Site`: it is a
       forbidden header name, so only the browser sets it. */
    if (
      options.originIsDerived === true &&
      options.fetchSite &&
      options.fetchSite.trim().toLowerCase() === "same-origin" &&
      originHostMatches(options.origin, options.requestHosts ?? [])
    ) {
      return { allowed: true, rule: "same-origin" };
    }

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
  /* The session cookie is read through the ONE definition of its name, so the policy can
     never disagree with the auth layer about which cookie is the session. */
  const hasSessionCookie = hasSessionCookieHeader(request.headers.get("cookie"));

  return evaluateCsrfRequest({
    method: request.method,
    origin: request.headers.get("origin"),
    fetchSite: request.headers.get("sec-fetch-site"),
    hasBearerAuthorization,
    hasSessionCookie,
    requestOrigins: getRequestOrigins(request),
    requestHosts: getRequestHosts(request),
    /* A configured public origin is exact, so the derived-origin rule below
       does not apply to it. */
    originIsDerived: getConfiguredPublicOrigin() === null,
  });
}
