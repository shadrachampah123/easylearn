import { NextRequest } from "next/server";
import { users } from "@/db/schema";
import { verifyPassword, createToken } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { getDatabaseErrorMessage } from "@/lib/database-errors";
import { getDatabaseConfigurationProblem, getJwtConfigurationProblem } from "@/lib/env";
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

    const configurationProblem =
      getDatabaseConfigurationProblem() || getJwtConfigurationProblem();
    if (configurationProblem) {
      return errorResponse(configurationProblem, 503);
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
      return errorResponse("Account is deactivated. Contact the school administrator.", 403);
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return errorResponse("Invalid email or password", 401);
    }

    const token = await createToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    await db
      .update(users)
      .set({ lastLogin: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const response = successResponse({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
      },
      token,
    });

    response.cookies.set("el_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });
    response.headers.set("Cache-Control", "no-store");

    return response;
  } catch (error) {
    console.error("Login error:", error);
    return errorResponse(getDatabaseErrorMessage(error), 503);
  }
}
