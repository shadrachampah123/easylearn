"use client";

/**
 * Root error boundary (H-2).
 *
 * `global-error.tsx` replaces the root layout when the layout itself throws, so it must
 * render its own `<html>` and `<body>`. It is the last line of defence: without it, an
 * exception in `src/app/layout.tsx` — a bad metadata value, a provider that fails
 * during render — produces Next's unstyled default error page.
 *
 * It deliberately does NOT use the application's CSS framework classes for layout
 * criticality: when the root layout fails, the stylesheet may not have loaded, so the
 * inline styles below are what keeps the page legible. Tailwind classes are included
 * where they help when CSS *is* present.
 *
 * The same reporting contract as `error.tsx`: digest only, fire-and-forget, never able
 * to break the page.
 */

import { useEffect } from "react";
import { apiFetch } from "@/lib/api-client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const digest = typeof error?.digest === "string" ? error.digest : undefined;
  const errorName = typeof error?.name === "string" ? error.name : "Error";

  useEffect(() => {
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
          fatal: true,
        }),
        keepalive: true,
      }).catch(() => {
        /* Best-effort. */
      });
    } catch {
      /* Best-effort. */
    }
  }, [digest, errorName]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8fafc",
          color: "#0f172a",
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <title>EasyLearn — Service error</title>
        <div
          style={{
            maxWidth: 520,
            width: "100%",
            margin: "24px",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 16,
            padding: 32,
            boxSizing: "border-box",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "#e11d48",
            }}
          >
            Service error
          </p>
          <h1 style={{ margin: "8px 0 0", fontSize: 24, lineHeight: 1.25 }}>
            EasyLearn could not load this page
          </h1>
          <p style={{ margin: "12px 0 0", fontSize: 14, lineHeight: 1.6, color: "#475569" }}>
            The application shell failed to render. Your session is unaffected — no data was changed.
            Reloading usually clears it; if it persists, the reference below identifies the failure in
            the server log.
          </p>

          <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                borderRadius: 8,
                border: "none",
                background: "#2563eb",
                color: "#ffffff",
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                /* A FULL document load, deliberately, and not `useRouter().push()`.
                   When the root layout fails the React tree is already broken; a
                   client-side navigation would re-enter the same failure. A hard
                   reload from `/` discards the broken tree instead of reusing it. */
                if (typeof window !== "undefined") window.location.replace("/");
              }}
              style={{
                borderRadius: 8,
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#334155",
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Go to the home page
            </button>
          </div>

          {digest ? (
            <p style={{ margin: "24px 0 0", paddingTop: 16, borderTop: "1px solid #f1f5f9", fontSize: 12, color: "#64748b" }}>
              Reference:{" "}
              <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, fontFamily: "ui-monospace, monospace" }}>
                {digest}
              </code>
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
