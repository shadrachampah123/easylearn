/**
 * Phase 2B — server-side school membership + authenticated school context.
 *
 * This is the ONE place that answers "which school is this user in, and with which role".
 * Route handlers must not query `school_users` directly; Phase 2C migrates the ~54
 * copy-pasted `getTokenFromRequest` + `verifyToken` preambles onto `requireSchoolContext`.
 *
 * SECURITY INVARIANTS (each one is covered by tests/membership-auth-db.test.ts):
 *
 *  1. A client can NEVER choose a school. `resolveAuthContext` reads exactly one thing from
 *     the request — the token — and every membership comes from `school_users`. There is no
 *     body/query/header `schoolId` read anywhere in this module.
 *  2. The optional `schoolId` accepted by the resolvers can only NARROW the caller's own
 *     already-verified memberships; an arbitrary or foreign value resolves to `null` instead
 *     of returning somebody else's membership.
 *  3. Token claims are hints. Nothing here trusts `schoolIdHint` / `membershipIdHint`;
 *     membership is re-derived from the database on every call.
 *  4. `super_admin` is a PLATFORM role (plan §7). It yields no membership, `toSchoolRole()`
 *     returns `null` for it, and there is no `role === 'super_admin'` branch below — a
 *     platform account never acquires school-wide access through this module.
 *  5. Only `status = 'active'` memberships count. `invited` / `disabled` never grant context.
 *  6. Memberships are always fetched `WHERE user_id = $1`, so resolving one user can never
 *     return another user's rows, and a user may hold memberships in several schools.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { schools, schoolUsers, users } from "@/db/schema";
import { findAuthUser, getTokenFromRequest, verifyToken } from "@/lib/auth";
import { isMissingRelation } from "@/lib/schema-resilience";

/* ── Roles ── */

/** The canonical CBISM tenant slug (migration 0015). Reference only — never use it to skip
 *  membership verification. */
export const CBISM_SCHOOL_SLUG = "cbism";

/** Platform-level role. Never a school membership role (plan §7). */
export const PLATFORM_ROLE = "super_admin";

/** Roles that can legitimately live on a `school_users` row. */
export const SCHOOL_ROLES = [
  "school_admin",
  "head_teacher",
  "teacher",
  "parent",
  "learner",
] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

export const MEMBERSHIP_STATUSES = ["active", "invited", "disabled"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export const ACTIVE_MEMBERSHIP_STATUS: MembershipStatus = "active";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** True only for the platform role. */
export function isPlatformRole(role: unknown): boolean {
  return role === PLATFORM_ROLE;
}

/**
 * Platform-level privilege check. Kept separate from the school-role predicates in
 * `src/lib/authorization.ts` on purpose: a platform privilege must never be mistaken for a
 * school membership, and vice versa.
 */
export function isPlatformPrivileged(role: unknown): boolean {
  return isPlatformRole(role);
}

/**
 * Map any role onto a SCHOOL role. Returns `null` for `super_admin` (platform role) and for
 * anything unrecognised — this is what makes writing a platform role into a membership row
 * impossible from application code, mirroring the exclusion in migration 0015.
 */
export function toSchoolRole(role: unknown): SchoolRole | null {
  if (typeof role !== "string") return null;
  return (SCHOOL_ROLES as readonly string[]).includes(role) ? (role as SchoolRole) : null;
}

function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === "string" && (MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

/* ── Errors ── */

/** Thrown by the `require*` helpers so Phase 2C routes can map it straight onto a response. */
export class AuthContextError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthContextError";
    this.status = status;
  }
}

/* ── Membership reads ── */

export type SchoolMembership = {
  membershipId: string;
  schoolId: string;
  userId: string;
  role: SchoolRole;
  status: MembershipStatus;
  schoolSlug: string;
  schoolName: string;
  /** School lifecycle (plan §4.4). Surfaced for later phases; not filtered here. */
  schoolStatus: string;
  createdAt: Date | null;
};

const membershipSelection = {
  membershipId: schoolUsers.id,
  schoolId: schoolUsers.schoolId,
  userId: schoolUsers.userId,
  role: schoolUsers.role,
  status: schoolUsers.status,
  createdAt: schoolUsers.createdAt,
  schoolSlug: schools.slug,
  schoolName: schools.name,
  schoolStatus: schools.status,
};

function toMembership(row: Record<string, unknown>): SchoolMembership | null {
  // Defence in depth: a platform role must never be interpreted as a school membership,
  // even if such a row somehow existed.
  const role = toSchoolRole(row.role);
  if (!role || !isUuid(row.schoolId) || !isUuid(row.userId)) return null;
  return {
    membershipId: String(row.membershipId),
    schoolId: row.schoolId,
    userId: row.userId,
    role,
    status: isMembershipStatus(row.status) ? row.status : ACTIVE_MEMBERSHIP_STATUS,
    schoolSlug: typeof row.schoolSlug === "string" ? row.schoolSlug : "",
    schoolName: typeof row.schoolName === "string" ? row.schoolName : "",
    schoolStatus: typeof row.schoolStatus === "string" ? row.schoolStatus : "",
    createdAt: row.createdAt instanceof Date ? row.createdAt : null,
  };
}

let missingMembershipTableReported = false;

/**
 * Every membership the user holds, newest-independent and deterministic
 * (`created_at`, then `id`). Only `active` rows unless `includeInactive` is set.
 *
 * Degrades to `[]` when `school_users` does not exist yet (migration 0013/0015 not
 * applied) — the same degrade-instead-of-crash rule the rest of the codebase follows, so
 * login and `/api/auth/me` keep working on an un-migrated database.
 */
export async function listSchoolMemberships(
  userId: string,
  options: { includeInactive?: boolean } = {}
): Promise<SchoolMembership[]> {
  if (!isUuid(userId)) return [];

  const conditions = [eq(schoolUsers.userId, userId)];
  if (!options.includeInactive) conditions.push(eq(schoolUsers.status, ACTIVE_MEMBERSHIP_STATUS));

  try {
    const rows = await db
      .select(membershipSelection)
      .from(schoolUsers)
      .innerJoin(schools, eq(schoolUsers.schoolId, schools.id))
      .where(and(...conditions))
      .orderBy(asc(schoolUsers.createdAt), asc(schoolUsers.id));

    return (rows as unknown as Record<string, unknown>[])
      .map(toMembership)
      .filter((membership): membership is SchoolMembership => membership !== null);
  } catch (error) {
    if (isMissingRelation(error)) {
      if (!missingMembershipTableReported) {
        missingMembershipTableReported = true;
        console.warn(
          "[tenant] school_users/schools are missing — run `node run-migration.js` " +
            "(0013/0015). School context is unavailable until then."
        );
      }
      return [];
    }
    throw error;
  }
}

/** Only `status = 'active'` memberships. This is the set that can grant school context. */
export async function listActiveSchoolMemberships(userId: string): Promise<SchoolMembership[]> {
  return listSchoolMemberships(userId);
}

/**
 * Resolve the user's active membership.
 *
 * `options.schoolId` is a NARROWING hint for trusted server-side callers (Phase 2E will
 * pass the host-resolved school). It is matched against rows already fetched for THIS
 * user, so it can never widen the result: an unknown, forged or foreign school id simply
 * yields `null`. Without it, the deterministic first membership is returned — for the
 * current single-school CBISM deployment that is the CBISM membership. It is not a school
 * switcher, and no client input reaches it.
 */
export async function resolveSchoolMembership(
  userId: string,
  options: { schoolId?: string | null } = {}
): Promise<SchoolMembership | null> {
  const memberships = await listActiveSchoolMemberships(userId);
  if (memberships.length === 0) return null;

  if (options.schoolId !== undefined && options.schoolId !== null) {
    if (!isUuid(options.schoolId)) return null;
    return memberships.find((membership) => membership.schoolId === options.schoolId) ?? null;
  }

  return memberships[0] ?? null;
}

/** Like `resolveSchoolMembership`, but throws `AuthContextError(403)` when there is none. */
export async function requireActiveSchoolMembership(
  userId: string,
  options: { schoolId?: string | null } = {}
): Promise<SchoolMembership> {
  const membership = await resolveSchoolMembership(userId, options);
  if (!membership) {
    throw new AuthContextError("You do not have an active school membership", 403);
  }
  return membership;
}

/**
 * The user's effective SCHOOL role, or `null` when they hold no active membership — which
 * is always the case for a platform `super_admin`.
 */
export async function getEffectiveSchoolRole(
  userId: string,
  options: { schoolId?: string | null } = {}
): Promise<SchoolRole | null> {
  const membership = await resolveSchoolMembership(userId, options);
  return membership?.role ?? null;
}

/* ── Authenticated context ── */

export type AuthContext = {
  userId: string;
  /** `users.role` as read from the database on THIS request (the current truth). */
  role: string;
  /** The `role` claim from the token. Diagnostics only — it can be up to 24 h stale. */
  tokenRole: string;
  email: string | null;
  username: string | null;
  /** True for the platform role. Never implies school access. */
  isPlatformAdmin: boolean;
  /** The user row (never contains `passwordHash` — the projection does not select it). */
  user: Record<string, unknown>;
  /** All active memberships (multi-school capable). */
  memberships: SchoolMembership[];
  /** Resolved school context, or `null` for platform-only / membership-less accounts. */
  school: SchoolMembership | null;
};

export type SchoolAuthContext = AuthContext & {
  school: SchoolMembership;
  schoolId: string;
  membershipId: string;
};

/**
 * Build the trusted application context for a request:
 *   token (signature + expiry) → user row (database) → memberships (database).
 *
 * The request contributes nothing but the token: no body, no query parameter and no header
 * is read for a school. The role in the returned context comes from the database, not from
 * the token claim, which is what makes this the Phase 2C replacement for the stale
 * `payload.role` checks.
 */
export async function resolveAuthContext(request: Request): Promise<AuthContext> {
  const token = getTokenFromRequest(request);
  if (!token) throw new AuthContextError("Authentication required", 401);

  const claims = await verifyToken(token);
  if (!claims || !isUuid(claims.userId)) {
    throw new AuthContextError("Invalid or expired session", 401);
  }

  const user = await findAuthUser(eq(users.id, claims.userId));
  if (!user) throw new AuthContextError("Invalid or expired session", 401);
  if (!user.isActive) throw new AuthContextError("Account is deactivated", 401);

  // Belt and braces: never let a password hash leave this module.
  delete (user as Record<string, unknown>).passwordHash;

  const role = typeof user.role === "string" ? user.role : "";
  const memberships = await listActiveSchoolMemberships(user.id);

  return {
    userId: user.id,
    role,
    tokenRole: claims.role,
    email: typeof user.email === "string" ? user.email : null,
    username: typeof user.username === "string" ? user.username : null,
    isPlatformAdmin: isPlatformRole(role),
    user,
    memberships,
    school: memberships[0] ?? null,
  };
}

/**
 * `resolveAuthContext` + a required active school membership. This is the Phase 2C gate;
 * it is intentionally not wired into the existing routes yet (Phase 2B keeps every current
 * authorization path exactly as it was).
 */
export async function requireSchoolContext(request: Request): Promise<SchoolAuthContext> {
  const context = await resolveAuthContext(request);
  if (!context.school) {
    throw new AuthContextError("You do not have an active school membership", 403);
  }
  return {
    ...context,
    school: context.school,
    schoolId: context.school.schoolId,
    membershipId: context.school.membershipId,
  };
}

/**
 * Validate a candidate school (Phase 2E: the host-resolved school) against the caller's own
 * memberships. Rejects anything the user is not an active member of — this is the
 * host/session cross-check the architecture plan calls for, with the database as the source
 * of truth.
 */
export function selectSchoolForContext(context: AuthContext, schoolId: unknown): SchoolAuthContext {
  if (!isUuid(schoolId)) {
    throw new AuthContextError("Unknown school", 403);
  }
  const membership = context.memberships.find((item) => item.schoolId === schoolId);
  if (!membership) {
    throw new AuthContextError("You are not a member of that school", 403);
  }
  return {
    ...context,
    school: membership,
    schoolId: membership.schoolId,
    membershipId: membership.membershipId,
  };
}

/* ── Login-time helpers ── */

/**
 * Membership context for a login response / token. NEVER throws: a missing membership (or a
 * database without the tenant tables) must not lock anybody out in Phase 2B — membership is
 * additive context here, not a gate. Errors are logged and degrade to "no school context".
 */
export async function resolveLoginSchoolContext(
  userId: string
): Promise<{ memberships: SchoolMembership[]; school: SchoolMembership | null }> {
  try {
    const memberships = await listActiveSchoolMemberships(userId);
    return { memberships, school: memberships[0] ?? null };
  } catch (error) {
    console.error("[tenant] school context resolution failed during login:", error);
    return { memberships: [], school: null };
  }
}

/** Client-safe summary of a membership (never exposes other users or internal state). */
export function toSchoolSummary(membership: SchoolMembership | null) {
  if (!membership) return null;
  return {
    schoolId: membership.schoolId,
    membershipId: membership.membershipId,
    slug: membership.schoolSlug,
    name: membership.schoolName,
    role: membership.role,
    status: membership.status,
  };
}
