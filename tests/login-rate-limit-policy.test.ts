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
 * The same review then produced four further findings, all pinned here as well:
 *
 *   4. **M-R1** the source address was taken from the *leftmost* `x-forwarded-for` entry,
 *      which is the element the client writes;
 *   5. **M-R2** the check and the record were separate steps, so a concurrent burst all read
 *      the same empty table and every request got a real guess;
 *   6. **M-R3** email and username were separate identifiers, so one account had two budgets;
 *   7. **M-R4a** `/api/health` reported "ready" whenever repair was merely *enabled*, even if
 *      repair had failed or the runtime role could not run DDL at all.
 *
 * The database-backed behaviour is asserted in tests/login-rate-limit-db.test.ts. This
 * suite covers what can be checked without a server: IP normalization (the real
 * fail-open vector) and the header trust model, the fail-closed decision path's shape, the
 * cross-file contract that keeps the self-heal DDL a superset of migration 0012, and the
 * structural invariants behind M-R1/M-R2/M-R3/M-R4a.
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

  /* M-R1. This test used to pin the OPPOSITE behaviour — "takes the first entry of a proxy
     chain (unchanged behaviour)" — which is the element the client writes. Every proxy appends
     to x-forwarded-for, so the leftmost entry is attacker-controlled and unfit for a security
     decision. The trust position is now declared, counted from the end of the chain. */
  await test("M-R1: a spoofed prefix in x-forwarded-for is ignored, the trusted hop is used", () => {
    /* What an attacker sends through one honest proxy: their own forged victim address first,
       then the address the proxy actually observed. */
    assert.strictEqual(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" })),
      "198.51.100.7",
      "the rightmost entry (what the trusted hop saw) must win, never the client-written prefix"
    );
    assert.strictEqual(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" })),
      "150.172.238.178",
      "with one trusted hop the client-supplied prefix must never be attributed"
    );
  });

  await test("M-R1: junk at the trusted position does not fall back towards the client", () => {
    assert.strictEqual(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.9, not-an-ip" })),
      null,
      "scanning left would hand the attacker the address they wrote"
    );
  });

  await test("M-R1: the trusted hop count is configurable and clamped", () => {
    const previous = process.env.EASY_LEARN_CLIENT_IP_TRUSTED_HOPS;
    try {
      process.env.EASY_LEARN_CLIENT_IP_TRUSTED_HOPS = "2";
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "spoofed, 203.0.113.7, 198.51.100.9" })),
        "203.0.113.7",
        "two trusted hops means the second entry from the end"
      );
      process.env.EASY_LEARN_CLIENT_IP_TRUSTED_HOPS = "5";
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.7, 198.51.100.9" })),
        null,
        "more declared hops than the chain has entries must be unattributable, not leftmost"
      );
      for (const junk of ["abc", "0", "-3", ""]) {
        process.env.EASY_LEARN_CLIENT_IP_TRUSTED_HOPS = junk;
        assert.strictEqual(
          getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.7, 198.51.100.9" })),
          "198.51.100.9",
          `an unusable hop count (${JSON.stringify(junk)}) must fall back to the default of 1`
        );
      }
    } finally {
      if (previous === undefined) delete process.env.EASY_LEARN_CLIENT_IP_TRUSTED_HOPS;
      else process.env.EASY_LEARN_CLIENT_IP_TRUSTED_HOPS = previous;
    }
  });

  await test("M-R1: a declared platform header is authoritative and used exclusively", () => {
    const previous = process.env.EASY_LEARN_CLIENT_IP_HEADER;
    try {
      process.env.EASY_LEARN_CLIENT_IP_HEADER = "x-vercel-forwarded-for";
      assert.strictEqual(
        getClientIp(
          requestWithHeaders({
            "x-vercel-forwarded-for": "203.0.113.44",
            "x-forwarded-for": "198.51.100.7",
          })
        ),
        "203.0.113.44",
        "the declared header wins over x-forwarded-for"
      );
      assert.strictEqual(
        getClientIp(
          requestWithHeaders({
            "x-vercel-forwarded-for": "junk",
            "x-forwarded-for": "198.51.100.7",
            "x-real-ip": "198.51.100.8",
          })
        ),
        null,
        "an operator-declared source must not silently fall back to a header the client writes"
      );
    } finally {
      if (previous === undefined) delete process.env.EASY_LEARN_CLIENT_IP_HEADER;
      else process.env.EASY_LEARN_CLIENT_IP_HEADER = previous;
    }
  });

  await test("M-R1: x-vercel-forwarded-for is only consulted when actually running on Vercel", () => {
    const previous = process.env.VERCEL;
    try {
      delete process.env.VERCEL;
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "junk", "x-vercel-forwarded-for": "203.0.113.9" })),
        null,
        "off-platform the header is client-writable, so it must not be trusted"
      );
      process.env.VERCEL = "1";
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "junk", "x-vercel-forwarded-for": "203.0.113.9" })),
        "203.0.113.9",
        "on Vercel the platform writes it, so it is a legitimate fallback"
      );
    } finally {
      if (previous === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previous;
    }
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

  await test("the fail-open branch is gone: nothing allows a login except decide()'s success path", () => {
    const content = readFile("src/lib/rate-limit.ts");
    /* Doc comments quote the old fail-open return value when explaining the fix, so count
       code only: block comments are stripped before matching. Since M-R2 there are exactly two
       permissive literals: decide()'s own verdict, and the recorder echoing that verdict after
       its transaction commits. Anything else — above all anything inside a catch — is fail-open. */
    const code = content.replace(/\/\*[\s\S]*?\*\//g, "");
    const matches = [...code.matchAll(/allowed:\s*true/g)];
    assert.strictEqual(
      matches.length,
      2,
      "exactly two permissive literals may exist: decide()'s verdict and the recorder echoing it"
    );

    const decideStart = code.indexOf("function decide(");
    const decideEnd = code.indexOf("function unavailableDecision");
    assert(decideStart > -1 && decideEnd > decideStart, "decide() must be locatable");
    assert(
      matches.some((match) => match.index! > decideStart && match.index! < decideEnd),
      "one permissive literal must be decide()'s allowed verdict"
    );

    const recordStart = code.indexOf("export async function recordFailedLoginAttempt");
    const commitAt = code.indexOf('await client.query("COMMIT")', recordStart);
    assert(recordStart > -1 && commitAt > recordStart, "the recorder must commit explicitly");
    assert(
      matches.some((match) => match.index! > commitAt),
      "the recorder may only report allowed:true after its transaction has committed"
    );

    for (const catchMatch of code.matchAll(/\}\s*catch\s*(\([^)]*\))?\s*\{/g)) {
      const body = code.slice(catchMatch.index!, catchMatch.index! + 200);
      assert(!/allowed:\s*true/.test(body), "an error path must never allow a login");
    }

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

  /* REWRITTEN for independent review finding H-R1 (2026-11-19). The old assertion pinned
     only the call site, and its stated rationale — "release both the account bucket and the
     source bucket" — described the vulnerability itself. It now pins the *scope of the
     DELETE*, so the widened form cannot be reintroduced by a future refactor. */
  await test("a successful login clears only the signing-in account's failures (H-R1)", () => {
    const route = readFile("src/app/api/auth/login/route.ts");
    assert(
      route.includes("clearFailedLoginAttempts(aliases, clientIp)"),
      "a successful login must still release the signing-in account's own recorded failures"
    );

    const lib = readFile("src/lib/rate-limit.ts");
    const start = lib.indexOf("export async function clearFailedLoginAttempts");
    assert(start > -1, "clearFailedLoginAttempts must still exist");
    const clear = lib.slice(start);
    assert(
      clear.includes(".where(inArray(loginAttempts.identifier, aliases))"),
      "the reset DELETE must be scoped to the signing-in account's aliases"
    );
    assert(
      !clear.includes("loginAttempts.ipAddress"),
      "the reset DELETE must never be widened by the source IP: that erases other accounts' failures"
    );
    assert(!lib.includes("or(eq(loginAttempts.identifier"), "no OR-scoped login_attempts delete may come back");
    const importLine = lib.split("\n").find((line) => line.includes('from "drizzle-orm"')) ?? "";
    assert(!/\bor\b/.test(importLine), "the drizzle `or` operator is unused now and must not be imported");
  });

  await test("the login route refuses a login it could not throttle, instead of allowing it", () => {
    const content = readFile("src/app/api/auth/login/route.ts");
    assert(content.includes("attempt.allowed"), "the atomic decision must be checked");
    assert(content.includes("rateLimitResponse(attempt.decision)"), "exhausted is 429, unevaluable is 503");
    assert(content.includes("attempt.recorded"), "an unstorable attempt must still be caught");
    assert(content.includes("degradedThrottleResponse"), "an unstorable failure must produce a degraded response");
    assert(content.includes("503"), "the degraded response must be a 503, not a 401");
    /* M-R2: enforcement must happen BEFORE the password hash is computed. Enforcing after
       verification is what let a concurrent burst buy extra guesses. */
    const enforceAt = content.indexOf("await recordFailedLoginAttempt(aliases, clientIp)");
    const verifyAt = content.indexOf("await verifyPassword(password, user.passwordHash)");
    assert(enforceAt > -1, "the route must enforce through recordFailedLoginAttempt");
    assert(verifyAt > -1, "the route must still verify the password");
    assert(enforceAt < verifyAt, "the attempt must be enforced and recorded before the password is verified");
    const preCheckAt = content.indexOf("await checkLoginRateLimit(suppliedIdentifier, clientIp)");
    assert(preCheckAt > -1 && preCheckAt < enforceAt, "the cheap read-only filter still runs first");
  });

  await test("M-R2: the record is atomic — advisory lock, insert, then a self-inclusive count", () => {
    const lib = readFile("src/lib/rate-limit.ts");
    assert(lib.includes("pg_advisory_xact_lock"), "enforcement must hold a PostgreSQL advisory lock");
    assert(lib.includes("hashtextextended"), "the lock key must derive from the source/account, not one global lock");
    for (const token of ['client.query("BEGIN")', 'client.query("COMMIT")', 'client.query("ROLLBACK")']) {
      assert(lib.includes(token), `enforcement must run in an explicit transaction (${token})`);
    }
    const insertAt = lib.indexOf("run(INSERT_ATTEMPT_SQL, [primary, ip])");
    const countAt = lib.indexOf("countRecentFailures(run, aliases, ip), ip, { countedSelf: true }");
    assert(insertAt > -1 && countAt > -1, "the insert and the self-inclusive count must both exist");
    assert(insertAt < countAt, "the insert must precede the count, or the count cannot see the in-flight attempt");
    assert(lib.includes("MAX_ATTEMPTS + self"), "decide() must compensate so the observable limit is unchanged");
    assert(
      /if \(!decision\.allowed\) \{\s*await client\.query\("ROLLBACK"\)/.test(lib),
      "a refused attempt must be rolled back so it cannot extend its own cooldown"
    );
    assert(!lib.includes("verifyPassword"), "the throttle module must never verify a password inside the lock");
    /* Two locks, always in the same order, so concurrent attempts cannot form a wait cycle. */
    const sourceKeyAt = lib.indexOf('ip === null ? `identifier:${primary}` : `source:${ip}`');
    const accountKeyAt = lib.indexOf("`account:${[...aliases].sort().join(\"|\")}`");
    assert(sourceKeyAt > -1 && accountKeyAt > -1 && sourceKeyAt < accountKeyAt, "source lock first, then account lock");
  });

  await test("M-R3: budgets are keyed on the account's alias set, not on one identifier", () => {
    const lib = readFile("src/lib/rate-limit.ts");
    assert(lib.includes("identifier = ANY($1::text[])"), "the count must cover every alias of the account");
    assert(lib.includes("function normalizeAliases"), "aliases must be normalized and de-duplicated");
    assert(lib.includes("inArray(loginAttempts.identifier, aliases)"), "clearing must cover every alias too");
    const route = readFile("src/app/api/auth/login/route.ts");
    assert(
      route.includes("[suppliedIdentifier, user.email, user.username]"),
      "the route must feed both aliases of the resolved account, supplied identifier first"
    );
    assert(route.includes(": [suppliedIdentifier];"), "an unknown account keeps a budget of its own");
    const lookupAt = route.indexOf("findAuthUser(eq(users.email, normalizedEmail)");
    const enforceAt = route.indexOf("await recordFailedLoginAttempt(aliases, clientIp)");
    assert(lookupAt > -1 && lookupAt < enforceAt, "the account must be resolved before alias-aware enforcement");
    assert(route.includes("await clearFailedLoginAttempts(aliases, clientIp)"), "a success releases every alias");
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
      content.includes('item.feature === "login_attempts" && item.repairBlocked'),
      "a missing login_attempts table that cannot be repaired must be treated as unavailable"
    );
    assert(content.includes("0012_login_attempts.sql"), "the health message must name the migration");
  });

  await test("M-R4a: 'repair is enabled' is no longer mistaken for 'repair worked'", () => {
    const resilience = readFile("src/lib/schema-resilience.ts");
    assert(resilience.includes("SchemaRepairFailure"), "a failed repair attempt must be recorded");
    assert(resilience.includes("getSchemaRepairFailure"), "and be readable by the health endpoint");
    assert(resilience.includes("repairFailures().set(feature"), "the ledger must be written when repair does not deliver");
    assert(
      resilience.includes("has_schema_privilege(current_user, 'public', 'CREATE')"),
      "the DDL capability probe must be read-only catalog SQL"
    );
    assert(
      resilience.includes("repairBlocked: !present && (!repairEnabled || ddlCapable === false || repairFailed)"),
      "a missing feature is blocked when repair is off, unprivileged, or already failed"
    );
    assert(resilience.includes("ddlCapable === false"), "an unknown capability (null) must NOT escalate on its own");

    const health = readFile("src/app/api/health/route.ts");
    assert(
      health.includes('item.feature === "session_revocation" && item.repairBlocked'),
      "the same blind spot must be closed for session revocation"
    );
    /* The public message must stay a fixed string: no role name, no database error text. */
    const branchStart = health.indexOf("if (loginThrottleUnavailable) {");
    assert(branchStart > -1, "the escalation branch must exist");
    const branch = health.slice(branchStart, branchStart + 1200);
    const messagePart = branch.slice(branch.indexOf("message:"), branch.indexOf("{ status: 503"));
    assert(messagePart.length > 0, "the branch must build a message");
    assert(!messagePart.includes("${"), "no runtime detail may be interpolated into the public message");
    assert(health.includes("console.error"), "the cause is logged server-side instead");
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
