import { db } from "@/db";
import { loginAttempts } from "@/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";

// Configuration
const MAX_ATTEMPTS = 5; // Max failed attempts
const WINDOW_MINUTES = 15; // Time window in minutes
const BLOCK_MINUTES = 30; // Block duration after exceeding max attempts

export interface RateLimitResult {
  allowed: boolean;
  remainingAttempts: number;
  blockedUntil?: Date;
  message?: string;
}

/**
 * Check if a login attempt is rate limited
 * Uses DB-backed storage so it works across Vercel instances
 */
export async function checkLoginRateLimit(identifier: string, ipAddress?: string): Promise<RateLimitResult> {
  try {
    const normalizedIdentifier = identifier.toLowerCase().trim();
    const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

    // Count recent failed attempts for this identifier
    const recentAttempts = await db
      .select({ count: sql<number>`count(*)` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.identifier, normalizedIdentifier),
          gte(loginAttempts.createdAt, windowStart)
        )
      );

    const attemptCount = Number(recentAttempts[0]?.count || 0);

    if (attemptCount >= MAX_ATTEMPTS) {
      // Find the most recent attempt to calculate block expiry
      const latestAttempt = await db
        .select({ createdAt: loginAttempts.createdAt })
        .from(loginAttempts)
        .where(eq(loginAttempts.identifier, normalizedIdentifier))
        .orderBy(sql`${loginAttempts.createdAt} DESC`)
        .limit(1);

      if (latestAttempt.length > 0) {
        const blockedUntil = new Date(latestAttempt[0].createdAt.getTime() + BLOCK_MINUTES * 60 * 1000);
        if (blockedUntil > new Date()) {
          return {
            allowed: false,
            remainingAttempts: 0,
            blockedUntil,
            message: `Too many failed login attempts. Please try again after ${blockedUntil.toLocaleTimeString()}.`,
          };
        }
      }

      // Block window has passed, but still at max - clean old attempts will be handled by DB
      // For now, still block if within window
      if (attemptCount >= MAX_ATTEMPTS) {
        const blockedUntil = new Date(Date.now() + BLOCK_MINUTES * 60 * 1000);
        return {
          allowed: false,
          remainingAttempts: 0,
          blockedUntil,
          message: `Too many failed login attempts. Please try again in ${BLOCK_MINUTES} minutes.`,
        };
      }
    }

    return {
      allowed: true,
      remainingAttempts: MAX_ATTEMPTS - attemptCount,
    };
  } catch (error) {
    // If rate limiting fails (e.g., table not yet migrated), allow the attempt but log
    console.error("Rate limit check failed:", error);
    return {
      allowed: true,
      remainingAttempts: MAX_ATTEMPTS,
    };
  }
}

/**
 * Record a failed login attempt
 */
export async function recordFailedLoginAttempt(identifier: string, ipAddress?: string): Promise<void> {
  try {
    const normalizedIdentifier = identifier.toLowerCase().trim();
    await db.insert(loginAttempts).values({
      identifier: normalizedIdentifier,
      ipAddress: ipAddress || null,
    });

    // Cleanup old attempts older than 1 hour to prevent table bloat
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.delete(loginAttempts).where(sql`${loginAttempts.createdAt} < ${oneHourAgo}`);
  } catch (error) {
    console.error("Failed to record login attempt:", error);
    // Don't throw - we don't want to break login flow if rate limiting table fails
  }
}

/**
 * Clear failed attempts after successful login
 */
export async function clearFailedLoginAttempts(identifier: string): Promise<void> {
  try {
    const normalizedIdentifier = identifier.toLowerCase().trim();
    await db.delete(loginAttempts).where(eq(loginAttempts.identifier, normalizedIdentifier));
  } catch (error) {
    console.error("Failed to clear login attempts:", error);
  }
}

/**
 * Get client IP from request
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}
