import { NextRequest } from "next/server";
import { users } from "@/db/schema";
import { verifyPassword, createToken, findAuthUser } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { getDatabaseErrorMessage } from "@/lib/database-errors";
import { getDatabaseConfigurationProblem, getJwtConfigurationProblem } from "@/lib/env";
import { eq } from "drizzle-orm";
import {
  checkLoginRateLimit,
  recordFailedLoginAttempt,
  clearFailedLoginAttempts,
  getClientIp,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
  UNAVAILABLE_RETRY_SECONDS,
  type RateLimitResult,
} from "@/lib/rate-limit";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Throttle responses carry `Retry-After` so a well-behaved client (and any intermediary)
 * stops hammering the endpoint, and `no-store` so a shared cache never replays a 429/503.
 */
function throttleResponse(message: string, status: number, retryAfterSeconds?: number) {
  const response = errorResponse(message, status);
  if (typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    response.headers.set("Retry-After", String(Math.ceil(retryAfterSeconds)));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function rateLimitResponse(rateLimit: RateLimitResult) {
  // A refused *check* is a service problem (503), not a client abuse problem (429): the
  // caller is not necessarily over any budget, the throttle simply could not be evaluated.
  const status = rateLimit.reason === "unavailable" ? 503 : 429;
  return throttleResponse(
    rateLimit.message || "Too many failed login attempts. Please try again later.",
    status,
    rateLimit.retryAfterSeconds
  );
}

/**
 * A failed attempt that could not be stored leaves the throttle blind to it. Answering 401
 * anyway would hand an attacker free guesses — that is precisely the fail-open behaviour
 * audit finding H-1 describes — so the login is paused until recording works again.
 */
function degradedThrottleResponse() {
  return throttleResponse(RATE_LIMIT_UNAVAILABLE_MESSAGE, 503, UNAVAILABLE_RETRY_SECONDS);
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid request body");
    }

    const { email, username, password } = body as Record<string, unknown>;
    if (typeof password !== "string") {
      return errorResponse("Password is required");
    }
    if (typeof email !== "string" && typeof username !== "string") {
      return errorResponse("Email or username is required");
    }

    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const normalizedUsername = typeof username === "string" ? username.trim() : "";
    if ((!normalizedEmail && !normalizedUsername) || !password) {
      return errorResponse("Email or username and password are required");
    }

    const configurationProblem =
      getDatabaseConfigurationProblem() || getJwtConfigurationProblem();
    if (configurationProblem) {
      return errorResponse(configurationProblem, 503);
    }

    const { db } = await import("@/db");

    // Rate limiting — DB-backed so it works across Vercel instances, and layered per
    // source IP as well as per account (see src/lib/rate-limit.ts for the H-1 rationale).
    const identifier = normalizedEmail || normalizedUsername;
    const clientIp = getClientIp(request);
    const rateLimit = await checkLoginRateLimit(identifier, clientIp);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit);
    }

    // Search by email first, then by username. Both reads go through findAuthUser so that a
    // database without drizzle/0006 (users.username) can still sign people in - previously the
    // `select()` picked every schema column and login itself threw.
    let user: Record<string, any> | null = null;
    if (normalizedEmail) {
      user = await findAuthUser(eq(users.email, normalizedEmail), {
        withPasswordHash: true,
        repair: true,
      });
    }
    if (!user && normalizedUsername) {
      const { isMissingColumn } = await import("@/lib/schema-resilience");
      try {
        user = await findAuthUser(eq(users.username, normalizedUsername), { withPasswordHash: true });
      } catch (error) {
        // Username login simply is not available before migration 0006; email login still is.
        if (!isMissingColumn(error)) throw error;
      }
    }

    if (!user) {
      const recorded = await recordFailedLoginAttempt(identifier, clientIp);
      if (!recorded.recorded) return degradedThrottleResponse();
      return errorResponse("Invalid email/username or password", 401);
    }

    if (!user.isActive) {
      // Counted as a failed attempt on purpose: deactivated accounts are a favourite
      // enumeration target, so those guesses should consume the source IP budget too.
      const recorded = await recordFailedLoginAttempt(identifier, clientIp);
      if (!recorded.recorded) return degradedThrottleResponse();
      return errorResponse("Account is deactivated. Contact the school administrator.", 403);
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      const recorded = await recordFailedLoginAttempt(identifier, clientIp);
      if (!recorded.recorded) return degradedThrottleResponse();
      return errorResponse("Invalid email or password", 401);
    }

    // Successful login — clear the account bucket *and* this source IP's bucket, so a
    // legitimate user behind a shared school NAT releases the budget they consumed.
    await clearFailedLoginAttempts(identifier, clientIp);

    // Phase 2B — school context. Resolved from `school_users` on the server; a client
    // supplied school id is never read or trusted (see src/lib/tenant.ts). This helper
    // never throws: a user without a membership (e.g. a platform super_admin) still logs in
    // with `school: null`, so nobody is locked out by the backfill.
    const { isPlatformRole, resolveLoginSchoolContext, toSchoolSummary } = await import("@/lib/tenant");
    const { memberships, school } = await resolveLoginSchoolContext(user.id);

    // Revocation: include current sessionVersion so logout can invalidate.
    let sessionVersion = 0;
    try {
      const [row] = await db
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      sessionVersion = (row as unknown as { sessionVersion?: number | null })?.sessionVersion ?? user.sessionVersion ?? 0;
    } catch {
      sessionVersion = user.sessionVersion ?? 0;
    }

    const token = await createToken({
      userId: user.id,
      email: user.email || undefined,
      username: user.username || undefined,
      role: user.role,
      // Hints only — authorization re-derives membership from the database.
      schoolId: school?.schoolId,
      membershipId: school?.membershipId,
      // Keep an unselected login ambiguous for its lifetime, even if memberships later change.
      schoolSelectionRequired: !isPlatformRole(user.role) && memberships.length !== 1,
      sessionVersion,
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
        mustChangePassword: Boolean(user.mustChangePassword),
      },
      // Phase 2B additive context. Server-derived and read-only for the client: sending a
      // `school`/`schoolId` back has no effect anywhere (see src/lib/tenant.ts).
      school: toSchoolSummary(school),
      schools: memberships.map((membership) => toSchoolSummary(membership)),
      // The session token is NOT returned in the body. The browser receives it as an
      // `httpOnly` cookie below, which script on the page cannot read. Returning it
      // here would put a long-lived credential back within reach of any injected
      // script, which is exactly what the cookie prevents.
    });

    response.cookies.set(SESSION_COOKIE_NAME, token, {
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
