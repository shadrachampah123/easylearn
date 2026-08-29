import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getTokenFromRequest, verifyToken, hashPassword } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, sql, ilike, or, desc } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import {
  clientSafeErrorMessage,
  ensureUserIdentityColumns,
  isMissingColumn,
  isSchemaOutOfDate,
  schemaAwareErrorMessage,
} from "@/lib/schema-resilience";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
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

    const baseProjection = {
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
    };

    // `username` only exists from drizzle/0006 onwards. When it is still missing (and
    // auto-repair is disabled or not permitted) list the users without it - the admin
    // parent/teacher/learner screens stay usable instead of throwing a 500.
    const projection = { ...baseProjection, username: users.username };

    const fetchPage = (fields: Record<string, unknown>) =>
      db
        .select(fields as never)
        .from(users)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(users.createdAt));

    let results: Record<string, unknown>[];
    let degradedMessage: string | null = null;
    try {
      results = (await fetchPage(projection)) as Record<string, unknown>[];
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      results = (await fetchPage(baseProjection)) as Record<string, unknown>[];
      degradedMessage =
        "Usernames are hidden because drizzle/0006_user_identity_columns.sql has not been applied to this database.";
    }

    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users).where(where);

    if (!degradedMessage) {
      return successResponse({
        users: results,
        pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        users: results,
        pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
      },
      meta: {
        degraded: true,
        warning: {
          area: "users",
          message: degradedMessage,
          migration: "drizzle/0006_user_identity_columns.sql",
        },
      },
    });
  } catch (error) {
    console.error("Users list error:", error);
    if (isSchemaOutOfDate(error)) {
      return errorResponse(
        "The users table is out of date for this build of EasyLearn. Apply the pending files in drizzle/ (see drizzle/0006_user_identity_columns.sql), then retry.",
        503
      );
    }
    return errorResponse(clientSafeErrorMessage(error, "The user list could not be loaded. Please retry."), 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    await ensureUserIdentityColumns();
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

    const baseUsername = (firstName.charAt(0).toLowerCase() + lastName.toLowerCase().replace(/\s+/g, ""));
    let generatedUsername = baseUsername;
    let suffix = 1;
    
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
      generatedUsername = `${baseUsername}${Date.now().toString().slice(-4)}`;
    }

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

    await logActivity({
      userId: payload.userId,
      action: "create",
      entityType: "user",
      entityId: newUser.id,
      description: `Created user ${firstName} ${lastName} (${role})`,
      details: JSON.stringify({ role, email: email ? "[REDACTED]" : null }),
    });

    return successResponse({ ...newUser, generatedPassword: password }, 201);
  } catch (error) {
    console.error("Create user error:", error);
    if (isSchemaOutOfDate(error)) {
      return errorResponse(
        schemaAwareErrorMessage(error, "The account could not be created."),
        503
      );
    }
    return errorResponse(
      clientSafeErrorMessage(error, "The account could not be created. Please retry."),
      500
    );
  }
}
