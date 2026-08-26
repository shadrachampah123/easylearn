import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getJwtSecret } from "@/lib/env";

const TOKEN_EXPIRY = "24h";

function getJwtKey(): Uint8Array {
  const secret = getJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createToken(payload: {
  userId: string;
  email: string;
  role: string;
}): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getJwtKey());
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getJwtKey(), {
      algorithms: ["HS256"],
    });

    if (
      typeof payload.userId !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.role !== "string"
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };
  } catch {
    return null;
  }
}

export async function getUserFromToken(token: string) {
  const payload = await verifyToken(token);
  if (!payload) return null;

  const { db } = await import("@/db");

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);

  return user?.isActive ? user : null;
}

export function getTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) return bearerToken;
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)el_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }

  return null;
}
