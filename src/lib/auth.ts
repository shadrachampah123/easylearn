import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { users } from "@/db/schema";
import { eq, type SQL } from "drizzle-orm";
import { getJwtSecret } from "@/lib/env";
import { assertJwtSecretIsUsable, isJwtSecretConfigurationError } from "@/lib/jwt-policy";
import { readSessionCookie } from "@/lib/session-cookie";

const TOKEN_EXPIRY = "24h";

/**
 * Token schema version (architecture plan §9.2).
 *
 * Phase 2B added membership hints; Phase 2F adds an explicit school-selection version.
 * Existing tokens continue verifying through expiry, but old multi-school hints are not
 * treated as explicit user selection. The active membership is still re-read from the DB.
 */
export const TOKEN_SCHEMA_VERSION = 3;

/** A token without `ver` predates Phase 2B. */
export const LEGACY_TOKEN_SCHEMA_VERSION = 1;

const UUID_CLAIM_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidClaim(value: unknown): string | undefined {
  return typeof value === "string" && UUID_CLAIM_PATTERN.test(value) ? value : undefined;
}

/**
 * The single chokepoint for every JWT signing and verification operation.
 *
 * The secret policy is enforced HERE, not in the individual routes, so that no route
 * can sign or verify a token with a secret that has not passed it. A route that adds
 * its own check is redundant; a route that forgets one is still protected.
 *
 * `assertJwtSecretIsUsable` throws a `JwtSecretConfigurationError` whose message
 * describes the requirement and never contains the secret itself.
 */
function getJwtKey(): Uint8Array {
  const secret = getJwtSecret();
  assertJwtSecretIsUsable(secret);
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createToken(payload: {
  userId: string;
  email?: string;
  username?: string;
  role: string;
  /**
   * Server-validated school context (Phase 2B). Only ever populated from a `school_users`
   * row read on the server — never from client input. Carried as a convenience/audit hint;
   * authorization must re-derive membership from the database (see `src/lib/tenant.ts`).
   */
  schoolId?: string;
  membershipId?: string;
  /** Prevent an unselected login session from falling into a remaining school after revocation. */
  schoolSelectionRequired?: boolean;
  /** Session version for revocation — bumped on logout, checked on every request. */
  sessionVersion?: number;
}): Promise<string> {
  return new SignJWT({ ...payload, ver: TOKEN_SCHEMA_VERSION })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getJwtKey());
}

/**
 * Thrown when the session-revocation check itself cannot be performed —
 * the `session_version` column is missing and could not be repaired, or
 * the database cannot be reached. This is a fail-CLOSED signal, distinct
 * from "token invalid" (null): callers should surface a safe 503-style
 * error rather than silently accepting a token whose revocation state
 * is unknown. A security-critical check must never fail open silently.
 */
export class SessionRevocationCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRevocationCheckError";
  }
}

export function isSessionRevocationCheckError(error: unknown): boolean {
  return error instanceof SessionRevocationCheckError;
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getJwtKey(), {
      algorithms: ["HS256"],
    });

    if (
      typeof payload.userId !== "string" ||
      typeof payload.role !== "string"
    ) {
      return null;
    }

    const tokenVersion =
      typeof (payload as Record<string, unknown>).sessionVersion === "number" &&
      Number.isInteger((payload as Record<string, unknown>).sessionVersion)
        ? ((payload as Record<string, unknown>).sessionVersion as number)
        : 0;

    // Revocation check: token's sessionVersion must match user's current version.
    // Per-session revocation would need a separate table; this per-user version
    // revokes all sessions on logout and on password change (acceptable for
    // 24h JWT, minimal DB cost).
    //
    // FAIL CLOSED, never silently open: if revocation cannot be checked —
    // the column is missing and lazy repair could not restore it (repair
    // disabled or no DDL privilege), or the database is unreachable — the
    // token is NOT accepted on faith. A SessionRevocationCheckError is
    // thrown so callers answer a safe 503-style error. Normal operation is
    // unaffected on a migrated database: `ensureSessionRevocationColumn`
    // probes (and by default repairs) the column first, so the only
    // deployments that see the error are those where revocation genuinely
    // does not exist — exactly the ones that must not silently accept
    // revoked tokens. (Pre-fix, this block swallowed every failure and
    // accepted the token; see tests/session-revocation-failclosed-db.test.ts.)
    const { ensureSessionRevocationColumn } = await import("@/lib/schema-resilience");
    let revocationStatus;
    try {
      revocationStatus = await ensureSessionRevocationColumn();
    } catch (error) {
      console.error("[auth] session-revocation schema check failed:", error);
      throw new SessionRevocationCheckError(
        "Session revocation could not be verified (schema check failed). Apply drizzle/0019_session_revocation.sql."
      );
    }
    if (!revocationStatus.available) {
      console.error(
        `[auth] session-revocation column unavailable (migration ${revocationStatus.migration}); refusing token rather than skipping revocation.`
      );
      throw new SessionRevocationCheckError(
        "Session revocation is unavailable on this database. Apply drizzle/0019_session_revocation.sql (or enable AUTO_SCHEMA_REPAIR)."
      );
    }
    let rows;
    try {
      const { db } = await import("@/db");
      rows = await db
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);
    } catch (error) {
      console.error("[auth] session-revocation database check failed:", error);
      throw new SessionRevocationCheckError(
        "Session revocation could not be verified (database unavailable)."
      );
    }
    if (rows.length === 0) {
      /* No row to compare against. Deliberately NOT a revocation failure:
         the dev seed route's documented bootstrap mints a claim for the
         super administrator it is about to create on a blank database.
         Every data-bearing caller re-reads the user row immediately
         after (resolveAuthContext/findAuthUser) and rejects a missing
         account, so this alone grants no access. */
      console.warn("[auth] revocation check: no user row for token subject; deferring to caller user lookup.");
    } else {
      const currentVersion = (rows[0] as unknown as { sessionVersion?: number | null }).sessionVersion ?? 0;
      if (tokenVersion !== currentVersion) {
        return null;
      }
    }

    return {
      userId: payload.userId,
      email: typeof payload.email === "string" ? payload.email : undefined,
      username: typeof payload.username === "string" ? payload.username : undefined,
      role: payload.role,
      /** Token schema version; tokens issued before Phase 2B have no claim and read as 1. */
      ver:
        typeof payload.ver === "number" && Number.isInteger(payload.ver)
          ? payload.ver
          : LEGACY_TOKEN_SCHEMA_VERSION,
      /**
       * UNTRUSTED HINTS — do not authorize from these.
       *
       * They describe the membership that existed when the token was minted, up to 24 h
       * ago, and a token is opaque to the database: membership can be removed, disabled or
       * re-roled without the claim changing. Every authorization path must go through
       * `src/lib/tenant.ts`, which re-reads `school_users` on each request.
       */
      schoolIdHint: uuidClaim(payload.schoolId),
      membershipIdHint: uuidClaim(payload.membershipId),
      /** A server-issued no-selection guard for logins that had zero or multiple memberships. */
      schoolSelectionRequired: payload.schoolSelectionRequired === true,
      sessionVersion: tokenVersion,
    };
  } catch (error) {
    // A misconfigured JWT secret is an OPERATOR problem, not an invalid token. Swallowing
    // it here would make every request answer 401 "Unauthorized" and hide the real cause
    // from the health endpoint and the logs, so it is re-thrown and reported as a 503.
    if (isJwtSecretConfigurationError(error)) throw error;
    // Same reasoning: an unverifiable revocation check must surface as a
    // safe availability error (callers map it to 503), not as a quiet 401
    // that looks like an ordinary bad token — and never as an accepted one.
    if (isSessionRevocationCheckError(error)) throw error;
    return null;
  }
}

/**
 * Columns every EasyLearn database has, versus the ones drizzle/0006 adds
 * (`username`, `must_change_password`). `db.select()` without a projection pulls the whole
 * schema and therefore fails on a not-yet-migrated database - which used to break *logging
 * in*, not just the dashboard.
 */
function authUserProjection(options: { withPasswordHash: boolean }) {
  const base = {
    id: users.id,
    email: users.email,
    role: users.role,
    firstName: users.firstName,
    lastName: users.lastName,
    avatarUrl: users.avatarUrl,
    isActive: users.isActive,
    ...(options.withPasswordHash ? { passwordHash: users.passwordHash } : {}),
  };
  return {
    full: { ...base, username: users.username, mustChangePassword: users.mustChangePassword },
    reduced: base,
  };
}

/**
 * Look an account up for an auth flow, degrading to the pre-0006 column set instead of
 * throwing. `repair: true` first makes sure the optional columns exist (no-op once the
 * migration is applied, and skipped entirely when AUTO_SCHEMA_REPAIR is off).
 * Never returns more than the requested projection, so password hashes stay server-side.
 */
export async function findAuthUser(
  where: SQL<unknown>,
  options: { withPasswordHash?: boolean; repair?: boolean } = {}
): Promise<Record<string, any> | null> {
  const { db } = await import("@/db");
  const { ensureUserIdentityColumns, isMissingColumn } = await import("@/lib/schema-resilience");

  if (options.repair) await ensureUserIdentityColumns();

  const { full, reduced } = authUserProjection({ withPasswordHash: Boolean(options.withPasswordHash) });
  const run = async (projection: Record<string, unknown>): Promise<Record<string, any>[]> => {
    const rows = await db.select(projection as never).from(users).where(where).limit(1);
    return rows as unknown as Record<string, any>[];
  };

  try {
    const [user] = await run(full);
    return user ?? null;
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    const [user] = await run(reduced);
    return user ? { ...user, username: null, mustChangePassword: false } : null;
  }
}

export async function getUserFromToken(token: string) {
  const payload = await verifyToken(token);
  if (!payload) return null;

  const user = await findAuthUser(eq(users.id, payload.userId));

  return user?.isActive ? user : null;
}

/**
 * Bearer values a browser produced by interpolating a missing credential.
 *
 * `Authorization: Bearer ${token}` with `token === null` yields the literal string
 * "null". Such a value is not a credential: accepting it shadows a perfectly valid
 * session cookie and turns an authenticated request into a 401.
 */
function isPlaceholderBearer(token: string): boolean {
  return token === "null" || token === "undefined";
}

export function getTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    /* Whitespace-only values are rejected by the truthiness check; the explicit
       placeholder list covers a client that interpolated an absent credential.
       Falling through to the cookie is fail-closed — a real token is still required. */
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken && !isPlaceholderBearer(bearerToken)) return bearerToken;
  }

  const cookieToken = readSessionCookie(request.headers.get("cookie"));
  if (cookieToken) return cookieToken;

  return null;
}
