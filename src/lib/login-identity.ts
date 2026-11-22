/**
 * Login-identity invariants (independent security review finding **F-6**, 2026-11-19).
 *
 * The login throttle keys every budget on identifier **strings** (`login_attempts.identifier`),
 * and `clearFailedLoginAttempts` releases the failures recorded for every alias of the account
 * that just signed in. That is correct as long as one string belongs to one account. Nothing in
 * the schema can enforce it: `users.email` and `users.username` are separate columns with
 * separate unique indexes, so cross-column uniqueness is inexpressible without a computed
 * union, and no migration here may add one.
 *
 * What that allowed, measured: an account whose `email` equals *another* account's `username`
 * erased that other account's recorded failures on sign-in — four accumulated failures went to
 * zero — because both accounts share the identifier string, and the throttle cannot tell them
 * apart. It is a narrow finding (public registration is a disabled stub, usernames are generated
 * from letters only, and an insider already has an admin password-reset path), but it is free to
 * close at the only place accounts are created.
 *
 * So the invariant is enforced in the application, at the write path, and documented as a
 * residual: an operator with direct database access can still create a collision, and the
 * throttle would then conflate the two accounts.
 */

/**
 * Deliberately strict, and stricter than "contains an @": the value is stored in a column that
 * the login throttle uses as a bucket key, so it must not be able to hold a bare username, a
 * header-ish fragment, or anything with whitespace or a comma/semicolon/colon in it.
 *
 * Not an RFC 5322 parser — quoted local parts and internationalised domains are out of scope
 * for a school identity store, and rejecting them is the safe direction.
 */
const EMAIL_FORMAT_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** True when `value` is a non-empty email address this application is willing to store. */
export function isValidLoginEmail(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim().toLowerCase();
  return candidate.length > 0 && candidate.length <= 255 && EMAIL_FORMAT_PATTERN.test(candidate);
}

/** The same normalization the throttle applies: trim, lower-case. */
export function normalizeLoginIdentifier(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export type LoginAliasCollisionKind =
  /** The new account's email is already another account's username. */
  | "email_matches_existing_username"
  /** The generated username is already another account's email. */
  | "username_matches_existing_email";

export interface LoginAliasCollision {
  kind: LoginAliasCollisionKind;
  /** The offending identifier, normalized. Safe to name: it is the caller's own input. */
  identifier: string;
}

/**
 * Check both directions of the cross-column invariant.
 *
 * `exists` is injected so the rule is testable without a database and so the caller decides how
 * to look rows up (the users route uses its own drizzle handle). It must answer "does any
 * **other** account already hold this identifier in the column named by the call".
 */
export async function findLoginAliasCollision(
  exists: (column: "email" | "username", identifier: string) => Promise<boolean>,
  candidate: { email?: string | null; username?: string | null }
): Promise<LoginAliasCollision | null> {
  const email = normalizeLoginIdentifier(candidate.email);
  const username = normalizeLoginIdentifier(candidate.username);

  if (email && (await exists("username", email))) {
    return { kind: "email_matches_existing_username", identifier: email };
  }
  if (username && (await exists("email", username))) {
    return { kind: "username_matches_existing_email", identifier: username };
  }
  return null;
}

/** Operator-facing wording for a rejected creation. No other account's data is disclosed. */
export function loginAliasCollisionMessage(collision: LoginAliasCollision): string {
  return collision.kind === "email_matches_existing_username"
    ? "That email address is already in use as another account's username. Login throttling identifies accounts by that string, so the two would share one guess budget. Choose a different email address."
    : "The generated username is already in use as another account's email address. Login throttling identifies accounts by that string, so the two would share one guess budget. Choose a different first or last name.";
}
