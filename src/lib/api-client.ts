/**
 * The single way the browser talks to the EasyLearn API.
 *
 * ── Why this module exists ──────────────────────────────────────────────────────
 * The session token is an `httpOnly` cookie. That is the whole point: script running
 * on the page cannot read it, so a cross-site scripting bug cannot exfiltrate a
 * long-lived credential. Every other way of carrying the token in the browser
 * (`localStorage`, a readable cookie, an `Authorization` header) puts the credential
 * back within reach of any injected script and defeats the control.
 *
 * So the browser does not have a token to send. It has a cookie, and the browser
 * attaches it to same-origin requests by itself. This module makes that explicit and
 * enforces it:
 *
 *   1. `credentials: "same-origin"` is set, so the session cookie is sent to
 *      same-origin API routes and is NEVER sent to a cross-origin URL.
 *   2. Any `Authorization` header is stripped before the request is made, so a
 *      call site cannot accidentally reintroduce bearer-token authentication in the
 *      browser even if one is added to the request by mistake.
 *   3. No token is read from, written to, or derived from web storage. There is no
 *      `getToken()` for a caller to reach for.
 *
 * The server still accepts `Authorization: Bearer` for deliberately supported
 * non-browser integrations (see `docs/SECURITY_AUTHENTICATION.md`). That is a
 * server-side capability; the browser simply never uses it.
 */

/**
 * The name of the `httpOnly` session cookie.
 *
 * It is defined once, in `src/lib/session-cookie.ts`, and re-exported here so the
 * browser code has a single import site. The browser cannot read the cookie's
 * value — only its name.
 */
export { SESSION_COOKIE_NAME } from "@/lib/session-cookie";

/**
 * Performs an authenticated same-origin API request.
 *
 * The session cookie is attached by the browser. No credential is read from or
 * written to web storage, and any `Authorization` header on `init` is removed.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  // Belt and braces: the browser must not be able to present a bearer token even if a
  // call site tries to add one.
  headers.delete("authorization");

  return fetch(input, {
    ...init,
    headers,
    credentials: "same-origin",
  });
}

/**
 * True when the response means "this session is no longer valid".
 *
 * Used by the client to send the user back to the sign-in page instead of rendering
 * an empty dashboard.
 */
export function isUnauthorized(response: Response): boolean {
  return response.status === 401;
}

/**
 * Reads a JSON API response, tolerating a non-JSON body.
 *
 * The API always answers JSON, but a proxy or a crashed handler can answer with HTML;
 * the client must not throw on that.
 */
export async function readJson(response: Response): Promise<{
  success?: boolean;
  data?: any;
  error?: string;
  [key: string]: any;
}> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
