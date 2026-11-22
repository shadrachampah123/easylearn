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

/**
 * **F-6 follow-up — making the invariant atomic.**
 *
 * Enforcing the cross-column rule with separate `SELECT`s followed by an `INSERT` is a
 * check-then-act race, and the window is not theoretical: `POST /api/users` hashed the
 * password (bcrypt cost 12, ~250 ms) *between* the checks and the insert, so two concurrent
 * creations could each read "no conflict" and each commit. Measured with two opposing
 * requests — one creating `email = X`, the other creating an account whose generated
 * `username = X` — both accounts were created and the collision survived, which is the exact
 * state the guard exists to prevent: two accounts sharing one login-throttle bucket, where a
 * successful sign-in to one releases the other's recorded failures.
 *
 * Nothing in the schema can close this with a constraint: `users.email` and `users.username`
 * are separate columns with separate unique indexes, so cross-column uniqueness would need a
 * computed union (an expression index over `COALESCE`) — a Production migration, which this
 * work is not authorised to add. So the invariant is serialised instead, in the database:
 *
 *   BEGIN
 *     SET LOCAL lock_timeout = <bound>            -- a stuck creation cannot wedge the pool
 *     SELECT pg_advisory_xact_lock(hash(NAMESPACE))
 *     ...every uniqueness check, the username generation, the INSERT and the membership...
 *   COMMIT                                        -- the lock is released by the commit
 *
 * The checks and the insert are then one atomic step: any second creation waits for the first
 * to commit and reads its rows.
 *
 * **Why one namespace lock rather than a lock per identifier.** Per-identifier keys look
 * finer-grained, but the generated username is not known until the uniqueness reads have run,
 * and those reads must themselves be inside the lock — so a per-identifier design has to lock
 * in two phases (the base candidate, then the chosen one plus the email), and two transactions
 * can then acquire overlapping key sets in opposite order. That is a deadlock cycle traded for
 * a little concurrency on an authenticated, school-admin-only path that creates a handful of
 * accounts at a time, with the slow part (bcrypt) deliberately outside the transaction. One
 * key cannot form a cycle. The wait is bounded, and hitting the bound is a clean retryable
 * error rather than a hang.
 *
 * `SERIALIZABLE` isolation was the alternative: it would detect the write skew and abort one
 * transaction with 40001. It was not chosen because it needs a retry loop to be usable, its
 * aborts are probabilistic rather than prevented, and it costs a serialization failure on
 * every genuinely concurrent creation. The advisory lock prevents the conflict instead of
 * detecting it.
 */
export const LOGIN_IDENTITY_LOCK_NAMESPACE = "easylearn:login-identity";

/**
 * How long a user-creation transaction may wait for the identity lock, in milliseconds.
 * Transaction-scoped (`SET LOCAL`), so it can never leak into another request's use of the
 * same pooled connection. Deliberately a constant rather than another environment variable:
 * the value is not a tuning knob an operator should have to reason about, and 5 s is far
 * longer than the few short statements the lock actually covers.
 */
export const LOGIN_IDENTITY_LOCK_TIMEOUT_MS = 5000;

/** SQLSTATE `55P03` — `lock_timeout` expired. */
export const LOCK_TIMEOUT_SQLSTATE = "55P03";

/** SQLSTATE `40P01` — deadlock detected. Cannot happen with one lock key, but is handled. */
export const DEADLOCK_SQLSTATE = "40P01";

/** True when a database error means "the identity lock could not be taken in time". */
export function isIdentityLockTimeout(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return candidate?.code === LOCK_TIMEOUT_SQLSTATE || candidate?.cause?.code === LOCK_TIMEOUT_SQLSTATE;
}

/** True when a database error means PostgreSQL broke a lock wait cycle. */
export function isIdentityDeadlock(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return candidate?.code === DEADLOCK_SQLSTATE || candidate?.cause?.code === DEADLOCK_SQLSTATE;
}
