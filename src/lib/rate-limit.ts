import { db } from "@/db";
import { loginAttempts } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { ensureLoginAttemptSchema, inspectDbError, isMissingRelation } from "@/lib/schema-resilience";

/**
 * Login brute-force protection.
 *
 * Remediated 2026-11-19 for production-audit finding **H-1**, which had three parts:
 *
 *  1. **It failed open.** Any database error inside `checkLoginRateLimit` returned
 *     `{ allowed: true }`, so an attacker who could make one query fail (a missing
 *     `login_attempts` table, a connection blip, or — see `normalizeLoginIp` — a
 *     header-injected value too long for `ip_address varchar(50)`, which made the
 *     *insert* fail instead) got unlimited password guesses. Every failure path here
 *     now **fails closed**: the login is refused with a short retry window, and the
 *     reason is logged. Failing closed costs no availability in practice, because a
 *     database that cannot answer the throttle query cannot answer the user lookup
 *     either.
 *  2. **The client IP was recorded but never limited.** `getClientIp` existed only to
 *     fill the `ip_address` column. Throttling is now layered per source as well as per
 *     account (see the three buckets in `decide`).
 *  3. **Anyone could lock anyone out.** Because the only bucket was "identifier", five
 *     failed guesses from one attacker locked that account for everybody for 30 minutes
 *     — including administrator accounts, which is a trivially exploitable denial of
 *     service. The five-attempt budget is now scoped to **(identifier, source IP)**, so
 *     an attacker locks *themselves* out of that account, not the legitimate owner. The
 *     account-wide bucket survives only as a much higher aggregate backstop against
 *     genuinely distributed guessing, with a shorter cooldown.
 *
 * Corrected the same day after independent security review (**H-R1**): a successful login
 * now releases only the failures recorded for *that identifier*. The first version of this
 * remediation also deleted every row sharing the source IP, which turned one valid
 * low-privilege credential into a repeatable throttle-reset oracle against other accounts.
 * See `clearFailedLoginAttempts` for the measured impact.
 *
 * Deliberate non-goal: no role-specific thresholds. The account's role is not known
 * before the password is verified, and looking it up on every unauthenticated request
 * would create an oracle ("this email belongs to an admin") plus an extra query on the
 * hottest unauthenticated path. Protecting every account by attributing failures to
 * their *source* protects administrators too, without leaking anything.
 *
 * Trust boundary: the source IP is only as trustworthy as the edge platform that sets
 * `x-forwarded-for` / `x-real-ip`. On Vercel those are platform-set. If this app is ever
 * deployed behind a proxy that *appends* to an attacker-supplied `x-forwarded-for`
 * instead of replacing it, the derived IP is client-controlled and the per-source buckets
 * degrade to per-account-only protection; the aggregate backstop still applies.
 */

// ── Configuration ────────────────────────────────────────────────────────────────

/** Failed attempts allowed for one identifier **from one source IP** inside the window. */
export const MAX_ATTEMPTS = 5;
/** Sliding window used by every bucket, in minutes. */
export const WINDOW_MINUTES = 15;
/** Cooldown after `MAX_ATTEMPTS` is exceeded for one (identifier, source IP) pair. */
export const BLOCK_MINUTES = 30;

/**
 * Whole-source budget: total failed logins from one IP against *any* account inside the
 * window. Set well above what a school NAT plausibly produces by mistyping, because
 * tripping it blocks a whole building.
 */
export const MAX_ATTEMPTS_PER_IP = 40;
/**
 * Credential-spraying budget: how many *distinct* identifiers one IP may fail against
 * inside the window. This is the high-signal rule — legitimate users get their own
 * password wrong, they do not get ten different people's passwords wrong.
 */
export const MAX_IDENTIFIERS_PER_IP = 10;
/** Cooldown applied to a source IP that trips either source-level budget. */
export const IP_BLOCK_MINUTES = 15;

/**
 * Account-wide backstop. Only reachable by an attacker using at least
 * `MAX_ATTEMPTS / 1` … in practice ≥3 distinct IPs (one IP is stopped by `MAX_ATTEMPTS`),
 * so a single attacker can no longer lock an administrator out. Kept because without it a
 * distributed attacker would get unlimited guesses against one account.
 */
export const MAX_ATTEMPTS_PER_IDENTIFIER = 15;
/** Cooldown for the account-wide backstop — shorter than the scoped block on purpose. */
export const IDENTIFIER_BLOCK_MINUTES = 15;

/** Rows older than this are pruned on every recorded failure (keeps the table small). */
export const ATTEMPT_RETENTION_MINUTES = 60;
/** How long a login is refused when the throttle itself cannot be evaluated. */
export const UNAVAILABLE_RETRY_SECONDS = 60;

/**
 * Shared client-facing wording for "the throttle could not be evaluated / the failure could
 * not be stored". Exported so the login route answers identically for both degraded paths
 * instead of drifting into a second message.
 */
export const RATE_LIMIT_UNAVAILABLE_MESSAGE =
  "Sign-in protection is temporarily unavailable, so login is paused. Please try again in about a minute.";

/**
 * Legacy sentinel returned by `getClientIp` before 2026-11-19. It is still accepted on
 * input (old rows and old callers) but is treated as "no attributable source", and it is
 * never written to the database again.
 */
export const UNKNOWN_IP = "unknown";

/** Column limits — an over-long value would make the INSERT fail, which used to mean
 *  "attempt not recorded", i.e. fail-open. Values are normalized to fit instead. */
const IDENTIFIER_MAX_LENGTH = 255; // login_attempts.identifier varchar(255)
const IP_MAX_LENGTH = 45; // longest legal IPv6 text form; column is varchar(50)

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export type RateLimitReason =
  | "none"
  /** (identifier, source IP) pair exhausted `MAX_ATTEMPTS`. */
  | "identifier_source"
  /** Account-wide backstop exhausted `MAX_ATTEMPTS_PER_IDENTIFIER`. */
  | "identifier_total"
  /** The source IP exhausted a source-level budget. */
  | "source_total"
  /** The throttle could not be evaluated; the login was refused to stay safe. */
  | "unavailable";

export interface RateLimitResult {
  allowed: boolean;
  remainingAttempts: number;
  blockedUntil?: Date;
  message?: string;
  /** Why the decision was made. Used by the caller to pick a status code and by tests. */
  reason: RateLimitReason;
  /** Seconds the client should wait; suitable for a `Retry-After` header. */
  retryAfterSeconds?: number;
}

export interface LoginAttemptRecordResult {
  /** False means the failure was NOT stored, so the throttle is blind to it. */
  recorded: boolean;
  /** Sanitized database error text for logs; never contains the password. */
  reason?: string;
}

interface ThrottleCounts {
  sourceTotal: number;
  sourceIdentifiers: number;
  sourceLatest: Date | null;
  pairTotal: number;
  pairLatest: Date | null;
  identifierTotal: number;
  identifierSources: number;
  identifierLatest: Date | null;
}

// ── Normalization ────────────────────────────────────────────────────────────────

/** Lower-case, trim and length-cap the identifier so it always fits the column. */
function normalizeIdentifier(identifier: string): string {
  return String(identifier ?? "")
    .trim()
    .toLowerCase()
    .slice(0, IDENTIFIER_MAX_LENGTH);
}

/**
 * Turn a raw header value into a storable IP, or `null` when it is not one.
 *
 * Returning `null` instead of junk matters twice over: it keeps the value inside
 * `varchar(50)` (an over-long value used to make the INSERT throw, which silently
 * disabled throttling for that attacker), and it prevents one shared pseudo-source such
 * as `"unknown"` from becoming a bucket that locks out every unattributable user.
 */
export function normalizeLoginIp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  if (!candidate || candidate === UNKNOWN_IP || candidate.length > IP_MAX_LENGTH) return null;

  const ipv4 = IPV4_PATTERN.exec(candidate);
  if (ipv4) {
    return ipv4.slice(1).every((octet) => Number(octet) <= 255) ? candidate : null;
  }

  // IPv6 (including IPv4-mapped ::ffff:192.0.2.1). Deliberately permissive about form
  // but strict about the character set, so a header can never smuggle SQL or newline junk
  // into the column.
  const colons = candidate.split(":").length - 1;
  if (colons >= 2 && /^[0-9a-f:.]+$/.test(candidate)) return candidate;

  return null;
}

/**
 * Derive the client IP from the request, or `null` when no trustworthy value is present.
 *
 * `x-forwarded-for` is read first for continuity with the pre-2026-11-19 behaviour, but
 * the list is now scanned for the first *syntactically valid* address rather than blindly
 * taking the leftmost token, and invalid values fall through to `x-real-ip`.
 */
export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    for (const candidate of forwarded.split(",")) {
      const ip = normalizeLoginIp(candidate);
      if (ip) return ip;
    }
  }
  return normalizeLoginIp(request.headers.get("x-real-ip"));
}

// ── Counting ─────────────────────────────────────────────────────────────────────

/**
 * One round trip, three buckets. Every count is restricted to the sliding window by the
 * outer WHERE, and the FILTER clauses split that same row set into:
 *
 *  - source:      failures from this IP against any identifier (spraying signal),
 *  - pair:        failures for this identifier from this IP (the five-attempt budget),
 *  - identifier:  failures for this identifier from anywhere (the aggregate backstop).
 *
 * `ip_address IS NOT DISTINCT FROM $ip` keeps the pair bucket meaningful when the source
 * is unattributable (`$ip` is NULL): those attempts share one bucket per identifier,
 * which is exactly the pre-2026-11-19 behaviour.
 */
async function countRecentFailures(identifier: string, ip: string | null): Promise<ThrottleCounts> {
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

  const rows = await db
    .select({
      sourceTotal: sql<string>`count(*) FILTER (WHERE ${loginAttempts.ipAddress} = ${ip}::text)`,
      sourceIdentifiers: sql<string>`count(DISTINCT ${loginAttempts.identifier}) FILTER (WHERE ${loginAttempts.ipAddress} = ${ip}::text)`,
      sourceLatest: sql<Date | null>`max(${loginAttempts.createdAt}) FILTER (WHERE ${loginAttempts.ipAddress} = ${ip}::text)`,
      pairTotal: sql<string>`count(*) FILTER (WHERE ${loginAttempts.identifier} = ${identifier} AND ${loginAttempts.ipAddress} IS NOT DISTINCT FROM ${ip}::text)`,
      pairLatest: sql<Date | null>`max(${loginAttempts.createdAt}) FILTER (WHERE ${loginAttempts.identifier} = ${identifier} AND ${loginAttempts.ipAddress} IS NOT DISTINCT FROM ${ip}::text)`,
      identifierTotal: sql<string>`count(*) FILTER (WHERE ${loginAttempts.identifier} = ${identifier})`,
      identifierSources: sql<string>`count(DISTINCT ${loginAttempts.ipAddress}) FILTER (WHERE ${loginAttempts.identifier} = ${identifier})`,
      identifierLatest: sql<Date | null>`max(${loginAttempts.createdAt}) FILTER (WHERE ${loginAttempts.identifier} = ${identifier})`,
    })
    .from(loginAttempts)
    .where(
      sql`${loginAttempts.createdAt} >= ${windowStart}
           AND (${loginAttempts.identifier} = ${identifier}
                OR (${ip}::text IS NOT NULL AND ${loginAttempts.ipAddress} = ${ip}::text))`
    );

  const row = rows[0] ?? {};
  return {
    sourceTotal: Number(row.sourceTotal ?? 0),
    sourceIdentifiers: Number(row.sourceIdentifiers ?? 0),
    sourceLatest: toDate(row.sourceLatest),
    pairTotal: Number(row.pairTotal ?? 0),
    pairLatest: toDate(row.pairLatest),
    identifierTotal: Number(row.identifierTotal ?? 0),
    identifierSources: Number(row.identifierSources ?? 0),
    identifierLatest: toDate(row.identifierLatest),
  };
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function cooldownFrom(latest: Date | null, minutes: number): Date {
  const base = latest ? latest.getTime() : Date.now();
  return new Date(base + minutes * 60 * 1000);
}

function blocked(
  reason: RateLimitReason,
  blockedUntil: Date,
  message: string
): RateLimitResult {
  const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil.getTime() - Date.now()) / 1000));
  return {
    allowed: false,
    remainingAttempts: 0,
    blockedUntil,
    retryAfterSeconds,
    reason,
    message: `${message} Please try again after ${blockedUntil.toLocaleTimeString()}.`,
  };
}

/**
 * Apply the three budgets, most specific first. A cooldown whose expiry has already
 * passed is not a block: the attempt still counts towards `remainingAttempts`, and the
 * next recorded failure re-arms the cooldown from its own timestamp.
 */
function decide(counts: ThrottleCounts, ip: string | null): RateLimitResult {
  const now = Date.now();

  if (ip !== null) {
    const sourceExhausted =
      counts.sourceTotal >= MAX_ATTEMPTS_PER_IP || counts.sourceIdentifiers >= MAX_IDENTIFIERS_PER_IP;
    if (sourceExhausted) {
      const blockedUntil = cooldownFrom(counts.sourceLatest, IP_BLOCK_MINUTES);
      if (blockedUntil.getTime() > now) {
        console.warn(
          `[rate-limit] source ${ip} throttled: ${counts.sourceTotal} failed logins across ` +
            `${counts.sourceIdentifiers} identifiers in ${WINDOW_MINUTES}m`
        );
        return blocked(
          "source_total",
          blockedUntil,
          "Too many failed login attempts from this network."
        );
      }
    }
  }

  if (counts.pairTotal >= MAX_ATTEMPTS) {
    const blockedUntil = cooldownFrom(counts.pairLatest, BLOCK_MINUTES);
    if (blockedUntil.getTime() > now) {
      return blocked("identifier_source", blockedUntil, "Too many failed login attempts.");
    }
  }

  if (counts.identifierTotal >= MAX_ATTEMPTS_PER_IDENTIFIER) {
    const blockedUntil = cooldownFrom(counts.identifierLatest, IDENTIFIER_BLOCK_MINUTES);
    if (blockedUntil.getTime() > now) {
      // Distributed-guessing signal: worth an operator's attention, which is why the
      // distinct-source count is logged even though the client message stays generic
      // (the same text as the scoped block, so the response leaks no bucket detail).
      console.warn(
        `[rate-limit] account-wide throttle reached for an identifier: ${counts.identifierTotal} failures ` +
          `from ${counts.identifierSources} distinct source(s) in ${WINDOW_MINUTES}m`
      );
      return blocked("identifier_total", blockedUntil, "Too many failed login attempts.");
    }
  }

  const remaining = Math.max(
    0,
    Math.min(
      MAX_ATTEMPTS - counts.pairTotal,
      MAX_ATTEMPTS_PER_IDENTIFIER - counts.identifierTotal,
      ip === null ? Number.MAX_SAFE_INTEGER : MAX_ATTEMPTS_PER_IP - counts.sourceTotal
    )
  );

  return { allowed: true, remainingAttempts: remaining, reason: "none" };
}

function rateLimitUnavailable(error: unknown): RateLimitResult {
  console.error(
    "[rate-limit] could not evaluate the login throttle — FAILING CLOSED, login refused:",
    inspectDbError(error).text
  );
  const blockedUntil = new Date(Date.now() + UNAVAILABLE_RETRY_SECONDS * 1000);
  return {
    allowed: false,
    remainingAttempts: 0,
    blockedUntil,
    retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
    reason: "unavailable",
    message: RATE_LIMIT_UNAVAILABLE_MESSAGE,
  };
}

/**
 * Self-heal a missing `login_attempts` relation (drizzle/0012 never applied) so an
 * un-migrated database becomes *throttled* instead of unprotected. Returns false for
 * every other error — a dead connection must not trigger a second round of queries.
 */
async function repairLoginAttemptSchema(error: unknown): Promise<boolean> {
  if (!isMissingRelation(error)) return false;
  const status = await ensureLoginAttemptSchema();
  if (status.available) {
    console.warn(
      `[rate-limit] login_attempts was missing; ${status.migration} has been auto-applied so login throttling stays active.`
    );
  } else {
    console.error(
      `[rate-limit] login_attempts is still unavailable (${status.migration}). Login throttling fails closed until it is applied.`
    );
  }
  return status.available;
}

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * Check whether a login attempt is allowed.
 *
 * DB-backed so it works across Vercel instances. **Fails closed**: if the check cannot be
 * evaluated the attempt is refused for `UNAVAILABLE_RETRY_SECONDS`, because the alternative
 * (the pre-2026-11-19 behaviour) handed out unlimited guesses whenever the database had a
 * problem.
 */
export async function checkLoginRateLimit(
  identifier: string,
  ipAddress?: string | null
): Promise<RateLimitResult> {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const ip = normalizeLoginIp(ipAddress);

  try {
    return decide(await countRecentFailures(normalizedIdentifier, ip), ip);
  } catch (error) {
    if (await repairLoginAttemptSchema(error)) {
      try {
        return decide(await countRecentFailures(normalizedIdentifier, ip), ip);
      } catch (retryError) {
        return rateLimitUnavailable(retryError);
      }
    }
    return rateLimitUnavailable(error);
  }
}

/**
 * Record a failed login attempt.
 *
 * Returns whether the attempt was actually stored. A `false` result means the throttle is
 * blind to this failure, and the caller must not continue as if the account were protected
 * — the login route answers 503 instead of 401 in that case. Never throws: the flow still
 * has to produce a response.
 */
export async function recordFailedLoginAttempt(
  identifier: string,
  ipAddress?: string | null
): Promise<LoginAttemptRecordResult> {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const ip = normalizeLoginIp(ipAddress);

  const insert = () =>
    db.insert(loginAttempts).values({ identifier: normalizedIdentifier, ipAddress: ip });

  try {
    await insert();
    await pruneExpiredAttempts();
    return { recorded: true };
  } catch (error) {
    if (await repairLoginAttemptSchema(error)) {
      try {
        await insert();
        await pruneExpiredAttempts();
        return { recorded: true };
      } catch (retryError) {
        return recordFailure(retryError);
      }
    }
    return recordFailure(error);
  }
}

function recordFailure(error: unknown): LoginAttemptRecordResult {
  const reason = inspectDbError(error).text;
  console.error(
    "[rate-limit] could NOT record a failed login attempt — throttling is degraded for this request:",
    reason
  );
  return { recorded: false, reason };
}

/**
 * Drop expired rows so the table stays small enough for the windowed counts to be cheap.
 * Bloat is an efficiency problem, not a security one, so a failure here is only logged.
 */
async function pruneExpiredAttempts(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ATTEMPT_RETENTION_MINUTES * 60 * 1000);
    await db.delete(loginAttempts).where(sql`${loginAttempts.createdAt} < ${cutoff}`);
  } catch (error) {
    console.warn("[rate-limit] could not prune expired login attempts:", inspectDbError(error).text);
  }
}

/**
 * Clear the failed attempts recorded for **one identifier** after it authenticates.
 *
 * Scoped by account, never by source. Signing in proves the caller controls *that
 * account*, so it releases that account's own recorded failures — including the rows it
 * wrote from this IP, which lowers the whole-source budget by exactly the rows removed.
 *
 * It must never release failures recorded for **other** accounts that share the source IP.
 * That wider `OR ip_address = $2` DELETE was the behaviour before this fix, added so a
 * school behind one NAT would get its whole-source budget back on a successful sign-in.
 * Independent security review (**H-R1**, 2026-11-19) measured it as a throttle-reset
 * oracle: anyone holding one valid low-privilege credential could sign in from the
 * school's exit IP and erase every failure an attacker had accumulated against
 * administrator accounts, which made the guess budget *repeatable* rather than bounded —
 * 108 unthrottled guesses across three sign-in cycles in the reproducing probe, with the
 * victim's pair bucket returning to a full budget after every cycle. It also deleted the
 * rows the account-wide aggregate backstop counts, defeating that layer too.
 *
 * The NAT concern stays covered without it: the source budget is deliberately generous
 * (`MAX_ATTEMPTS_PER_IP` failures / `MAX_IDENTIFIERS_PER_IP` identifiers per window) and
 * it self-heals as rows age out of the sliding window.
 *
 * `ipAddress` is accepted so existing call sites keep their shape and is used only to
 * attribute the reset in the log — it can never widen the DELETE.
 *
 * A failure here is logged but never blocks the login: the user has already authenticated,
 * and stale rows only make throttling stricter.
 */
export async function clearFailedLoginAttempts(
  identifier: string,
  ipAddress?: string | null
): Promise<void> {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const source = normalizeLoginIp(ipAddress);
  try {
    await db.delete(loginAttempts).where(eq(loginAttempts.identifier, normalizedIdentifier));
    console.log(
      `[rate-limit] released recorded failures for one identifier after a successful login ` +
        (source === null ? "from an unattributable source" : `from ${source}`)
    );
  } catch (error) {
    console.error("[rate-limit] could not clear login attempts:", inspectDbError(error).text);
  }
}
