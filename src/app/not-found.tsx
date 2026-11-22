/**
 * 404 boundary (H-2).
 *
 * Rendered by `notFound()` and for an unmatched route. It is a Server Component: a 404
 * has no state to recover, so there is no reason to ship JavaScript for it.
 *
 * Two deliberate choices:
 *
 * - **No navigation is guessed.** A signed-in learner, a teacher and a signed-out
 *   visitor all reach this page. Offering "go to your dashboard" to a signed-out
 *   visitor produces another redirect and another moment of confusion, so the page
 *   offers the public home page and the sign-in page, which exist in every state.
 * - **It says what happened without echoing the path.** The requested URL can contain
 *   a token, an email address or another user's identifier — and this page is rendered
 *   into a response that may be cached by a proxy. The path is not reflected.
 */

import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 py-16">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">404 — not found</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">We could not find that page</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          The link may be out of date, or the page may have moved. Check the address, or start again
          from one of these:
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Home page
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
