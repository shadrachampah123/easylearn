/**
 * Per-request correlation context (H-2).
 *
 * `AsyncLocalStorage` carries the request id across `await` boundaries without
 * threading it through every function signature — which matters because the code that
 * needs it most (a `catch` deep inside a route) is the code furthest from the handler.
 *
 * Two deliberate limits:
 *
 * 1. **It is best-effort, not a correctness mechanism.** If the store is unavailable
 *    (an Edge runtime without `node:async_hooks`, a bundler that dropped it) the
 *    helpers become no-ops and the request still works. Correlation is a diagnostic;
 *    it must never be a dependency of the response.
 * 2. **It stores only an id.** Not a user, not an email, not the path. The id is the
 *    one value that is safe to log and safe to echo, so there is nothing here whose
 *    redaction could be forgotten.
 *
 * ── How the context is ESTABLISHED (PR #70 review finding) ───────────────────
 * The first version of this module defined `runWithRequestContext` and nothing called
 * it, so every log line produced deep inside a route had no correlation id unless the
 * author passed one by hand. A helper nobody invokes is not integration, and a unit test
 * that calls it directly proves only that `AsyncLocalStorage` works — not that a request
 * is ever wrapped in it. That is why the regression for this finding is an END-TO-END
 * test (`tests/observability-correlation.test.ts`) that drives the real proxy and the real
 * route handlers and reads the lines that reach the log.
 *
 * The chain is now:
 *
 *   1. `src/proxy.ts` — the one place every matched request passes through. It resolves
 *      an id (reusing a platform header only when it is well-formed) and sets
 *      `x-request-id` on the request headers.
 *   2. `src/lib/request-context.ts#runWithCurrentRequest` — called by route handlers
 *      and by the instrumentation hook. It reads that header, falls back to generating
 *      an id, and runs the handler inside `AsyncLocalStorage.run`.
 *   3. `src/lib/logger.ts#emit` — fills `requestId` from `currentRequestId()` whenever
 *      the caller did not supply one, so a `log.error(...)` three `await`s deep carries
 *      the id without being told.
 *
 * Every step is optional at runtime: if the header is missing or the store is
 * unavailable, an id is generated and the request proceeds. Correlation is a diagnostic
 * and must never be a reason a request fails.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { __setActiveRequestIdReader, isAcceptableRequestId } from "@/lib/logger";

interface RequestContext {
  requestId: string;
  route?: string;
  method?: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/* Install the reader the logger uses to fill `requestId` on every line. Done here rather
   than in the logger because the dependency arrow points this way (this module imports
   `isAcceptableRequestId` from the logger). One assignment at module load; no per-request
   cost. */
__setActiveRequestIdReader(currentRequestId);

/** Whether the store is usable. False in a runtime that dropped `node:async_hooks`. */
export const hasAsyncContext = (() => {
  try {
    /* Construct twice: some shims throw only on `getStore`, others only on `run`. */
    const probe = new AsyncLocalStorage<RequestContext>();
    probe.run({ requestId: "probe", startedAt: 0 }, () => probe.getStore());
    return true;
  } catch {
    return false;
  }
})();

/** Run `fn` with a correlation context. Returns `fn`'s value unchanged. */
export function runWithRequestContext<T>(context: Omit<RequestContext, "startedAt"> & { startedAt?: number }, fn: () => T): T {
  const full: RequestContext = { ...context, startedAt: context.startedAt ?? Date.now() };
  if (!hasAsyncContext) return fn();
  try {
    return storage.run(full, fn);
  } catch {
    /* Never let a diagnostic mechanism change the response. */
    return fn();
  }
}

/** The current request id, or `undefined` outside a request. */
export function currentRequestId(): string | undefined {
  if (!hasAsyncContext) return undefined;
  try {
    return storage.getStore()?.requestId;
  } catch {
    return undefined;
  }
}

/** The current request's route/method, or undefined. */
export function currentRequestInfo(): { requestId: string; route?: string; method?: string; elapsedMs: number } | undefined {
  if (!hasAsyncContext) return undefined;
  try {
    const store = storage.getStore();
    if (!store) return undefined;
    return {
      requestId: store.requestId,
      route: store.route,
      method: store.method,
      elapsedMs: Date.now() - store.startedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the correlation id for an incoming request.
 *
 * A platform header is reused only when it is well-formed (`isAcceptableRequestId`), so a
 * client cannot inject text into the log or claim another request's id. Otherwise a
 * fresh UUID is generated. Deliberately separate from `runWithCurrentRequest` so a caller
 * that only needs the id (the proxy) does not have to enter a store it cannot share with
 * the route anyway.
 */
export function resolveIncomingRequestId(headers: { get(name: string): string | null } | null | undefined): string {
  try {
    if (headers) {
      for (const name of ["x-request-id", "x-vercel-id", "x-vercel-request-id"]) {
        const candidate = headers.get(name);
        if (candidate && isAcceptableRequestId(candidate.trim())) return candidate.trim();
      }
    }
  } catch {
    /* A header shim that throws is not a reason to fail a request. */
  }
  return randomUUID();
}

/**
 * Run `fn` with a correlation context derived from the request's headers.
 *
 * This is the function route handlers and the instrumentation hook call. It is
 * deliberately tolerant: any failure to enter the store falls back to calling `fn`
 * directly, with the id still resolved, so the request's behaviour never depends on
 * the diagnostic working.
 */
export function runWithCurrentRequest<T>(
  request: { headers: { get(name: string): string | null }; method?: string } | null | undefined,
  fn: (requestId: string) => T
): T {
  let requestId: string;
  try {
    requestId = resolveIncomingRequestId(request?.headers);
  } catch {
    requestId = randomUUID();
  }
  try {
    return runWithRequestContext(
      { requestId, method: request?.method, route: currentRouteHint() },
      () => fn(requestId)
    );
  } catch {
    /* Entering the store failed (should not happen — `runWithRequestContext` already
       guards). Still run the work, with the id in hand for the caller to log itself. */
    return fn(requestId);
  }
}

/**
 * Best-effort route label for the context.
 *
 * Next.js does not expose the matched route to a Server Component, and inventing one
 * from the headers would be a guess. An empty value is honest; the request id is what
 * correlation actually needs.
 */
function currentRouteHint(): string | undefined {
  return undefined;
}
