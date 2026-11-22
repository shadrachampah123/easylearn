/**
 * Next.js instrumentation lifecycle (H-2).
 *
 * `instrumentation.ts` is the supported hook (Next.js 15+, unchanged in 16) for code
 * that must run once per server instance and for catching errors that escape a route.
 * It lives in `src/` because that is where `app/` lives; Next resolves
 * `src/instrumentation.ts` when the app directory is `src/app`.
 *
 * TWO HOOKS, TWO JOBS:
 *
 * `register()` runs once when a server instance boots, before the first request. It is
 * used for the one-time configuration sanity report — a structured line that says what
 * the instance *thinks* its deployment looks like. This is what turns "the deployment
 * has no JWT secret" from a user-reported 503 into a log line at boot.
 *
 * `onRequestError()` receives every error the framework catches while handling a
 * request — render errors, route-handler throws, server-action failures — with the
 * request path, method and route kind. That is the observability channel the audit
 * said did not exist: before this, a thrown error in a route could reach Vercel's log
 * as an unstructured stack trace, or reach nobody at all.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE:
 *
 * - No APM agent, no vendor SDK, no paid dependency (an explicit constraint of this
 *   task). The runtime log is the transport.
 * - No network call at boot. Vercel would bill the invocation, and a boot hook that
 *   fails on a database blip would take the function down with it.
 * - No throwing. `register()` must not fail startup: a deployment that boots but logs a
 *   warning is strictly better than one that refuses to boot because a diagnostic did.
 */

export async function register(): Promise<void> {
  /* The instrumentation hook runs for both the Node.js and the Edge runtime. The
     logging and correlation modules use `node:async_hooks` and `node:crypto`, so the
     Edge pass reports nothing rather than being half-initialised. Next.js documents
     `process.env.NEXT_RUNTIME` as the way to branch here. */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const [{ log }, { hasAsyncContext }] = await Promise.all([
      import("@/lib/logger"),
      import("@/lib/request-context"),
    ]);
    const {
      getDatabaseConfigurationProblem,
      getJwtConfigurationProblem,
      getNodeRuntimeVersion,
    } = await import("@/lib/env");
    const { inspectObjectStorageConfiguration } =
      await import("@/lib/object-storage-readiness");

    const jwtProblem = getJwtConfigurationProblem();
    const databaseProblem = getDatabaseConfigurationProblem();
    const storage = inspectObjectStorageConfiguration();

    /* Field names, counts and booleans — never a value. `jwtProblem` is produced by the
       shared secret policy and is a sentence about *why* a secret is unacceptable, not
       the secret; it is still passed through the logger's redactor like everything
       else. */
    const fields = {
      event: "server.startup",
      runtime: process.env.NEXT_RUNTIME,
      /* Indirect on purpose: reading the Node version inline in this file makes Next's
         build-time Edge checker warn, because it sees the expression in the Edge copy of
         this module and cannot tell that the branch above already returned. See
         `getNodeRuntimeVersion` in `@/lib/env` for the full reasoning. */
      nodeVersion: getNodeRuntimeVersion(),
      deployment:
        process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      /* Vercel's git metadata is not secret and is the first thing anyone asks. */
      gitCommit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
      gitBranch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      hasJwtSecret: !jwtProblem,
      hasDatabaseUrl: !databaseProblem,
      objectStorageConfigured: storage.configured,
      objectStorageMissingVariables: storage.missingVariables,
      objectStorageWarnings: storage.warnings,
      requestCorrelationAvailable: hasAsyncContext,
      logLevel: process.env.EASY_LEARN_LOG_LEVEL ?? "info",
    };

    /* A broken deployment configuration is an ERROR at boot: an operator reading the
       log should not have to wait for the first failed login to learn that the JWT
       secret is unusable. A working one is `info`. */
    if (jwtProblem || databaseProblem) {
      log.error("server started with a configuration problem", {
        ...fields,
        /* The reason string only — never the offending value. */
        jwtProblem: jwtProblem ?? undefined,
        databaseProblem: databaseProblem ?? undefined,
      });
      return;
    }

    log.info("server started", fields);
  } catch (error) {
    /* Startup must continue whatever happens in a diagnostic. The logger redacts the
       error, so this line cannot leak the very configuration it is complaining about. */
    try {
      const { log } = await import("@/lib/logger");
      log.warn(
        "instrumentation register() failed; continuing without the startup report",
        {
          event: "server.startup_failed",
          error,
        },
      );
    } catch {
      /* Even the logger is unavailable. Booting matters more than reporting. */
    }
  }
}

/**
 * Errors that escape a request.
 *
 * The framework passes the error, a minimal request view and a context describing
 * *where* it happened (router kind, route path, route type, render source). Everything
 * logged here is redacted by `logger.emit`; the request headers are deliberately NOT
 * logged wholesale — they carry `cookie` and `authorization` — and only the two
 * headers that are safe and useful are read.
 */
export async function onRequestError(
  error: unknown,
  request: Readonly<{
    path: string;
    method: string;
    headers: NodeJS.Dict<string | string[]>;
  }>,
  context: Readonly<{
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "render" | "route" | "action" | "proxy";
    renderSource?:
      | "react-server-components"
      | "react-server-components-payload"
      | "server-rendering";
    revalidateReason: "on-demand" | "stale" | undefined;
  }>,
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { log, describeError } = await import("@/lib/logger");
    const { runWithCurrentRequest } = await import("@/lib/request-context");

    /* The framework hands us its own request view, not the proxy-stamped one, so the id
       is resolved the same way the proxy resolves it: reuse `x-request-id` when it is
       well-formed, otherwise Vercel's id, otherwise generate. Logging inside
       `runWithCurrentRequest` means `emit` picks this id up automatically — the same
       mechanism every other line of the request uses, rather than a second code path
       that could drift. */
    const headers = new Headers();
    const incoming = safeHeader(request.headers, "x-request-id");
    if (incoming) headers.set("x-request-id", incoming);
    const vercel = safeHeader(request.headers, "x-vercel-id");
    if (vercel) headers.set("x-vercel-id", vercel);

    await runWithCurrentRequest({ headers }, async () => {
      /* `request.path` is attacker-controlled. `logger` redacts strings, so a token
       pasted into a query string is removed; the length is bounded for the same reason
       every other field is. */
      log.error("unhandled request error", {
        event: "request.error",
        path: String(request.path ?? "").slice(0, 512),
        method: String(request.method ?? "").slice(0, 16),
        routerKind: context?.routerKind,
        routePath: context?.routePath,
        routeType: context?.routeType,
        renderSource: context?.renderSource,
        userAgent: safeHeader(request.headers, "user-agent")?.slice(0, 256),
        error: describeError(error),
      });
    });
  } catch {
    /* The observability hook must never create a second failure on top of the one it
       is reporting. */
  }
}

/** Read one header from the framework's `NodeJS.Dict<string | string[]>` view. */
function safeHeader(
  headers: NodeJS.Dict<string | string[]> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
