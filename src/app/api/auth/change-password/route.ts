import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

export async function POST(req: Request) {
  try {
    const { userId, currentPassword, newPassword } = await req.json();

    if (!userId || !currentPassword || !newPassword) {
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 });
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ success: false, error: "New password must be at least 8 characters" }, { status: 400 });
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (!user) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      return NextResponse.json({ success: false, error: "Incorrect current password" }, { status: 400 });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    await db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        mustChangePassword: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return NextResponse.json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error) {
    console.error("Change password error:", error);
    return NextResponse.json({ success: false, error: "Failed to update password" }, { status: 500 });
  }
}