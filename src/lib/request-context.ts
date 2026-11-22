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
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
  route?: string;
  method?: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

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
