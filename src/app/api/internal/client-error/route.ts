/**
 * Client error-boundary intake (H-2).
 *
 * The error boundaries in `src/app/error.tsx` and `src/app/global-error.tsx` POST the
 * framework's error digest here so a failure surfaced to a user also appears in the
 * server log. Without this, a render error reaches Vercel's log only if the platform
 * independently captured it, and it is never joined to the user's report.
 *
 * SECURITY POSTURE — this is an unauthenticated endpoint that writes to the log, so it
 * is treated as an untrusted-input sink:
 *
 * - **It never echoes what it was sent.** The response is a fixed `{ ok: true }`.
 * - **No CSRF exemption is taken, and none is needed.** This is a `POST`, so the
 *   proxy's policy in `src/lib/csrf.ts` applies to it exactly as it does to every other
 *   state-changing API request: a same-origin browser request passes, a cross-site one
 *   is refused. The boundary that calls it always runs on this application's origin.
 *   The route is additionally built so that forgery would be harmless if it were ever
 *   reachable — it has no side effect beyond a log line and accepts no credentials — and
 *   every field is validated, redacted and size-capped anyway, because the remaining
 *   risk after a bypass is log *volume*, not disclosure.
 * - **Every field is validated and bounded.** The digest must look like a digest; the
 *   name must be short and alphanumeric; the route must be a path; the body must be
 *   small. Anything else is dropped silently, because the caller is a browser that
 *   cannot act on an error.
 * - **It is rate-limited per source.** A loop of failing renders must not be able to
 *   fill the log platform's quota — the same reasoning as the login throttle, applied
 *   to the newest write path.
 * - **It cannot fail.** Any error inside the handler still answers 204: a reporting
 *   endpoint that returns 500 creates a second error for the boundary to handle.
 */

import { randomUUID } from "node:crypto";

import { describeError, log } from "@/lib/logger";
import { currentRequestId, runWithCurrentRequest } from "@/lib/request-context";
import { redactText } from "@/lib/log-redaction";
import { getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A Next.js error digest is a 10-digit decimal string; a single hex hash also occurs. */
const DIGEST_PATTERN = /^[0-9]{1,32}$|^[a-f0-9]{8,64}$/i;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._]{0,63}$/;
const MAX_BODY_BYTES = 2_048;
/** Per-source ceiling. Generous for a real user, useless for a loop. */
const MAX_REPORTS_PER_SOURCE_PER_MINUTE = 20;

/* A module-level counter, not a database table: this is a self-protection valve, it
   resets with the instance, and it must never be the reason a report fails. Vercel's
   function instances are short-lived, so the true global rate is bounded anyway. */
const recentReports = new Map<string, number[]>();
/* Sources that have already been told they are over the limit in the current window.
   The FIRST suppression is logged at `warn` — an operator needs to know reports are
   being dropped — and every later one in the same window is `debug`, so a loop cannot
   turn the valve into the flood it exists to prevent. */
const announcedSuppression = new Set<string>();

function isRateLimited(source: string, now: number): boolean {
  try {
    const windowStart = now - 60_000;
    const timestamps = (recentReports.get(source) ?? []).filter(
      (at) => at > windowStart,
    );
    if (timestamps.length >= MAX_REPORTS_PER_SOURCE_PER_MINUTE) {
      recentReports.set(source, timestamps);
      if (!announcedSuppression.has(source)) {
        announcedSuppression.add(source);
        /* One line per source per window. No counts of what was dropped: the count is
           itself a resource an attacker controls. */
        log.warn("client error reports are being rate-limited for a source", {
          event: "client_error.rate_limited",
          limit: MAX_REPORTS_PER_SOURCE_PER_MINUTE,
          windowSeconds: 60,
        });
      }
      return true;
    }
    timestamps.push(now);
    recentReports.set(source, timestamps);
    /* Bound the map itself: a flood from many sources is the case the log quota is
       meant to survive. 512 sources × 20 timestamps is a few hundred kilobytes. */
    if (recentReports.size > 512) {
      const oldest = recentReports.keys().next();
      if (!oldest.done) {
        recentReports.delete(oldest.value);
        announcedSuppression.delete(oldest.value);
      }
    }
    /* A quiet source gets its suppression announcement back after the window. */
    if (announcedSuppression.size > 512) announcedSuppression.clear();
    return false;
  } catch {
    /* If the valve itself fails, allow the report. Losing a signal is worse than one
       extra line. */
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  /* Same wiring as the health route: enter the correlation context so the line this
     handler writes carries the id the proxy published instead of a fresh one. */
  return runWithCurrentRequest(request, () => handleReport(request));
}

async function handleReport(request: Request): Promise<Response> {
  const respond = () =>
    new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });

  try {
    /* Inherited from the context `runWithCurrentRequest` established above.
     *
     * `currentRequestId()` is typed `string | undefined` because it answers `undefined`
     * when `node:async_hooks` is unavailable — a runtime where correlation degrades but
     * the application must keep working. Logging `requestId: undefined` there would drop
     * the field entirely (and, before the logger fix in this review, could overwrite a
     * resolved id with an empty one). The intake's whole value is that a browser-visible
     * failure can be joined to a server line, so it falls back to a fresh id rather than
     * emitting an uncorrelated report. Post-deployment H-2 review, 2026-11-19. */
    const requestId = currentRequestId() ?? randomUUID();
    const source = getClientIp(request) ?? "unattributable";
    if (isRateLimited(source, Date.now())) {
      /* `isRateLimited` logs the first suppression in a window and nothing after it. */
      return respond();
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      log.warn("client error report rejected: body too large", {
        event: "client_error.rejected",
        requestId,
        size: rawBody.length,
      });
      return respond();
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return respond();
    }
    if (!parsed || typeof parsed !== "object") return respond();

    const body = parsed as Record<string, unknown>;
    const digest =
      typeof body.digest === "string" && DIGEST_PATTERN.test(body.digest)
        ? body.digest
        : undefined;
    const name =
      typeof body.name === "string" && ERROR_NAME_PATTERN.test(body.name)
        ? body.name
        : "Error";
    /* The route is a pathname the boundary read from `window.location`; it can still be
       attacker-shaped if a tool calls this directly. Only the shape is kept. */
    const route =
      typeof body.route === "string" && body.route.startsWith("/")
        ? redactText(body.route.slice(0, 256))
        : undefined;
    const fatal = body.fatal === true;

    log.error(
      fatal
        ? "client fatal error boundary fired"
        : "client error boundary fired",
      {
        event: fatal ? "client_error.fatal" : "client_error",
        requestId,
        error: { name, digest },
        route,
        /* The reporter cannot say whether the server already logged this; a digest with
         no matching server line means the error happened during hydration. */
        phase: digest ? "server-or-hydration" : "client-only",
      },
    );

    return respond();
  } catch (error) {
    /* Even here: a fixed structured line, no request echo, and a success-shaped answer. */
    try {
      log.warn("client error report handler failed", {
        event: "client_error.handler_failed",
        error: describeError(error),
      });
    } catch {
      /* Nothing left to do. */
    }
    return respond();
  }
}

/** A GET on this path is a misconfiguration, not a resource. Say so without detail. */
export async function GET(): Promise<Response> {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}
