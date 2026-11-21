/**
 * H-1 (login rate limiting) regression — database backed.
 *
 * Proves the four properties the remediation had to deliver:
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
 *      releases both the account bucket and the source bucket.
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

    await test("clearing releases the account bucket and the source bucket together", async () => {
      await reset();
      await seedFailures(ADMIN_EMAIL, OWNER_IP, MAX_ATTEMPTS - 1);
      await seedFailures(`colleague-${DB_NAME}@test.test`, OWNER_IP, MAX_ATTEMPTS - 1);

      const before = await checkLoginRateLimit(ADMIN_EMAIL, OWNER_IP);
      assert.strictEqual(before.allowed, true, "one attempt short of the budget must still be allowed");
      assert.strictEqual(before.remainingAttempts, 1);

      await clearFailedLoginAttempts(ADMIN_EMAIL, OWNER_IP);

      assert.strictEqual(await attemptRows(), 0, "both buckets for that source must be cleared");
      const colleague = await checkLoginRateLimit(`colleague-${DB_NAME}@test.test`, OWNER_IP);
      assert.strictEqual(colleague.remainingAttempts, MAX_ATTEMPTS, "a shared NAT source gets its budget back");
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

      assert.strictEqual(await attemptRows(), 0, "a successful login clears both buckets");
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

    await test("/api/health stays ready when automatic repair can recreate the table", async () => {
      delete process.env.AUTO_SCHEMA_REPAIR;
      resilience.resetSchemaFeatureCache();
      const { GET } = await import("@/app/api/health/route");
      const response = await GET();
      assert.strictEqual(response.status, 200, `expected 200 while repair is enabled, got ${response.status}`);
      const body = (await response.json()) as {
        ok: boolean;
        checks?: { migrationWarnings?: string[] };
      };
      assert.strictEqual(body.ok, true);
      const warned = (body.checks?.migrationWarnings ?? []).some((warning) => warning.includes("0012_login_attempts.sql"));
      assert(warned, "the missing table must still be surfaced as a warning");
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
