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

const INVALID_LOGIN_MESSAGE = "Invalid email or password";

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

    // Rate limiting — DB-backed so it works across Vercel instances, and layered per source IP
    // as well as per account (see src/lib/rate-limit.ts for the H-1, M-R2 and M-R3 rationale).
    const suppliedIdentifier = normalizedEmail || normalizedUsername;
    // M-R1: getClientIp only ever returns an address this deployment has declared trustworthy.
    // `null` is a normal outcome (an unattributable source) and simply means the per-source
    // budgets cannot be applied — the per-account budgets still are.
    const clientIp = getClientIp(request);

    // Step 1 — cheap read-only pre-check. It refuses an obvious repeat offender without
    // spending a transaction, but it is NOT the enforcement point: a concurrent burst can all
    // pass it before any row exists, which is exactly what M-R2 measured (30 simultaneous
    // wrong-password requests, 30 real guesses).
    const preCheck = await checkLoginRateLimit(suppliedIdentifier, clientIp);
    if (!preCheck.allowed) {
      return rateLimitResponse(preCheck);
    }

    // Step 2 — resolve the account. Search by email first, then by username. Both reads go
    // through findAuthUser so that a database without drizzle/0006 (users.username) can still
    // sign people in - previously the `select()` picked every schema column and login itself threw.
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

    // M-R3: one account, ONE budget. The supplied identifier comes first (it is the one
    // recorded, so the spraying budget still counts distinct supplied identities); every other
    // alias of the resolved account joins the count, so an account reachable by both email and
    // username can no longer be guessed twice over. For an unknown account the supplied
    // identifier is all we have, and it stays protected exactly as before.
    const aliases = user
      ? [suppliedIdentifier, user.email, user.username]
      : [suppliedIdentifier];

    // Step 3 — enforce and record atomically, BEFORE the password is verified (M-R2). The
    // attempt is inserted under a PostgreSQL advisory lock and the budgets are re-decided on a
    // count that already includes it, so a concurrent burst cannot all slip past step 1. The row
    // is provisional: a correct password deletes it below, a wrong one leaves it as the record.
    const attempt = await recordFailedLoginAttempt(aliases, clientIp);
    if (!attempt.allowed) {
      // 429 when a budget is exhausted, 503 when the throttle could not be evaluated.
      return rateLimitResponse(attempt.decision);
    }
    if (!attempt.recorded) {
      // Defence in depth: an allowed-but-unstored attempt would leave the throttle blind.
      return degradedThrottleResponse();
    }

    // Step 4 — outcome. Nothing further is recorded here: the attempt is already stored, and
    // only a success removes it.
    if (!user) {
      return errorResponse(INVALID_LOGIN_MESSAGE, 401);
    }

    if (!user.isActive) {
      // Counted as a failed attempt on purpose: deactivated accounts are a favourite
      // enumeration target, so those guesses should consume the source IP budget too. The
      // provisional row above is that record — this branch must not add a second one.
      return errorResponse(INVALID_LOGIN_MESSAGE, 401);
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      // Same here: the wrong password is already counted, and counting it twice would halve
      // the effective budget.
      return errorResponse(INVALID_LOGIN_MESSAGE, 401);
    }

    // Successful login — release only *this account's* recorded failures, under every alias it
    // can be reached by (H-R1 + M-R3). Clearing by source IP as well would let anyone holding
    // one valid credential wipe another account's pending failures from the same NAT, making
    // the throttle repeatable to bypass; see clearFailedLoginAttempts.
    await clearFailedLoginAttempts(aliases, clientIp);

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
