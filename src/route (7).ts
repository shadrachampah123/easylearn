import { NextRequest } from "next/server";
import { users } from "@/db/schema";
import { verifyPassword, createToken } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { getDatabaseErrorMessage } from "@/lib/database-errors";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid request body");
    }

    const { email, password } = body as Record<string, unknown>;

    if (typeof email !== "string" || typeof password !== "string") {
      return errorResponse("Email and password are required");
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
      return errorResponse("Email and password are required");
    }

    if (!process.env.DATABASE_URL?.trim()) {
      return errorResponse(
        "DATABASE_URL is not configured in Vercel. Add it to Production, Preview, and Development, then redeploy.",
        503
      );
    }

    const { db } = await import("@/db");

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (!user) {
      return errorResponse("Invalid email or password", 401);
    }

    if (!user.isActive) {
      return errorResponse("Account is deactivated. Contact admin.", 403);
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return errorResponse("Invalid email or password", 401);
    }

    await db
      .update(users)
      .set({ lastLogin: new Date() })
      .where(eq(users.id, user.id));

    const token = await createToken({
      userId: user.id,
      email: user.email || undefined,
      role: user.role,
    });

    const userData = {
      id: user.id,
      email: user.email || undefined,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
    };

    const response = successResponse({ user: userData, token });
    response.cookies.set("el_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Login error:", error);
    return errorResponse(getDatabaseErrorMessage(error), 503);
  }
}
