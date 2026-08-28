import { NextRequest } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getTokenFromRequest, verifyToken, hashPassword } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, sql, ilike, or, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const role = request.nextUrl.searchParams.get("role");
    const search = request.nextUrl.searchParams.get("search");
    const page = parseInt(request.nextUrl.searchParams.get("page") || "1");
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "50");
    const offset = (page - 1) * limit;

    const conditions = [];
    if (role) conditions.push(eq(users.role, role as "teacher" | "parent" | "learner" | "super_admin" | "school_admin" | "head_teacher"));
    if (search && search.trim()) {
      conditions.push(
        or(
          ilike(users.firstName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
          ilike(users.email, `%${search}%`)
        )!
      );
    }

    const where = conditions.length > 0
      ? conditions.reduce((a, b) => sql`${a} AND ${b}`)
      : undefined;

    const results = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        phone: users.phone,
        gender: users.gender,
        isActive: users.isActive,
        createdAt: users.createdAt,
        lastLogin: users.lastLogin,
      })
      .from(users)
      .where(where)
      .limit(limit)
      .offset(offset)
      .orderBy(desc(users.createdAt));

    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users).where(where);

    return successResponse({
      users: results,
      pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
    });
  } catch (error) {
    console.error("Users list error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!["super_admin", "school_admin"].includes(payload.role)) {
      return errorResponse("Only administrators can create users", 403);
    }

    const body = await request.json();
    const { email, password, firstName, lastName, role, phone, gender } = body;

    if (!password || !firstName || !lastName || !role) {
      return errorResponse("Password, first name, last name and role are required");
    }

    // Email is required for teachers/admins, optional for learners/parents
    const needsEmail = ["teacher", "school_admin", "head_teacher"].includes(role);
    if (needsEmail && !email) {
      return errorResponse("Email is required for teachers and administrators");
    }

    if (password.length < 6) {
      return errorResponse("Password must be at least 6 characters");
    }

    const validRoles = ["teacher", "parent", "learner", "school_admin", "head_teacher"] as const;
    type ValidRole = typeof validRoles[number];
    if (!validRoles.includes(role as ValidRole)) {
      return errorResponse("Invalid role");
    }

    // Generate a username from name if not provided
    const baseUsername = (firstName.charAt(0).toLowerCase() + lastName.toLowerCase().replace(/\s+/g, ""));
    let generatedUsername = baseUsername;
    let suffix = 1;
    
    // Check uniqueness
    try {
      let existingUser = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, generatedUsername))
        .limit(1);
      
      while (existingUser.length > 0) {
        generatedUsername = `${baseUsername}${suffix}`;
        suffix++;
        existingUser = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, generatedUsername))
          .limit(1);
      }
    } catch (err) {
      console.error("Username check error:", err);
      // Fallback: use timestamp
      generatedUsername = `${baseUsername}${Date.now().toString().slice(-4)}`;
    }

    // Check email uniqueness if provided
    if (email) {
      const existingEmail = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

      if (existingEmail.length > 0) {
        return errorResponse("Email already registered");
      }
    }

    const passwordHash = await hashPassword(password);

    const [newUser] = await db
      .insert(users)
      .values({
        email: email ? email.toLowerCase() : null,
        username: generatedUsername,
        passwordHash,
        firstName,
        lastName,
        role: role as ValidRole,
        phone: phone || null,
        gender: gender || null,
        isActive: true,
        emailVerified: email ? false : true,
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

    return successResponse({ ...newUser, generatedPassword: password }, 201);
  } catch (error) {
    console.error("Create user error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Internal server error: ${errorMessage}`, 500);
  }
}
