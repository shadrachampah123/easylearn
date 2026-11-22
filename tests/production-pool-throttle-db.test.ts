/**
 * Login throttle under the **Production connection-pool shape** — regression suite for the
 * second independent security review of PR #69 (findings F-2 and F-5, plus the M-R2 budgets
 * re-measured where they actually run).
 *
 * `src/db/index.ts` gives Production `max: 2` connections per instance with a 10 s acquire
 * timeout. Every other suite in this repository runs with the development pool of 10, so before
 * this file nothing in CI exercised the configuration that ships. That mattered, because the
 * M-R2 fix holds PostgreSQL advisory locks *inside* a transaction on that pool:
 *
 *   - with two connections, a burst that serialises on one lock can starve every other route;
 *   - `pg_advisory_xact_lock` has no timeout of its own, so a lock held elsewhere used to wedge
 *     a request indefinitely. Measured against `e4c7b41`: two wedged logins consumed both
 *     Production connections, `GET /api/health` answered **503** and `pool.query('SELECT 1')`
 *     errored — the whole application, not just sign-in (finding **F-5**);
 *   - a backend failure during the transaction was an unhandled `'error'` event on the
 *     checked-out client and killed the isolate (finding **F-2**).
 *
 * This suite therefore asserts, with `NODE_ENV=production` set before `@/db` is imported:
 *
 *   1. the pool really is `max: 2` (so the rest of the file means what it says);
 *   2. the M-R2 budgets hold under a 40-way and a 200-way concurrent burst — exactly
 *      `MAX_ATTEMPTS` guesses from one source and exactly `MAX_ATTEMPTS_PER_IDENTIFIER` across
 *      many sources, with no deadlocks and no unevaluable throttles;
 *   3. `/api/health` and a bare `pool.query` stay usable *during* the burst;
 *   4. a lock held by another backend fails closed within `lock_timeout`, leaves no advisory
 *      lock behind, keeps the rest of the application alive, and recovers afterwards;
 *   5. a backend killed mid-transaction degrades one login instead of the process.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/production-pool-throttle-db.test.ts
 * (CI hard-requires execution via EASY_LEARN_REQUIRE_PRODUCTION_POOL_DB=true; a silent skip fails the job)
 * (falls back to embedded-postgres when installed)
 */
/* @types/node declares NODE_ENV readonly; this assignment is what makes the pool below the
   Production pool. The login route does not touch the CSRF helper, so nothing else in this
   suite is affected by production mode. */
(process.env as Record<string, string>).NODE_ENV = "production";

import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

const DB_NAME = `easylearn_prodpool_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();

const ADMIN_EMAIL = `prodpool-${DB_NAME}@test.test`;
const ADMIN_PASSWORD = "Correct-Horse-1!";

/** RFC 5737 documentation addresses, so no test ever names a real host. */
const ONE_SOURCE_IP = "203.0.113.200";
const MANY_SOURCE_PREFIX = "203.0.114";
const LOCKWAIT_IP = "203.0.113.201";
const CRASH_IP = "203.0.113.202";

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
    const { startEmbeddedPostgres } = requireFromRepo("./tests/helpers/embedded-postgres.js");
    const port = 57851 + (crypto.randomBytes(2).readUInt16BE(0) % 400);
    const embedded = await startEmbeddedPostgres({
      dbName: DB_NAME,
      port,
      requireEnv: "EASY_LEARN_REQUIRE_PRODUCTION_POOL_DB",
    });
    if (!embedded) return; // SKIP printed by the helper (only when the suite is not required)
    adminUrl = embedded.adminUrl;
    stopServer = embedded.stop;
  }
  const { createScratchDatabase, assertCleanupSucceeded } = requireFromRepo("./tests/helpers/scratch-db.js");
  const admin = new Client({ connectionString: adminUrl });
  let scratch: { db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }; scratchUrl: string; dispose: () => Promise<{ ok: boolean; error: string | null }> } | null = null;

  try {
    await admin.connect();
    const created = await createScratchDatabase({
      admin,
      adminUrl: adminUrl as string,
      dbName: DB_NAME,
      label: "production-pool-throttle",
    });
    scratch = created;
    const db = created.db;
    process.env.DATABASE_URL = created.scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";
    delete process.env.AUTO_SCHEMA_REPAIR;
    delete process.env.VERCEL;
    delete process.env.EASY_LEARN_CLIENT_IP_HEADER;
    delete process.env.EASY_LEARN_CLIENT_IP_TRUSTED_HOPS;
    delete process.env.EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS;

    const run = runMigrationChain({
      databaseUrl: created.scratchUrl,
      env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" },
    });
    assert.strictEqual(run.status, 0, "migrations must succeed");

    /* Imported only after the environment points at the scratch database — and after
       NODE_ENV=production was set at the top of this file, which is what makes the pool
       `max: 2` exactly as it is in Production. */
    const rateLimit = await import("@/lib/rate-limit");
    const resilience = await import("@/lib/schema-resilience");
    const { POST } = await import("@/app/api/auth/login/route");
    const { GET: healthGet } = await import("@/app/api/health/route");
    const { pool } = await import("@/db");

    const { MAX_ATTEMPTS, MAX_ATTEMPTS_PER_IDENTIFIER } = rateLimit;

    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, 'school_admin', 'Prod', 'Pool', true)`,
      [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 4)]
    );

    const wrongPassword = { email: ADMIN_EMAIL, password: "not-the-password" };

    function loginRequest(sourceHeader?: string) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sourceHeader !== undefined) headers["x-forwarded-for"] = sourceHeader;
      return new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify(wrongPassword),
      });
    }

    async function reset() {
      await db.query(`DELETE FROM login_attempts`);
      resilience.resetSchemaFeatureCache();
    }

    async function attemptRows(): Promise<number> {
      return Number((await db.query(`SELECT count(*)::int AS count FROM login_attempts`)).rows[0].count);
    }

    async function advisoryLocks(): Promise<number> {
      /* Scoped to this database: `pg_locks` is cluster-wide, and a killed suite in another
         scratch database leaves advisory locks behind that this suite must not be blamed for. */
      return Number(
        (
          await db.query(`SELECT count(*)::int AS count FROM pg_locks
         WHERE locktype = 'advisory'
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
        ).rows[0].count
      );
    }

    const tally = (statuses: number[]) =>
      statuses.reduce<Record<string, number>>((acc, status) => {
        acc[String(status)] = (acc[String(status)] ?? 0) + 1;
        return acc;
      }, {});

    /** Sample /api/health and a bare pool query while `during` runs. */
    async function sampleLiveness(during: () => Promise<void>): Promise<string[]> {
      const samples: string[] = [];
      let running = true;
      const sampler = (async () => {
        while (running) {
          const health = await healthGet()
            .then((response) => String(response.status))
            .catch(() => "ERR");
          const query = await pool
            .query("SELECT 1")
            .then(() => "ok")
            .catch(() => "ERR");
          samples.push(`${health}/${query}`);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      })();
      /* `finally`, not a straight-line sequence: if an assertion inside `during()` throws, the
         sampler must still be stopped. Without this a FAILED test left the sampler looping
         forever and the process never exited — measured, it hung the whole suite (and would have
         hung the CI step until the job timeout) instead of reporting the failure. */
      try {
        await during();
        await new Promise((resolve) => setTimeout(resolve, 400));
      } finally {
        running = false;
        await sampler;
      }
      return samples;
    }

    /* ── 1. The pool really is the Production shape ───────────────────────────── */

    await test("the pool under test is the Production shape (max: 2, 10s acquire timeout)", () => {
      const options = (pool as unknown as {
        options?: { max?: number; connectionTimeoutMillis?: number; idleTimeoutMillis?: number };
      }).options;
      assert.strictEqual(process.env.NODE_ENV, "production", "NODE_ENV must be production before @/db is imported");
      assert.strictEqual(options?.max, 2, `Production allows two connections per instance, got ${options?.max}`);
      assert.strictEqual(options?.connectionTimeoutMillis, 10_000, "the acquire timeout is what makes a wedge fail closed");
    });

    /* ── 2. The M-R2 budgets hold with two connections ────────────────────────── */

    await test("M-R2 under max:2 — 40 parallel wrong passwords from ONE source yield exactly MAX_ATTEMPTS guesses", async () => {
      await reset();
      const responses = await Promise.all(
        Array.from({ length: 40 }, () => POST(loginRequest(ONE_SOURCE_IP)))
      );
      const statuses = await Promise.all(responses.map((response) => response.status));
      const counts = tally(statuses);
      assert.strictEqual(counts["401"], MAX_ATTEMPTS, `exactly ${MAX_ATTEMPTS} real guesses: ${JSON.stringify(counts)}`);
      assert.strictEqual(counts["429"], 40 - MAX_ATTEMPTS, `everything else is refused: ${JSON.stringify(counts)}`);
      assert.strictEqual(counts["503"], undefined, `no attempt may be unevaluable: ${JSON.stringify(counts)}`);
      assert.strictEqual(await attemptRows(), MAX_ATTEMPTS, "refusals are rolled back, so only real guesses are stored");
      assert.strictEqual(await advisoryLocks(), 0, "no advisory lock may outlive its request");
    });

    await test("M-R2 under max:2 — 40 parallel sources still respect the account backstop", async () => {
      await reset();
      const responses = await Promise.all(
        Array.from({ length: 40 }, (_, index) => POST(loginRequest(`${MANY_SOURCE_PREFIX}.${index + 1}`)))
      );
      const statuses = await Promise.all(responses.map((response) => response.status));
      const counts = tally(statuses);
      assert.strictEqual(
        counts["401"],
        MAX_ATTEMPTS_PER_IDENTIFIER,
        `the account-wide backstop is ${MAX_ATTEMPTS_PER_IDENTIFIER}: ${JSON.stringify(counts)}`
      );
      assert.strictEqual(counts["503"], undefined, `no deadlock or degraded throttle: ${JSON.stringify(counts)}`);
      assert.strictEqual(await attemptRows(), MAX_ATTEMPTS_PER_IDENTIFIER);
      assert.strictEqual(await advisoryLocks(), 0);
    });

    await test("M-R2 under max:2 — a mixed burst of attributable and unattributable sources does not deadlock", async () => {
      /* Different lock keys in the same burst (`source:<ip>` versus `identifier:<alias>`) is
         where a lock-ordering mistake would show up as 40P01. */
      await reset();
      const responses = await Promise.all([
        ...Array.from({ length: 20 }, () => POST(loginRequest(ONE_SOURCE_IP))),
        ...Array.from({ length: 20 }, () => POST(loginRequest("junk-at-the-trusted-position"))),
      ]);
      const statuses = await Promise.all(responses.map((response) => response.status));
      const counts = tally(statuses);
      assert.strictEqual(counts["503"], undefined, `a deadlock would surface as an unevaluable throttle: ${JSON.stringify(counts)}`);
      assert.strictEqual(
        (counts["401"] ?? 0) <= MAX_ATTEMPTS + MAX_ATTEMPTS_PER_IDENTIFIER,
        true,
        `the two buckets together bound the guesses: ${JSON.stringify(counts)}`
      );
      assert.strictEqual(await advisoryLocks(), 0);
    });

    await test("a 200-way burst from one source keeps the budgets AND the rest of the application alive", async () => {
      await reset();
      const samples = await sampleLiveness(async () => {
        const responses = await Promise.all(Array.from({ length: 200 }, () => POST(loginRequest(ONE_SOURCE_IP))));
        const statuses = await Promise.all(responses.map((response) => response.status));
        const counts = tally(statuses);
        assert.strictEqual(counts["401"], MAX_ATTEMPTS, `still exactly ${MAX_ATTEMPTS} guesses: ${JSON.stringify(counts)}`);
        assert.strictEqual(counts["503"], undefined, `no request may end up unevaluable: ${JSON.stringify(counts)}`);
      });
      assert(samples.length > 0, "the liveness sampler must have run during the burst");
      for (const sample of samples) {
        assert.strictEqual(sample, "200/ok", `/api/health and pool.query must stay usable during the burst, got ${sample}`);
      }
      assert.strictEqual(await attemptRows(), MAX_ATTEMPTS);
    });

    /* ── 3. F-5: a bounded lock wait, with two connections ────────────────────── */

    await test("F-5 under max:2 — a lock held elsewhere fails closed within the bound and the app survives", async () => {
      await reset();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      const bound = rateLimit.loginLockTimeoutMs();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`source:${LOCKWAIT_IP}`]);

        /* Six requests, i.e. three times the Production pool. Before F-5 two of them waited
           forever on the lock and held both connections, so every sample below was 503/ERR. */
        const started = Date.now();
        const responses = await Promise.all(Array.from({ length: 6 }, () => POST(loginRequest(LOCKWAIT_IP))));
        const elapsed = Date.now() - started;
        const statuses = await Promise.all(responses.map((response) => response.status));
        const counts = tally(statuses);

        assert.strictEqual(counts["503"], 6, `every wedged login must fail closed, got ${JSON.stringify(counts)}`);
        assert(
          elapsed < bound + 12_000,
          `all six must be answered within the lock bound plus the pool acquire timeout, took ${elapsed}ms`
        );
        for (const response of responses) {
          assert(response.headers.get("Retry-After"), "a degraded login must carry Retry-After");
        }

        /* The blast-radius regression: with both connections back in the pool, the rest of the
           application must be unaffected while the lock is still held. */
        await pool.query("SELECT 1");
        const health = await healthGet();
        assert.strictEqual(health.status, 200, `/api/health must stay green while one source is wedged, got ${health.status}`);
        assert.strictEqual(((await health.json()) as { ok: boolean }).ok, true);

        await blocker.query("ROLLBACK");
        const recovered = await POST(loginRequest(LOCKWAIT_IP));
        assert.strictEqual(recovered.status, 401, `login must resume once the lock is free, got ${recovered.status}`);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end().catch(() => undefined);
      }
      assert.strictEqual(await advisoryLocks(), 0, "no advisory lock may be left behind");
      assert.strictEqual(await attemptRows(), 1, "only the recovered attempt is recorded");
    });

    /* ── 4. F-2: a dead backend costs one request, not the isolate ────────────── */

    await test("F-2 under max:2 — killing the backend mid-transaction degrades one login and the pool recovers", async () => {
      await reset();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      try {
        /* The SOURCE lock is the first of the two the enforcement transaction takes, so the
           backend is inside an open transaction (BEGIN + SET LOCAL have run) when it is killed.
           The `account:` key cannot be predicted from the identifier alone — it is built from
           every alias of the resolved account. */
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`source:${CRASH_IP}`]);

        const inFlight = POST(loginRequest(CRASH_IP));
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
        assert(pid !== null, "the login must be observed waiting inside its transaction");
        await db.query("SELECT pg_terminate_backend($1)", [pid]);

        const response = await inFlight;
        assert.strictEqual(response.status, 503, `the killed attempt must fail closed, got ${response.status}`);
        assert.strictEqual(await attemptRows(), 0, "a killed attempt must not be recorded");

        /* Reaching this line is the real assertion: without the checked-out client's own
           'error' listener this process died here (unhandled 'error' event). */
        await pool.query("SELECT 1");
        const health = await healthGet();
        assert.strictEqual(health.status, 200, `the app must stay healthy, got ${health.status}`);
        assert(
          (await advisoryLocks()) <= 1,
          "only the blocker's own advisory lock may remain"
        );
        const idleInTransaction = Number(
          (
            await db.query(
              `SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'idle in transaction'`
            )
          ).rows[0].count
        );
        assert(idleInTransaction <= 1, `no app connection may be left idle in transaction, found ${idleInTransaction}`);

        await blocker.query("ROLLBACK");
        const recovered = await POST(loginRequest(CRASH_IP));
        assert.strictEqual(recovered.status, 401, `login must work again, got ${recovered.status}`);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end().catch(() => undefined);
      }
    });

    /* ── 5. F-6 follow-up at max:2 — the identity transaction must not starve the pool ──

       User creation now holds a connection for a whole transaction (advisory lock, checks,
       INSERT, membership). With two connections that is exactly where a nested acquisition —
       a query on the pool from inside the transaction — would deadlock the application. */

    await test("F-6 under max:2 — concurrent opposing creations serialise and the app stays alive", async () => {
      const slugSafe = DB_NAME.replace(/[^a-z0-9-]/g, "-");
      const school = (
        await db.query(
          `INSERT INTO schools (name, short_name, slug) VALUES ($1, 'PPS', $2) RETURNING id`,
          [`Pool School ${DB_NAME}`, `pool-${slugSafe}`]
        )
      ).rows[0].id as string;
      const adminRow = (
        await db.query(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
           VALUES ($1, $2, 'school_admin', 'Pool', 'Admin', true) RETURNING id, session_version`,
          [`pool-admin-${DB_NAME}@school.test`, await bcrypt.hash("Pool-Admin-1!", 4)]
        )
      ).rows[0] as { id: string; session_version: number };
      await db.query(
        `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'school_admin', 'active')`,
        [school, adminRow.id]
      );
      const { createToken } = await import("@/lib/auth");
      const token = await createToken({
        userId: adminRow.id,
        role: "school_admin",
        email: `pool-admin-${DB_NAME}@school.test`,
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

      const identity = `pool-duel-${slugSafe}@school.test`;
      const samples = await sampleLiveness(async () => {
        /* Six concurrent creations, three times the Production pool: three take the string as an
           email, three as a generated username. Every one of them needs a connection for a
           transaction, so a nested acquisition would wedge here. */
        const responses = await Promise.all([
          ...Array.from({ length: 3 }, (_, index) =>
            createUser({
              email: identity,
              password: "Pool-Email-1!",
              firstName: "P",
              lastName: `ool${index}`,
              role: "teacher",
            })
          ),
          ...Array.from({ length: 3 }, () =>
            createUser({
              password: "Pool-Name-1!",
              firstName: "p",
              lastName: `ool-duel-${slugSafe}@school.test`,
              role: "learner",
            })
          ),
        ]);
        const statuses = responses.map((response) => response.status);
        for (const status of statuses) {
          assert(
            status === 200 || status === 201 || status === 409 || status === 400,
            `every creation must end in a mapped outcome at max:2, got ${status} (${statuses.join(", ")})`
          );
        }
      });

      for (const sample of samples) {
        assert.strictEqual(sample, "200/ok", `/api/health and pool.query must stay usable, got ${sample}`);
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
      assert.strictEqual(holders, 1, `exactly one account may hold ${identity} across both columns, found ${holders}`);
      const collisions = Number(
        (
          await db.query(
            `SELECT count(*)::int AS count
               FROM users a JOIN users b ON b.id <> a.id AND lower(b.username) = lower(a.email)
              WHERE a.email IS NOT NULL`
          )
        ).rows[0].count
      );
      assert.strictEqual(collisions, 0, `no cross-column collision may survive, found ${collisions}`);
      assert.strictEqual(await advisoryLocks(), 0, "the identity lock is transaction-scoped: none may outlive the requests");
    });

    /* ── 5. Cost of the enforcement transaction at Production pool size ───────── */

    await test("sequential attempts stay cheap with two connections", async () => {
      await reset();
      const durations: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const started = Date.now();
        const response = await POST(loginRequest(`${MANY_SOURCE_PREFIX}.${100 + index}`));
        durations.push(Date.now() - started);
        assert.strictEqual(response.status, 401, `attempt ${index + 1} must be an ordinary failure`);
      }
      const slowest = Math.max(...durations);
      assert(slowest < 5_000, `a single throttled attempt must stay cheap, slowest was ${slowest}ms`);
      assert.strictEqual(await attemptRows(), 10);
    });
  } finally {
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
