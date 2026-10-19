/**
 * The development seed must produce a USABLE development environment.
 *
 * The finding this suite locks down (MEDIUM-4 in
 * `docs/PRODUCTION_MIGRATION_SAFETY_REVIEW_PR32.md`):
 *
 *   `POST /api/seed` created four `users` rows and a full set of school-owned content
 *   (classes, subjects, `teacher_classes`, `learner_classes`, `parent_learners`,
 *   timetable entries, announcements, FAQs) — every row stamped with a `school_id` — and
 *   never created a `school_users` row. Since migration 0013/0015 a school context comes
 *   ONLY from `school_users`: `src/lib/tenant.ts` resolves it from the caller's active
 *   membership rows and never from `users.role` (which is a PLATFORM role), and
 *   migration 0015's backfill cannot help because it ran before these users existed.
 *
 *   The result was a seed that answered `201 "Database seeded successfully"` and handed
 *   back three demo credentials that could not open a single tenant-scoped screen:
 *
 *     teacher login -> 200, school = null, schools = []
 *     GET /api/assignments -> 403 "You do not have an active school membership in an
 *                                     active school"
 *
 *   The failure direction is safe (403, never a leak), but the seeded environment was
 *   unusable, and the route advertises exactly those credentials.
 *
 * The suite also locks down the companion fix (LOW-6): on a POPULATED database the seed
 * route must read the caller's role from the DATABASE, not from the token claim. A signed
 * claim can be up to 24 hours stale, so a platform administrator whose role was changed
 * would otherwise still pass the check.
 *
 * Database providers (same approach as tests/tenant-integration-regression.test.ts):
 *   - TEST_DATABASE_URL → any PostgreSQL
 *   - embedded-postgres → throwaway server (`npm i --no-save embedded-postgres`)
 *   - otherwise the suite SKIPS (exit 0) — unless EASY_LEARN_REQUIRE_SEED_MEMBERSHIP=true,
 *     which turns a skip into a failure. CI sets that flag, so the job proves these
 *     assertions really ran.
 *
 * Every database used here is disposable. No production database is ever contacted.
 */

import assert from "assert";
import path from "path";
import os from "os";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");
const { createScratchDatabase, assertCleanupSucceeded } = requireFromRepo(
  "./tests/helpers/scratch-db.js"
);

const DB_NAME = `easylearn_seed_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = "seed-membership-test-secret-0123456789abc";

let passed = 0;
let failed = 0;
let skipped = false;

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

function assertEq(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(
      `${message || "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertIncludes(haystack: string, needle: string, message?: string) {
  if (!String(haystack).includes(needle)) {
    throw new Error(
      `${message || "assertIncludes"}: expected output to contain ${JSON.stringify(needle)}\n--- output ---\n${haystack}`
    );
  }
}

async function main() {
  const { Client } = requireFromRepo("pg");
  const bcrypt = requireFromRepo("bcryptjs");

  let adminUrl = process.env.TEST_DATABASE_URL;

  const requireExecution = process.env.EASY_LEARN_REQUIRE_SEED_MEMBERSHIP === "true";
  const skip = (message: string) => {
    console.log(message);
    skipped = true;
    if (requireExecution) {
      console.error(
        "❌ FAIL: EASY_LEARN_REQUIRE_SEED_MEMBERSHIP=true — the seed membership suite " +
          "must run, not skip."
      );
    }
  };

  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      skip("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run the suite.");
      process.exit(skipped && requireExecution ? 1 : 0);
    }
    const port = 58529 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`),
      user: "easylearn",
      password: "easylearn",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    adminUrl = `postgres://easylearn:easylearn@localhost:${port}/postgres`;
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const scratch = await createScratchDatabase({
    admin,
    adminUrl: adminUrl as string,
    dbName: DB_NAME,
    label: "seed-membership",
  });
  const db = scratch.db;

  let primaryError: any = null;
  try {
    /* The application modules must see the scratch database. Set BEFORE the first `@/db`
       import — the pool is created at import time. */
    process.env.DATABASE_URL = scratch.scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";

    const migrationRun = runMigrationChain({ databaseUrl: scratch.scratchUrl, env: { JWT_SECRET } });
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    const q = async (sql: string, values: unknown[] = []): Promise<any[]> =>
      (await db.query(sql, values)).rows;

    /* The route handlers are imported dynamically, after DATABASE_URL is set. */
    const { createToken } = await import("@/lib/auth");
    const seedRoute = await import("@/app/api/seed/route");
    const loginRoute = await import("@/app/api/auth/login/route");
    const assignmentsRoute = await import("@/app/api/assignments/route");

    const post = (route: any, url: string, token?: string) =>
      route.POST(
        new NextRequest(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: "{}",
        })
      );

    const login = async (email: string, password: string) => {
      const response = await post(loginRoute, "http://127.0.0.1/api/auth/login");
      const body = await response.json();
      return { response, body };
    };

    const loginAs = async (email: string, password: string) => {
      const response = await loginRoute.POST(
        new NextRequest("http://127.0.0.1/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        })
      );
      const body = await response.json();
      return { status: response.status, body };
    };

    /* The bootstrap token: the database has no users yet, so there is no account to read
       a role from and the signed claim is all that exists. */
    const bootstrapToken = await createToken({
      userId: "00000000-0000-4000-8000-0000000000ff",
      role: "super_admin",
    });

    let seedStatus = 0;
    let seedBody: any = null;

    await test("the seed route seeds a blank development database", async () => {
      const response = await post(seedRoute, "http://127.0.0.1/api/seed", bootstrapToken);
      seedStatus = response.status;
      seedBody = await response.json();
      assertEq(seedStatus, 201, `the seed must succeed: ${JSON.stringify(seedBody)}`);
      assertEq(seedBody?.success, true);
    });

    await test("the seed creates a school membership for every school-role demo account", async () => {
      const rows = await q(
        `select u."email", m."role", m."status"
           from "users" u
           left join "school_users" m on m."user_id" = u."id"
          order by u."email"`
      );
      const byEmail = new Map<string, { role: string | null; status: string | null }>(
        rows.map((row: any) => [row.email, { role: row.role, status: row.status }])
      );

      assertEq(byEmail.get("teacher@cbism.edu")?.role, "teacher", "the teacher needs a membership");
      assertEq(byEmail.get("parent@cbism.edu")?.role, "parent", "the parent needs a membership");
      assertEq(byEmail.get("learner@cbism.edu")?.role, "learner", "the learner needs a membership");

      for (const email of ["teacher@cbism.edu", "parent@cbism.edu", "learner@cbism.edu"]) {
        assertEq(
          byEmail.get(email)?.status,
          "active",
          `${email} must have an ACTIVE membership — an inactive one grants no context`
        );
      }
    });

    await test("the platform administrator gets NO school membership", async () => {
      const rows = await q(
        `select count(*)::int AS n
           from "school_users" m
           join "users" u on u."id" = m."user_id"
          where u."role" = 'super_admin'`
      );
      assertEq(
        rows[0].n,
        0,
        "super_admin is a PLATFORM role; migration 0015 excludes it from membership rows"
      );
    });

    await test("the seeded demo accounts obtain a school context at login", async () => {
      const expectations: Array<[string, string, string]> = [
        ["teacher@cbism.edu", "teacher123", "teacher"],
        ["parent@cbism.edu", "parent123", "parent"],
        ["learner@cbism.edu", "learner123", "learner"],
      ];
      for (const [email, password, role] of expectations) {
        const { status, body } = await loginAs(email, password);
        assertEq(status, 200, `${email} must be able to log in: ${JSON.stringify(body)}`);
        assertEq(body?.data?.school?.role, role, `${email} must resolve its school role`);
        assert(
          typeof body?.data?.school?.schoolId === "string",
          `${email} must resolve a school id`
        );
        assertEq(
          Array.isArray(body?.data?.schools) ? body.data.schools.length : 0,
          1,
          `${email} must hold exactly one active membership`
        );
      }
    });

    await test("a seeded demo account can actually reach a tenant-scoped API", async () => {
      const { body } = await loginAs("teacher@cbism.edu", "teacher123");
      const token = body?.data?.token;
      assert(typeof token === "string" && token.length > 0, "the login must return a token");

      const response = await assignmentsRoute.GET(
        new NextRequest("http://127.0.0.1/api/assignments", {
          headers: { authorization: `Bearer ${token}` },
        })
      );
      assertEq(
        response.status,
        200,
        `a seeded teacher must be able to list assignments: ${response.status}`
      );
    });

    await test("the seed route reads the caller's role from the DATABASE, not the token claim", async () => {
      /* A user whose DATABASE role is not super_admin, holding a token whose CLAIM says
         super_admin. Before the fix the claim was trusted and the route proceeded. */
      const impostor = {
        id: crypto.randomUUID(),
        email: `impostor-${crypto.randomBytes(3).toString("hex")}@example.test`,
        passwordHash: await bcrypt.hash("irrelevant", 4),
        role: "teacher",
      };
      await q(
        `insert into "users"
           ("id","email","password_hash","role","first_name","last_name","is_active","email_verified")
         values ($1,$2,$3,'teacher','Impostor','Tester',true,true)`,
        [impostor.id, impostor.email, impostor.passwordHash]
      );
      const forged = await createToken({ userId: impostor.id, role: "super_admin" });

      const response = await post(seedRoute, "http://127.0.0.1/api/seed", forged);
      assertEq(response.status, 403, "a stale or forged super_admin claim must be refused");
      const body = await response.json();
      assertIncludes(
        JSON.stringify(body),
        "Only super administrators can seed the database",
        "the refusal must name the reason"
      );
    });

    await test("a real super administrator may still call the seed route on a populated database", async () => {
      const { status, body } = await loginAs("admin@cbism.edu", "admin123");
      assertEq(status, 200, `the platform admin must be able to log in: ${JSON.stringify(body)}`);
      const token = body?.data?.token;
      const response = await post(seedRoute, "http://127.0.0.1/api/seed", token);
      assertEq(response.status, 200);
      const seeded = await response.json();
      assertIncludes(
        JSON.stringify(seeded),
        "Database already seeded",
        "a populated database must not be seeded twice"
      );
    });

    console.log(`\n📊 Seed membership results: ${passed} passed, ${failed} failed\n`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    /* Close the application's pool before the scratch database is dropped, so the
       teardown does not race the pool's idle connections. */
    try {
      const { pool } = requireFromRepo("./src/db/index.ts");
      await pool.end().catch(() => undefined);
    } catch {
      /* The pool was never created; nothing to close. */
    }
    const cleanup = await scratch.dispose();
    assertCleanupSucceeded(cleanup, primaryError);
    await admin.end().catch(() => undefined);
  }

  process.exit(failed > 0 || (skipped && requireExecution) ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
