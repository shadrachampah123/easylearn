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
  getEffectiveSchoolRole,
  isUserInSchool,
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
 * School-scoped reads and membership-role changes target the caller's active school
 * membership. Global identity fields (profile, active status, password, and the legacy
 * global role) are platform-only because one identity may be shared across schools.
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
    if (!hasSchoolAdminExtendedRole(ctx)) return errorResponse("Forbidden", 403);

    const { id } = await params;
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), sqlUserInSchool(ctx.schoolId, users.id)))
      .limit(1);

    if (!user) return notFoundResponse("User");
    const schoolRole = await getEffectiveSchoolRole(id, { schoolId: ctx.schoolId });
    if (!schoolRole) return notFoundResponse("User");
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return successResponse({ ...safeUser, role: schoolRole });
  } catch (error) {
    console.error("Get user error:", error);
    return errorResponse(schemaAwareErrorMessage(error, "The user could not be loaded."), 503);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const schoolAuth = await guardSchoolContext(request);
    const body = await request.json();
    const { firstName, lastName, phone, gender, isActive, role } = body;
    const { id } = await params;
    await ensureUserIdentityColumns();

    if (role !== undefined && !ASSIGNABLE_ROLES.includes(role)) {
      return errorResponse("Invalid role");
    }

    const hasGlobalFields = [firstName, lastName, phone, gender, isActive].some((value) => value !== undefined);

    if (schoolAuth.ok) {
      const ctx = schoolAuth.context;
      if (!(await isUserInSchool(ctx.schoolId, id))) return notFoundResponse("User");
      if (!hasSchoolAdminRole(ctx)) return errorResponse("Only administrators can update users", 403);
      // A school cannot change fields on the shared identity, even if this request's
      // target happens to be a member of the current school.
      if (hasGlobalFields) {
        return errorResponse("Profile and account status changes require a platform administrator", 403);
      }
      if (role === undefined) return errorResponse("No school-scoped user changes provided", 400);

      const updatedRole = await updateSchoolMembershipRole({ schoolId: ctx.schoolId, userId: id, role });
      if (!updatedRole) return notFoundResponse("User");
      const [user] = await db.select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        phone: users.phone,
        gender: users.gender,
        isActive: users.isActive,
      }).from(users).where(eq(users.id, id)).limit(1);
      return successResponse({ ...user, role: updatedRole });
    }

    // No school context means the caller must explicitly pass the platform gate before any
    // mutation to the global identity store (profile/status/legacy role).
    const platformAuth = await guardPlatformAdmin(request);
    if (!platformAuth.ok) return platformAuth.response;
    if (!hasGlobalFields && role === undefined) return errorResponse("No user changes provided", 400);

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
      .where(eq(users.id, id))
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
    if (!updated) return notFoundResponse("User");
    return successResponse(updated);
  } catch (error) {
    console.error("Update user error:", error);
    return errorResponse(schemaAwareErrorMessage(error, "The account could not be updated."), 503);
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
    const schoolAuth = await guardSchoolContext(request);
    if (schoolAuth.ok) {
      const { id } = await params;
      if (!(await isUserInSchool(schoolAuth.context.schoolId, id))) return notFoundResponse("User");
      return errorResponse("Password resets require a platform administrator", 403);
    }

    const auth = await guardPlatformAdmin(request);
    if (!auth.ok) return auth.response;
    await ensureUserIdentityColumns();

    const { id } = await params;
    const body = await request.json();
    const { password } = body;
    if (!password || typeof password !== "string" || password.length < 6) {
      return errorResponse("Password must be at least 6 characters");
    }

    const passwordHash = await hashPassword(password);
    const [updated] = await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!updated) return notFoundResponse("User");
    return successResponse({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset password error:", error);
    return errorResponse(schemaAwareErrorMessage(error, "The password could not be reset."), 503);
  }
}
