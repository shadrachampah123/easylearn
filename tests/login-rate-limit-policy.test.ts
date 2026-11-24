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

  await test("getClientIp uses the trusted position even when a leftward entry is junk", () => {
    /* Renamed 2026-11-19 (review round 2): the old name described the pre-M-R1 behaviour,
       "skip junk and fall back to the first valid entry", which is exactly the leftmost scan
       M-R1 removed. What this asserts is the trusted *position* in a two-entry chain. */
    assert.strictEqual(
      getClientIp(requestWithHeaders({ "x-forwarded-for": "not-an-ip, 203.0.113.7" })),
      "203.0.113.7"
    );
  });

  await test("F-3: getClientIp does NOT fall back to x-real-ip when the chain holds nothing usable", () => {
    /* This assertion was the opposite before review finding F-3: it *required* the fall-through.
       `x-real-ip` is written by the client on every platform this deployment runs on, so it made
       the whole attribution chain forgeable — measured: a junk trusted position plus
       `x-real-ip: 203.0.113.66` returned the attacker's address, and every forged address is a
       fresh per-source budget (15 guesses per account against unlimited accounts). */
    const previousVercel = process.env.VERCEL;
    try {
      delete process.env.VERCEL;
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "junk", "x-real-ip": "198.51.100.4" })),
        null,
        "a junk trusted position must yield an unattributable source, not the client's own header"
      );
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-real-ip": "198.51.100.4" })),
        null,
        "with no forwarded chain at all the client must not be able to name its own source"
      );
      process.env.VERCEL = "1";
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "junk", "x-real-ip": "198.51.100.4" })),
        null,
        "running on Vercel does not make a client-written header trustworthy"
      );
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }

    const source = readFile("src/lib/rate-limit.ts");
    assert(
      !source.includes('headers.get("x-real-ip")'),
      "no code path may read x-real-ip any more"
    );
    assert(
      source.includes("EASY_LEARN_CLIENT_IP_HEADER"),
      "an operator whose edge really sets x-real-ip must declare it explicitly, where it is used exclusively"
    );
  });

  await test("F-3: the platform marker is an exact environment check, never a header", () => {
    const previousVercel = process.env.VERCEL;
    try {
      process.env.VERCEL = "true";
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "junk", "x-vercel-forwarded-for": "203.0.113.9" })),
        null,
        "only the exact marker the Vercel runtime sets may enable the platform header"
      );
      process.env.VERCEL = "1";
      assert.strictEqual(
        getClientIp(requestWithHeaders({ "x-forwarded-for": "junk", "x-vercel-forwarded-for": "203.0.113.9" })),
        "203.0.113.9",
        "on Vercel the platform writes the header, so it is a legitimate last resort"
      );
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }
    assert(
      readFile("src/lib/rate-limit.ts").includes('process.env.VERCEL === "1"'),
      "the provenance signal must stay an environment variable a client cannot write"
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

  await test("F-10: IPv6 junk is rejected instead of minting a fresh source key", () => {
    /* The previous rule was "at least two colons and only hex/dot/colon characters", which
       accepted every string below. A reviewer probe minted 5 000 distinct "source addresses"
       from 5 000 junk strings, and each one was a fresh per-source budget. */
    for (const junk of [
      ":::", "a:b:c", "1:::1", "....::", "1:2", "1::2::3", ":1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1", "2001:db8::g", "1.2.3.4::", "-1::1",
    ]) {
      assert.strictEqual(normalizeLoginIp(junk), null, `${junk} must not be accepted as a source address`);
    }
    const minted = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      const value = normalizeLoginIp(`ab:${i.toString(16)}z::${(i * 7).toString(16)}`);
      if (value) minted.add(value);
    }
    assert.strictEqual(minted.size, 0, "no junk string may mint a distinct source key");
  });

  await test("F-10: equivalent spellings of one address collapse onto one source key", () => {
    assert.strictEqual(normalizeLoginIp("2001:0db8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
    assert.strictEqual(normalizeLoginIp("2001:DB8:0:0:0:0:0:1"), "2001:db8::1");
    assert.strictEqual(normalizeLoginIp("0:0:0:0:0:ffff:203.0.113.7"), "::ffff:203.0.113.7");
    assert.strictEqual(normalizeLoginIp("::"), "::");
    assert.strictEqual(normalizeLoginIp("2001:db8::"), "2001:db8::");
  });

  await test("F-10: zero-padded IPv4 octets are rejected rather than reinterpreted", () => {
    /* `010.001.001.001` is octal on some stacks and decimal on others. Accepting it would give
       one host two source keys, and the two would disagree about which address was punished. */
    assert.strictEqual(normalizeLoginIp("010.001.001.001"), null);
    assert.strictEqual(normalizeLoginIp("203.0.113.07"), null);
    assert.strictEqual(normalizeLoginIp("0.0.0.0"), "0.0.0.0");
    assert.strictEqual(normalizeLoginIp("10.1.1.1"), "10.1.1.1");
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

  await test("failed login states share a generic response while successful login remains unchanged", () => {
    const content = readFile("src/app/api/auth/login/route.ts");
    assert(content.includes("verifyPassword(password, user.passwordHash)"), "password verification unchanged");
    assert(content.includes('const INVALID_LOGIN_MESSAGE = "Invalid email or password"'), "one generic failure message is defined");
    assert(!content.includes("Invalid email/username or password"), "unknown accounts must not use a distinguishable message");
    assert(!content.includes("Account is deactivated. Contact the school administrator."), "deactivated accounts must not disclose their state");
    assert(content.includes("httpOnly: true"), "the session cookie is still httpOnly");
  });

  /* ── 4. Self-heal keeps throttling alive on an un-migrated database ──────────── */

  await test("login_attempts is a registered, auto-repairable schema feature", () => {
    const content = readFile("src/lib/schema-resilience.ts");
    assert(content.includes('| "login_attempts"'), "the feature must be in the SchemaFeature union");
    assert(content.includes('login_attempts: "drizzle/0012_login_attempts.sql"'), "the feature must point at its migration");
    /* F-1: relation-mode was not enough — a relation that exists without the columns the
       throttle reads is unusable, and relation-mode reported it as present. */
    assert(
      /login_attempts:\s*{[^}]*mode: "columns"[^}]*table: "login_attempts"[^}]*columns: \["identifier", "ip_address", "created_at"\]/.test(content),
      "the probe must check the three columns the throttle actually reads and writes"
    );
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
      /repairBlocked:\s*!present && \(securityCritical \|\| !repairEnabled \|\| ddlCapable === false \|\| repairFailed\)/.test(resilience),
      "a missing feature is blocked when it is security-critical, or repair is off, unprivileged, or already failed"
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
    /* The CAUSE must reach the server log. This assertion used to read
       `health.includes("console.error")`, which pinned a MECHANISM rather than the
       property: when H-2 replaced those four `console.error` calls with structured
       `log.error` lines (so the cause carries a request id and survives redaction), the
       behaviour got BETTER and the pin failed. It now accepts either mechanism and
       requires that the cause is the thing being logged. */
    assert(
      /log\.error\(\s*"login throttling is unavailable[\s\S]{0,200}cause/.test(health) ||
        (/console\.error/.test(health) && /cause/.test(health)),
      "the cause is logged server-side instead (structured log or console, but with the cause)"
    );
  });

  /* ── 8. F-1 / F-4 / F-7: health must not be green while a control is broken ───── */

  await test("F-1: the self-heal can repair a drifted relation, not only a missing one", () => {
    const resilience = readFile("src/lib/schema-resilience.ts");
    for (const column of ["identifier", "ip_address", "created_at"]) {
      assert(
        resilience.includes(`ALTER TABLE "login_attempts" ADD COLUMN IF NOT EXISTS "${column}"`),
        `a dropped ${column} used to be an unrecoverable outage: CREATE TABLE IF NOT EXISTS cannot repair drift`
      );
    }
    /* Additive only. The word "drop" appears in this file's comments (the composite-FK
       feature must never drop its constraints), so scope the check to the login_attempts DDL. */
    const blockStart = resilience.indexOf("login_attempts: [");
    const block = resilience.slice(blockStart, resilience.indexOf("composite_tenant_foreign_keys: []", blockStart));
    assert(blockStart > -1 && block.length > 0, "the login_attempts self-heal DDL must exist");
    assert(
      !/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)/i.test(block),
      "repairing drift must be additive: nothing may be dropped"
    );
  });

  await test("F-1/F-4: a missing security-critical feature is unhealthy without a prior failed repair", () => {
    const resilience = readFile("src/lib/schema-resilience.ts");
    assert(resilience.includes("SECURITY_CRITICAL_FEATURES"), "the two fail-closed features must be named");
    for (const feature of ["login_attempts", "session_revocation"]) {
      assert(
        new RegExp(`SECURITY_CRITICAL_FEATURES[\\s\\S]{0,200}"${feature}"`).test(resilience),
        `${feature} must be in the security-critical set`
      );
    }
    assert(
      resilience.includes("!present && (securityCritical ||"),
      "escalation must not depend on a failure that only a request path can record"
    );

    const health = readFile("src/app/api/health/route.ts");
    assert(
      health.includes("securityCriticalMissing"),
      "the endpoint must refuse to say ready while a security-critical flag is false"
    );
    /* A bare `includes("featureProbeUnavailable")` is satisfied by the declaration and by the
       `catch` block that sets it, so deleting the guard that READS it left the pin green — found
       by mutation, not by review. The clause is the only escalation for the case where the probe
       module cannot be imported at all (a per-feature throw is caught inside
       `probeSchemaFeatures` and reported through `repairBlocked` instead), so its shape is the
       only cheap observable and it must be pinned as a condition, not as a name. */
    assert(
      /if\s*\(\s*featureProbeUnavailable\s*\|\|\s*securityCriticalMissing\s*\)/.test(health),
      "F-7: a schema state that could not be read at all must not be reported as ready — the guard must READ the flag, not merely declare it"
    );
    assert(
      resilience.includes("probeError"),
      "F-7: an errored probe must be distinguishable from a probe that says 'absent'"
    );
  });

  /* ── 9. F-2 / F-5: the enforcement transaction must not take the process down ─── */

  await test("F-2: the checked-out client carries an error listener for the whole transaction", () => {
    const source = readFile("src/lib/rate-limit.ts");
    assert(
      source.includes('client.on("error", onClientError)'),
      "pg-pool detaches its own listener on checkout, so an error mid-transaction was unhandled and killed the isolate"
    );
    assert(
      source.includes('client.removeListener("error", onClientError)'),
      "the listener must be removed again so it cannot fire after the client is pooled"
    );
    assert(source.includes("isConnectionLevelError"), "a broken connection must be classified, not guessed");
    assert(
      source.includes("client.release(broken"),
      "a connection-level failure must destroy the client instead of pooling a dead one"
    );
    const checkout = source.indexOf("await pool.connect()");
    const listener = source.indexOf('client.on("error"');
    assert(checkout > -1 && listener > checkout, "the listener must be attached after checkout");
    assert(listener - checkout < 900, "and immediately after it, before any statement runs");
  });

  await test("F-5: the advisory-lock wait is bounded, transaction-scoped and fails closed", () => {
    assert.strictEqual(rateLimit.loginLockTimeoutMs(), 2000, "the default bound is two seconds");
    const previous = process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS;
    try {
      process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS = "1";
      assert.strictEqual(rateLimit.loginLockTimeoutMs(), 250, "clamped to a usable floor");
      process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS = "999999";
      assert.strictEqual(rateLimit.loginLockTimeoutMs(), 10000, "clamped to a ceiling");
      process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS = "junk";
      assert.strictEqual(rateLimit.loginLockTimeoutMs(), 2000, "junk falls back to the default");
      process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS = "1500";
      assert.strictEqual(rateLimit.loginLockTimeoutMs(), 1500, "an operator value inside the bounds is used");
    } finally {
      if (previous === undefined) delete process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS;
      else process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS = previous;
    }

    const source = readFile("src/lib/rate-limit.ts");
    assert(source.includes("SET LOCAL lock_timeout"), "the bound must be applied inside the transaction");
    assert(!/SET\s+lock_timeout/i.test(source), "SET LOCAL only: a session-wide setting would leak to other requests");
    assert(source.includes('"55P03"'), "a lock timeout must be recognised as contention and logged as such");
    assert(
      source.includes("unavailableDecision()"),
      "a lock timeout is an unevaluable throttle, which fails closed with 503"
    );
  });

  /* ── 10. F-6: one identifier string belongs to one account ───────────────────── */

  await test("F-6: email format is validated and cross-account alias collisions are refused", async () => {
    const identity = await import("@/lib/login-identity");
    assert.strictEqual(identity.isValidLoginEmail("name@school.edu"), true);
    assert.strictEqual(identity.isValidLoginEmail("first.last+tag@sub.school.edu"), true);
    assert.strictEqual(
      identity.isValidLoginEmail("victim-admin"),
      false,
      "a bare username must not be storable as an email: that is the collision"
    );
    for (const bad of ["", "   ", "a@b", "a b@c.edu", "a@b c.edu", "a,@b.edu", "a@b;edu",
      "plainaddress", "@school.edu", "a@.edu", "a@b.", "a@@b.edu", null, undefined, 42]) {
      assert.strictEqual(identity.isValidLoginEmail(bad), false, `${JSON.stringify(bad)} must be rejected`);
    }

    /* Behavioural: the invariant in both directions, with an injected lookup so it needs no
       database. `victim-admin` is an existing USERNAME; `collider@school.edu` an existing EMAIL. */
    const store: Record<string, Set<string>> = {
      email: new Set(["victim-admin"]),
      username: new Set(["collider@school.edu"]),
    };
    const exists = async (column: "email" | "username", identifier: string) =>
      (store[column]?.has(identifier) ?? false);
    const emailClash = await identity.findLoginAliasCollision(exists, {
      email: "collider@school.edu",
      username: "someone",
    });
    assert.strictEqual(emailClash?.kind, "email_matches_existing_username");
    const usernameClash = await identity.findLoginAliasCollision(exists, {
      email: "ok@school.edu",
      username: "victim-admin",
    });
    assert.strictEqual(usernameClash?.kind, "username_matches_existing_email");
    assert.strictEqual(
      await identity.findLoginAliasCollision(exists, { email: "ok@school.edu", username: "someone" }),
      null,
      "an ordinary account must not be refused"
    );
    assert.match(
      identity.loginAliasCollisionMessage(emailClash!),
      /guess budget/,
      "the operator must be told why the creation was refused"
    );

    const route = readFile("src/app/api/users/route.ts");
    assert(route.includes("isValidLoginEmail("), "the only account-creation path must validate the format");
    assert(route.includes("findLoginAliasCollision("), "and must check both directions of the invariant");
    assert(route.includes("loginAliasCollisionMessage("), "and must explain a refusal");
  });

  /* ── 11. F-8 / F-9: the documentation must match the measurements ────────────── */

  await test("F-8: an unattributable source is no longer described as 'stricter, not looser'", () => {
    const source = readFile("src/lib/rate-limit.ts");
    assert(!source.includes("which is stricter, not looser"), "the disproved claim must be gone");
    assert(
      !source.includes("*stricter* than a per-source budget"),
      "so must the claim that a null source is stricter than a per-source budget"
    );
    assert(source.includes("F-8"), "the measured behaviour must be recorded in its place");
    assert(
      source.includes("deliberately rejected"),
      "the decision NOT to add a global cap for unattributable traffic must be recorded, with its reason"
    );
    assert(
      source.includes("12 accounts"),
      "the measurement (40 refused for an attributed source, 60 for an unattributable one) must be quoted"
    );
  });

  await test("F-9: the shared-proxy lockout risk is documented next to the hop-count decision", () => {
    const roadmap = readFile("docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md");
    const security = readFile("docs/SECURITY_AUTHENTICATION.md");
    assert(roadmap.includes("F-9"), "the roadmap register must carry the finding");
    assert(
      /Cloudflare[\s\S]{0,900}EASY_LEARN_CLIENT_IP_TRUSTED_HOPS|EASY_LEARN_CLIENT_IP_TRUSTED_HOPS[\s\S]{0,900}Cloudflare/.test(roadmap),
      "the WAF recommendation must be cross-referenced with the hop-count decision it silently changes"
    );
    assert(
      security.includes("locked out"),
      "section 11 must say that a shared edge address turns five attacker guesses into an owner lockout"
    );
    /* A marker somewhere in the file is not evidence. The register ROW must carry the finding,
       its severity, the lockout consequence and the remedy that prevents it — otherwise the
       claim can be deleted from the row and still satisfy `includes("F-9")`. */
    assert(
      /\| \*\*F-9\*\* \| (Low|Medium|High) \|[\s\S]{0,1500}locked out[\s\S]{0,1500}EASY_LEARN_CLIENT_IP_TRUSTED_HOPS/.test(
        roadmap
      ),
      "the F-9 register row must state the lockout consequence next to the hop-count remedy"
    );
    assert(
      /EASY_LEARN_CLIENT_IP_TRUSTED_HOPS[\s\S]{0,600}locked out|locked out[\s\S]{0,600}EASY_LEARN_CLIENT_IP_TRUSTED_HOPS/.test(
        security
      ),
      "section 11 must tie the hop count to the lockout it can cause, not list them apart"
    );
  });

  /* ── 12. F-1 follow-up: the self-heal must restore columns BEFORE it builds indexes ──

     `ALTER TABLE ... DROP COLUMN` drops every index that depends on the column, and
     `ensureSchemaFeature` logs and SKIPS a statement that fails instead of aborting. With the
     four `CREATE INDEX` statements listed before the three additive `ADD COLUMN` repairs — the
     order this shipped in — a drifted table came back with its columns but only some of its
     indexes: the index build failed with 42703, was skipped, and because the columns-mode probe
     then reported the feature AVAILABLE the repair never ran again. Silent, permanent index
     loss on exactly the table the throttle counts. This asserts the order of the list that is
     actually executed, not the order it appears in a comment. */

  await test("F-1 follow-up: every login_attempts index is built after every column repair", async () => {
    const resilience = await import("@/lib/schema-resilience");
    const statements = resilience.FEATURE_SQL.login_attempts;
    const kindOf = (statement: string) =>
      /^\s*CREATE TABLE/i.test(statement)
        ? "table"
        : /^\s*ALTER TABLE/i.test(statement)
          ? "column"
          : /^\s*CREATE INDEX/i.test(statement)
            ? "index"
            : "other";
    const kinds = statements.map(kindOf);

    assert.strictEqual(statements.length, 8, "the ledger total the health probe and the tests report");
    assert.deepStrictEqual(
      kinds.filter((kind) => kind === "other"),
      [],
      `every statement must be a table, column or index statement: ${kinds.join(" -> ")}`
    );
    assert.strictEqual(kinds[0], "table", "the relation must be created first");
    assert.strictEqual(kinds.filter((kind) => kind === "column").length, 3, "identifier, ip_address, created_at");
    assert.strictEqual(kinds.filter((kind) => kind === "index").length, 4, "all four indexes");

    const lastColumn = kinds.lastIndexOf("column");
    const firstIndex = kinds.indexOf("index");
    assert(
      firstIndex > lastColumn,
      `no index may be attempted before the column repairs: ${kinds.join(" -> ")}`
    );

    /* And per index: whichever of the three repaired columns it references, it must come after
       that column's ADD COLUMN — that is the ordering the failure actually depended on. */
    const columnIndex: Record<string, number> = {};
    statements.forEach((statement, index) => {
      const match = /ADD COLUMN IF NOT EXISTS "(\w+)"/.exec(statement);
      if (match) columnIndex[match[1]] = index;
    });
    for (const [name, position] of Object.entries(columnIndex)) {
      assert(typeof position === "number", `${name} must be repaired by the list`);
    }
    statements.forEach((statement, index) => {
      if (kindOf(statement) !== "index") return;
      for (const column of Object.keys(columnIndex)) {
        if (!statement.includes(`"${column}"`)) continue;
        assert(
          index > columnIndex[column],
          `statement ${index} indexes "${column}" but that column is only repaired at ${columnIndex[column]}`
        );
      }
    });
  });

  await test("F-1 follow-up: the repair list is re-runnable and can never destroy anything", async () => {
    /* Asserted on the executed list rather than on the source text: a comment that happens to
       contain the phrase would otherwise satisfy a text-based count. */
    const resilience = await import("@/lib/schema-resilience");
    const statements = resilience.FEATURE_SQL.login_attempts;
    for (const statement of statements) {
      const head = statement.trim().slice(0, 70);
      assert(/IF NOT EXISTS/i.test(statement), `every statement must be idempotent: ${head}`);
      assert(!/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)/i.test(statement), `the repair must never drop anything: ${head}`);
      assert(!/TRUNCATE|DELETE\s+FROM/i.test(statement), `and must never remove data: ${head}`);
      assert(
        !/CONCURRENTLY/i.test(statement),
        `no CONCURRENTLY: it cannot run inside a transaction and is not needed while logins already fail closed: ${head}`
      );
    }
    /* The ordering contract has to stay documented where the list lives, or the next person to
       add a statement puts it back in the wrong place. */
    assert(
      readFile("src/lib/schema-resilience.ts").includes("ORDERING IS LOAD-BEARING"),
      "the ordering requirement must be documented next to the list"
    );
  });

  /* ── 13. F-6 follow-up: the cross-column identity check must be atomic ──────────────

     Separate SELECTs then an INSERT is check-then-act, and the window was ~250 ms wide because
     bcrypt cost 12 ran between the checks and the insert. The fix serialises the whole
     check-generate-insert-membership sequence on one transaction-scoped advisory lock. These
     pins hold the shape: if the lock, the bound or the transaction go, the race comes back and
     only the concurrent database test would notice — too late and too rarely. */

  await test("F-6 follow-up: user creation takes the identity lock inside one transaction", () => {
    const route = readFile("src/app/api/users/route.ts");
    assert(route.includes("db.transaction("), "the checks and the insert must share one transaction");
    assert(
      route.includes("pg_advisory_xact_lock(hashtextextended("),
      "the transaction must serialise on a PostgreSQL advisory lock"
    );
    assert(
      route.includes("LOGIN_IDENTITY_LOCK_NAMESPACE"),
      "and the lock key must be the shared identity namespace, not an ad-hoc string"
    );
    assert(
      route.includes("SET LOCAL lock_timeout"),
      "the wait must be bounded and transaction-scoped, so a stuck creation cannot hold a pooled connection"
    );
    assert(
      /await tx\s*\.insert\(users\)/.test(route),
      "the account must be written through the transaction, not the pool"
    );
    assert(
      !/await db\s*\n?\s*\.insert\(users\)/.test(route),
      "no part of the creation may insert outside the transaction"
    );
    assert(
      route.includes("addSchoolMembership(\n          { schoolId: ctx.schoolId, userId: newUser.id, role },\n          tx\n        )") ||
        /addSchoolMembership\([\s\S]{0,200}?,\s*tx\s*\)/.test(route),
      "the membership must be written in the same transaction, so a failure rolls the account back"
    );
    assert(
      !route.includes("db.delete(users)"),
      "the compensating DELETE is gone: rollback replaces it"
    );

    /* bcrypt outside the lock. This is the ordering that makes the lock cheap AND the ordering
       whose absence made the old race window hundreds of milliseconds wide. */
    const hashAt = route.indexOf("await hashPassword(password)");
    const transactionAt = route.indexOf("db.transaction(");
    assert(hashAt > 0 && transactionAt > 0, "both calls must exist");
    assert(
      hashAt < transactionAt,
      "bcrypt must run BEFORE the transaction, never inside the lock"
    );
    /* The uniqueness reads must run AFTER the lock is taken. */
    const lockAt = route.indexOf("pg_advisory_xact_lock");
    const existsAt = route.indexOf("const identifierExists");
    assert(lockAt > 0 && existsAt > 0, "both the lock and the check must exist");
    assert(existsAt > lockAt, "no uniqueness check may run before the lock is held");
  });

  await test("F-6 follow-up: the identity lock is bounded, named and its errors are classified", async () => {
    const identity = await import("@/lib/login-identity");
    assert.strictEqual(
      identity.LOGIN_IDENTITY_LOCK_NAMESPACE,
      "easylearn:login-identity",
      "one namespace key: per-identifier locking would need two phases and could form a wait cycle"
    );
    assert.strictEqual(identity.LOGIN_IDENTITY_LOCK_TIMEOUT_MS, 5000, "the wait is bounded at five seconds");
    assert.strictEqual(identity.LOCK_TIMEOUT_SQLSTATE, "55P03");
    assert.strictEqual(identity.DEADLOCK_SQLSTATE, "40P01");
    assert.strictEqual(
      identity.isIdentityLockTimeout({ code: "55P03" }),
      true,
      "a direct lock_timeout error must be recognised"
    );
    assert.strictEqual(
      identity.isIdentityLockTimeout({ cause: { code: "55P03" } }),
      true,
      "and one wrapped by the driver/or layer"
    );
    assert.strictEqual(identity.isIdentityLockTimeout({ code: "23505" }), false, "a unique violation is not a lock timeout");
    assert.strictEqual(identity.isIdentityLockTimeout(null), false, "nor is a null error");
    assert.strictEqual(identity.isIdentityDeadlock({ code: "40P01" }), true);
    assert.strictEqual(identity.isIdentityDeadlock({ code: "55P03" }), false);
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
