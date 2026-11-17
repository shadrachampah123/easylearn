/**
 * Interactive route segment — forces per-request rendering of this segment.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * `src/proxy.ts` issues a per-request CSP nonce and sends:
 *
 *   script-src 'self' 'nonce-…' 'strict-dynamic' 'unsafe-inline' blob:
 *
 * Under `'strict-dynamic'` a browser IGNORES `'self'` and `'unsafe-inline'`, so the
 * only scripts that may execute are the ones carrying that request's nonce (plus any
 * script those insert). Next.js can only inject that nonce into its `<script>` tags
 * when the document is rendered per request: a prerendered document is a build-time
 * artifact and carries no nonce at all.
 *
 * On af4fd93 `/login` was prerendered (`○`), so all 11 of its script tags had no
 * nonce, every chunk was blocked (`(blocked:csp)`), React never hydrated, the form's
 * `onSubmit` handler never existed, and clicking "Log In" performed a native form
 * GET back to `/login`. `POST /api/auth/login` was never dispatched, so no session
 * cookie was ever set and no error could be rendered.
 *
 * ── Why a layout and not the page ─────────────────────────────────────────────
 * Route segment config is only read from Server Components. A `"use client"` page
 * cannot export `dynamic`: Next.js accepts the export, ignores it, and still
 * prerenders the route (verified on 16.4.5). A server layout applies the config to
 * every route in the segment, which is why the fix lives here.
 *
 * ── Trade-off, stated deliberately ────────────────────────────────────────────
 * Every document in this segment is now server-rendered per request
 * (`Cache-Control: private, no-cache, no-store`), which is the price of a
 * nonce-based policy. `/_next/static/*` chunks keep their immutable caching.
 * Public marketing routes are not covered here and stay prerendered (`○`) on
 * purpose; see tests/csp-hydration-dynamic-rendering.test.ts for the invariant.
 *
 * Regression coverage: `tests/csp-hydration-dynamic-rendering.test.ts` (CI, no
 * build needed) and `tests/manual/csp-nonce-hydration-probe.js` (asserts the
 * served nonces against a running build).
 */
export const dynamic = "force-dynamic";

import type { ReactNode } from "react";

export default function LoginSegmentLayout({ children }: { children: ReactNode }) {
  return children;
}
