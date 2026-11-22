/**
 * H-1 (login rate limiting) regression — database backed.
 *
 * Proves the five properties the remediation had to deliver:
 *
 *   1. **fails safely** — a database the throttle cannot read refuses the login instead of
 *      waving it through, and an un-migrated database self-heals rather than losing
 *      protection silently;
 *   2. **per-source limiting works** — one IP has a whole-source budget and a
 *      credential-spraying budget;
 *   3. **an attacker cannot lock a legitimate administrator out** — the five-attempt budget
 *      is scoped to (identifier, source), so the account-wide backstop needs several
 *      distinct sources to trip;
 *   4. **legitimate login is preserved** — a correct password still returns 200 with an
 *      httpOnly cookie, including with no source header at all, and a successful login
 *      releases that account's own recorded failures;
 *   5. **a successful login is not a throttle-reset oracle (H-R1)** — signing in as account
 *      A leaves account B's recorded failures intact even when both share a source IP, so
 *      one valid low-privilege credential cannot make the guess budget repeatable;
 *   6. **concurrency cannot buy extra guesses (M-R2)** — a burst of simultaneous wrong
 *      passwords is enforced inside an advisory-locked transaction that inserts first and
 *      re-decides, so the number of real guesses never exceeds the configured budget;
 *   7. **one account has ONE budget across its aliases (M-R3)** — email and username
 *      attempts against the same account share it, while unknown accounts keep their own;
 *   8. **a failed repair is observable (M-R4a)** — when automatic repair is enabled but does
 *      not deliver the table, `/api/health` stops claiming that login services are ready.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/login-rate-limit-db.test.ts
 * (CI hard-requires execution via EASY_LEARN_REQUIRE_LOGIN_RATE_LIMIT_DB=true; a silent skip fails the job)
 * (falls back to embedded-postgres when installed)
 */
import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

const DB_NAME = `easylearn_ratelimit_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();

const ADMIN_EMAIL = `admin-${DB_NAME}@test.test`;
const ADMIN_PASSWORD = "Correct-Horse-1!";

/** Distinct RFC 5737 documentation addresses, so no test ever names a real host. */
const ATTACKER_IP = "203.0.113.66";
const OWNER_IP = "203.0.113.10";
const SPRAY_IP = "198.51.100.20";
const VOLUME_IP = "198.51.100.30";

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

async function main() {
  const { Client } = requireFromRepo("pg");
  const bcrypt = requireFromRepo("bcryptjs");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    /* Shared bootstrap: one credential pair for the cluster and the URL, a startup
       watchdog, and a guaranteed stop + data-dir cleanup even on failure. */
    const { startEmbeddedPostgres } = requireFromRepo("./tests/helpers/embedded-postgres.js");
    const port = 57801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const embedded = await startEmbeddedPostgres({
      dbName: DB_NAME,
      port,
      requireEnv: "EASY_LEARN_REQUIRE_LOGIN_RATE_LIMIT_DB",
    });
    if (!embedded) return; // SKIP printed by the helper (only when the suite is not required)
    adminUrl = embedded.adminUrl;
    stopServer = embedded.stop;
  }
  const { createScratchDatabase, assertCleanupSucceeded } = requireFromRepo("./tests/helpers/scratch-db.js");
  const admin = new Client({ connectionString: adminUrl });
  /* The shared helpers are CommonJS, so the scratch handle stays untyped. */
  let scratch: any = null;
  try {
    await admin.connect();
    const created = await createScratchDatabase({
      admin,
      adminUrl: adminUrl as string,
      dbName: DB_NAME,
      label: "login-rate-limit",
    });
    scratch = created;
    const scratchUrl = created.scratchUrl;
    const db = created.db;
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";
    const run = runMigrationChain({
      databaseUrl: scratchUrl,
      env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" },
    });
    assert.strictEqual(run.status, 0, "migrations must succeed");

    /* Imported only after the environment points at the scratch database: @/db throws at
       import time without a usable DATABASE_URL and caches its pool on globalThis. */
    const rateLimit = await import("@/lib/rate-limit");
    const resilience = await import("@/lib/schema-resilience");
    const { POST } = await import("@/app/api/auth/login/route");

    const {
      MAX_ATTEMPTS,
      MAX_ATTEMPTS_PER_IP,
      MAX_IDENTIFIERS_PER_IP,
      MAX_ATTEMPTS_PER_IDENTIFIER,
      WINDOW_MINUTES,
      checkLoginRateLimit,
      recordFailedLoginAttempt,
      clearFailedLoginAttempts,
    } = rateLimit;

    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, 'school_admin', 'Site', 'Admin', true)`,
      [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 4)]
    );

    /** Empty the throttle table and drop cached schema verdicts between scenarios. */
    async function reset() {
      await db.query(`DELETE FROM login_attempts`);
      resilience.resetSchemaFeatureCache();
    }

    /** Insert a failure row directly, optionally backdated, without going through the app. */
    async function seedFailure(identifier: string, ip: string | null, minutesAgo = 0) {
      await db.query(
        `INSERT INTO login_attempts (identifier, ip_address, created_at)
         VALUES (lower($1), $2, now() - make_interval(mins => $3::int))`,
        [identifier, ip, minutesAgo]
      );
    }

    async function seedFailures(identifier: string, ip: string | null, count: number, minutesAgo = 0) {
      for (let index = 0; index < count; index += 1) await seedFailure(identifier, ip, minutesAgo);
    }

    async function attemptRows(): Promise<number> {
      return Number((await db.query(`SELECT count(*)::int AS count FROM login_attempts`)).rows[0].count);
    }

    function loginRequest(body: Record<string, unknown>, sourceHeader?: string) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sourceHeader !== undefined) headers["x-forwarded-for"] = sourceHeader;
      return new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    }

    const wrongPassword = { email: ADMIN_EMAIL, password: "not-the-password" };
    const rightPassword = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };

    /* ── 1. Baseline: a clean account is unaffected ─────────────────────────────── */

    await test("a fresh identifier from a fresh source keeps the full budget", async () => {
      await reset();
      const result = await checkLoginRateLimit(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(result.allowed, true, "an account with no failures must be allowed");
      assert.strictEqual(result.reason, "none");
      assert.strictEqual(result.remainingAttempts, MAX_ATTEMPTS);
    });

    /* ── 2/3. The core H-1 fix: an attacker locks themselves out, not the admin ── */

    await test("five failures from one source block that source for that account", async () => {
      await reset();
      await seedFailures(ADMIN_EMAIL, ATTACKER_IP, MAX_ATTEMPTS);
      const attacker = await checkLoginRateLimit(ADMIN_EMAIL, ATTACKER_IP);
      assert.strictEqual(attacker.allowed, false, "the guessing source must be blocked");
      assert.strictEqual(attacker.reason, "identifier_source");
      assert.strictEqual(attacker.remainingAttempts, 0);
      assert(attacker.retryAfterSeconds && attacker.retryAfterSeconds > 0, "a retry window must be reported");
      assert(attacker.blockedUntil instanceof Date && attacker.blockedUntil.getTime() > Date.now());
      assert(attacker.message && attacker.message.length > 0);
    });

    await test("the legitimate owner on another source is NOT locked out (H-1 admin lockout)", async () => {
      /* Same table state as the previous test: the attacker has exhausted the scoped
         budget for this administrator account. Before the fix this locked the account for
         everybody for 30 minutes, which is a one-request denial of service. */
      const owner = await checkLoginRateLimit(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(owner.allowed, true, "a different source must still be allowed in");
      assert.strictEqual(owner.reason, "none");
      assert.strictEqual(owner.remainingAttempts, MAX_ATTEMPTS, "the owner keeps a full budget");
    });

    await test("the account-wide backstop still stops distributed guessing", async () => {
      await reset();
      const sources = ["203.0.113.71", "203.0.113.72", "203.0.113.73", "203.0.113.74"];
      const perSource = Math.ceil(MAX_ATTEMPTS_PER_IDENTIFIER / sources.length) + 1;
      for (const source of sources) {
        /* Stay under the per-source budget so only the aggregate bucket can trip. */
        await seedFailures(ADMIN_EMAIL, source, Math.min(perSource, MAX_ATTEMPTS - 1));
      }
      const total = Number(
        (await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE identifier = lower($1)`, [ADMIN_EMAIL])).rows[0].count
      );
      assert(total >= MAX_ATTEMPTS_PER_IDENTIFIER, `fixture must reach the backstop (seeded ${total})`);
      const distributed = await checkLoginRateLimit(ADMIN_EMAIL, "203.0.113.99");
      assert.strictEqual(distributed.allowed, false, "a fifth source must inherit the account-wide block");
      assert.strictEqual(distributed.reason, "identifier_total");
    });

    /* ── 4. Per-source limiting ────────────────────────────────────────────────── */

    await test("one source cannot spray many different accounts", async () => {
      await reset();
      for (let index = 0; index < MAX_IDENTIFIERS_PER_IP; index += 1) {
        await seedFailure(`spray-${index}-${DB_NAME}@test.test`, SPRAY_IP);
      }
      const fresh = await checkLoginRateLimit(`spray-victim-${DB_NAME}@test.test`, SPRAY_IP);
      assert.strictEqual(fresh.allowed, false, "the spraying source must be blocked before it reaches a new account");
      assert.strictEqual(fresh.reason, "source_total");

      const sameAccountElsewhere = await checkLoginRateLimit(`spray-victim-${DB_NAME}@test.test`, OWNER_IP);
      assert.strictEqual(sameAccountElsewhere.allowed, true, "spraying must not lock out unrelated sources");
    });

    await test("one source cannot exceed its whole-source failure budget", async () => {
      await reset();
      /* Fewer distinct identifiers than the spraying budget, so this asserts the volume
         rule specifically: MAX_ATTEMPTS_PER_IP failures from a single source. */
      const identifiers = Math.floor(MAX_ATTEMPTS_PER_IP / MAX_ATTEMPTS);
      assert(identifiers < MAX_IDENTIFIERS_PER_IP, "fixture must stay under the spraying budget");
      for (let index = 0; index < identifiers; index += 1) {
        await seedFailures(`volume-${index}-${DB_NAME}@test.test`, VOLUME_IP, MAX_ATTEMPTS);
      }
      const seeded = await attemptRows();
      assert.strictEqual(seeded, MAX_ATTEMPTS_PER_IP, `fixture must seed exactly the source budget (seeded ${seeded})`);

      const next = await checkLoginRateLimit(`volume-next-${DB_NAME}@test.test`, VOLUME_IP);
      assert.strictEqual(next.allowed, false, "the source budget must be exhausted");
      assert.strictEqual(next.reason, "source_total");
    });

    await test("failures outside the sliding window are not counted", async () => {
      await reset();
      await seedFailures(ADMIN_EMAIL, ATTACKER_IP, MAX_ATTEMPTS + 1, WINDOW_MINUTES + 5);
      const aged = await checkLoginRateLimit(ADMIN_EMAIL, ATTACKER_IP);
      assert.strictEqual(aged.allowed, true, "expired attempts must not block anybody");
      assert.strictEqual(aged.remainingAttempts, MAX_ATTEMPTS);
    });

    /* ── 5. Clearing on success ────────────────────────────────────────────────── */

    /* REVERSED by independent review finding H-R1 (2026-11-19). This test used to assert
       that a successful login emptied the whole source — `attemptRows() === 0` and the
       colleague "gets its budget back" — which is precisely the vulnerability: it is an
       amnesty for *other accounts'* recorded failures. The assertions are now inverted. */
    await test("clearing releases the signing-in account only, never other accounts on the same source", async () => {
      await reset();
      const COLLEAGUE = `colleague-${DB_NAME}@test.test`;
      await seedFailures(ADMIN_EMAIL, OWNER_IP, MAX_ATTEMPTS - 1);
      await seedFailures(COLLEAGUE, OWNER_IP, MAX_ATTEMPTS - 1);

      const before = await checkLoginRateLimit(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(before.allowed, true, "one attempt short of the budget must still be allowed");
      assert.strictEqual(before.remainingAttempts, 1);
      const colleagueBefore = await checkLoginRateLimit(COLLEAGUE, OWNER_IP);
      assert.strictEqual(colleagueBefore.remainingAttempts, 1, "fixture: the colleague is one attempt short too");

      await clearFailedLoginAttempts(ADMIN_EMAIL, OWNER_IP);

      const adminRows = Number(
        (await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE identifier = lower($1)`, [ADMIN_EMAIL]))
          .rows[0].count
      );
      assert.strictEqual(adminRows, 0, "the signing-in account's own failures must be released");
      assert.strictEqual(
        await attemptRows(),
        MAX_ATTEMPTS - 1,
        `only the colleague's ${MAX_ATTEMPTS - 1} rows may survive — a shared source is NOT an amnesty (H-R1)`
      );
      const colleague = await checkLoginRateLimit(COLLEAGUE, OWNER_IP);
      assert.strictEqual(colleague.remainingAttempts, 1, "another account on the same source keeps the budget it consumed");
      assert.strictEqual(colleague.allowed, true, "and is still one guess short of its own block, not reset to full");
    });

    await test("clearing still works with the historical single-argument signature", async () => {
      await reset();
      await seedFailures(ADMIN_EMAIL, null, MAX_ATTEMPTS);
      await clearFailedLoginAttempts(ADMIN_EMAIL);
      assert.strictEqual(await attemptRows(), 0);
    });

    /* ── 6. Unattributable sources are throttled, not exempt ───────────────────── */

    await test("an unattributable source shares one bucket per identifier and stores no sentinel", async () => {
      await reset();
      for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
        const recorded = await recordFailedLoginAttempt(ADMIN_EMAIL, index % 2 === 0 ? "unknown" : null);
        assert.strictEqual(recorded.recorded, true, `attempt ${index} must be stored`);
      }
      const sentinels = Number(
        (await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE ip_address = 'unknown'`)).rows[0].count
      );
      assert.strictEqual(sentinels, 0, "the legacy 'unknown' sentinel must never be written again");

      const result = await checkLoginRateLimit(ADMIN_EMAIL, null);
      assert.strictEqual(result.allowed, false, "no source header must not mean no throttle");
      assert.strictEqual(result.reason, "identifier_source");
    });

    /* ── 7. End-to-end through POST /api/auth/login ────────────────────────────── */

    await test("the route answers 429 with Retry-After once a source exhausts its budget", async () => {
      await reset();
      let lastStatus = 0;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const response = await POST(loginRequest(wrongPassword, ATTACKER_IP));
        lastStatus = response.status;
        assert.strictEqual(lastStatus, 401, `attempt ${attempt + 1} should be a normal 401`);
      }
      const throttled = await POST(loginRequest(wrongPassword, ATTACKER_IP));
      assert.strictEqual(throttled.status, 429, `expected 429 after ${MAX_ATTEMPTS} failures, got ${throttled.status}`);
      const retryAfter = throttled.headers.get("Retry-After");
      assert(retryAfter && Number(retryAfter) > 0, `Retry-After must be set (got ${retryAfter})`);
      assert.strictEqual(throttled.headers.get("Cache-Control"), "no-store");
      const body = (await throttled.json()) as { success: boolean; error?: string };
      assert.strictEqual(body.success, false);
      assert(typeof body.error === "string" && body.error.length > 0);
    });

    await test("the administrator can still sign in from their own source afterwards", async () => {
      /* The attacker is still throttled from the previous test — that is the point. */
      const ownerWrong = await POST(loginRequest(wrongPassword, OWNER_IP));
      assert.strictEqual(ownerWrong.status, 401, "the owner must get a normal 401, not a 429");

      const ownerRight = await POST(loginRequest(rightPassword, OWNER_IP));
      assert.strictEqual(ownerRight.status, 200, `the legitimate owner must still be able to sign in (got ${ownerRight.status})`);
      const setCookie = ownerRight.headers.get("set-cookie") ?? "";
      assert(setCookie.includes("HttpOnly"), "the session cookie must stay httpOnly");
      const payload = (await ownerRight.json()) as { success: boolean; data?: { user?: { email?: string; role?: string } } };
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.data?.user?.email, ADMIN_EMAIL);

      assert.strictEqual(
        await attemptRows(),
        0,
        "a successful login clears every recorded failure for that account, from any source"
      );
    });

    await test("an over-long x-forwarded-for can no longer switch throttling off", async () => {
      await reset();
      /* Before the fix this header made the INSERT fail against ip_address varchar(50);
         recordFailedLoginAttempt swallowed it, so the failures were never counted and the
         attacker could keep guessing forever. */
      const junk = "a".repeat(60);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const response = await POST(loginRequest(wrongPassword, junk));
        assert.strictEqual(response.status, 401, `attempt ${attempt + 1} should be a normal 401`);
      }
      const throttled = await POST(loginRequest(wrongPassword, junk));
      assert.strictEqual(throttled.status, 429, "a spoofed oversized header must not bypass the throttle");

      /* The 429 response is produced by the *check*, before any insert, so exactly the
         MAX_ATTEMPTS earlier failures are stored — all of them with a NULL source rather
         than an oversized junk value that would have made the insert throw. */
      const stored = await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE ip_address IS NULL`);
      assert.strictEqual(Number(stored.rows[0].count), MAX_ATTEMPTS, "every failure must be stored with a NULL source");
      assert.strictEqual(await attemptRows(), MAX_ATTEMPTS, "no failure may be lost");
    });

    await test("login still works with no source header at all", async () => {
      await reset();
      const denied = await POST(loginRequest(wrongPassword));
      assert.strictEqual(denied.status, 401);
      const granted = await POST(loginRequest(rightPassword));
      assert.strictEqual(granted.status, 200, "a missing source header must not break legitimate login");
    });

    /* ── 7b. H-R1 regression: a successful login must not reset another account ───── */

    await test("a successful login by account A cannot clear account B's failures from the same IP (H-R1)", async () => {
      await reset();
      const INSIDER_EMAIL = `insider-${DB_NAME}@test.test`;
      const INSIDER_PASSWORD = "Insider-Horse-1!";
      const SHARED_IP = "203.0.113.88";
      await db.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, 'learner', 'Ins', 'Ider', true)`,
        [INSIDER_EMAIL, await bcrypt.hash(INSIDER_PASSWORD, 4)]
      );

      /* The attack as measured by the independent review: guess against the administrator
         from the school's exit IP, then erase the accumulated evidence by signing in with
         the insider's own perfectly valid low-privilege credential from that same IP.
         Three cycles must yield ONE budget of guesses, not three. */
      const cycles = 3;
      const statuses: number[] = [];
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        for (let guess = 0; guess < MAX_ATTEMPTS - 1; guess += 1) {
          statuses.push((await POST(loginRequest(wrongPassword, SHARED_IP))).status);
        }
        const insider = await POST(
          loginRequest({ email: INSIDER_EMAIL, password: INSIDER_PASSWORD }, SHARED_IP)
        );
        assert.strictEqual(insider.status, 200, `the insider must still be able to sign in (cycle ${cycle + 1})`);
      }
      const afterAllCycles = (await POST(loginRequest(wrongPassword, SHARED_IP))).status;

      const attempted = statuses.filter((status) => status === 401).length;
      const throttled = statuses.filter((status) => status === 429).length;
      assert.strictEqual(attempted + throttled, statuses.length, "every guess must be answered 401 or 429");
      assert.strictEqual(
        attempted,
        MAX_ATTEMPTS,
        `H-R1: ${cycles} insider sign-ins must release at most one budget of ${MAX_ATTEMPTS} guesses, got ${attempted}`
      );
      assert(throttled > 0, "the later cycles must be refused rather than waved through by the insider's reset");
      assert.strictEqual(afterAllCycles, 429, "the administrator's budget must still be exhausted after three insider sign-ins");

      const victim = await checkLoginRateLimit(ADMIN_EMAIL, SHARED_IP);
      assert.strictEqual(victim.allowed, false, "H-R1: the victim account must still be blocked");
      const victimRows = Number(
        (await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE identifier = lower($1)`, [ADMIN_EMAIL]))
          .rows[0].count
      );
      assert(victimRows >= MAX_ATTEMPTS, `the victim's recorded failures must survive (found ${victimRows})`);

      /* The insider's own account is still released, so the fix did not simply disable
         clearing: the legitimate user who mistypes and then succeeds is not punished. */
      const insiderRows = Number(
        (await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE identifier = lower($1)`, [INSIDER_EMAIL]))
          .rows[0].count
      );
      assert.strictEqual(insiderRows, 0, "the signing-in account's own failures are still released");
    });

    /* ── 7c. M-R2 regression: concurrency must not buy extra guesses ───────────── */

    await test("M-R2: a concurrent burst from one source yields at most MAX_ATTEMPTS real guesses", async () => {
      await reset();
      const BURST_IP = "203.0.113.140";
      const burst = 25;
      /* The review measured this exactly: 30 simultaneous wrong-password requests all read an
         empty table before any of them wrote, so all 30 were answered 401 — six times the
         configured budget. Step 1 of the route is still a cheap read-only pre-check, so the
         burst does reach step 3 together; enforcement there is serialized by two advisory
         locks and re-decided on a count that already includes the in-flight row. */
      const responses = await Promise.all(
        Array.from({ length: burst }, () => POST(loginRequest(wrongPassword, BURST_IP)))
      );
      const statuses = await Promise.all(responses.map((response) => response.status));
      const guessed = statuses.filter((status) => status === 401).length;
      const refused = statuses.filter((status) => status === 429).length;
      assert.strictEqual(
        guessed + refused,
        statuses.length,
        `every response must be 401 or 429, got [${statuses.join(", ")}]`
      );
      assert.strictEqual(
        guessed,
        MAX_ATTEMPTS,
        `concurrency must not raise the pair budget above ${MAX_ATTEMPTS}: ${guessed} guesses were allowed`
      );
      assert.strictEqual(refused, burst - MAX_ATTEMPTS, "every request past the budget must be refused");

      /* A refused attempt is rolled back, so it cannot extend its own cooldown (finding L-R1
         is about the window, not about refusals multiplying it): exactly the counted guesses
         are stored. */
      const stored = Number(
        (await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE ip_address = $1`, [BURST_IP])).rows[0]
          .count
      );
      assert.strictEqual(stored, MAX_ATTEMPTS, `only the ${MAX_ATTEMPTS} counted guesses may be stored, found ${stored}`);

      const after = await checkLoginRateLimit(ADMIN_EMAIL, BURST_IP);
      assert.strictEqual(after.allowed, false, "the source must still be exhausted once the burst settles");
      assert.strictEqual(after.reason, "identifier_source");
      assert.strictEqual(after.remainingAttempts, 0);
    });

    await test("M-R2: a concurrent burst across many sources still respects the account backstop", async () => {
      await reset();
      /* Rotating the source defeats the pair budget, so the per-account backstop is the only
         limit left — and it is the one a parallel spray would blow through first. The account
         advisory lock is taken in a fixed order after the source lock, so 24 writers serialize
         instead of deadlocking. */
      const spray = MAX_ATTEMPTS_PER_IDENTIFIER + 9;
      const sources = Array.from({ length: spray }, (_, index) => `203.0.113.${160 + index}`);
      const responses = await Promise.all(
        sources.map((source) => POST(loginRequest(wrongPassword, source)))
      );
      const statuses = await Promise.all(responses.map((response) => response.status));
      const guessed = statuses.filter((status) => status === 401).length;
      const refused = statuses.filter((status) => status === 429).length;
      assert.strictEqual(guessed + refused, statuses.length, `unexpected statuses [${statuses.join(", ")}]`);
      assert.strictEqual(
        guessed,
        MAX_ATTEMPTS_PER_IDENTIFIER,
        `a parallel spray must not exceed the ${MAX_ATTEMPTS_PER_IDENTIFIER}-failure account backstop, got ${guessed}`
      );
      assert(refused > 0, "the rest of the spray must be refused");
      assert.strictEqual(
        await attemptRows(),
        MAX_ATTEMPTS_PER_IDENTIFIER,
        "refused attempts must not leave rows behind"
      );
    });

    /* ── 7d. M-R3 regression: one account, ONE budget across its aliases ───────── */

    await test("M-R3: email and username share one budget instead of two", async () => {
      await reset();
      const ADMIN_USERNAME = `admin-${DB_NAME}`;
      await db.query(`UPDATE users SET username = $1 WHERE email = $2`, [ADMIN_USERNAME, ADMIN_EMAIL]);
      /* Before the fix each alias carried its own MAX_ATTEMPTS_PER_IDENTIFIER budget, so the
         same account could be guessed 30 times over by alternating the identifier. Sources
         rotate so the pair budget (5 per identifier+source) never fires first. */
      const budget = MAX_ATTEMPTS_PER_IDENTIFIER;
      const wrongUsername = { username: ADMIN_USERNAME, password: "not-the-password" };
      const statuses: number[] = [];
      for (let index = 0; index < budget; index += 1) {
        const body = index % 2 === 1 ? wrongUsername : wrongPassword;
        statuses.push((await POST(loginRequest(body, `203.0.114.${index + 1}`))).status);
      }
      assert.strictEqual(
        statuses.filter((status) => status === 401).length,
        budget,
        `the first ${budget} guesses across both aliases must be allowed, got [${statuses.join(", ")}]`
      );

      const refusedByEmail = await POST(loginRequest(wrongPassword, "203.0.114.201"));
      assert.strictEqual(
        refusedByEmail.status,
        429,
        "once the shared account budget is gone, the email alias must be refused too"
      );
      const refusedByUsername = await POST(loginRequest(wrongUsername, "203.0.114.202"));
      assert.strictEqual(refusedByUsername.status, 429, "and so must the username alias");

      const grouped = (
        await db.query(
          `SELECT identifier, count(*)::int AS count FROM login_attempts GROUP BY identifier ORDER BY identifier`
        )
      ).rows as { identifier: string; count: number }[];
      assert.strictEqual(grouped.length, 2, `both aliases must have been used, got ${JSON.stringify(grouped)}`);
      const total = grouped.reduce((sum, row) => sum + row.count, 0);
      assert.strictEqual(
        total,
        budget,
        `the two aliases must share ONE budget of ${budget} stored failures, found ${total}`
      );

      /* The authoritative count needs the resolved account, which only the route knows: the
         alias-aware check is what refuses the next guess. */
      const shared = await checkLoginRateLimit([ADMIN_EMAIL, ADMIN_USERNAME], "203.0.114.203");
      assert.strictEqual(shared.allowed, false, "the alias set must be refused");
      assert.strictEqual(
        shared.reason,
        "identifier_total",
        "the shared account budget is what refused it, not the per-source one"
      );
      assert.strictEqual(shared.remainingAttempts, 0);

      /* The shared backstop is a real account lockout: it refuses the correct password too,
         through either alias. That is the intended trade (finding L-R1 tracks the length of
         the window), and it is precisely why the budget must not be duplicated per alias. */
      const ownerLockedOut = await POST(loginRequest({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }, OWNER_IP));
      assert.strictEqual(
        ownerLockedOut.status,
        429,
        `the exhausted shared budget must hold against the correct password too, got ${ownerLockedOut.status}`
      );
    });

    await test("M-R3: a successful sign-in releases every alias of that account, and nobody else's", async () => {
      await reset();
      const ADMIN_USERNAME = `admin-${DB_NAME}`;
      const COLLEAGUE = `colleague-${DB_NAME}@test.test`;
      /* A few failures spread over both aliases of one account, plus a different account on
         the same source, all far below every budget. */
      await seedFailure(ADMIN_EMAIL, OWNER_IP);
      await seedFailure(ADMIN_EMAIL, ATTACKER_IP);
      await seedFailure(ADMIN_USERNAME, ATTACKER_IP);
      await seedFailure(COLLEAGUE, OWNER_IP);
      assert.strictEqual(await attemptRows(), 4, "the fixture must be in place");

      const owner = await POST(loginRequest({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }, OWNER_IP));
      assert.strictEqual(owner.status, 200, `the legitimate owner must still get in, got ${owner.status}`);

      const survivors = (
        await db.query(`SELECT identifier, count(*)::int AS count FROM login_attempts GROUP BY identifier ORDER BY identifier`)
      ).rows as { identifier: string; count: number }[];
      assert.strictEqual(
        survivors.length,
        1,
        `only the colleague's rows may survive, got ${JSON.stringify(survivors)}`
      );
      assert.strictEqual(survivors[0].identifier, COLLEAGUE.toLowerCase(), "a different account is untouched (H-R1)");
      assert.strictEqual(survivors[0].count, 1, "and it keeps its own single recorded failure");
      /* The provisional row the successful attempt inserted was removed with the rest. */
      assert.strictEqual(await attemptRows(), 1, "exactly the colleague's failure remains");
    });

    await test("M-R3: unknown accounts keep their own budget and cannot borrow a real account's", async () => {
      await reset();
      const UNKNOWN = `nobody-${DB_NAME}@test.test`;
      const ENUMERATOR_IP = "203.0.115.7";
      for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
        const response = await POST(loginRequest({ email: UNKNOWN, password: "not-the-password" }, ENUMERATOR_IP));
        assert.strictEqual(response.status, 401, `enumeration attempt ${index + 1} must be counted normally`);
      }
      const refused = await POST(loginRequest({ email: UNKNOWN, password: "not-the-password" }, ENUMERATOR_IP));
      assert.strictEqual(
        refused.status,
        429,
        "alias-aware counting must not weaken the protection for accounts that do not resolve"
      );
      const unknownRows = Number(
        (await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE identifier = lower($1)`, [UNKNOWN]))
          .rows[0].count
      );
      assert.strictEqual(unknownRows, MAX_ATTEMPTS, "the unknown account's own failures must be stored");
      const realAccount = await checkLoginRateLimit(ADMIN_EMAIL, ENUMERATOR_IP);
      assert.strictEqual(realAccount.allowed, true, "a different account from the same source keeps its own budget");
    });

    /* ── 8. Fail safely: self-heal, then fail closed ───────────────────────────── */

    await test("a missing login_attempts table is repaired instead of disabling throttling", async () => {
      await reset();
      await db.query(`DROP TABLE login_attempts`);
      resilience.resetSchemaFeatureCache();
      delete process.env.AUTO_SCHEMA_REPAIR; // default: repair enabled

      const result = await checkLoginRateLimit(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(result.allowed, true, "an empty, freshly repaired table allows the login");
      assert.strictEqual(result.reason, "none", "the check must succeed, not fall back to unavailable");

      const indexes = (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'login_attempts'`)).rows.map(
        (row: { indexname: string }) => row.indexname
      );
      for (const expected of [
        "login_attempts_identifier_idx",
        "login_attempts_created_at_idx",
        "login_attempts_identifier_created_at_idx",
        "login_attempts_ip_created_at_idx",
      ]) {
        assert(indexes.includes(expected), `self-heal must recreate ${expected} (found ${indexes.join(", ")})`);
      }

      const recorded = await recordFailedLoginAttempt(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(recorded.recorded, true, "recording must work again after the repair");
    });

    await test("with repair disabled the throttle FAILS CLOSED (no more fail-open)", async () => {
      await db.query(`DROP TABLE login_attempts`);
      process.env.AUTO_SCHEMA_REPAIR = "false";
      resilience.resetSchemaFeatureCache();

      const checked = await checkLoginRateLimit(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(checked.allowed, false, "an unevaluable check must refuse the login");
      assert.strictEqual(checked.reason, "unavailable");
      assert(checked.retryAfterSeconds && checked.retryAfterSeconds > 0, "a bounded retry window must be given");
      assert(checked.message && checked.message.length > 0);

      const recorded = await recordFailedLoginAttempt(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(recorded.recorded, false, "a failure that cannot be stored must be reported as unstored");
      assert(typeof recorded.reason === "string" && recorded.reason.length > 0);

      const response = await POST(loginRequest(wrongPassword, OWNER_IP));
      assert.strictEqual(response.status, 503, `a degraded throttle must answer 503, got ${response.status}`);
      assert(response.headers.get("Retry-After"), "the degraded response must carry Retry-After");
      const body = (await response.json()) as { success: boolean };
      assert.strictEqual(body.success, false);
    });

    await test("the correct password is still refused while the throttle is degraded", async () => {
      /* Fail-safe means fail-safe in both directions: with no way to detect guessing, the
         endpoint does not verify passwords at all. */
      const response = await POST(loginRequest(rightPassword, OWNER_IP));
      assert.strictEqual(response.status, 503, `expected 503 while degraded, got ${response.status}`);
    });

    await test("/api/health reports the degraded throttle instead of 'ready'", async () => {
      /* Still degraded from the previous test: login_attempts is gone and repair is off, so
         every login now answers 503. The health endpoint must say so — reporting "Login and
         registration services are ready" in that state is the exact mistake Issue #54 found
         for session revocation. */
      const { GET } = await import("@/app/api/health/route");
      const response = await GET();
      assert.strictEqual(response.status, 503, `expected 503, got ${response.status}`);
      const body = (await response.json()) as {
        ok: boolean;
        message?: string;
        checks?: { optionalMigrations?: Record<string, boolean>; migrationWarnings?: string[] };
      };
      assert.strictEqual(body.ok, false);
      assert.match(body.message ?? "", /login throttling/i, "the message must name login throttling");
      assert.match(body.message ?? "", /0012_login_attempts/, "the message must name the migration");
      assert.strictEqual(body.checks?.optionalMigrations?.login_attempts, false, "the probe must report the feature");
    });

    await test("F-1: /api/health reports a missing throttle table even though repair could recreate it", async () => {
      /* This assertion was the OPPOSITE before review findings F-1/F-4, and the change is
         deliberate. "Automatic repair is enabled" is a promise about the future; the question
         this endpoint answers is whether sign-in works *now*, and with login_attempts gone it
         does not — every login answers 503, correct passwords included.

         Escalation used to require a *recorded* repair failure, and only a request path ever
         records one (/api/health never runs DDL). Measured on a fresh isolate: 200 ok:true
         "Login and registration services are ready." before the first login, 503 after it. */
      delete process.env.AUTO_SCHEMA_REPAIR;
      resilience.resetSchemaFeatureCache();
      const { GET } = await import("@/app/api/health/route");
      const response = await GET();
      assert.strictEqual(response.status, 503, `a missing throttle table is not "ready", got ${response.status}`);
      const body = (await response.json()) as {
        ok: boolean;
        checks?: { optionalMigrations?: Record<string, boolean>; migrationWarnings?: string[] };
      };
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.checks?.optionalMigrations?.login_attempts, false);
      const warned = (body.checks?.migrationWarnings ?? []).some((warning) => warning.includes("0012_login_attempts.sql"));
      assert(warned, "the missing table must still be surfaced as a warning");

      /* And it stays self-correcting: the moment repair actually delivers the table the
         endpoint goes green again, with no restart and no operator action. */
      const repaired = await resilience.ensureLoginAttemptSchema();
      assert.strictEqual(repaired.available, true, "repair must still work when it is allowed to");
      resilience.resetSchemaFeatureCache();
      const recovered = await GET();
      assert.strictEqual(recovered.status, 200, `health must recover once the table exists, got ${recovered.status}`);
      assert.strictEqual(((await recovered.json()) as { ok: boolean }).ok, true);
    });

    /* ── 9. M-R4a regression: a failed repair must be visible to /api/health ───── */

    await test("M-R4a: an enabled-but-failing repair makes /api/health unhealthy, not 'ready'", async () => {
      /* Production evidence (2026-11-19): the runtime role is neondb_owner and
         has_schema_privilege(current_user, 'public', 'CREATE') is true, so repair *can* work
         there. This suite's role is the database owner too, which no REVOKE can demote, so
         the failure is injected instead: DDL statements are blocked while read-only probes
         still answer. That is exactly the state Production would be in if the privilege were
         ever revoked, the disk were full, or a statement were invalid — and it is the state
         in which /api/health used to answer 200 "Login and registration services are ready"
         while every single login answered 503. */
      /* The previous scenario now repairs the table on its way out (F-1), so this one drops it
         again to start from the missing-table state it needs. */
      await db.query(`DROP TABLE IF EXISTS login_attempts`);
      delete process.env.AUTO_SCHEMA_REPAIR; // repair stays ENABLED: that was the blind spot
      resilience.resetSchemaFeatureCache();

      const { pool } = await import("@/db");
      const poolForStub = pool as unknown as { query: (...args: never[]) => Promise<unknown> };
      const realQuery = poolForStub.query;
      const boundQuery = realQuery.bind(pool) as (text: unknown, ...args: unknown[]) => Promise<unknown>;
      const denial = Object.assign(new Error("permission denied for schema public"), { code: "42501" });
      poolForStub.query = ((sql: unknown, ...rest: unknown[]) => {
        /* CREATE **and** ALTER: since F-1 the self-heal runs three additive
           `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` repairs after the CREATE TABLE, and a
           role that may not create in `public` may not alter it either. Denying only CREATE
           let those three reach the real database and fail with a *different* error, so the
           ledger recorded "relation does not exist" instead of the privilege denial this
           scenario simulates. */
        if (/^\s*(CREATE|ALTER)/i.test(String(sql))) return Promise.reject(denial);
        return boundQuery(sql, ...rest);
      }) as typeof poolForStub.query;

      try {
        /* A login attempt is what exercises the repair, so this is the order the failure
           becomes observable in: the first sign-in 503s and records the failed repair. */
        const login = await POST(loginRequest(wrongPassword, OWNER_IP));
        assert.strictEqual(login.status, 503, `the throttle must fail closed, got ${login.status}`);

        /* THE regression. Before the fix this answered 200 "Login and registration services
           are ready" — because the escalation branch only fired when repair was DISABLED, and
           here repair is enabled, privileged, and still broken. */
        const { GET } = await import("@/app/api/health/route");
        const response = await GET();
        assert.strictEqual(response.status, 503, `a failed repair must be unhealthy, got ${response.status}`);
        const body = (await response.json()) as {
          ok: boolean;
          message?: string;
          checks?: { optionalMigrations?: Record<string, boolean> };
        };
        assert.strictEqual(body.ok, false, "health must not claim readiness while every login answers 503");
        assert.match(body.message ?? "", /login throttling/i, "the message must name login throttling");
        assert.match(body.message ?? "", /0012_login_attempts/, "and the migration that fixes it");
        assert.strictEqual(body.checks?.optionalMigrations?.login_attempts, false, "the probe must report the feature missing");

        /* The mechanism behind that verdict. */
        const capabilities = await resilience.probeSchemaFeatures(["login_attempts"]);
        const throttledFeature = capabilities.find((item) => item.feature === "login_attempts");
        assert(throttledFeature, "the probe must report the throttle feature");
        assert.strictEqual(throttledFeature!.present, false, "the table is gone");
        assert.strictEqual(throttledFeature!.repairEnabled, true, "repair is enabled — the old check stopped here");
        assert.strictEqual(
          throttledFeature!.ddlCapable,
          true,
          "this role can create in public (matching Production's neondb_owner), so the capability probe alone must not escalate"
        );

        const failure = resilience.getSchemaRepairFailure("login_attempts");
        assert(failure, "the failed repair must be recorded, not only logged");
        assert.strictEqual(failure!.feature, "login_attempts");
        assert.strictEqual(failure!.appliedStatements, 0, "no statement may be reported as applied");
        /* Eight since F-1: the original CREATE TABLE + four indexes, plus the three additive
           ALTERs that let the self-heal repair a *drifted* relation and not only a missing one. */
        assert.strictEqual(failure!.totalStatements, 8, "the ledger must know the size of the repair");
        assert.match(failure!.reason, /permission denied/, "the recorded reason must be the database error");
        assert(failure!.at <= Date.now() && failure!.at > Date.now() - 60_000, "the failure must be timestamped now");

        const blocked = await resilience.probeSchemaFeatures(["login_attempts"]);
        const item = blocked.find((entry) => entry.feature === "login_attempts")!;
        assert.strictEqual(item.repairFailed, true, "the probe must expose the recorded failure");
        assert.strictEqual(
          item.repairBlocked,
          true,
          "repair enabled + repair failed must be treated as blocked, even though the role is privileged"
        );

        /* Finding L-4: the endpoint is unauthenticated, so the cause stays in the server log.
           The recorded reason and the privilege wording must not appear in the response. */
        const text = JSON.stringify(body);
        assert(!text.includes(failure!.reason), "the database error text must not be echoed to clients");
        assert(
          !/permission denied|42501|has_schema_privilege|appliedStatements|statements applied/i.test(text),
          `the response must not disclose the cause: ${text}`
        );
      } finally {
        poolForStub.query = realQuery;
      }
    });

    await test("M-R4a: a successful repair clears the failure and health recovers", async () => {
      /* The ledger must not be sticky: once repair delivers the object, health goes green
         again without a restart, otherwise the first incident would alert forever. */
      resilience.resetSchemaFeatureCache();
      const repaired = await resilience.ensureLoginAttemptSchema();
      assert.strictEqual(repaired.available, true, "with DDL unblocked the table must come back");
      assert.strictEqual(repaired.repaired, true);
      assert.strictEqual(resilience.getSchemaRepairFailure("login_attempts"), null, "the recorded failure must be cleared");

      const capabilities = await resilience.probeSchemaFeatures(["login_attempts"]);
      const item = capabilities.find((entry) => entry.feature === "login_attempts")!;
      assert.strictEqual(item.present, true);
      assert.strictEqual(item.repairFailed, false);
      assert.strictEqual(item.repairBlocked, false);

      const { GET } = await import("@/app/api/health/route");
      const response = await GET();
      assert.strictEqual(response.status, 200, `health must recover, got ${response.status}`);
      const body = (await response.json()) as { ok: boolean };
      assert.strictEqual(body.ok, true);

      const login = await POST(loginRequest(wrongPassword, OWNER_IP));
      assert.strictEqual(login.status, 401, "throttling must be live again (a normal 401, not a degraded 503)");
    });

    /* ── 10. Second independent review (F-1 … F-10): behavioural regressions ─────
       Each test below reproduces a state the reviewer measured by hand against e4c7b41 and
       found the suites silent about. They are written to fail against that commit. */

    const DRIFT_IP = "198.51.100.40";
    const FORGED_IP = "198.51.100.41";
    const LOCKWAIT_IP = "198.51.100.42";
    const CRASH_IP = "198.51.100.43";
    const { pool } = await import("@/db");
    const { GET: healthGet } = await import("@/app/api/health/route");
    const auth = await import("@/lib/auth");
    type HealthBody = {
      ok: boolean;
      message?: string;
      checks?: { optionalMigrations?: Record<string, boolean>; migrationWarnings?: string[] };
    };
    const healthBody = async (): Promise<{ status: number; body: HealthBody }> => {
      const response = await healthGet();
      return { status: response.status, body: (await response.json()) as HealthBody };
    };
    /** Stub `pool.query` for the statements matching `predicate`; always restored. */
    const withPoolStub = async (
      predicate: (sql: string) => boolean,
      message: string,
      code: string,
      body: () => Promise<void>
    ) => {
      const poolForStub = pool as unknown as { query: (...args: never[]) => Promise<unknown> };
      const realQuery = poolForStub.query;
      const boundQuery = realQuery.bind(pool) as (text: unknown, ...args: unknown[]) => Promise<unknown>;
      const denial = Object.assign(new Error(message), { code });
      poolForStub.query = ((sql: unknown, ...rest: unknown[]) =>
        predicate(String(sql)) ? Promise.reject(denial) : boundQuery(sql, ...rest)) as typeof poolForStub.query;
      try {
        await body();
      } finally {
        poolForStub.query = realQuery;
      }
    };

    await test("F-1: a drifted login_attempts column is unhealthy AND self-heals (was a permanent silent outage)", async () => {
      /* The reviewer's measurement against e4c7b41, three rounds with the CORRECT password:
           login => 503; health => 200 ok=true "Login and registration services are ready."
           ensureLoginAttemptSchema.available=true  repaired=false  ledger=empty
         Relation-mode probing reported the feature present, the self-heal DDL contained no
         ALTER, so nothing could ever repair it and nothing could ever escalate: a total login
         outage that monitoring could not see. */
      await reset();
      await db.query(`ALTER TABLE login_attempts DROP COLUMN ip_address`);
      resilience.resetSchemaFeatureCache();
      delete process.env.AUTO_SCHEMA_REPAIR;

      const before = await healthBody();
      assert.strictEqual(before.status, 503, `a drifted throttle is not ready, got ${before.status}`);
      assert.strictEqual(before.body.ok, false, "ok must not be true while login answers 503");
      assert.strictEqual(
        before.body.checks?.optionalMigrations?.login_attempts,
        false,
        "the probe must check the columns the throttle reads, not only the relation"
      );

      /* One login attempt is enough to repair it now: a missing column (42703) triggers the
         same self-heal a missing relation does, and the additive ALTERs restore the column. */
      const firstLogin = await POST(loginRequest(wrongPassword, DRIFT_IP));
      assert.strictEqual(firstLogin.status, 401, `the throttle must be live again, got ${firstLogin.status}`);
      const columns = (
        await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'login_attempts' ORDER BY column_name`
        )
      ).rows.map((row: { column_name: string }) => row.column_name);
      for (const expected of ["created_at", "id", "identifier", "ip_address"]) {
        assert(columns.includes(expected), `self-heal must restore ${expected} (found ${columns.join(", ")})`);
      }
      const after = await healthBody();
      assert.strictEqual(after.status, 200, `health must recover, got ${after.status}`);
      assert.strictEqual(after.body.ok, true);
      assert.strictEqual(await attemptRows(), 1, "the attempt that triggered the repair must still be recorded");
    });

    await test("F-1: a fresh process with a blocked repair is unhealthy BEFORE any login attempt", async () => {
      /* Measured on e4c7b41: health answered 200 ok:true until the first login happened to
         attempt a repair and record the failure. Escalation that waits for a request is not a
         health check. */
      await reset();
      await db.query(`DROP TABLE IF EXISTS login_attempts`);
      delete process.env.AUTO_SCHEMA_REPAIR;
      resilience.resetSchemaFeatureCache();

      await withPoolStub(
        (sql) => /^\s*(CREATE|ALTER)/i.test(sql),
        "permission denied for schema public",
        "42501",
        async () => {
          const first = await healthBody();
          assert.strictEqual(first.status, 503, `no login has run yet, so nothing recorded a failure: got ${first.status}`);
          assert.strictEqual(first.body.ok, false);
          assert.strictEqual(resilience.getSchemaRepairFailure("login_attempts"), null, "the ledger is still empty — that was the blind spot");

          const login = await POST(loginRequest(wrongPassword, DRIFT_IP));
          assert.strictEqual(login.status, 503, "the throttle must fail closed");
          const second = await healthBody();
          assert.strictEqual(second.status, 503, "and health must stay unhealthy after the failed repair");
          assert(resilience.getSchemaRepairFailure("login_attempts"), "the repair failure is recorded now");
        }
      );

      /* Recovery: with DDL allowed again the table comes back and health goes green. */
      resilience.resetSchemaFeatureCache();
      const repaired = await resilience.ensureLoginAttemptSchema();
      assert.strictEqual(repaired.available, true);
      resilience.resetSchemaFeatureCache();
      const recovered = await healthBody();
      assert.strictEqual(recovered.status, 200, `health must recover, got ${recovered.status}`);
    });

    await test("F-4: a missing session_revocation column is unhealthy even with repair enabled and DDL blocked", async () => {
      /* Measured on e4c7b41: 200 ok:true, ledger empty, forever — because no login touches
         users.session_version, so nothing ever attempted (and therefore recorded) a repair.
         The roadmap claimed "the same blind spot is closed for session_revocation". */
      await reset();
      await db.query(`ALTER TABLE users DROP COLUMN session_version`);
      delete process.env.AUTO_SCHEMA_REPAIR;
      resilience.resetSchemaFeatureCache();
      try {
        await withPoolStub(
          (sql) => /^\s*(CREATE|ALTER)/i.test(sql),
          "permission denied for schema public",
          "42501",
          async () => {
            const { status, body } = await healthBody();
            assert.strictEqual(status, 503, `session revocation failing closed is not "ready", got ${status}`);
            assert.strictEqual(body.ok, false);
            assert.strictEqual(body.checks?.optionalMigrations?.session_revocation, false);
            assert.match(body.message ?? "", /session revocation/i, "the message must name the affected control");
          }
        );
        /* And without the DDL block: still unhealthy, because the column is missing NOW. */
        resilience.resetSchemaFeatureCache();
        const stillMissing = await healthBody();
        assert.strictEqual(stillMissing.status, 503, `a missing column is unhealthy whatever the repair settings, got ${stillMissing.status}`);
      } finally {
        await db.query(`ALTER TABLE users ADD COLUMN session_version integer DEFAULT 0 NOT NULL`);
        resilience.resetSchemaFeatureCache();
      }
      const recovered = await healthBody();
      assert.strictEqual(recovered.status, 200, `health must recover once the column is back, got ${recovered.status}`);
      assert.strictEqual(recovered.body.ok, true);
    });

    await test("F-7: an errored probe cannot produce ok:true next to a false security-critical flag", async () => {
      /* Measured on e4c7b41: a transient probe error produced `ok:true` with
         `login_attempts: false` in the SAME body — a response that contradicts itself, so
         flag-based alerting fires while `ok` says healthy. */
      await reset();
      resilience.resetSchemaFeatureCache();
      await withPoolStub(
        (sql) => /information_schema\.columns/.test(sql) && /login_attempts/.test(sql),
        "connection reset by peer",
        "08006",
        async () => {
          resilience.resetSchemaFeatureCache();
          const { status, body } = await healthBody();
          assert.notStrictEqual(
            body.ok === true && body.checks?.optionalMigrations?.login_attempts === false,
            true,
            "the body must never claim readiness while reporting the throttle as absent"
          );
          assert.strictEqual(status, 503, `an unverifiable throttle state is not ready, got ${status}`);
          assert.strictEqual(body.ok, false);
          const cause = resilience.getSchemaProbeFailure("login_attempts");
          assert(cause, "an errored probe must leave a retrievable cause instead of silence");
          assert.match(cause!.text, /connection reset by peer/, "the cause must carry the database error");
          assert.strictEqual(cause!.code, "08006", "and its SQLSTATE");
          assert.strictEqual(
            resilience.getSchemaRepairFailure("login_attempts"),
            null,
            "a probe that errored applied no statements, so it must not be recorded as a failed repair"
          );
        }
      );
      resilience.resetSchemaFeatureCache();
      const recovered = await healthBody();
      assert.strictEqual(recovered.status, 200, `a transient probe error must clear, got ${recovered.status}`);
      assert.strictEqual(recovered.body.ok, true);
      assert.strictEqual(
        resilience.getSchemaProbeFailure("login_attempts"),
        null,
        "a probe that answers again must clear the recorded cause"
      );
    });

    await test("F-3: forged x-real-ip values buy no extra guesses (route level)", async () => {
      /* Attribution-level assertions existed only as unit tests; nothing drove the real route.
         On e4c7b41 each forged x-real-ip was a fresh per-source bucket, so every request below
         was a real guess. Now the chain ends at `null` and all of them share one per-account
         bucket, exactly as an attributed source would. */
      await reset();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < MAX_ATTEMPTS + 1; attempt += 1) {
        const response = await POST(
          new NextRequest("http://localhost/api/auth/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-forwarded-for": "junk-at-the-trusted-position",
              "x-real-ip": `203.0.113.${attempt + 1}`,
            },
            body: JSON.stringify(wrongPassword),
          })
        );
        statuses.push(response.status);
      }
      assert.deepStrictEqual(
        statuses.slice(0, MAX_ATTEMPTS),
        Array<number>(MAX_ATTEMPTS).fill(401),
        `the first ${MAX_ATTEMPTS} forged attempts are ordinary failures: ${statuses.join(",")}`
      );
      assert.strictEqual(statuses[MAX_ATTEMPTS], 429, `the forged header must not buy a sixth guess: ${statuses.join(",")}`);
      assert.strictEqual(await attemptRows(), MAX_ATTEMPTS, "and every one of them must be stored");
      const stored = (
        await db.query(`SELECT count(*)::int AS count FROM login_attempts WHERE ip_address IS NULL`)
      ).rows[0].count;
      assert.strictEqual(stored, MAX_ATTEMPTS, "an unattributable source stores NULL, never a sentinel or a forged value");
      assert.strictEqual(
        rateLimit.getClientIp(
          new NextRequest("http://localhost/api/auth/login", {
            method: "POST",
            headers: { "x-forwarded-for": "junk", "x-real-ip": FORGED_IP },
          })
        ),
        null,
        "the forged header must not be readable as a source at all"
      );
    });

    await test("F-5: a lock held elsewhere fails closed within the bound and does not take the pool with it", async () => {
      /* On e4c7b41 `pg_advisory_xact_lock` waited forever. With the Production pool at two
         connections the reviewer measured two such waits making GET /api/health answer 503 and
         `pool.query('SELECT 1')` error — the whole application, not just login. */
      await reset();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      const bound = rateLimit.loginLockTimeoutMs();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`source:${LOCKWAIT_IP}`]);

        const started = Date.now();
        const response = await POST(loginRequest(wrongPassword, LOCKWAIT_IP));
        const elapsed = Date.now() - started;
        assert.strictEqual(response.status, 503, `a lock wait that times out must fail closed, got ${response.status}`);
        assert(response.headers.get("Retry-After"), "the degraded response must carry Retry-After");
        assert(
          elapsed < bound + 3000,
          `the wait must be bounded by lock_timeout (${bound}ms), took ${elapsed}ms`
        );
        assert.strictEqual(await attemptRows(), 0, "a timed-out attempt must not be recorded");

        /* The point of the bound: the connection came back, so the rest of the app still works. */
        await pool.query("SELECT 1");
        const during = await healthBody();
        assert.strictEqual(during.status, 200, `/api/health must stay green while one login waits, got ${during.status}`);

        await blocker.query("ROLLBACK");
        const recovered = await POST(loginRequest(wrongPassword, LOCKWAIT_IP));
        assert.strictEqual(recovered.status, 401, `the next login must work once the lock is free, got ${recovered.status}`);
        assert.strictEqual(await attemptRows(), 1);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end().catch(() => undefined);
      }
      /* Scoped to THIS database on purpose: `pg_locks` is cluster-wide, and an earlier run of
         the mutation harness left three orphaned advisory locks in a scratch database whose
         suite had been killed mid-wait. Counting them made this assertion fail on a healthy
         run (3 !== 0) — the same false failure a shared CI PostgreSQL service could produce. */
      const locks = Number(
        (await db.query(`SELECT count(*)::int AS count FROM pg_locks
                WHERE locktype = 'advisory'
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].count
      );
      assert.strictEqual(locks, 0, "no advisory lock may outlive the request that took it");
    });

    await test("F-2: a backend killed mid-transaction degrades one login instead of killing the process", async () => {
      /* On e4c7b41 the checked-out client had no 'error' listener (pg-pool detaches its own on
         checkout), so a 57P01 during the transaction was an unhandled 'error' event: the
         reviewer's probe process died. If this test regresses, the whole suite dies with it. */
      await reset();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      try {
        /* Hold the SOURCE lock, which is the first of the two advisory locks the enforcement
           transaction takes (`lockKeys` in src/lib/rate-limit.ts). The backend is then inside
           an open transaction — BEGIN and `SET LOCAL lock_timeout` have both run — and waiting,
           which is exactly the state in which a 57P01 is fatal to an unlistened client.
           (Holding `account:<email>` instead does not work: that key is built from EVERY alias
           of the resolved account, so it is `account:<sorted aliases joined by |>`, not the
           supplied identifier — measured, the login sailed straight through.) */
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `source:${CRASH_IP}`,
        ]);

        const inFlight = POST(loginRequest(wrongPassword, CRASH_IP));
        let pid: number | null = null;
        for (let attempt = 0; attempt < 80 && pid === null; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const waiting = await db.query(
            `SELECT pid FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock' AND wait_event = 'advisory'
                AND pid <> pg_backend_pid()
              ORDER BY backend_start DESC LIMIT 1`
          );
          pid = waiting.rows[0] ? Number(waiting.rows[0].pid) : null;
        }
        assert(pid !== null, "the login must be observed waiting on the advisory lock");
        await db.query("SELECT pg_terminate_backend($1)", [pid]);

        const response = await inFlight;
        assert.strictEqual(response.status, 503, `the killed attempt must fail closed, got ${response.status}`);
        assert(response.headers.get("Retry-After"), "the degraded response must carry Retry-After");
        assert.strictEqual(await attemptRows(), 0, "a killed attempt must not be recorded");

        /* Reaching this line at all is the assertion that matters. The rest proves the pool is
           not left holding a dead client or an orphaned lock. */
        await pool.query("SELECT 1");
        const locks = Number(
          (await db.query(`SELECT count(*)::int AS count FROM pg_locks
                WHERE locktype = 'advisory'
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].count
        );
        assert(locks <= 1, `only the blocker's own lock may remain, found ${locks}`);
        const stuck = Number(
          (
            await db.query(
              `SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'idle in transaction'`
            )
          ).rows[0].count
        );
        assert(stuck <= 1, `no app connection may be left idle in transaction, found ${stuck}`);

        await blocker.query("ROLLBACK");
        const recovered = await POST(loginRequest(wrongPassword, CRASH_IP));
        assert.strictEqual(recovered.status, 401, `login must work again, got ${recovered.status}`);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end().catch(() => undefined);
      }
    });

    await test("F-6: an account cannot be created whose email is another account's username", async () => {
      /* Measured on e4c7b41: signing in to an account whose email equalled a SECOND account's
         username erased the second account's recorded failures, 4 -> 0, because the throttle
         identifies accounts by string. Nothing in the schema can express cross-column
         uniqueness, so the invariant is enforced at the only path that creates accounts. */
      /* schools_slug_format_check allows only ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$, and the
         scratch database name contains an underscore. */
      const slugSafe = DB_NAME.replace(/[^a-z0-9-]/g, "-");
      const school = (
        await db.query(
          `INSERT INTO schools (name, short_name, slug) VALUES ($1, 'F6S', $2) RETURNING id`,
          [`Alias School ${DB_NAME}`, `alias-${slugSafe}`]
        )
      ).rows[0].id as string;
      const adminRow = (
        await db.query(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
           VALUES ($1, $2, 'school_admin', 'Alias', 'Admin', true) RETURNING id, session_version`,
          [`alias-admin-${DB_NAME}@school.test`, await bcrypt.hash("Alias-Admin-1!", 4)]
        )
      ).rows[0] as { id: string; session_version: number };
      await db.query(
        `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'school_admin', 'active')`,
        [school, adminRow.id]
      );
      /* The victim: an account whose USERNAME is an email-shaped string. It has to be
         email-shaped because the route now rejects a malformed `email` with 400 long before
         the collision check runs — a bare username as an email is the `malformed` case below,
         and this one is the legacy-data case the collision guard exists for. */
      const victimUsername = `victim-${DB_NAME}@school.test`;
      await db.query(
        `INSERT INTO users (username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, 'learner', 'Vic', 'Tim', true)`,
        [victimUsername, await bcrypt.hash("Victim-Password-1!", 4)]
      );
      /* Legacy data can also hold the reverse: an email that looks like a username. */
      await db.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, 'learner', 'Legacy', 'Email', true)`,
        [`jsmith-${DB_NAME}`, await bcrypt.hash("Legacy-Password-1!", 4)]
      );

      const token = await auth.createToken({
        userId: adminRow.id,
        role: "school_admin",
        email: `alias-admin-${DB_NAME}@school.test`,
        schoolId: school,
        sessionVersion: Number(adminRow.session_version ?? 0),
      });
      const { POST: createUsers } = await import("@/app/api/users/route");
      const createUser = (payload: Record<string, unknown>) =>
        createUsers(
          new NextRequest("http://localhost/api/users", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
          })
        );

      const collision = await createUser({
        email: victimUsername,
        password: "Collider-1!",
        firstName: "Col",
        lastName: "Lider",
        role: "teacher",
      });
      assert.strictEqual(collision.status, 409, `an email that is another account's username must be refused, got ${collision.status}`);

      const malformed = await createUser({
        email: "not-an-email",
        password: "Malformed-1!",
        firstName: "Mal",
        lastName: "Formed",
        role: "teacher",
      });
      assert.strictEqual(malformed.status, 400, `a bare username must not be storable as an email, got ${malformed.status}`);

      /* The reverse direction: the generated username must skip an existing email, so an
         ordinary creation still succeeds instead of being refused. */
      const generated = await createUser({
        password: "Learner-1!",
        firstName: "j",
        lastName: `smith-${DB_NAME}`,
        role: "learner",
      });
      assert.ok(generated.status === 200 || generated.status === 201, `an ordinary creation must succeed, got ${generated.status}`);
      const createdUsername = String(
        (await db.query(`SELECT username FROM users WHERE last_name = $1`, [`smith-${DB_NAME}`])).rows[0]?.username ?? ""
      );
      assert.notStrictEqual(createdUsername, `jsmith-${DB_NAME}`, "the generated username must not be an existing email");
      assert(
        createdUsername.startsWith(`jsmith-${DB_NAME}`.toLowerCase()),
        `the generated username must be the suffixed form, got ${createdUsername}`
      );

      const rows = Number(
        (await db.query(`SELECT count(*)::int AS count FROM users WHERE lower(email) = lower($1)`, [victimUsername])).rows[0].count
      );
      assert.strictEqual(rows, 0, "no account may hold another account's username as its email");
    });

    /* ── 11. F-1 follow-up: a drifted table must come back with ALL FOUR indexes ────────

       `ALTER TABLE ... DROP COLUMN` also drops every index that depends on the column, and
       the repair list runs in order, skipping (not aborting on) a statement that fails. With
       the indexes listed BEFORE the additive column repairs — the order this shipped in —
       dropping `ip_address` made `login_attempts_ip_created_at_idx` fail with 42703 and be
       skipped, the ALTERs after it restored the column, the columns-mode probe then reported
       the feature AVAILABLE, and because it was available the repair never ran again. The
       table came back with three of its four indexes and nothing would ever notice: the
       per-source count degrades to a sequential scan (finding L-R5 measured 3 ms empty vs
       40 ms at 200 001 rows) with no error, no log line and no health signal. */

    const REQUIRED_INDEXES = [
      "login_attempts_identifier_idx",
      "login_attempts_created_at_idx",
      "login_attempts_identifier_created_at_idx",
      "login_attempts_ip_created_at_idx",
    ];

    async function loginAttemptColumns(): Promise<string[]> {
      return (
        await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'login_attempts' ORDER BY column_name`
        )
      ).rows.map((row: { column_name: string }) => row.column_name);
    }

    async function loginAttemptIndexes(): Promise<string[]> {
      return (
        await db.query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'login_attempts' ORDER BY indexname`
        )
      ).rows.map((row: { indexname: string }) => row.indexname);
    }

    for (const dropped of ["identifier", "ip_address", "created_at"] as const) {
      await test(`F-1: dropping ${dropped} takes its indexes with it and the repair restores all four`, async () => {
        await reset();
        delete process.env.AUTO_SCHEMA_REPAIR;
        await db.query(`ALTER TABLE login_attempts DROP COLUMN ${dropped}`);
        resilience.resetSchemaFeatureCache();

        /* Establish the premise: PostgreSQL dropped the dependent indexes with the column, so
           there is something for the repair to put back. Without this the assertion below could
           pass vacuously. */
        const afterDrop = await loginAttemptIndexes();
        const lost = REQUIRED_INDEXES.filter((index) => !afterDrop.includes(index));
        assert(
          lost.length > 0,
          `dropping ${dropped} must have taken at least one required index with it, found ${afterDrop.join(", ")}`
        );

        /* Trigger the repair through the real path: one login attempt. The pre-check and the
           recorder both raise 42703, and either is enough to run the self-heal. */
        const login = await POST(loginRequest(wrongPassword, DRIFT_IP));
        assert.strictEqual(login.status, 401, `the throttle must be live again after the repair, got ${login.status}`);

        const columns = await loginAttemptColumns();
        for (const expected of ["created_at", "id", "identifier", "ip_address"]) {
          assert(columns.includes(expected), `the repair must restore ${expected} (found ${columns.join(", ")})`);
        }
        const indexes = await loginAttemptIndexes();
        for (const expected of REQUIRED_INDEXES) {
          assert(
            indexes.includes(expected),
            `the repair must recreate ${expected} on a DRIFTED table, not only on a new one ` +
              `(dropped ${dropped}; lost ${lost.join(", ")}; found ${indexes.join(", ")})`
          );
        }
        assert.strictEqual(
          resilience.getSchemaRepairFailure("login_attempts"),
          null,
          "a repair that delivered every column and index must not be recorded as failed"
        );
        const health = await healthBody();
        assert.strictEqual(health.status, 200, `health must recover, got ${health.status}`);
        assert.strictEqual(health.body.ok, true);
        assert.strictEqual(await attemptRows(), 1, "the attempt that triggered the repair must be recorded");
      });
    }

    await test("F-1: the repair DDL is idempotent — a second and third pass change nothing", async () => {
      await reset();
      await seedFailure(ADMIN_EMAIL, OWNER_IP);
      const columnsBefore = await loginAttemptColumns();
      const indexesBefore = await loginAttemptIndexes();

      /* Executed directly, twice, against an already-healthy table: every statement must be
         re-runnable, must not rewrite or drop anything, and must not touch data. */
      for (let pass = 1; pass <= 2; pass += 1) {
        for (const statement of resilience.FEATURE_SQL.login_attempts) {
          await db.query(statement);
        }
      }
      assert.deepStrictEqual(await loginAttemptColumns(), columnsBefore, "columns must be unchanged");
      assert.deepStrictEqual(await loginAttemptIndexes(), indexesBefore, "indexes must be unchanged");
      for (const expected of REQUIRED_INDEXES) {
        assert(indexesBefore.includes(expected), `${expected} must still exist (found ${indexesBefore.join(", ")})`);
      }
      assert.strictEqual(await attemptRows(), 1, "re-running the repair must not touch recorded attempts");

      /* And through the real entry point: two consecutive ensure calls, cache cleared between
         them so the second one really probes again. */
      resilience.resetSchemaFeatureCache();
      const first = await resilience.ensureLoginAttemptSchema();
      resilience.resetSchemaFeatureCache();
      const second = await resilience.ensureLoginAttemptSchema();
      assert.strictEqual(first.available, true, "the first ensure must report the feature available");
      assert.strictEqual(second.available, true, "and so must the second");
      assert.strictEqual(resilience.getSchemaRepairFailure("login_attempts"), null, "no failure may be recorded");
      assert.strictEqual(await attemptRows(), 1);
    });

    /* ── 12. F-6 follow-up: the cross-column check must survive concurrency ──────────────

       Separate SELECTs followed by an INSERT is a check-then-act race, and the window was not
       microseconds: the route hashed the password (bcrypt cost 12, ~250 ms) BETWEEN the checks
       and the insert. Two opposing creations — one taking `email = X`, the other taking
       `username = X` — could each read "no conflict" and each commit, leaving two accounts that
       share one login-throttle bucket, where signing in to one releases the other's recorded
       failures. The repair is a transaction-scoped advisory lock over the whole
       check-generate-insert-membership sequence, so the second creation reads the first one's
       committed rows. */

    await test("F-6: two concurrent opposing creations leave the identity held by exactly one account", async () => {
      const slugSafe = DB_NAME.replace(/[^a-z0-9-]/g, "-");
      const school = (
        await db.query(
          `INSERT INTO schools (name, short_name, slug) VALUES ($1, 'F6C', $2) RETURNING id`,
          [`Duel School ${DB_NAME}`, `duel-${slugSafe}`]
        )
      ).rows[0].id as string;
      const adminRow = (
        await db.query(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
           VALUES ($1, $2, 'school_admin', 'Duel', 'Admin', true) RETURNING id, session_version`,
          [`duel-admin-${DB_NAME}@school.test`, await bcrypt.hash("Duel-Admin-1!", 4)]
        )
      ).rows[0] as { id: string; session_version: number };
      await db.query(
        `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'school_admin', 'active')`,
        [school, adminRow.id]
      );
      const token = await auth.createToken({
        userId: adminRow.id,
        role: "school_admin",
        email: `duel-admin-${DB_NAME}@school.test`,
        schoolId: school,
        sessionVersion: Number(adminRow.session_version ?? 0),
      });
      const { POST: createUsers } = await import("@/app/api/users/route");
      const createUser = (payload: Record<string, unknown>) =>
        createUsers(
          new NextRequest("http://localhost/api/users", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
          })
        );

      /** Nobody may hold the same string in both columns, anywhere in the table. */
      async function crossColumnCollisions(): Promise<number> {
        return Number(
          (
            await db.query(
              `SELECT count(*)::int AS count
                 FROM users a JOIN users b ON b.id <> a.id AND lower(b.username) = lower(a.email)
                WHERE a.email IS NOT NULL`
            )
          ).rows[0].count
        );
      }

      assert.strictEqual(await crossColumnCollisions(), 0, "the fixtures themselves must start collision-free");

      /* Three rounds, each with its own contested string, because a race is probabilistic: one
         clean round proves little. Round shape — request A creates `email = X`; request B is a
         learner whose generated username (first initial + last name) is the SAME string X. */
      for (let round = 1; round <= 3; round += 1) {
        const identity = `duel-${slugSafe}-r${round}@school.test`;
        const [byEmail, byUsername] = await Promise.all([
          createUser({
            email: identity,
            password: "Duel-Email-1!",
            firstName: "D",
            lastName: `Uel${round}`,
            role: "teacher",
          }),
          createUser({
            password: "Duel-Name-1!",
            firstName: "d",
            lastName: `uel-${slugSafe}-r${round}@school.test`,
            role: "learner",
          }),
        ]);

        for (const [label, response] of [["email", byEmail], ["username", byUsername]] as const) {
          assert(
            response.status === 201 || response.status === 200 || response.status === 409,
            `the ${label} creation must be accepted or refused as a conflict, got ${response.status}`
          );
        }

        const holders = (
          await db.query(
            `SELECT count(*) FILTER (WHERE lower(email) = lower($1))::int AS as_email,
                    count(*) FILTER (WHERE lower(username) = lower($1))::int AS as_username
               FROM users`,
            [identity]
          )
        ).rows[0] as { as_email: number; as_username: number };
        assert.strictEqual(
          holders.as_email + holders.as_username,
          1,
          `exactly one account may hold ${identity} across BOTH columns ` +
            `(email=${holders.as_email}, username=${holders.as_username}, ` +
            `statuses=${byEmail.status}/${byUsername.status})`
        );
        assert.strictEqual(await crossColumnCollisions(), 0, "no cross-column collision may survive the round");

        /* Whichever request lost must have lost COHERENTLY: the username side skips to a
           suffixed candidate (201 with a different username), the email side is refused (409). */
        if (holders.as_email === 1) {
          assert.strictEqual(
            byEmail.status,
            201,
            `the email side holds the identity, so it must be the one that succeeded, got ${byEmail.status}`
          );
          const generated: string[] = (
            await db.query(`SELECT username FROM users WHERE lower(username) LIKE $1 ORDER BY username`, [
              `${identity}%`,
            ])
          ).rows.map((row: { username: string }) => row.username);
          assert(
            generated.every((username) => username !== identity),
            `the losing side must not have taken the contested username, found ${generated.join(", ")}`
          );
        } else {
          assert.strictEqual(
            byEmail.status,
            409,
            `the username side holds the identity, so the email side must be refused as a conflict, got ${byEmail.status}`
          );
        }
      }
    });

    await test("F-6: a burst of concurrent creations never produces a shared identity", async () => {
      /* Wider net: eight concurrent requests, four taking the string as an email and four as a
         generated username. Under the pre-fix code this reliably produced several colliding
         pairs, because every request cleared its checks before any of them inserted. */
      const slugSafe = DB_NAME.replace(/[^a-z0-9-]/g, "-");
      const identity = `burst-${slugSafe}@school.test`;
      const school = (
        await db.query(
          `INSERT INTO schools (name, short_name, slug) VALUES ($1, 'F6B', $2) RETURNING id`,
          [`Burst School ${DB_NAME}`, `burst-${slugSafe}`]
        )
      ).rows[0].id as string;
      const adminRow = (
        await db.query(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
           VALUES ($1, $2, 'school_admin', 'Burst', 'Admin', true) RETURNING id, session_version`,
          [`burst-admin-${DB_NAME}@school.test`, await bcrypt.hash("Burst-Admin-1!", 4)]
        )
      ).rows[0] as { id: string; session_version: number };
      await db.query(
        `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'school_admin', 'active')`,
        [school, adminRow.id]
      );
      const token = await auth.createToken({
        userId: adminRow.id,
        role: "school_admin",
        email: `burst-admin-${DB_NAME}@school.test`,
        schoolId: school,
        sessionVersion: Number(adminRow.session_version ?? 0),
      });
      const { POST: createUsers } = await import("@/app/api/users/route");
      const createUser = (payload: Record<string, unknown>) =>
        createUsers(
          new NextRequest("http://localhost/api/users", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
          })
        );

      const responses = await Promise.all([
        ...Array.from({ length: 4 }, (_, index) =>
          createUser({
            email: identity,
            password: "Burst-Email-1!",
            firstName: "B",
            lastName: `urst${index}`,
            role: "teacher",
          })
        ),
        ...Array.from({ length: 4 }, (_, index) =>
          createUser({
            password: "Burst-Name-1!",
            firstName: "b",
            /* All four ask for the same generated username, so this also exercises the
               same-column skip under the lock: one takes it, the rest are suffixed. */
            lastName: `urst-${slugSafe}@school.test`,
            role: "learner",
          })
        ),
      ]);
      const statuses = responses.map((response) => response.status);
      for (const status of statuses) {
        assert(
          status === 201 || status === 200 || status === 409 || status === 400,
          `every concurrent creation must end in a mapped outcome, got ${status} (${statuses.join(", ")})`
        );
      }
      const holders = Number(
        (
          await db.query(
            `SELECT (count(*) FILTER (WHERE lower(email) = lower($1))
                   + count(*) FILTER (WHERE lower(username) = lower($1)))::int AS count FROM users`,
            [identity]
          )
        ).rows[0].count
      );
      assert.strictEqual(holders, 1, `exactly one account may hold ${identity}, found ${holders} (${statuses.join(", ")})`);
      const collisions = Number(
        (
          await db.query(
            `SELECT count(*)::int AS count
               FROM users a JOIN users b ON b.id <> a.id AND lower(b.username) = lower(a.email)
              WHERE a.email IS NOT NULL`
          )
        ).rows[0].count
      );
      assert.strictEqual(collisions, 0, `no cross-column collision may survive a burst, found ${collisions}`);
      const locks = Number(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM pg_locks
              WHERE locktype = 'advisory'
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
          )
        ).rows[0].count
      );
      assert.strictEqual(locks, 0, "the identity lock is transaction-scoped, so none may outlive the requests");
    });

    /* Restore the table so cleanup and any later suite state stay conventional. */
    delete process.env.AUTO_SCHEMA_REPAIR;
    resilience.resetSchemaFeatureCache();
    const restored = await resilience.ensureLoginAttemptSchema();
    assert.strictEqual(restored.available, true, "the throttle table must exist again before teardown");
  } finally {
    /* Cleanup runs on EVERY outcome (pass, fail, or throw): drop the scratch DB, close the
       admin client, stop the embedded cluster and remove its data dir. A cleanup failure
       fails the suite instead of being swallowed. */
    const scratchCleanup = scratch ? await scratch.dispose() : { ok: true, error: null };
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer();
    assertCleanupSucceeded(scratchCleanup, failed > 0 ? new Error(`${failed} test(s) failed`) : null);
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
