/**
 * The session cookie: one name, one definition, used by every reader and writer.
 *
 * The cookie name is the thing that ties the browser session together. If the
 * login route set `el_token` but the logout route cleared `session_token`, the
 * browser would keep sending the old cookie after a logout and the session would
 * appear to survive it. The name therefore lives in exactly one place, and every
 * producer and consumer imports it from here.
 *
 * This module is isomorphic: it contains no Node-only and no browser-only API, so
 * it can be imported from a route handler and from a client component alike.
 */

/** The name of the `httpOnly` session cookie. Browser JavaScript cannot read it. */
export const SESSION_COOKIE_NAME = "el_token";

/**
 * Reads the session token out of a `Cookie` request header.
 *
 * Returns `null` when the header is absent or does not carry the session cookie.
 *
 * The match is anchored to the start of a cookie pair (`(?:^|;\s*)`) so that a
 * cookie such as `other_el_token=…` is never mistaken for the session cookie.
 */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;

  const escapedName = SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  if (!match || !match[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed cookie value is not a valid token; treat it as absent rather
    // than letting a decoding error turn into a 500.
    return null;
  }
}
