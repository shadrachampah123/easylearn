import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { findAuthUser, getTokenFromRequest, hashPassword, isSessionRevocationCheckError, verifyToken } from "@/lib/auth";
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

    /* Revocation is MANDATORY for a password change, not best-effort:
       the change exists to lock out whoever holds an old credential, so
       changing the password while silently leaving every issued token
       valid (the pre-fix fallback) would report success while failing
       its purpose. Make sure the session_version column exists first
       (lazy repair, the application's migration strategy); if it cannot
       be made available, refuse with a safe 503 and change NOTHING. */
    const { ensureSessionRevocationColumn, isMissingColumn } = await import("@/lib/schema-resilience");
    const revocation = await ensureSessionRevocationColumn();
    if (!revocation.available) {
      console.error(
        `[change-password] refusing password change: session-revocation schema unavailable (${revocation.migration}).`
      );
      return NextResponse.json(
        { success: false, error: "Password cannot be changed until the session-revocation migration (drizzle/0019) is applied." },
        { status: 503 }
      );
    }

    // Same cost factor as every other password write (src/lib/auth.ts hashPassword).
    // Password hash + session_version bump are ONE atomic update: a crash
    // between them must never leave a new password with unrevoked tokens.
    const newPasswordHash = await hashPassword(newPassword);
    try {
      await db
        .update(users)
        .set({
          passwordHash: newPasswordHash,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    } catch (error) {
      // A missing column here can only be session_version (existence was
      // just verified, so this is a race or a permissions change): fail
      // safe, do not fall back to an unrevoked password change.
      if (isMissingColumn(error)) {
        console.error("[change-password] session_version missing at update time; password NOT changed:", error);
        return NextResponse.json(
          { success: false, error: "Password cannot be changed until the session-revocation migration (drizzle/0019) is applied." },
          { status: 503 }
        );
      }
      throw error;
    }

    /* Clearing must_change_password (drizzle/0006) is NOT security-critical
       in the same way — the password itself has already changed — so it
       keeps the tolerant pre-0006 behaviour as a separate update. */
    try {
      await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
    }

    return NextResponse.json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error) {
    // Revocation could not be verified for the caller's own token:
    // safe 503, and the password was not changed.
    if (isSessionRevocationCheckError(error)) {
      return NextResponse.json(
        { success: false, error: "Session validation is temporarily unavailable. Please try again later." },
        { status: 503 }
      );
    }
    console.error("Change password error:", error);
    return NextResponse.json({ success: false, error: "Failed to update password" }, { status: 500 });
  }
}
