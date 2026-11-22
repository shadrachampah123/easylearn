import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, ilike, or, desc } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import {
  findLoginAliasCollision,
  isIdentityDeadlock,
  isIdentityLockTimeout,
  isValidLoginEmail,
  LOGIN_IDENTITY_LOCK_NAMESPACE,
  LOGIN_IDENTITY_LOCK_TIMEOUT_MS,
  loginAliasCollisionMessage,
  type LoginAliasCollision,
} from "@/lib/login-identity";
import {
  addSchoolMembership,
  guardSchoolContext,
  hasSchoolAdminRole,
  hasSchoolAdminExtendedRole,
  sqlUserHasRoleInSchool,
  sqlUserInSchool,
  sqlUserRoleInSchool,
} from "@/lib/tenant";
import {
  clientSafeErrorMessage,
  ensureUserIdentityColumns,
  isMissingColumn,
  isSchemaOutOfDate,
  schemaAwareErrorMessage,
} from "@/lib/schema-resilience";

/**
 * Phase 2C — the user directory is a SCHOOL directory.
 *
 * `users` stays the global identity store (plan §6), but a row is only listed here when it
 * holds an ACTIVE `school_users` membership in the caller's own school. The school comes
 * from the database-backed membership context, never from a client parameter, and the
 * filter is a SQL predicate so another school's row is never fetched (and therefore never
 * leaked through a response body or an error path).
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    await ensureUserIdentityColumns();

    // Only administrators may enumerate users (Phase 1 rule, now backed by the DB
    // membership role instead of the JWT `role` claim).
    if (!hasSchoolAdminExtendedRole(ctx)) {
      return errorResponse("Only administrators can view user directory", 403);
    }

    const role = request.nextUrl.searchParams.get("role");
    const search = request.nextUrl.searchParams.get("search");
    const page = parseInt(request.nextUrl.searchParams.get("page") || "1");
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "50");
    const offset = (page - 1) * limit;

    // The school_users membership role, not global users.role, is authoritative within
    // this tenant. A shared identity can legitimately have different roles in each school.
    const conditions = [sqlUserInSchool(ctx.schoolId, users.id)];
    if (role) {
      const validRoles = ["teacher", "parent", "learner", "school_admin", "head_teacher"] as const;
      conditions.push((validRoles as readonly string[]).includes(role)
        ? sqlUserHasRoleInSchool(ctx.schoolId, users.id, role as (typeof validRoles)[number])
        : sql`false`);
    }
    if (search && search.trim()) {
      conditions.push(
        or(
          ilike(users.firstName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
          ilike(users.email, `%${search}%`)
        )!
      );
    }

    const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);

    const baseProjection = {
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: sql<string>`${sqlUserRoleInSchool(ctx.schoolId, users.id)}`,
      phone: users.phone,
      gender: users.gender,
      isActive: users.isActive,
      createdAt: users.createdAt,
      lastLogin: users.lastLogin,
    };

    // `username` only exists from drizzle/0006 onwards. When it is still missing (and
    // auto-repair is disabled or not permitted) list the users without it - the admin
    // parent/teacher/learner screens stay usable instead of throwing a 500.
    const projection = { ...baseProjection, username: users.username };

    const fetchPage = (fields: Record<string, unknown>) =>
      db
        .select(fields as never)
        .from(users)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(users.createdAt));

    let results: Record<string, unknown>[];
    let degradedMessage: string | null = null;
    try {
      results = (await fetchPage(projection)) as Record<string, unknown>[];
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      results = (await fetchPage(baseProjection)) as Record<string, unknown>[];
      degradedMessage =
        "Usernames are hidden because drizzle/0006_user_identity_columns.sql has not been applied to this database.";
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(where);

    if (!degradedMessage) {
      return successResponse({
        users: results,
        pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        users: results,
        pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
      },
      meta: {
        degraded: true,
        warning: {
          area: "users",
          message: degradedMessage,
          migration: "drizzle/0006_user_identity_columns.sql",
        },
      },
    });
  } catch (error) {
    console.error("Users list error:", error);
    if (isSchemaOutOfDate(error)) {
      return errorResponse(
        "The users table is out of date for this build of EasyLearn. Apply the pending files in drizzle/ (see drizzle/0006_user_identity_columns.sql), then retry.",
        503
      );
    }
    return errorResponse(clientSafeErrorMessage(error, "The user list could not be loaded. Please retry."), 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    await ensureUserIdentityColumns();

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can create users", 403);
    }

    const body = await request.json();
    const { email, password, firstName, lastName, role, phone, gender } = body;

    if (!password || !firstName || !lastName || !role) {
      return errorResponse("Password, first name, last name and role are required");
    }

    const needsEmail = ["teacher", "school_admin", "head_teacher"].includes(role);
    if (needsEmail && !email) {
      return errorResponse("Email is required for teachers and administrators");
    }

    /* F-6: an email address is also a login-throttle bucket key, so it has to be an email
       address. Before this, any string was accepted — including another account's username,
       which makes the two accounts share one guess budget (see src/lib/login-identity.ts). */
    if (email !== undefined && email !== null && email !== "" && !isValidLoginEmail(email)) {
      return errorResponse("Enter a valid email address, for example name@school.edu");
    }

    if (password.length < 6) {
      return errorResponse("Password must be at least 6 characters");
    }

    const validRoles = ["teacher", "parent", "learner", "school_admin", "head_teacher"] as const;
    type ValidRole = typeof validRoles[number];
    if (!validRoles.includes(role as ValidRole)) {
      return errorResponse("Invalid role");
    }

    const baseUsername = (firstName.charAt(0).toLowerCase() + lastName.toLowerCase().replace(/\s+/g, ""));
    const normalizedEmail =
      typeof email === "string" && email.trim().length > 0 ? email.trim().toLowerCase() : null;

    /* bcrypt cost 12 costs a couple of hundred milliseconds, so it is deliberately OUTSIDE the
       transaction below: the identity lock has to be held for as few statements as possible and
       the hash does not depend on anything the lock protects. In the pre-fix code this same call
       sat BETWEEN the uniqueness checks and the INSERT, which is what made the check-then-act
       race hundreds of milliseconds wide instead of microseconds (F-6 follow-up). */
    const passwordHash = await hashPassword(password);

    /** Thrown to roll the transaction back for an outcome that is normal and gets mapped below. */
    class IdentityRollback extends Error {}

    type IdentityOutcome =
      | {
          kind: "created";
          user: {
            id: string;
            username: string | null;
            email: string | null;
            firstName: string;
            lastName: string;
            role: string;
            isActive: boolean;
          };
        }
      | { kind: "duplicate-email" }
      | { kind: "collision"; collision: LoginAliasCollision }
      | { kind: "membership-failed" };

    /* Returned from the transaction rather than assigned inside it: a `let` written from a
       closure is narrowed to `null` by TypeScript's control-flow analysis at the read site.
       The pre-insert refusals return normally (they commit an empty transaction, which only
       releases the lock); the one case that HAS written a row — a failed membership — throws,
       so the account is rolled back instead of being compensating-deleted. */
    let outcome: IdentityOutcome = { kind: "membership-failed" };

    try {
      /* F-6 follow-up: the cross-column uniqueness check is now ATOMIC. Separate SELECTs
         followed by an INSERT let two concurrent creations both read "no conflict" and both
         commit — measured with two opposing requests (one creating `email = X`, the other
         creating an account whose generated `username = X`): both accounts were created and the
         collision survived, which is exactly the state this guard exists to prevent, because two
         accounts sharing one identifier string share one login-throttle budget and a successful
         sign-in to one releases the other's recorded failures.

         The schema cannot express the constraint (`users.email` and `users.username` have
         separate unique indexes, so cross-column uniqueness would need an expression index — a
         Production migration this work is not authorised to add), so the check is serialised in
         the database instead: one transaction-scoped advisory lock over the whole
         check-generate-insert-membership sequence. See src/lib/login-identity.ts for why one
         namespace key rather than a key per identifier, and why not SERIALIZABLE. */
      outcome = await db.transaction(async (tx): Promise<IdentityOutcome> => {
        /* Bounded, and transaction-scoped so it can never leak into another request's use of the
           same pooled connection. The constant is an integer interpolated into the statement
           because `SET` does not accept a bind parameter; there is no string to inject. */
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${LOGIN_IDENTITY_LOCK_TIMEOUT_MS}`));
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOGIN_IDENTITY_LOCK_NAMESPACE}::text, 0))`
        );

        const identifierExists = async (column: "email" | "username", identifier: string) => {
          const rows = await tx
            .select({ id: users.id })
            .from(users)
            .where(column === "email" ? eq(users.email, identifier) : eq(users.username, identifier))
            .limit(1);
          return rows.length > 0;
        };

        /* F-6: a generated username must be unique in BOTH columns. It was only checked against
           `users.username`, so a generated username that happened to be an existing account's
           email created two accounts the login throttle cannot tell apart. */
        const usernameIsTaken = async (candidate: string) =>
          (await identifierExists("username", candidate)) ||
          (await findLoginAliasCollision(identifierExists, { username: candidate })) !== null;

        /* Inside the lock, so the candidate this transaction chooses cannot be taken by a
           concurrent creation between the check and the INSERT. The old timestamp-suffix fallback
           on error is gone on purpose: swallowing a database error inside a transaction would
           continue on a possibly aborted transaction, and it never helped anyway — the INSERT
           below names the `username` column, so a missing column fails there regardless. */
        let generatedUsername = baseUsername;
        let suffix = 1;
        let guard = 0;
        while ((await usernameIsTaken(generatedUsername)) && guard < 1000) {
          generatedUsername = `${baseUsername}${suffix}`;
          suffix++;
          guard++;
        }

        if (normalizedEmail && (await identifierExists("email", normalizedEmail))) {
          return { kind: "duplicate-email" as const };
        }

        /* F-6: the other direction — the supplied email must not already be some account's
           username. Measured before this guard: signing in to an account whose email equalled a
           second account's username erased the second account's four recorded failures to zero,
           because `clearFailedLoginAttempts` releases every alias string of the account that
           authenticated. 409 rather than 400 because it is a conflict with existing state. */
        const collision = await findLoginAliasCollision(identifierExists, {
          email: normalizedEmail,
          username: generatedUsername,
        });
        if (collision) return { kind: "collision" as const, collision };

        const [newUser] = await tx
          .insert(users)
          .values({
            email: normalizedEmail,
            username: generatedUsername,
            passwordHash,
            firstName,
            lastName,
            role: role as ValidRole,
            phone: phone || null,
            gender: gender || null,
            isActive: true,
            emailVerified: normalizedEmail ? false : true,
          })
          .returning({
            id: users.id,
            username: users.username,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
            isActive: users.isActive,
          });

        if (!newUser) throw new IdentityRollback();

        /* Phase 2C: the new account is made a member of the CALLER'S school (never a
           client-supplied one) so membership stays the single source of truth for school
           context. Inside the same transaction now, so a failure rolls the account back instead
           of needing a compensating DELETE — an account with an identity and no school is a
           silent lockout, and a compensating delete could itself fail and leave that state. */
        const membership = await addSchoolMembership(
          { schoolId: ctx.schoolId, userId: newUser.id, role },
          tx
        );
        if (!membership) throw new IdentityRollback();

        return { kind: "created" as const, user: newUser };
      });
    } catch (error) {
      if (error instanceof IdentityRollback) {
        outcome = { kind: "membership-failed" };
      } else if (isIdentityLockTimeout(error) || isIdentityDeadlock(error)) {
        /* Bounded on purpose: a stuck creation must not be able to hold one of the two
           Production connections, or every other creation, indefinitely. Nothing was written. */
        console.error(
          `[users] could not take the login-identity lock within ${LOGIN_IDENTITY_LOCK_TIMEOUT_MS}ms — refusing this creation, nothing was written`
        );
        return errorResponse(
          "Another account is being created right now. Please retry in a moment.",
          503
        );
      } else {
        throw error;
      }
    }

    if (outcome.kind === "duplicate-email") return errorResponse("Email already registered");
    if (outcome.kind === "collision") {
      return errorResponse(loginAliasCollisionMessage(outcome.collision), 409);
    }
    if (outcome.kind !== "created") {
      return errorResponse(
        "The account could not be added to your school. Please retry.",
        503
      );
    }
    const newUser = outcome.user;

    await logActivity({
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      action: "create",
      entityType: "user",
      entityId: newUser.id,
      description: `Created user ${firstName} ${lastName} (${role})`,
      details: JSON.stringify({ role, email: email ? "[REDACTED]" : null }),
    });

    return successResponse({ ...newUser, generatedPassword: password }, 201);
  } catch (error) {
    console.error("Create user error:", error);
    if (isSchemaOutOfDate(error)) {
      return errorResponse(
        schemaAwareErrorMessage(error, "The account could not be created."),
        503
      );
    }
    return errorResponse(
      clientSafeErrorMessage(error, "The account could not be created. Please retry."),
      500
    );
  }
}
