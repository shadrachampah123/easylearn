import { db, pool } from "@/db";
import { loginAttempts } from "@/db/schema";
import { inArray, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
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
 * Three further findings from the same independent review are fixed here:
 *
 *  - **M-R1 — the source address is taken from a declared trust position, not from the
 *    leftmost forwarded entry.** `x-forwarded-for` is a chain every proxy appends to, so its
 *    first element is whatever the *client* wrote. See `getClientIp`.
 *  - **M-R2 — the attempt is recorded atomically with the decision.** The check used to run
 *    before the record with nothing serialising them, so a concurrent burst all saw the same
 *    empty table: 30 parallel wrong-password requests from one IP produced 30 real guesses
 *    against a budget of 5. `recordFailedLoginAttempt` now inserts inside a transaction that
 *    holds a PostgreSQL advisory lock and re-decides on the count *including* that insert, so
 *    the budget cannot be outrun by concurrency.
 *  - **M-R3 — one account has one budget, however many aliases reach it.** The identifier used
 *    to be `email || username`, so an account with both was throttled twice over (10 guesses
 *    from one IP instead of 5, and twice the aggregate backstop). Every counting, recording and
 *    clearing function here now accepts an *alias set*; the caller resolves it from the user row.
 *
 * Deliberate non-goal: no role-specific thresholds. The account's role is not known
 * before the password is verified, and looking it up on every unauthenticated request
 * would create an oracle ("this email belongs to an admin") plus an extra query on the
 * hottest unauthenticated path. Protecting every account by attributing failures to
 * their *source* protects administrators too, without leaking anything.
 *
 * Trust boundary: the source address is only as trustworthy as the edge that sets it. On
 * Vercel `x-forwarded-for` is platform-set and single-valued, so the default trust position —
 * the rightmost entry, `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS=1` — is the client. If another proxy
 * is ever placed in front, declare it: raise the hop count, or point
 * `EASY_LEARN_CLIENT_IP_HEADER` at a header only the platform writes (for example
 * `x-vercel-forwarded-for` or `cf-connecting-ip`). Unlike the host/origin policy in
 * `src/lib/csrf.ts`, this cannot simply refuse the forwarded headers: a Next.js route handler
 * has no socket address, so without them there is no client IP at all — and an unattributable
 * source falls back to one shared bucket per identifier, which is stricter, not looser.
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
  /** True only when the attempt is committed to `login_attempts`. */
  recorded: boolean;
  /**
   * False when the attempt must NOT be let through to password verification: either a budget
   * was exhausted (M-R2 — decided *after* the insert, so concurrency cannot outrun it) or the
   * attempt could not be evaluated/stored at all. The caller refuses the login either way and
   * uses `decision.reason` to choose 429 (exhausted) or 503 (unavailable).
   */
  allowed: boolean;
  /** Always present: the throttle decision behind `allowed` (`reason: "none"` when allowed). */
  decision: RateLimitResult;
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
 * An operator-declared header that only the edge platform writes, used *exclusively* when
 * set — for example `x-vercel-forwarded-for` or `cf-connecting-ip`. Read as a single value;
 * no chain parsing, because a platform-set header has exactly one.
 */
export const CLIENT_IP_HEADER_ENV = "EASY_LEARN_CLIENT_IP_HEADER";

/**
 * How many proxies between the client and this application append to `x-forwarded-for`.
 * `1` (the default) means "the entry nearest to me was written by a hop I trust", which is
 * what Vercel guarantees: it overwrites the header with the client address, so the chain has
 * one element. Raise it only for a deployment that genuinely sits behind more than one
 * appending proxy, and never above the number of proxies you control.
 */
export const CLIENT_IP_TRUSTED_HOPS_ENV = "EASY_LEARN_CLIENT_IP_TRUSTED_HOPS";

const DEFAULT_CLIENT_IP_TRUSTED_HOPS = 1;
/** A sane ceiling: a longer chain is not something this application should reason about. */
const MAX_CLIENT_IP_TRUSTED_HOPS = 8;

function clientIpTrustedHops(): number {
  const raw = Number.parseInt((process.env[CLIENT_IP_TRUSTED_HOPS_ENV] ?? "").trim(), 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CLIENT_IP_TRUSTED_HOPS;
  return Math.min(raw, MAX_CLIENT_IP_TRUSTED_HOPS);
}

/**
 * Derive the client address every per-source budget is keyed on, or `null` when the request
 * carries nothing this deployment is configured to trust.
 *
 * **M-R1.** The pre-fix version scanned the chain for the *first syntactically valid* entry.
 * That is the leftmost one, and the leftmost element of `x-forwarded-for` is written by the
 * client: every proxy appends, so an attacker may prefix any address they like. On today's
 * Vercel deployment the platform overwrites the header and the attack does not land — but
 * nothing in the code enforced that assumption, and the moment an appending edge is added the
 * per-source budgets become decoration: an attacker rotates forged addresses, never fills a
 * per-source bucket, and 15 requests × 15 forged addresses trip the account-wide backstop,
 * which is exactly the administrator lockout H-1 was meant to remove.
 *
 * The trust position is now explicit, in order:
 *
 *   1. `EASY_LEARN_CLIENT_IP_HEADER`, when configured, is authoritative and used
 *      **exclusively**. A missing or unusable value yields `null` rather than falling back to
 *      a header the client can write: the operator declared where the truth is.
 *   2. Otherwise the entry `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS` positions from the **end** of
 *      the `x-forwarded-for` chain (default 1 ⇒ rightmost ⇒ what the nearest trusted hop saw).
 *      Entries further left are closer to the client and are never consulted, not even when
 *      the trusted position holds junk.
 *   3. Only then the platform-set single-value headers: `x-vercel-forwarded-for` (consulted
 *      only when actually running on Vercel, where the platform writes it) and `x-real-ip`.
 *
 * `null` is the safe outcome: `decide` then buckets by identifier alone
 * (`ip_address IS NULL`), which is *stricter* than a per-source budget, and `normalizeLoginIp`
 * keeps such values inside the `varchar(50)` column.
 */
export function getClientIp(request: Request): string | null {
  const headers = request.headers;

  const configured = (process.env[CLIENT_IP_HEADER_ENV] ?? "").trim().toLowerCase();
  if (configured) return normalizeLoginIp(headers.get(configured));

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const trustedIndex = chain.length - clientIpTrustedHops();
    if (trustedIndex >= 0) {
      const ip = normalizeLoginIp(chain[trustedIndex]);
      // Deliberately NOT scanning left when the trusted position is unusable: everything
      // further left is closer to the client, i.e. attacker-controlled.
      if (ip) return ip;
    }
  }

  if (process.env.VERCEL) {
    const vercelForwarded = normalizeLoginIp(headers.get("x-vercel-forwarded-for"));
    if (vercelForwarded) return vercelForwarded;
  }

  return normalizeLoginIp(headers.get("x-real-ip"));
}

// ── Counting ─────────────────────────────────────────────────────────────────────

/** Anything that can run one parameterised statement: the pool, or a client in a transaction. */
type SqlRunner = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const runOnPool: SqlRunner = (text, params) => pool.query(text, params);

/**
 * One round trip, three buckets. Every count is restricted to the sliding window by the outer
 * WHERE, and the FILTER clauses split that same row set into:
 *
 *  - source:      failures from this address against any identifier (spraying signal),
 *  - pair:        failures for any alias of this account from this address (the 5-attempt budget),
 *  - identifier:  failures for any alias of this account from anywhere (the aggregate backstop).
 *
 * This is raw SQL on purpose: the *same* statement must serve the read-only pre-check
 * (`pool.query`) and the enforcing record (`client.query` inside an advisory-lock transaction,
 * M-R2). Two copies of a security-critical count is exactly how the two paths drift apart, and
 * Drizzle's builder cannot be shared between the database handle and a transaction handle
 * without widening types.
 *
 * `$1` is the **alias set** (M-R3): an account reachable by email *and* username gets one
 * budget, not one per alias. `ip_address IS NOT DISTINCT FROM $2` keeps the pair bucket
 * meaningful when the source is unattributable (`$2` NULL): those attempts share one bucket per
 * account, which is the pre-2026-11-19 behaviour.
 */
const COUNT_RECENT_FAILURES_SQL = `
  SELECT
    count(*) FILTER (WHERE ip_address = $2::text)                          AS source_total,
    count(DISTINCT identifier) FILTER (WHERE ip_address = $2::text)        AS source_identifiers,
    max(created_at) FILTER (WHERE ip_address = $2::text)                   AS source_latest,
    count(*) FILTER (WHERE identifier = ANY($1::text[])
                       AND ip_address IS NOT DISTINCT FROM $2::text)       AS pair_total,
    max(created_at) FILTER (WHERE identifier = ANY($1::text[])
                       AND ip_address IS NOT DISTINCT FROM $2::text)       AS pair_latest,
    count(*) FILTER (WHERE identifier = ANY($1::text[]))                   AS identifier_total,
    count(DISTINCT ip_address) FILTER (WHERE identifier = ANY($1::text[])) AS identifier_sources,
    max(created_at) FILTER (WHERE identifier = ANY($1::text[]))            AS identifier_latest
  FROM login_attempts
  WHERE created_at >= $3
    AND (identifier = ANY($1::text[])
         OR ($2::text IS NOT NULL AND ip_address = $2::text))
`;

async function countRecentFailures(
  run: SqlRunner,
  aliases: string[],
  ip: string | null
): Promise<ThrottleCounts> {
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
  const result = await run(COUNT_RECENT_FAILURES_SQL, [aliases, ip, windowStart]);
  const row = result.rows[0] ?? {};
  return {
    sourceTotal: Number(row.source_total ?? 0),
    sourceIdentifiers: Number(row.source_identifiers ?? 0),
    sourceLatest: toDate(row.source_latest),
    pairTotal: Number(row.pair_total ?? 0),
    pairLatest: toDate(row.pair_latest),
    identifierTotal: Number(row.identifier_total ?? 0),
    identifierSources: Number(row.identifier_sources ?? 0),
    identifierLatest: toDate(row.identifier_latest),
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
 * Apply the three budgets, most specific first. A cooldown whose expiry has already passed is
 * not a block: the attempt still counts towards `remainingAttempts`, and the next recorded
 * failure re-arms the cooldown from its own timestamp.
 *
 * `countedSelf` is set by the enforcing recorder (M-R2), which counts *after* inserting the
 * very attempt it is deciding on. Each budget then gets one extra unit of headroom, so the
 * observable limit is identical on both paths: five recorded failures allow five guesses and
 * refuse the sixth, whether the count was taken before the insert (the read-only pre-check) or
 * after it (the atomic enforcement inside the advisory lock).
 */
function decide(
  counts: ThrottleCounts,
  ip: string | null,
  options?: { countedSelf?: boolean }
): RateLimitResult {
  const now = Date.now();
  const self = options?.countedSelf ? 1 : 0;

  if (ip !== null) {
    const sourceExhausted =
      counts.sourceTotal >= MAX_ATTEMPTS_PER_IP + self ||
      counts.sourceIdentifiers >= MAX_IDENTIFIERS_PER_IP + self;
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

  if (counts.pairTotal >= MAX_ATTEMPTS + self) {
    const blockedUntil = cooldownFrom(counts.pairLatest, BLOCK_MINUTES);
    if (blockedUntil.getTime() > now) {
      return blocked("identifier_source", blockedUntil, "Too many failed login attempts.");
    }
  }

  if (counts.identifierTotal >= MAX_ATTEMPTS_PER_IDENTIFIER + self) {
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
      MAX_ATTEMPTS + self - counts.pairTotal,
      MAX_ATTEMPTS_PER_IDENTIFIER + self - counts.identifierTotal,
      ip === null ? Number.MAX_SAFE_INTEGER : MAX_ATTEMPTS_PER_IP + self - counts.sourceTotal
    )
  );

  return { allowed: true, remainingAttempts: remaining, reason: "none" };
}

/** The fail-closed decision, without logging: callers that log their own line use this. */
function unavailableDecision(): RateLimitResult {
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

function rateLimitUnavailable(error: unknown): RateLimitResult {
  console.error(
    "[rate-limit] could not evaluate the login throttle — FAILING CLOSED, login refused:",
    inspectDbError(error).text
  );
  return unavailableDecision();
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
 * Normalize an **alias set**: every identifier one account can be reached by (M-R3).
 *
 * Accepts a single identifier or an array. Empties are dropped, values are de-duplicated, and
 * the caller's order is preserved — element 0 is the identifier the client actually supplied,
 * which is the one recorded, so the credential-spraying budget still counts distinct *supplied*
 * identities rather than the account behind them.
 */
function normalizeAliases(identifier: string | string[]): string[] {
  const supplied = Array.isArray(identifier) ? identifier : [identifier];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const entry of supplied) {
    const normalized = normalizeIdentifier(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}

/**
 * Read-only pre-check: is this login attempt allowed?
 *
 * DB-backed so it works across Vercel instances, and **fails closed**: if the check cannot be
 * evaluated the attempt is refused for `UNAVAILABLE_RETRY_SECONDS`, because the alternative
 * (the pre-2026-11-19 behaviour) handed out unlimited guesses whenever the database had a
 * problem.
 *
 * This is a *filter*, not the enforcement point. It reads without a lock, so concurrent
 * requests can all see the same stale counts — that is M-R2, and it is why the route calls
 * `recordFailedLoginAttempt` (which re-decides atomically) before verifying any password.
 * Keeping this cheap read first means a blocked repeat offender costs one SELECT and no write.
 *
 * `identifier` may be an alias set: pass every identifier the resolved account is reachable by
 * so email and username share one budget (M-R3).
 */
export async function checkLoginRateLimit(
  identifier: string | string[],
  ipAddress?: string | null
): Promise<RateLimitResult> {
  const aliases = normalizeAliases(identifier);
  const ip = normalizeLoginIp(ipAddress);
  // No identifier means nothing to attribute the attempt to. Fail closed rather than guess.
  if (aliases.length === 0) return rateLimitUnavailable(new Error("no identifier supplied"));

  const count = () => countRecentFailures(runOnPool, aliases, ip);
  try {
    return decide(await count(), ip);
  } catch (error) {
    if (await repairLoginAttemptSchema(error)) {
      try {
        return decide(await count(), ip);
      } catch (retryError) {
        return rateLimitUnavailable(retryError);
      }
    }
    return rateLimitUnavailable(error);
  }
}

/** Advisory locks are keyed by bigint; a fixed seed maps the same text to the same lock. */
const ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))";
const INSERT_ATTEMPT_SQL =
  "INSERT INTO login_attempts (identifier, ip_address) VALUES ($1, $2) RETURNING id";

/**
 * Record a login attempt **and** enforce the budgets in the same atomic step (M-R2).
 *
 * Call this *before* verifying the password. It inserts the attempt inside a transaction that
 * holds PostgreSQL advisory locks, then re-decides on a count that already includes the row it
 * just wrote:
 *
 *   - `allowed: true`  → the row is committed. It is a *provisional* failure: the caller
 *                        deletes it via `clearFailedLoginAttempts` if the password turns out to
 *                        be correct, and leaves it if not.
 *   - `allowed: false` → the transaction is rolled back, so a refused attempt never extends its
 *                        own cooldown. `decision.reason` distinguishes an exhausted budget
 *                        (429) from an unevaluable one (503).
 *
 * Why the insert has to come first: the previous shape checked, then verified the password,
 * then recorded. Nothing serialised those three steps, so a concurrent burst all read the same
 * empty table and all got a real guess — measured at **30 concurrent wrong-password requests
 * from one IP producing 30 guesses against a budget of 5**. Because enforcement now happens
 * before the hash is computed, concurrency cannot buy extra guesses; the password check (the
 * expensive part, bcrypt cost 12) stays *outside* the transaction, so locks are held for two
 * short statements and never across a hash.
 *
 * Two locks are taken, always in the same order — source, then account — so concurrent attempts
 * can never form a wait cycle. The source lock makes the per-source and (account, source)
 * budgets race-free; the account lock additionally makes the account-wide aggregate race-free
 * across sources. When the source is unattributable the first key falls back to the identifier.
 *
 * `identifier` may be an alias set (M-R3): the supplied identifier is recorded, while the count
 * covers every alias of the same account.
 */
export async function recordFailedLoginAttempt(
  identifier: string | string[],
  ipAddress?: string | null,
  retry = 0
): Promise<LoginAttemptRecordResult> {
  const aliases = normalizeAliases(identifier);
  const ip = normalizeLoginIp(ipAddress);
  if (aliases.length === 0) {
    return recordFailure(new Error("no identifier supplied"));
  }

  const primary = aliases[0];
  const lockKeys = [
    ip === null ? `identifier:${primary}` : `source:${ip}`,
    `account:${[...aliases].sort().join("|")}`,
  ];

  let client: PoolClient | null = null;
  let outcome: LoginAttemptRecordResult;
  let repairCandidate: unknown = null;

  try {
    client = await pool.connect();
    const run: SqlRunner = (text, params) => client!.query(text, params);

    await client.query("BEGIN");
    for (const key of lockKeys) await client.query(ADVISORY_LOCK_SQL, [key]);

    await run(INSERT_ATTEMPT_SQL, [primary, ip]);
    const decision = decide(await countRecentFailures(run, aliases, ip), ip, { countedSelf: true });

    if (!decision.allowed) {
      await client.query("ROLLBACK");
      outcome = { recorded: false, allowed: false, decision };
    } else {
      await client.query("COMMIT");
      outcome = { recorded: true, allowed: true, decision };
    }
  } catch (error) {
    repairCandidate = error;
    outcome = recordFailure(error);
    try {
      await client?.query("ROLLBACK");
    } catch {
      // The connection is already unusable; releasing it below is what matters.
    }
  } finally {
    client?.release();
    client = null;
  }

  /* Repair and prune only *after* the connection is back in the pool: both need one of their
     own, and Production allows just two. Holding a connection while waiting for another could
     stall a saturated pool. */
  if (repairCandidate !== null && retry === 0 && (await repairLoginAttemptSchema(repairCandidate))) {
    return recordFailedLoginAttempt(identifier, ipAddress, retry + 1);
  }
  if (outcome.recorded) await pruneExpiredAttempts();
  return outcome;
}

function recordFailure(error: unknown): LoginAttemptRecordResult {
  const reason = inspectDbError(error).text;
  console.error(
    "[rate-limit] could NOT record a failed login attempt — throttling is degraded for this request:",
    reason
  );
  return { recorded: false, allowed: false, decision: unavailableDecision(), reason };
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
 * Clear the failed attempts recorded for **one account** after it authenticates.
 *
 * Scoped by account, never by source. Signing in proves the caller controls *that account*, so
 * it releases that account's own recorded failures — including the rows it wrote from this IP,
 * which lowers the whole-source budget by exactly the rows removed, and including every alias of
 * the account, so a success via email also releases the budget consumed via username (M-R3).
 *
 * It must never release failures recorded for **other** accounts that share the source IP. That
 * wider `OR ip_address = $2` DELETE was the behaviour before the H-R1 fix, added so a school
 * behind one NAT would get its whole-source budget back on a successful sign-in. Independent
 * security review (**H-R1**, 2026-11-19) measured it as a throttle-reset oracle: anyone holding
 * one valid low-privilege credential could sign in from the school's exit IP and erase every
 * failure an attacker had accumulated against administrator accounts, which made the guess
 * budget *repeatable* rather than bounded — 108 unthrottled guesses across three sign-in cycles
 * in the reproducing probe, with the victim's pair bucket returning to a full budget after every
 * cycle. It also deleted the rows the account-wide aggregate backstop counts.
 *
 * The NAT concern stays covered without it: the source budget is deliberately generous
 * (`MAX_ATTEMPTS_PER_IP` failures / `MAX_IDENTIFIERS_PER_IP` identifiers per window) and it
 * self-heals as rows age out of the sliding window.
 *
 * `ipAddress` is accepted so existing call sites keep their shape and is used only to attribute
 * the reset in the log — it can never widen the DELETE.
 *
 * A failure here is logged but never blocks the login: the user has already authenticated, and
 * stale rows only make throttling stricter.
 */
export async function clearFailedLoginAttempts(
  identifier: string | string[],
  ipAddress?: string | null
): Promise<void> {
  const aliases = normalizeAliases(identifier);
  const source = normalizeLoginIp(ipAddress);
  if (aliases.length === 0) return;
  try {
    await db.delete(loginAttempts).where(inArray(loginAttempts.identifier, aliases));
    console.log(
      `[rate-limit] released recorded failures for ${aliases.length} alias(es) of one account ` +
        `after a successful login ` +
        (source === null ? "from an unattributable source" : `from ${source}`)
    );
  } catch (error) {
    console.error("[rate-limit] could not clear login attempts:", inspectDbError(error).text);
  }
}
