import { NextRequest } from "next/server";
import { db } from "@/db";
import { users, parentLearners, learnerClasses } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { successResponse, errorResponse, notFoundResponse } from "@/lib/api-helpers";
import { and, eq } from "drizzle-orm";
import {
  guardPlatformAdmin,
  guardSchoolContext,
  hasSchoolAdminRole,
  hasSchoolAdminExtendedRole,
  sqlUserInSchool,
  updateSchoolMembershipRole,
} from "@/lib/tenant";
import {
  ensureUserIdentityColumns,
  schemaAwareErrorMessage,
} from "@/lib/schema-resilience";

/**
 * Phase 2C — `/api/users/[id]` is the canonical cross-tenant IDOR and is the reason the
 * brief calls this the highest-risk route.
 *
 * Every method resolves the caller's school from the database membership context and then
 * requires the TARGET user to be an ACTIVE member of that same school. The check is part of
 * the SQL predicate, so another school's row cannot be read, mutated, deactivated or have
 * its role changed — and it is reported as 404, not 403, so the endpoint cannot be used to
 * enumerate users in other schools.
 *
 * DELETE keeps its pre-Phase-2C rule: it is a PLATFORM operation on the global identity
 * store and requires `super_admin` explicitly (see docs/PHASE2C_TENANT_AUTHORIZATION.md).
 * It is not a tenant bypass — the platform role gets no school data from it.
 */

/** Valid school roles an administrator may assign. `super_admin` is platform-only. */
const ASSIGNABLE_ROLES = ["teacher", "parent", "learner", "school_admin", "head_teacher"] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    await ensureUserIdentityColumns();

    if (!hasSchoolAdminExtendedRole(ctx)) {
      return errorResponse("Forbidden", 403);
    }

    const { id } = await params;

    // Tenant predicate inside the query: a user of another school is "not found".
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), sqlUserInSchool(ctx.schoolId, users.id)))
      .limit(1);

    if (!user) return notFoundResponse("User");

    // Never hand a credential out of the API, whatever the row happens to contain.
    const { passwordHash: _passwordHash, ...safeUser } = user as Record<string, unknown>;

    return successResponse(safeUser);
  } catch (error) {
    console.error("Get user error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The user could not be loaded."),
      503
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    await ensureUserIdentityColumns();

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can update users", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { firstName, lastName, phone, gender, isActive, role } = body;

    if (role !== undefined && !ASSIGNABLE_ROLES.includes(role)) {
      return errorResponse("Invalid role");
    }

    // Tenant predicate inside the query — another school's user is not updatable here.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), sqlUserInSchool(ctx.schoolId, users.id)))
      .limit(1);

    if (!existing) return notFoundResponse("User");

    /* A platform administrator is not a school member and therefore cannot be edited into
       one: assigning `super_admin` is already rejected above, and a platform account is
       excluded from the school predicate, so it cannot be targeted here at all. */
    const [updated] = await db
      .update(users)
      .set({
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
        phone: phone ?? undefined,
        gender: gender ?? undefined,
        isActive: isActive ?? undefined,
        role: role ?? undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, id), sqlUserInSchool(ctx.schoolId, users.id)))
      .returning({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        phone: users.phone,
        gender: users.gender,
        isActive: users.isActive,
      });

    /* Keep `school_users.role` aligned with the identity role so the DB membership stays
       authoritative for the next request instead of drifting for up to 24 h. Scoped to the
       caller's own school, so this can never touch another school's membership. */
    if (role !== undefined) {
      await updateSchoolMembershipRole({ schoolId: ctx.schoolId, userId: id, role });
    }

    return successResponse(updated);
  } catch (error) {
    console.error("Update user error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The account could not be updated."),
      503
    );
  }
}

/**
 * PLATFORM-LEVEL, PRESERVED EXPLICITLY (pre-Phase-2C rule: "Only super admin can delete
 * users"). `users` is the global identity store — not school-owned data — so this is a
 * platform capability, not a tenant bypass. It requires the platform role only; it does not
 * grant and cannot be used to reach school-owned records.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardPlatformAdmin(request);
    if (!auth.ok) return auth.response;

    await ensureUserIdentityColumns();

    const { id } = await params;

    // Delete related records
    await db.delete(parentLearners).where(eq(parentLearners.parentId, id));
    await db.delete(parentLearners).where(eq(parentLearners.learnerId, id));
    await db.delete(learnerClasses).where(eq(learnerClasses.learnerId, id));

    await db.delete(users).where(eq(users.id, id));

    return successResponse({ message: "User deleted" });
  } catch (error) {
    console.error("Delete user error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The account could not be removed."),
      503
    );
  }
}

// Reset password
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    await ensureUserIdentityColumns();

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can reset passwords", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { password } = body;

    if (!password || password.length < 6) {
      return errorResponse("Password must be at least 6 characters");
    }

    // Tenant predicate inside the query: no cross-school password reset.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), sqlUserInSchool(ctx.schoolId, users.id)))
      .limit(1);

    if (!existing) return notFoundResponse("User");

    const passwordHash = await hashPassword(password);

    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(and(eq(users.id, id), sqlUserInSchool(ctx.schoolId, users.id)));

    return successResponse({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset password error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The password could not be reset."),
      503
    );
  }
}
