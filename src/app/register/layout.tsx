/**
 * Interactive route segment — forces per-request rendering of this segment.
 *
 * Registration is a client component that must hydrate: it posts to
 * `/api/auth/register` and renders validation/server errors. A prerendered document
 * receives no CSP nonce, and `'strict-dynamic'` (see `src/proxy.ts`) makes the browser
 * ignore `'self'`, so every chunk would be blocked and the form would fall back to a
 * native submit that never reaches the API.
 *
 * See `src/app/login/layout.tsx` for the full rationale and the af4fd93 failed-login
 * case this prevents.
 */
export const dynamic = "force-dynamic";

import type { ReactNode } from "react";

export default function RegisterSegmentLayout({ children }: { children: ReactNode }) {
  return children;
}
