/**
 * H-1 (login rate limiting) policy regression — no database required.
 *
 * Audit finding H-1 (2026-11-19) had three parts, and each one is pinned here so a
 * future refactor cannot quietly bring it back:
 *
 *   1. the throttle **failed open** — any database error returned `{ allowed: true }`,
 *      and an over-long `x-forwarded-for` value made the *insert* fail against
 *      `ip_address varchar(50)`, which was silently swallowed: unlimited guesses;
 *   2. the client IP was **recorded but never limited**;
 *   3. the only bucket was the identifier, so five guesses from one attacker **locked the
 *      account for everybody**, administrators included.
 *
 * The database-backed behaviour is asserted in tests/login-rate-limit-db.test.ts. This
 * suite covers what can be checked without a server: IP normalization (the real
 * fail-open vector), the fail-closed decision path's shape, and the cross-file contract
 * that keeps the self-heal DDL a superset of migration 0012.
 *
 * Run: npx tsx tests/login-rate-limit-policy.test.ts
 */
import assert from "assert";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.join(__dirname, "..");

function readFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed += 1;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${(error as Error).message}`);
      failed += 1;
    });
}

/* @/lib/rate-limit imports @/db, which throws at import time without a usable
   DATABASE_URL. A dummy local URL is enough here: pg.Pool connects lazily and this suite
   issues no queries. EASY_LEARN_TEST_DATABASE keeps the TLS policy from rejecting the
   loopback URL (the same combination `npm test` already uses for real-authorization). */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://policy:policy@127.0.0.1:5432/easylearn_policy_probe";
process.env.EASY_LEARN_TEST_DATABASE = "true";

/** Minimal stand-in for a Request: getClientIp only ever touches `headers.get`. */
function requestWithHeaders(headers: Record<string, string>): Request {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;
  return {
    headers: { get: (key: string) => lowered[String(key).toLowerCase()] ?? null },
  } as unknown as Request;
}

async function main() {
  const rateLimit = await import("@/lib/rate-limit");
  const { getClientIp, normalizeLoginIp } = rateLimit;

  /* ── 1. Source attribution: the fail-open vector ─────────────────────────────── */

  await test("getClientIp reads a single x-forwarded-for value", () => {
    assert.strictEqual(getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.7" })), "203.0.113.7");
  });

  await test("getClientIp takes the first entry of a proxy chain (unchanged behaviour)", () => {
    assert.strictEqual(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" })),
      "203.0.113.7"
    );
  });

  await test("getClientIp skips junk and falls back to the first valid entry", () => {
    assert.strictEqual(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "not-an-ip, 203.0.113.7" })),
      "203.0.113.7"
    );
  });

  await test("getClientIp falls back to x-real-ip when the chain holds nothing usable", () => {
    assert.strictEqual(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "junk", "x-real-ip": "198.51.100.4" })),
      "198.51.100.4"
    );
  });

  await test("getClientIp returns null when no source header is present", () => {
    assert.strictEqual(getClientIp(requestWithHeaders({})), null);
  });

  await test("an over-long x-forwarded-for value can no longer reach the varchar(50) column", () => {
    /* This is the concrete H-1 bypass: a 60-character value made the INSERT throw
       "value too long for type character varying(50)", recordFailedLoginAttempt swallowed
       it, and the attacker's failures were never counted at all. */
    const oversized = "a".repeat(60);
    assert.strictEqual(getClientIp(requestWithHeaders({ "x-forwarded-for": oversized })), null);
    assert.strictEqual(normalizeLoginIp(oversized), null);
  });

  await test("the legacy 'unknown' sentinel is treated as no attributable source", () => {
    /* A shared pseudo-source would otherwise become one bucket that locks out every
       unattributable user — a denial of service against legitimate logins. */
    assert.strictEqual(getClientIp(requestWithHeaders({ "x-forwarded-for": "unknown" })), null);
    assert.strictEqual(normalizeLoginIp("unknown"), null);
    assert.strictEqual(normalizeLoginIp(""), null);
    assert.strictEqual(normalizeLoginIp(null), null);
    assert.strictEqual(normalizeLoginIp(undefined), null);
  });

  await test("valid IPv4 and IPv6 forms are kept, invalid octets are rejected", () => {
    assert.strictEqual(normalizeLoginIp("192.0.2.10"), "192.0.2.10");
    assert.strictEqual(normalizeLoginIp("  192.0.2.10  "), "192.0.2.10");
    assert.strictEqual(normalizeLoginIp("2001:DB8::1"), "2001:db8::1");
    assert.strictEqual(normalizeLoginIp("::ffff:203.0.113.7"), "::ffff:203.0.113.7");
    assert.strictEqual(normalizeLoginIp("999.1.1.1"), null);
    assert.strictEqual(normalizeLoginIp("203.0.113.7; DROP TABLE users"), null);
  });

  await test("every normalized source fits the ip_address column", () => {
    const longestIpv6 = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255";
    assert.strictEqual(normalizeLoginIp(longestIpv6), longestIpv6.toLowerCase());
    assert(longestIpv6.length <= 50, "longest legal IPv6 text form must fit varchar(50)");
  });

  /* ── 2. Thresholds: per-source limiting actually exists ──────────────────────── */

  await test("per-source budgets are exported alongside the historical per-account ones", () => {
    assert.strictEqual(rateLimit.MAX_ATTEMPTS, 5, "the historical five-attempt budget is unchanged");
    assert.strictEqual(rateLimit.BLOCK_MINUTES, 30, "the historical cooldown is unchanged");
    assert.strictEqual(rateLimit.WINDOW_MINUTES, 15, "the historical window is unchanged");
    assert(rateLimit.MAX_ATTEMPTS_PER_IP > rateLimit.MAX_ATTEMPTS, "a source budget must exist and exceed the scoped budget");
    assert(rateLimit.MAX_IDENTIFIERS_PER_IP >= 2, "spraying budget must exist");
    assert(
      rateLimit.MAX_ATTEMPTS_PER_IDENTIFIER > rateLimit.MAX_ATTEMPTS,
      "the account-wide backstop must be harder to trip than the scoped budget, otherwise one attacker can still lock any account"
    );
    assert(rateLimit.IP_BLOCK_MINUTES > 0 && rateLimit.IDENTIFIER_BLOCK_MINUTES > 0);
    assert(rateLimit.UNAVAILABLE_RETRY_SECONDS > 0, "a fail-closed retry window must be defined");
  });

  await test("the fail-open branch is gone: exactly one `allowed: true` remains", () => {
    const content = readFile("src/lib/rate-limit.ts");
    /* Doc comments quote the old fail-open return value when explaining the fix, so count
       code only: block comments are stripped before matching. */
    const code = content.replace(/\/\*[\s\S]*?\*\//g, "");
    const permissive = (code.match(/allowed:\s*true/g) ?? []).length;
    assert.strictEqual(permissive, 1, "only the success path of decide() may allow a login");
    assert(content.includes("FAILING CLOSED"), "the catch path must document that it fails closed");
    assert(!content.includes("allow the attempt but log"), "the old fail-open comment must not come back");
    assert(content.includes("rateLimitUnavailable"), "a dedicated unavailable result must exist");
  });

  await test("recording a failure reports whether it was stored", () => {
    const content = readFile("src/lib/rate-limit.ts");
    assert(content.includes("recorded: true") && content.includes("recorded: false"), "recordFailedLoginAttempt must return a recorded flag");
    assert(content.includes("LoginAttemptRecordResult"), "the result type must be exported for callers");
  });

  await test("the historical rate-limit contract tokens are all still present", () => {
    /* Mirrors tests/security.test.js so a refactor of this file cannot drop the names the
       rest of the audit evidence relies on. */
    const content = readFile("src/lib/rate-limit.ts");
    for (const token of ["loginAttempts", "checkLoginRateLimit", "recordFailedLoginAttempt", "clearFailedLoginAttempts", "MAX_ATTEMPTS"]) {
      assert(content.includes(token), `rate-limit.ts must keep ${token}`);
    }
  });

  /* ── 3. The login route wires all three layers together ──────────────────────── */

  await test("the login route passes the source IP when clearing a successful login", () => {
    const content = readFile("src/app/api/auth/login/route.ts");
    assert(
      content.includes("clearFailedLoginAttempts(identifier, clientIp)"),
      "a successful login must release both the account bucket and the source bucket"
    );
  });

  await test("the login route refuses a login it could not throttle, instead of allowing it", () => {
    const content = readFile("src/app/api/auth/login/route.ts");
    assert(content.includes("recorded.recorded"), "every recorded failure must be checked");
    assert(content.includes("degradedThrottleResponse"), "an unstorable failure must produce a degraded response");
    assert(content.includes("503"), "the degraded response must be a 503, not a 401");
    const guarded = (content.match(/if \(!recorded\.recorded\) return degradedThrottleResponse\(\);/g) ?? []).length;
    assert.strictEqual(guarded, 3, "all three failure branches (unknown user, deactivated, wrong password) must be guarded");
  });

  await test("throttle responses tell the client when to stop retrying", () => {
    const content = readFile("src/app/api/auth/login/route.ts");
    assert(content.includes('response.headers.set("Retry-After"'), "Retry-After must be set");
    assert(content.includes('rateLimit.reason === "unavailable" ? 503 : 429'), "an unevaluable check is a 503, an exhausted budget is a 429");
    assert(content.includes("Cache-Control"), "throttle responses must not be cacheable");
  });

  await test("legitimate login behaviour is untouched", () => {
    const content = readFile("src/app/api/auth/login/route.ts");
    assert(content.includes("verifyPassword(password, user.passwordHash)"), "password verification unchanged");
    assert(content.includes("Account is deactivated"), "deactivated-account message unchanged");
    assert(content.includes("httpOnly: true"), "the session cookie is still httpOnly");
  });

  /* ── 4. Self-heal keeps throttling alive on an un-migrated database ──────────── */

  await test("login_attempts is a registered, auto-repairable schema feature", () => {
    const content = readFile("src/lib/schema-resilience.ts");
    assert(content.includes('| "login_attempts"'), "the feature must be in the SchemaFeature union");
    assert(content.includes('login_attempts: "drizzle/0012_login_attempts.sql"'), "the feature must point at its migration");
    assert(content.includes('login_attempts: { mode: "relation", relation: "login_attempts" }'), "the probe must check the relation");
    assert(content.includes("export function ensureLoginAttemptSchema"), "a wrapper must exist for the rate limiter");
    const probeStart = content.indexOf("export async function probeSchemaFeatures");
    assert(probeStart > -1, "probeSchemaFeatures must exist");
    const defaults = content.slice(probeStart, content.indexOf("): Promise<OptionalSchemaStatus[]>", probeStart));
    assert(defaults.includes('"login_attempts"'), "/api/health must report the throttle table by default");
  });

  await test("the self-heal DDL is a superset of migration 0012", () => {
    const migration = readFile("drizzle/0012_login_attempts.sql");
    const resilience = readFile("src/lib/schema-resilience.ts");
    const objects = Array.from(migration.matchAll(/(?:CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS) "([a-z_]+)"/g)).map(
      (match) => match[1]
    );
    assert(objects.length >= 4, "0012 must create the table and its three indexes");
    for (const object of objects) {
      assert(resilience.includes(`"${object}"`), `self-heal must recreate ${object}`);
    }
    assert(
      resilience.includes('"login_attempts_ip_created_at_idx"'),
      "self-heal must also add the per-source index the H-1 throttle counts with"
    );
  });

  await test("/api/health cannot report 'ready' while the throttle fails closed", () => {
    /* Mirrors the Issue #54 lesson already applied to session revocation: an endpoint that
       says "ready" while every login answers 503 is worse than no health endpoint. */
    const content = readFile("src/app/api/health/route.ts");
    assert(content.includes("loginThrottleUnavailable"), "health must track the throttle state");
    assert(
      content.includes('item.feature === "login_attempts" && !item.present && !item.repairEnabled'),
      "a missing login_attempts table with repair disabled must be treated as unavailable"
    );
    assert(content.includes("0012_login_attempts.sql"), "the health message must name the migration");
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
