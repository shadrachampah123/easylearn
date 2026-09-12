import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { users } from "@/db/schema";
import { eq, type SQL } from "drizzle-orm";
import { getJwtSecret } from "@/lib/env";

const TOKEN_EXPIRY = "24h";

/**
 * Token schema version (architecture plan §9.2).
 *
 * Phase 2B adds `ver`, `schoolId` and `membershipId` to newly issued tokens. Nothing is
 * removed or renamed, `JWT_SECRET` is unchanged, and no code branches authorization on
 * `ver`, so tokens minted before this deploy (no `ver` → treated as 1) keep verifying until
 * their natural 24 h expiry. The rollout therefore needs no rotation window and forces no
 * re-login.
 */
export const TOKEN_SCHEMA_VERSION = 2;

/** A token without `ver` predates Phase 2B. */
export const LEGACY_TOKEN_SCHEMA_VERSION = 1;

const UUID_CLAIM_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidClaim(value: unknown): string | undefined {
  return typeof value === "string" && UUID_CLAIM_PATTERN.test(value) ? value : undefined;
}

function getJwtKey(): Uint8Array {
  const secret = getJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }
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
}): Promise<string> {
  return new SignJWT({ ...payload, ver: TOKEN_SCHEMA_VERSION })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getJwtKey());
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
    };
  } catch {
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

export function getTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) return bearerToken;
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)el_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }

  return null;
}
