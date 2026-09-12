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
import { and, asc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { schools, schoolUsers, users } from "@/db/schema";
import { errorResponse } from "@/lib/api-helpers";
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
export async function resolveAuthContext(
  request: Request,
  /**
   * Phase 1 compatibility hook: `/api/files/[id]` also accepts `?token=` because <img>,
   * <video> and <a download> cannot set an `Authorization` header. This only widens WHERE a
   * token may be read from — never what it grants, and never a school.
   */
  tokenOverride?: string | null
): Promise<AuthContext> {
  const token = tokenOverride || getTokenFromRequest(request);
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
export async function requireSchoolContext(
  request: Request,
  tokenOverride?: string | null
): Promise<SchoolAuthContext> {
  const context = await resolveAuthContext(request, tokenOverride);
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

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 2C — CENTRAL TENANT AUTHORIZATION
   ══════════════════════════════════════════════════════════════════════════════

   The Phase 2B module above answers "who is this and which school are they in".
   This section is the single place that answers "may this school touch that record".

   DESIGN RULES (mirroring the architecture plan §10 and the Phase 2C brief):

   1. FAIL CLOSED. Every helper below denies when tenancy cannot be established.
      There is no branch that turns "no school found" / "no membership found" /
      "no attribution" into access.
   2. THE DATABASE IS AUTHORITATIVE. Membership and ownership come from `school_users`
      and the relational chain of the target row — never from a client-supplied
      `school_id`/`schoolId`, a header, a query parameter, or the JWT `role` claim.
   3. TENANT FIRST, ROLE SECOND. Routes resolve the school context and prove the target
      belongs to that school BEFORE applying the Phase 1 role/relationship rules.
   4. PREFER SQL PREDICATES. The `sql*` helpers below are meant to be embedded directly in
      a `WHERE` clause so a foreign row is never fetched, inspected and then filtered in
      JavaScript (no leak through a response body, an error message or timing).
   5. IDENTITY vs CONTENT. Identity/relationship records that hang off one user
      (users, notifications, announcements, activity) are visible inside a school when the
      anchor user is an ACTIVE member of it. School content (classes, assignments,
      submissions, files, attendance, enrollments, quizzes, timetable) additionally has to
      be UNIQUELY attributable: if it is reachable from a second school, it belongs to
      neither and is denied.
   6. NO PLATFORM BYPASS. `super_admin` is a platform role with no school membership, so it
      cannot pass `guardSchoolContext`. Only routes whose existing rule is explicitly
      platform-scoped use `guardPlatformAdmin`, and those are documented in
      docs/PHASE2C_TENANT_AUTHORIZATION.md.

   Every property above is covered by tests/tenant-authorization-db.test.ts (real
   PostgreSQL, two real schools) and mutated deliberately in
   tests/tenant-authorization-mutation.test.ts to prove the suite fails when a check is
   removed.
   ────────────────────────────────────────────────────────────────────────────── */

/** Which school roles a caller may hold. Mirrors the Phase 1 role groups in
 *  `src/lib/authorization.ts`, minus `super_admin` (which is not a school role). */
export const SCHOOL_ADMIN_ROLES = ["school_admin"] as const;
export const SCHOOL_ADMIN_EXTENDED_ROLES = ["school_admin", "head_teacher"] as const;
export const SCHOOL_TEACHING_ROLES = ["teacher", "head_teacher"] as const;

/* ── Guard plumbing ── */

/**
 * Result of a request gate. The failure branch already carries the HTTP response so route
 * handlers collapse their whole authentication preamble into two lines and cannot forget
 * to map an error status.
 */
export type TenantGuard<T> = { ok: true; context: T } | { ok: false; response: NextResponse };

function guardDenied(status: number, message: string): { ok: false; response: NextResponse } {
  return { ok: false, response: errorResponse(message, status) };
}

/** Map any thrown authorization error onto a response, or return `null` when it is not one. */
export function tenantErrorResponse(error: unknown, fallbackMessage = "Request failed"): NextResponse {
  if (error instanceof AuthContextError) {
    return errorResponse(error.message, error.status);
  }
  console.error("[tenant] unexpected authorization error:", error);
  return errorResponse(fallbackMessage, 500);
}

/**
 * THE PHASE 2C GATE: authenticate (401), re-read the user from the database (401 when the
 * account is gone or deactivated), resolve the active schools membership from the database
 * (403 when there is none) and hand the route a trusted context.
 *
 * The request contributes nothing but its token: no body, no query parameter and no header
 * is read for a school, so a forged `schoolId` has nothing to attach to.
 */
export async function guardSchoolContext(
  request: Request,
  tokenOverride?: string | null
): Promise<TenantGuard<SchoolAuthContext>> {
  try {
    return { ok: true, context: await requireSchoolContext(request, tokenOverride) };
  } catch (error) {
    if (error instanceof AuthContextError) return guardDenied(error.status, error.message);
    throw error;
  }
}

/**
 * PLATFORM GATE — `super_admin` only, and deliberately NOT a tenant bypass.
 *
 * A platform role has no school membership (migration 0015 excludes it and
 * `toSchoolRole()` refuses to map it), so this helper grants no school data on its own. It
 * exists only for routes whose pre-Phase-2C rule was already explicitly platform-scoped —
 * today that is `DELETE /api/users/[id]` (the global identity store) and the dev-only
 * `/api/seed`. Those routes must scope their own queries to a school when they touch
 * school data. Never use this to skip a school predicate.
 */
export async function guardPlatformAdmin(
  request: Request,
  tokenOverride?: string | null
): Promise<TenantGuard<AuthContext>> {
  try {
    const context = await resolveAuthContext(request, tokenOverride);
    if (!isPlatformAdminContext(context)) {
      throw new AuthContextError("Only platform administrators may perform this action", 403);
    }
    return { ok: true, context };
  } catch (error) {
    if (error instanceof AuthContextError) return guardDenied(error.status, error.message);
    throw error;
  }
}

/* ── Role gates (membership role, never the JWT claim) ── */

/** True for a platform-scoped context (no school implication whatsoever). */
export function isPlatformAdminContext(context: AuthContext): boolean {
  return context.isPlatformAdmin;
}

/**
 * The caller's EFFECTIVE school role: the `school_users.role` read from the database on this
 * request (plan §6.4). Never `payload.role`, never `users.role`.
 */
export function schoolRole(context: AuthContext): SchoolRole | null {
  return context.school?.role ?? null;
}

/** Does the caller hold one of these school roles in their resolved school? */
export function hasSchoolRole(context: AuthContext, ...roles: readonly SchoolRole[]): boolean {
  const role = schoolRole(context);
  return role !== null && roles.includes(role);
}

/** School administrator (`school_admin`). Head teachers are NOT included — see below. */
export function hasSchoolAdminRole(context: AuthContext): boolean {
  return hasSchoolRole(context, ...SCHOOL_ADMIN_ROLES);
}

/**
 * Administrator-equivalent (`school_admin` | `head_teacher`) — the `ADMIN_EXTENDED_ROLES`
 * group of Phase 1, with `super_admin` replaced by the requirement to hold a real
 * membership in the school. Phase 1 semantics for head teachers are preserved because the
 * membership role is what decides, exactly as `users.role` decided before 0015.
 */
export function hasSchoolAdminExtendedRole(context: AuthContext): boolean {
  return hasSchoolRole(context, ...SCHOOL_ADMIN_EXTENDED_ROLES);
}

/** Teacher or head teacher (the Phase 1 `TEACHER_ROLES` group). */
/**
 * The Phase 1 "staff" group: teachers (including head teachers) plus school administrators.
 * Used by routes that were written as `["super_admin", "school_admin", "head_teacher",
 * "teacher"].includes(payload.role)` — the platform role is deliberately gone because a
 * platform account has no membership and therefore never reaches these routes.
 */
export function hasSchoolStaffRole(context: AuthContext): boolean {
  return hasSchoolTeachingRole(context) || hasSchoolAdminRole(context);
}

export function hasSchoolTeachingRole(context: AuthContext): boolean {
  return hasSchoolRole(context, ...SCHOOL_TEACHING_ROLES);
}

/* ── SQL ownership predicates (embedded in WHERE clauses — no fetch-then-inspect) ── */

function assertSchoolId(schoolId: string): string {
  if (!isUuid(schoolId)) {
    throw new AuthContextError("Invalid school context", 403);
  }
  return schoolId;
}

/**
 * SQL predicate — the referenced user holds an ACTIVE membership in this school.
 * `'invited'` and `'disabled'` memberships never satisfy it, and `super_admin` never has a
 * membership at all, so a platform account cannot satisfy a school predicate.
 */
export function sqlUserInSchool(schoolId: string, userRef: SQL | AnyColumn): SQL {
  assertSchoolId(schoolId);
  return sql`exists (
    select 1 from "school_users" su
     where su."user_id" = ${userRef}
       and su."school_id" = ${schoolId}
       and su."status" = 'active'
  )`;
}

/** Every school an ACTIVE membership links this user to. */
function sqlSchoolsOfUser(userRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "school_users" su
     where su."user_id" = ${userRef} and su."status" = 'active'
  )`;
}

/**
 * Every school reachable from a class: its homeroom teacher, its assigned teachers
 * (`teacher_classes`) and its enrolled learners (`learner_classes`).
 */
function sqlSchoolsOfClass(classRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "classes" c
      join "school_users" su on su."user_id" = c."class_teacher_id" and su."status" = 'active'
     where c."id" = ${classRef}
    union
    select su."school_id"
      from "teacher_classes" tc
      join "school_users" su on su."user_id" = tc."teacher_id" and su."status" = 'active'
     where tc."class_id" = ${classRef}
    union
    select su."school_id"
      from "learner_classes" lc
      join "school_users" su on su."user_id" = lc."learner_id" and su."status" = 'active'
     where lc."class_id" = ${classRef}
  )`;
}

/**
 * Every school reachable from a teacher↔class row: the teacher, plus the class's own
 * members (so a row that pairs a School A teacher with a School B class is denied).
 *
 * NOTE (regression lock): the injected class lookup aliases `teacher_classes` as `tc0`.
 * Without that alias the outer reference `"teacher_classes"."id"` would bind to the
 * subquery's own table, degenerating into the tautology `"id" = "id"`, which returns every
 * row and makes Postgres raise "more than one row returned by a subquery used as an
 * expression" as soon as the table holds more than one row.
 */
function sqlSchoolsOfTeacherClass(teacherClassRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "teacher_classes" tc
      join "school_users" su on su."user_id" = tc."teacher_id" and su."status" = 'active'
     where tc."id" = ${teacherClassRef}
    union
    ${sqlSchoolsOfClass(sql`(select tc0."class_id" from "teacher_classes" tc0 where tc0."id" = ${teacherClassRef})`)}
  )`;
}

/**
 * Every school reachable from a timetable slot: the teacher, the creator (the admin who
 * scheduled it) and the class's own members.
 *
 * NOTE (regression lock): the injected class lookup aliases `timetable_entries` as `t`.
 * Without that alias the outer reference `"timetable_entries"."id"` would bind to the
 * subquery's own table, degenerating into the tautology `"id" = "id"`, which returns every
 * row and makes Postgres raise "more than one row returned by a subquery used as an
 * expression" as soon as the table holds more than one row.
 */
function sqlSchoolsOfTimetableEntry(entryRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "timetable_entries" te
      join "school_users" su on su."user_id" = te."teacher_id" and su."status" = 'active'
     where te."id" = ${entryRef}
    union
    select su."school_id"
      from "timetable_entries" te
      join "school_users" su on su."user_id" = te."created_by" and su."status" = 'active'
     where te."id" = ${entryRef}
    union
    ${sqlSchoolsOfClass(sql`(select t."class_id" from "timetable_entries" t where t."id" = ${entryRef})`)}
  )`;
}

/** Every school reachable from an assignment: its teacher plus its class's members. */
function sqlSchoolsOfAssignment(assignmentRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "assignments" a
      join "school_users" su on su."user_id" = a."teacher_id" and su."status" = 'active'
     where a."id" = ${assignmentRef}
    union
    select ss."school_id" from ${sqlSchoolsOfClass(sql`(select a."class_id" from "assignments" a where a."id" = ${assignmentRef})`)} ss
  )`;
}

/** Every school reachable from a quiz: its teacher plus its class's members. */
function sqlSchoolsOfQuiz(quizRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "quizzes" q
      join "school_users" su on su."user_id" = q."teacher_id" and su."status" = 'active'
     where q."id" = ${quizRef}
    union
    select ss."school_id" from ${sqlSchoolsOfClass(sql`(select q."class_id" from "quizzes" q where q."id" = ${quizRef})`)} ss
  )`;
}

/** Every school reachable from a submission: its learner plus its assignment. */
function sqlSchoolsOfSubmission(submissionRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "submissions" s
      join "school_users" su on su."user_id" = s."learner_id" and su."status" = 'active'
     where s."id" = ${submissionRef}
    union
    select ss."school_id" from ${sqlSchoolsOfAssignment(sql`(select s."assignment_id" from "submissions" s where s."id" = ${submissionRef})`)} ss
  )`;
}

/** Every school reachable from an uploaded file: its uploader plus its assignment. */
function sqlSchoolsOfFile(fileRef: SQL | AnyColumn): SQL {
  return sql`(
    select su."school_id" as "school_id"
      from "uploaded_files" f
      join "school_users" su on su."user_id" = f."uploader_id" and su."status" = 'active'
     where f."id" = ${fileRef}
    union
    select ss."school_id" from ${sqlSchoolsOfAssignment(sql`(select f."assignment_id" from "uploaded_files" f where f."id" = ${fileRef})`)} ss
  )`;
}

/**
 * SQL predicate — the ownership set resolves to EXACTLY this school.
 *
 * "Owned by A" means reachable from A and from nowhere else. Content reachable from a
 * second school is attributable to neither and is denied (fail closed), which also makes a
 * cross-school row impossible to smuggle into a response by adding a membership.
 */
export function sqlOwnedBySchool(schoolId: string, schoolSet: SQL): SQL {
  assertSchoolId(schoolId);
  return sql`(
    exists (select 1 from ${schoolSet} ss where ss."school_id" = ${schoolId})
    and not exists (select 1 from ${schoolSet} ss where ss."school_id" <> ${schoolId})
  )`;
}

/** Content predicate: the class (roster, teachers, homeroom teacher) is this school's alone. */
export function sqlClassInSchool(schoolId: string, classRef: SQL | AnyColumn): SQL {
  return sqlOwnedBySchool(schoolId, sqlSchoolsOfClass(classRef));
}

/** Content predicate: the assignment belongs to this school's alone. */
export function sqlAssignmentInSchool(schoolId: string, assignmentRef: SQL | AnyColumn): SQL {
  return sqlOwnedBySchool(schoolId, sqlSchoolsOfAssignment(assignmentRef));
}

/** Content predicate: the quiz belongs to this school's alone. */
export function sqlQuizInSchool(schoolId: string, quizRef: SQL | AnyColumn): SQL {
  return sqlOwnedBySchool(schoolId, sqlSchoolsOfQuiz(quizRef));
}

/** Content predicate: the submission belongs to this school's alone. */
export function sqlSubmissionInSchool(schoolId: string, submissionRef: SQL | AnyColumn): SQL {
  return sqlOwnedBySchool(schoolId, sqlSchoolsOfSubmission(submissionRef));
}

/** Content predicate: the teacher↔class assignment belongs to this school alone. */
export function sqlTeacherClassInSchool(schoolId: string, teacherClassRef: SQL | AnyColumn): SQL {
  return sqlOwnedBySchool(schoolId, sqlSchoolsOfTeacherClass(teacherClassRef));
}

/** Content predicate: the timetable slot belongs to this school alone. */
export function sqlTimetableInSchool(schoolId: string, entryRef: SQL | AnyColumn): SQL {
  return sqlOwnedBySchool(schoolId, sqlSchoolsOfTimetableEntry(entryRef));
}

/** Content predicate: the uploaded file belongs to this school's alone. */
export function sqlFileInSchool(schoolId: string, fileRef: SQL | AnyColumn): SQL {
  return sqlOwnedBySchool(schoolId, sqlSchoolsOfFile(fileRef));
}

/** Identity predicate: the learner is an ACTIVE member of this school. */
export function sqlLearnerInSchool(schoolId: string, learnerRef: SQL | AnyColumn): SQL {
  return sqlUserInSchool(schoolId, learnerRef);
}

/* ── Ownership resolution (same rules as above, for single-record decisions) ── */

function rowsFromResult(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Resolve the set of schools a SQL ownership expression points at. */
async function resolveSchoolSet(schoolSet: SQL): Promise<Set<string>> {
  const result = await db.execute(sql`select distinct ss."school_id"::text as "school_id" from ${schoolSet} ss`);
  const ids = new Set<string>();
  for (const row of rowsFromResult(result)) {
    const value = row.school_id;
    if (typeof value === "string" && value) ids.add(value);
  }
  return ids;
}

/** Schools in which an ACTIVE membership links this user. Empty set = no school access. */
export async function getUserSchoolIds(userId: string): Promise<Set<string>> {
  if (!isUuid(userId)) return new Set();
  return resolveSchoolSet(sqlSchoolsOfUser(sql`${userId}::uuid`));
}

/** Is this user an ACTIVE member of this school? */
export async function isUserInSchool(schoolId: string, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  return (await getUserSchoolIds(userId)).has(schoolId);
}

/**
 * Which of these learners are ACTIVE members of this school (one query). Used by the
 * parent/teacher scoped branches so a relationship row can never widen access across
 * schools.
 */
export async function getLearnerIdsInSchool(schoolId: string, learnerIds: string[]): Promise<Set<string>> {
  assertSchoolId(schoolId);
  const candidates = learnerIds.filter(isUuid);
  if (candidates.length === 0) return new Set();

  const rows = await db
    .select({ userId: schoolUsers.userId })
    .from(schoolUsers)
    .where(
      and(
        eq(schoolUsers.schoolId, schoolId),
        eq(schoolUsers.status, ACTIVE_MEMBERSHIP_STATUS),
        inArray(schoolUsers.userId, candidates)
      )
    );
  return new Set(rows.map((row) => row.userId));
}

/** Schools a class belongs to — Phase 2D: direct school_id preferred, relational fallback */
export async function getClassSchoolIds(classId: string): Promise<Set<string>> {
  if (!isUuid(classId)) return new Set();
  const direct = await getDirectSchoolId("classes", classId);
  if (direct) return new Set([direct]);
  return resolveSchoolSet(sqlSchoolsOfClass(sql`${classId}::uuid`));
}

/** Is this class uniquely attributable to this school? — Phase 2D direct check */
export async function isClassInSchool(schoolId: string, classId: string): Promise<boolean> {
  const direct = await getDirectSchoolId("classes", classId);
  if (direct) return direct === schoolId;
  const schools = await resolveSchoolSet(sqlSchoolsOfClass(sql`${classId}::uuid`));
  return schools.size === 1 && schools.has(schoolId);
}

/** Schools an assignment belongs to — Phase 2D direct check first */
export async function getAssignmentSchoolIds(assignmentId: string): Promise<Set<string>> {
  if (!isUuid(assignmentId)) return new Set();
  const direct = await getDirectSchoolId("assignments", assignmentId);
  if (direct) return new Set([direct]);
  return resolveSchoolSet(sqlSchoolsOfAssignment(sql`${assignmentId}::uuid`));
}
export async function isAssignmentInSchool(schoolId: string, assignmentId: string): Promise<boolean> {
  const direct = await getDirectSchoolId("assignments", assignmentId);
  if (direct) return direct === schoolId;
  const schools = await resolveSchoolSet(sqlSchoolsOfAssignment(sql`${assignmentId}::uuid`));
  return schools.size === 1 && schools.has(schoolId);
}
export async function getQuizSchoolIds(quizId: string): Promise<Set<string>> {
  if (!isUuid(quizId)) return new Set();
  const direct = await getDirectSchoolId("quizzes", quizId);
  if (direct) return new Set([direct]);
  return resolveSchoolSet(sqlSchoolsOfQuiz(sql`${quizId}::uuid`));
}
export async function isQuizInSchool(schoolId: string, quizId: string): Promise<boolean> {
  const direct = await getDirectSchoolId("quizzes", quizId);
  if (direct) return direct === schoolId;
  const schools = await resolveSchoolSet(sqlSchoolsOfQuiz(sql`${quizId}::uuid`));
  return schools.size === 1 && schools.has(schoolId);
}
export async function getSubmissionSchoolIds(submissionId: string): Promise<Set<string>> {
  if (!isUuid(submissionId)) return new Set();
  const direct = await getDirectSchoolId("submissions", submissionId);
  if (direct) return new Set([direct]);
  return resolveSchoolSet(sqlSchoolsOfSubmission(sql`${submissionId}::uuid`));
}
export async function isSubmissionInSchool(schoolId: string, submissionId: string): Promise<boolean> {
  const direct = await getDirectSchoolId("submissions", submissionId);
  if (direct) return direct === schoolId;
  const schools = await resolveSchoolSet(sqlSchoolsOfSubmission(sql`${submissionId}::uuid`));
  return schools.size === 1 && schools.has(schoolId);
}
export async function getTeacherClassSchoolIds(teacherClassId: string): Promise<Set<string>> {
  if (!isUuid(teacherClassId)) return new Set();
  const direct = await getDirectSchoolId("teacher_classes", teacherClassId);
  if (direct) return new Set([direct]);
  return resolveSchoolSet(sqlSchoolsOfTeacherClass(sql`${teacherClassId}::uuid`));
}
export async function isTeacherClassInSchool(schoolId: string, teacherClassId: string): Promise<boolean> {
  const direct = await getDirectSchoolId("teacher_classes", teacherClassId);
  if (direct) return direct === schoolId;
  const schools = await resolveSchoolSet(sqlSchoolsOfTeacherClass(sql`${teacherClassId}::uuid`));
  return schools.size === 1 && schools.has(schoolId);
}
export async function getTimetableSchoolIds(entryId: string): Promise<Set<string>> {
  if (!isUuid(entryId)) return new Set();
  const direct = await getDirectSchoolId("timetable_entries", entryId);
  if (direct) return new Set([direct]);
  return resolveSchoolSet(sqlSchoolsOfTimetableEntry(sql`${entryId}::uuid`));
}
export async function isTimetableInSchool(schoolId: string, entryId: string): Promise<boolean> {
  const direct = await getDirectSchoolId("timetable_entries", entryId);
  if (direct) return direct === schoolId;
  const schools = await resolveSchoolSet(sqlSchoolsOfTimetableEntry(sql`${entryId}::uuid`));
  return schools.size === 1 && schools.has(schoolId);
}
export async function getFileSchoolIds(fileId: string): Promise<Set<string>> {
  if (!isUuid(fileId)) return new Set();
  const direct = await getDirectSchoolId("uploaded_files", fileId);
  if (direct) return new Set([direct]);
  return resolveSchoolSet(sqlSchoolsOfFile(sql`${fileId}::uuid`));
}
export async function isFileInSchool(schoolId: string, fileId: string): Promise<boolean> {
  const direct = await getDirectSchoolId("uploaded_files", fileId);
  if (direct) return direct === schoolId;
  const schools = await resolveSchoolSet(sqlSchoolsOfFile(sql`${fileId}::uuid`));
  return schools.size === 1 && schools.has(schoolId);
}

/**
 * Identity ownership of an authored row (announcement, resource, activity log): the author
 * is an ACTIVE member of this school. Multi-school authors are visible in each of their
 * schools — a membership is a real affiliation, not a leak.
 */
export async function sqlAuthorInSchool(schoolId: string, authorRef: SQL | AnyColumn): Promise<SQL> {
  return sqlUserInSchool(schoolId, authorRef);
}

/** Identity predicate: the announcement author is an ACTIVE member of this school. */
export function sqlAnnouncementInSchool(schoolId: string, announcementRef: SQL | AnyColumn): SQL {
  // Phase 2D: prefer direct school_id column when present, fallback to author membership
  assertSchoolId(schoolId);
  return sql`(
    exists (select 1 from "announcements" a where a."id" = ${announcementRef} and a."school_id" = ${schoolId})
    or (
      not exists (select 1 from "announcements" a where a."id" = ${announcementRef} and a."school_id" is not null)
      and ${sqlUserInSchool(schoolId, sql`(select "author_id" from "announcements" where "id" = ${announcementRef})`)}
    )
  )`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 2D — DIRECT school_id TENANT PREDICATES
   Phase 2C used relational attribution (teacher/class membership joins) because
   legacy tables had no school_id. Phase 2D adds school_id to all A-class tables
   (migration 0016) so we can enforce tenancy directly via WHERE school_id = ctx.
   These helpers are the preferred path; the relational helpers above remain as
   fallback for databases that have not yet applied 0016, or for rows where
   school_id is NULL (legacy).
   ────────────────────────────────────────────────────────────────────────────── */

/** Generic direct school_id predicate: table has school_id = ctx.schoolId */
function sqlDirectSchoolId(schoolId: string, tableName: string, idRef: SQL | AnyColumn): SQL {
  assertSchoolId(schoolId);
  return sql`exists (select 1 from ${sql.raw(`"${tableName}"`)} t where t."id" = ${idRef} and t."school_id" = ${schoolId})`;
}

/** Direct school_id check for academic_years */
export function sqlAcademicYearInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "academic_years", ref);
}
export function sqlTermInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "terms", ref);
}
export function sqlDepartmentInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "departments", ref);
}
export function sqlSubjectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "subjects", ref);
}

/** Direct school_id for classes — preferred over relational */
export function sqlClassDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "classes", ref);
}
export function sqlTeacherClassDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "teacher_classes", ref);
}
export function sqlLearnerClassDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "learner_classes", ref);
}
export function sqlParentLearnerDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "parent_learners", ref);
}
export function sqlAssignmentDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "assignments", ref);
}
export function sqlSubmissionDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "submissions", ref);
}
export function sqlFileDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "uploaded_files", ref);
}
export function sqlResourceDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "resources", ref);
}
export function sqlQuizDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "quizzes", ref);
}
export function sqlQuizAttemptDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "quiz_attempts", ref);
}
export function sqlAnnouncementDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "announcements", ref);
}
export function sqlNotificationDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "notifications", ref);
}
export function sqlAttendanceDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "attendance", ref);
}
export function sqlTimetableDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "timetable_entries", ref);
}
export function sqlMessageDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "messages", ref);
}
export function sqlActivityLogDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "activity_logs", ref);
}
export function sqlDashboardOverrideDirectInSchool(schoolId: string, ref: SQL | AnyColumn): SQL {
  return sqlDirectSchoolId(schoolId, "dashboard_card_overrides", ref);
}

/** Direct school_id for list filtering: WHERE table.school_id = ctx.schoolId */
export function sqlSchoolIdEquals(schoolId: string, columnRef: SQL | AnyColumn): SQL {
  assertSchoolId(schoolId);
  return sql`${columnRef} = ${schoolId}`;
}

/* ── Direct school_id resolvers (single-record) ── */

async function getDirectSchoolId(tableName: string, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  try {
    const result = await db.execute(sql`select "school_id"::text as sid from ${sql.raw(`"${tableName}"`)} where "id" = ${id}::uuid limit 1`);
    const rows = rowsFromResult(result);
    const sid = rows[0]?.sid;
    return typeof sid === "string" && isUuid(sid) ? sid : null;
  } catch {
    return null;
  }
}

export async function isAcademicYearInSchool(schoolId: string, id: string): Promise<boolean> {
  const direct = await getDirectSchoolId("academic_years", id);
  if (direct) return direct === schoolId;
  // No relational fallback — catalog tables have no anchor, so NULL means not attributable
  return false;
}
export async function isTermInSchool(schoolId: string, id: string): Promise<boolean> {
  const direct = await getDirectSchoolId("terms", id);
  return direct ? direct === schoolId : false;
}
export async function isDepartmentInSchool(schoolId: string, id: string): Promise<boolean> {
  const direct = await getDirectSchoolId("departments", id);
  return direct ? direct === schoolId : false;
}
export async function isSubjectInSchool(schoolId: string, id: string): Promise<boolean> {
  const direct = await getDirectSchoolId("subjects", id);
  return direct ? direct === schoolId : false;
}

/** For classes, prefer direct school_id, fallback to relational for transition */
export async function getClassSchoolIdDirect(classId: string): Promise<string | null> {
  return getDirectSchoolId("classes", classId);
}

/** Updated: try direct school_id first, then relational */
export async function getClassSchoolIdsDirectFirst(classId: string): Promise<Set<string>> {
  const direct = await getDirectSchoolId("classes", classId);
  if (direct) return new Set([direct]);
  return getClassSchoolIds(classId);
}

/* ── Membership writes (routes never touch `school_users` directly) ── */

/**
 * Add a user to a school. Only ever called with a server-resolved school (the caller's own
 * verified context) and a server-validated school role — `super_admin` is rejected by
 * `toSchoolRole`, so a platform role can never be written into a membership row.
 */
export async function addSchoolMembership(params: {
  schoolId: string;
  userId: string;
  role: unknown;
  status?: MembershipStatus;
}): Promise<{ id: string; role: SchoolRole } | null> {
  const role = toSchoolRole(params.role);
  if (!role || !isUuid(params.schoolId) || !isUuid(params.userId)) return null;

  const [row] = await db
    .insert(schoolUsers)
    .values({
      schoolId: params.schoolId,
      userId: params.userId,
      role,
      status: params.status && isMembershipStatus(params.status) ? params.status : ACTIVE_MEMBERSHIP_STATUS,
    })
    .onConflictDoNothing({ target: [schoolUsers.schoolId, schoolUsers.userId] })
    .returning({ id: schoolUsers.id, role: schoolUsers.role });

  return row ? { id: row.id, role: row.role as SchoolRole } : null;
}

/**
 * Keep the membership role aligned when an administrator changes a school member's role.
 * Scoped to `(schoolId, userId)` so it can only ever touch the caller's own school, and it
 * refuses platform roles / unknowns.
 */
export async function updateSchoolMembershipRole(params: {
  schoolId: string;
  userId: string;
  role: unknown;
}): Promise<SchoolRole | null> {
  const role = toSchoolRole(params.role);
  if (!role || !isUuid(params.schoolId) || !isUuid(params.userId)) return null;

  const [row] = await db
    .update(schoolUsers)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(schoolUsers.schoolId, params.schoolId), eq(schoolUsers.userId, params.userId)))
    .returning({ role: schoolUsers.role });

  return row ? (row.role as SchoolRole) : null;
}

/**
 * Phase 2B compatibility: a school-role membership can never be created for a user whose
 * `users.role` is the platform role. Prevents a platform account from acquiring school-wide
 * data access through `POST /api/users` or a role change.
 */
export function canHoldSchoolMembership(role: unknown): boolean {
  return toSchoolRole(role) !== null;
}
