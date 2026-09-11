import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { findAuthUser, getTokenFromRequest, verifyToken } from "@/lib/auth";
import { unauthorizedResponse, errorResponse } from "@/lib/api-helpers";

export async function POST(request: NextRequest) {
  try {
    // Require authentication
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
    }

    const { currentPassword, newPassword, userId: requestedUserId } = body as Record<string, unknown>;

    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return NextResponse.json({ success: false, error: "Current password and new password are required" }, { status: 400 });
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ success: false, error: "New password must be at least 8 characters" }, { status: 400 });
    }

    // Never trust client-supplied userId for normal users - derive from token
    // If client supplies a different userId, reject it (prevent privilege escalation)
    if (requestedUserId && typeof requestedUserId === "string" && requestedUserId !== payload.userId) {
      // Only allow if the requester is admin and wants to change own password via this route?
      // For self-service, we always use payload.userId. Changing another user's password
      // should go through the admin reset flow at /api/users/[id] PATCH which is separately authorized.
      // So we reject cross-user attempts here.
      return NextResponse.json({ success: false, error: "You can only change your own password" }, { status: 403 });
    }

    const userId = payload.userId;

    // findAuthUser degrades on databases without drizzle/0006 (must_change_password)
    const user = await findAuthUser(eq(users.id, userId), {
      withPasswordHash: true,
      repair: true,
    });

    if (!user) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      return NextResponse.json({ success: false, error: "Incorrect current password" }, { status: 400 });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    try {
      await db
        .update(users)
        .set({
          passwordHash: newPasswordHash,
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    } catch (error) {
      // Older database without the must_change_password column
      const { isMissingColumn } = await import("@/lib/schema-resilience");
      if (!isMissingColumn(error)) throw error;
      await db
        .update(users)
        .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
        .where(eq(users.id, userId));
    }

    return NextResponse.json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error) {
    console.error("Change password error:", error);
    return NextResponse.json({ success: false, error: "Failed to update password" }, { status: 500 });
  }
}
