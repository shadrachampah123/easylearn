/**
 * Interactive route segment — forces per-request rendering of every dashboard route.
 *
 * Every page under `/dashboard` is a client component that renders `DashboardShell`,
 * which immediately calls `/api/auth/me` and redirects to `/login` when the session is
 * not usable. A prerendered document receives no CSP nonce, and `'strict-dynamic'`
 * (see `src/proxy.ts`) makes the browser ignore `'self'`, so the chunks would be
 * blocked, React would never hydrate, `DashboardShell` would never run, and the user
 * would sit on the shell's loading spinner forever.
 *
 * This layout is a pass-through: it adds no markup and does not change any page's
 * structure. It exists only to carry the route segment config, which a `"use client"`
 * page cannot supply. See `src/app/login/layout.tsx` for the full rationale.
 */
export const dynamic = "force-dynamic";

import type { ReactNode } from "react";

export default function DashboardSegmentLayout({ children }: { children: ReactNode }) {
  return children;
}
