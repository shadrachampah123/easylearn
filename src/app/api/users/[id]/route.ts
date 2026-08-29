import { NextRequest } from "next/server";
import { db } from "@/db";
import { users, parentLearners, learnerClasses } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { hashPassword } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse, notFoundResponse } from "@/lib/api-helpers";
import { eq } from "drizzle-orm";
import {
  ensureUserIdentityColumns,
  schemaAwareErrorMessage,
} from "@/lib/schema-resilience";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin", "head_teacher"].includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    const { id } = await params;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!user) return notFoundResponse("User");

    return successResponse(user);
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
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("Only administrators can update users", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { firstName, lastName, phone, gender, isActive, role } = body;

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("User");

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

    return successResponse(updated);
  } catch (error) {
    console.error("Update user error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The account could not be updated."),
      503
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (payload.role !== "super_admin") {
      return errorResponse("Only super admin can delete users", 403);
    }

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
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("Only administrators can reset passwords", 403);
    }

    const { id } = await params;
    const body = await request.json();
    const { password } = body;

    if (!password || password.length < 6) {
      return errorResponse("Password must be at least 6 characters");
    }

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!existing) return notFoundResponse("User");

    const passwordHash = await hashPassword(password);

    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id));

    return successResponse({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset password error:", error);
    return errorResponse(
      schemaAwareErrorMessage(error, "The password could not be reset."),
      503
    );
  }
}
