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

    if (!email || !password || !firstName || !lastName || !role) {
      return errorResponse("Email, password, first name, last name and role are required");
    }

    if (password.length < 6) {
      return errorResponse("Password must be at least 6 characters");
    }

    const validRoles = ["teacher", "parent", "learner", "school_admin", "head_teacher"] as const;
    type ValidRole = typeof validRoles[number];
    if (!validRoles.includes(role as ValidRole)) {
      return errorResponse("Invalid role");
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      return errorResponse("Email already registered");
    }

    const passwordHash = await hashPassword(password);

    const [newUser] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        role: role as ValidRole,
        phone: phone || null,
        gender: gender || null,
        isActive: true,
        emailVerified: true,
      })
      .returning({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        isActive: users.isActive,
      });

    return successResponse(newUser, 201);
  } catch (error) {
    console.error("Create user error:", error);
    return errorResponse("Internal server error", 500);
  }
}
