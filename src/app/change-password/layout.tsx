/**
 * Interactive route segment — forces per-request rendering of this segment.
 *
 * `/change-password` is the mandatory first stop for an account whose
 * `must_change_password` flag is set. It is a client component: it reads the session
 * from `/api/auth/me` and posts to `/api/auth/change-password`. Without hydration it
 * cannot do either — and a bounce back to `/login` would look exactly like a login
 * failure, which is why this segment is covered by the same fix as `/login`.
 *
 * See `src/app/login/layout.tsx` for the full rationale.
 */
export const dynamic = "force-dynamic";

import type { ReactNode } from "react";

export default function ChangePasswordSegmentLayout({ children }: { children: ReactNode }) {
  return children;
}
