import { NextRequest } from "next/server";
import { users } from "@/db/schema";
import { hashPassword, createToken } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { getDatabaseErrorMessage, isUniqueViolation } from "@/lib/database-errors";
import { getDatabaseConfigurationProblem, getJwtConfigurationProblem } from "@/lib/env";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publicRoles = ["learner", "parent", "teacher"] as const;
type PublicRole = (typeof publicRoles)[number];

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid request body");
    }

    const values = body as Record<string, unknown>;
    const email = typeof values.email === "string" ? values.email.trim().toLowerCase() : "";
    const password = typeof values.password === "string" ? values.password : "";
    const firstName = typeof values.firstName === "string" ? values.firstName.trim() : "";
    const lastName = typeof values.lastName === "string" ? values.lastName.trim() : "";
    const phone = typeof values.phone === "string" ? values.phone.trim() : "";
    const gender = values.gender === "male" || values.gender === "female" || values.gender === "other"
      ? values.gender
      : null;
    const requestedRole = typeof values.role === "string" ? values.role : "learner";
    const userRole: PublicRole = publicRoles.includes(requestedRole as PublicRole)
      ? requestedRole as PublicRole
      : "learner";

    if (!email || !password || !firstName || !lastName) {
      return errorResponse("Email, password, first name, and last name are required");
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return errorResponse("Enter a valid email address");
    }

    if (password.length < 6) {
      return errorResponse("Password must be at least 6 characters");
    }

    const configurationProblem =
      getDatabaseConfigurationProblem() || getJwtConfigurationProblem();
    if (configurationProblem) {
      return errorResponse(configurationProblem, 503);
    }

    const { db } = await import("@/db");

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length > 0) {
      return errorResponse("Email already registered", 409);
    }

    const passwordHash = await hashPassword(password);

    const [newUser] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        firstName,
        lastName,
        role: userRole,
        phone: phone || null,
        gender,
      })
      .returning({
        id: users.id,
        email: users.email,
        role: users.role,
        firstName: users.firstName,
        lastName: users.lastName,
      });

    const token = await createToken({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    const response = successResponse({ user: newUser, token }, 201);
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
    console.error("Registration error:", error);

    if (isUniqueViolation(error)) {
      return errorResponse("Email already registered", 409);
    }

    return errorResponse(getDatabaseErrorMessage(error), 503);
  }
}
