"use client";

/**
 * Route-level error boundary (H-2, audit finding 3.2-5).
 *
 * Next.js renders this file when a Server Component below it throws, and when a Client
 * Component below it throws during render. Before this file existed there was **no**
 * error boundary in the application: a server-render failure produced Next's default
 * page, which in a production build says "Application error: a server-side exception
 * has occurred" and nothing else — no route, no correlation id, no "try again". The
 * user had no action and the operator got no signal.
 *
 * THREE THINGS IT DOES, in order of importance:
 *
 * 1. **It reports.** `error.digest` is the only stable handle on a server error: Next
 *    generates it, includes it in the framework's own log line, and passes it here. The
 *    client sends it back in a fire-and-forget POST so the failure appears in the
 *    request log even when the user never reports it. The report carries the digest,
 *    the route and the error name — never the message, because a server-rendered
 *    message can contain data the user should not re-transmit, and never a stack.
 *    The report is wrapped in try/catch and uses `keepalive`: a monitoring call must
 *    never break the recovery path.
 *
 * 2. **It gives the user an action.** A reset that re-renders the segment, plus a link
 *    home. `reset()` is the boundary's own recovery; a full navigation is offered for
 *    the case where the segment's state is what is broken.
 *
 * 3. **It stays quiet about internals.** The digest is shown to the user because it is
 *    their support handle, and it is not a secret: it is a hash, not a stack trace. The
 *    error message is not shown.
 *
 * This is a Client Component by necessity — error boundaries use `useEffect` and hooks.
 */

import { useEffect } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-client";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const digest = typeof error?.digest === "string" ? error.digest : undefined;
  const errorName = typeof error?.name === "string" ? error.name : "Error";

  useEffect(() => {
    /* One report per (digest, route) is enough; `useEffect` runs once per mount and the
       boundary remounts on a real navigation. `void` keeps the promise unobserved on
       purpose: there is nothing to do with a failure here, and awaiting it would delay
       painting the recovery UI. */
    try {
      /* The browser has exactly ONE audited call path (src/lib/api-client.ts), and this
         file is browser code: `tests/cookie-auth.test.ts` fails any browser file that
         calls the global `fetch` directly. Using `apiFetch` here is not incidental — it
         is what keeps "no browser file bypasses the audited path" true as this file
         grows. It sets `credentials: "same-origin"` and strips any `Authorization`
         header, neither of which this report needs or should ever carry. */
      void apiFetch("/api/internal/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          digest,
          name: errorName,
          route: typeof window !== "undefined" ? window.location.pathname : undefined,
        }),
        keepalive: true,
      }).catch(() => {
        /* Reporting is best-effort. Never surface its failure to the user. */
      });
    } catch {
      /* `fetch` itself can throw synchronously in a hostile environment. Ignore it. */
    }
  }, [digest, errorName]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 py-16">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-rose-600">Something went wrong</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">This page could not be loaded</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          The page ran into a problem while loading. Nothing you submitted from this screen was
          saved. You can try again, or go back to your dashboard.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              /* A full document reload is the honest escalation when re-rendering the
                 same segment with the same state is what failed. */
              if (typeof window !== "undefined") window.location.reload();
            }}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Reload the page
          </button>
          <Link
            href="/dashboard"
            className="rounded-lg px-2 py-2 text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
          >
            Go to dashboard
          </Link>
        </div>

        {digest ? (
          <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500">
            If you contact support, quote this reference:{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{digest}</code>
          </p>
        ) : null}
      </div>
    </main>
  );
}
