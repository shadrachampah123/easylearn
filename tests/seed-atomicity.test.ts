/**
 * The development seed must be ATOMIC.
 *
 * The finding this suite locks down (the non-transactional seed, recorded in
 * docs/PRODUCTION_MIGRATION_SAFETY_REVIEW_PR32.md and investigated in the PR #35
 * review):
 *
 *   `POST /api/seed` performed a long series of independent INSERTs with no
 *   transaction around them. A failure part-way through left the rows written before
 *   the failure COMMITTED. The route then answered "Database already seeded" on every
 *   retry — because `users` was no longer empty — so the missing half could only be
 *   repaired by hand.
 *
 *   Reproduced on a disposable PostgreSQL with an injected failure:
 *
 *     failure at the membership write  → users 4, school_users 0   ← the MEDIUM-4 state
 *     failure after the memberships     → users 4, classes 10, timetable_entries 0
 *     retry                            → 401 (bootstrap token) / 200 "already seeded"
 *     the half-seeded database         → the teacher can still log in and gets a school
 *                                         context, so the failure is not obvious
 *
 *   The membership write is the failure point PR #35 introduced, and it produced
 *   exactly the state MEDIUM-4 describes: the four demo accounts present, none of
 *   them with a school membership — and the route unable to repair it.
 *
 * The fix: the whole seed runs in ONE transaction. Any failure rolls the whole thing
 * back, the database is left exactly as it was, and a retry seeds it completely.
 *
 * Database providers (same approach as tests/seed-membership.test.ts):
 *   - TEST_DATABASE_URL → any PostgreSQL
 *   - embedded-postgres → throwaway server
 *   - otherwise the suite SKIPS (exit 0) — unless EASY_LEARN_REQUIRE_SEED_ATOMICITY
 *     is set, which turns a skip into a failure.
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

const JWT_SECRET = "seed-atomicity-test-secret-0123456789abc";

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

async function main() {
  const { Client } = requireFromRepo("pg");

  let adminUrl = process.env.TEST_DATABASE_URL;
  const requireExecution = process.env.EASY_LEARN_REQUIRE_SEED_ATOMICITY === "true";
  const skip = (message: string) => {
    console.log(message);
    skipped = true;
    if (requireExecution) {
      console.error(
        "❌ FAIL: EASY_LEARN_REQUIRE_SEED_ATOMICITY=true — the seed atomicity suite must run, not skip."
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
      process.exit(skipped && requireExecution ? 1 : 0);
    }
    const port = 58529 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `easylearn_atomicity_${crypto.randomBytes(4).toString("hex")}-data`),
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
  const dbName = `easylearn_atomicity_${crypto.randomBytes(4).toString("hex")}`;
  const scratch = await createScratchDatabase({
    admin,
    adminUrl: adminUrl as string,
    dbName,
    label: "seed-atomicity",
  });
  const db = scratch.db;

  let primaryError: any = null;
  try {
    process.env.DATABASE_URL = scratch.scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";

    const migrationRun = runMigrationChain({ databaseUrl: scratch.scratchUrl, env: { JWT_SECRET } });
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    const { createToken } = await import("@/lib/auth");
    const seedRoute = await import("@/app/api/seed/route");

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

    const count = async (table: string): Promise<number> => {
      const r = await db.query(`select count(*)::int as n from "${table}"`);
      return r.rows[0].n as number;
    };

    const state = async () => ({
      users: await count("users"),
      school_users: await count("school_users"),
      academic_years: await count("academic_years"),
      classes: await count("classes"),
      subjects: await count("subjects"),
      timetable_entries: await count("timetable_entries"),
      announcements: await count("announcements"),
      faqs: await count("faqs"),
    });

    /* A BEFORE INSERT trigger that raises: the failure point is exact and the schema
       is untouched. */
    const installTripwire = async (table: string) => {
      await db.query(`
        create or replace function tripwire() returns trigger as $$
        begin
          raise exception 'injected failure in %', TG_TABLE_NAME;
        end $$ language plpgsql;
      `);
      await db.query(
        `create trigger tripwire_${table} before insert on "${table}"
           for each row execute function tripwire();`
      );
    };
    const removeTripwire = async (table: string) => {
      await db.query(`drop trigger if exists tripwire_${table} on "${table}";`);
    };

    const bootstrapToken = await createToken({
      userId: "00000000-0000-4000-8000-0000000000ff",
      role: "super_admin",
    });

    const before = await state();

    await test("a failure part-way through the seed leaves the database untouched", async () => {
      /* The failure lands on the MEMBERSHIP write — the step PR #35 introduced, and the
         one that produced the MEDIUM-4 state (accounts present, no memberships). */
      await installTripwire("school_users");
      const response = await post(seedRoute, "http://127.0.0.1/api/seed", bootstrapToken);
      await removeTripwire("school_users");

      assertEq(response.status, 500, "the failed seed must report a 500");
      const after = await state();
      assertEq(
        after.users,
        before.users,
        `the seeded accounts must have been rolled back, not left behind: ${JSON.stringify(after)}`
      );
      assertEq(
        after.school_users,
        before.school_users,
        "no membership row may survive a failed seed"
      );
      assertEq(
        after.classes,
        before.classes,
        "no class may survive a failed seed"
      );
    });

    await test("a retry after a failed seed seeds the database COMPLETELY", async () => {
      const response = await post(seedRoute, "http://127.0.0.1/api/seed", bootstrapToken);
      assertEq(response.status, 201, `the retry must succeed: ${response.status}`);
      const body = await response.json();
      assertEq(body?.success, true);
      const after = await state();
      assertEq(after.users, before.users + 4, "the four demo accounts must be created");
      assertEq(after.school_users, before.school_users + 3, "the three memberships must be created");
      assertEq(after.classes, before.classes + 10, "the classes must be created");
      assertEq(
        after.timetable_entries,
        before.timetable_entries + 6,
        "the timetable must be created"
      );
      assertEq(after.announcements, before.announcements + 2, "the announcements must be created");
    });

    await test("a failure LATE in the seed also rolls back everything", async () => {
      /* Clean the database back to the pre-seed state so the second scenario starts
         from the same place. */
      await db.query(
        `delete from "timetable_entries"; delete from "announcements"; delete from "faqs";
           delete from "learner_classes"; delete from "parent_learners";
           delete from "teacher_classes"; delete from "subjects"; delete from "classes";
           delete from "terms"; delete from "academic_years"; delete from "school_users";
           delete from "users"; delete from "achievements"; delete from "departments";`
      );
      const clean = await state();
      assertEq(clean.users, before.users, "the clean-up must return the database to its start state");

      await installTripwire("timetable_entries");
      const response = await post(seedRoute, "http://127.0.0.1/api/seed", bootstrapToken);
      await removeTripwire("timetable_entries");
      assertEq(response.status, 500, "the failed seed must report a 500");
      const after = await state();
      assertEq(
        after.users,
        clean.users,
        "a late failure must roll the accounts back too"
      );
      assertEq(
        after.school_users,
        clean.school_users,
        "a late failure must roll the memberships back too"
      );
      assertEq(
        after.timetable_entries,
        clean.timetable_entries,
        "a late failure must roll the timetable back"
      );
    });

    await test("the database is still empty enough for the bootstrap path after a failure", async () => {
      /* The whole point: because the failed seed left nothing behind, the route is
         still in its BOOTSTRAP state and the documented retry works. */
      const response = await post(seedRoute, "http://127.0.0.1/api/seed", bootstrapToken);
      assertEq(response.status, 201, `the retry must seed cleanly: ${response.status}`);
      const after = await state();
      assertEq(after.school_users, before.school_users + 3, "the memberships must be created");
    });

    console.log(`\n📊 Seed atomicity results: ${passed} passed, ${failed} failed\n`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const { pool } = requireFromRepo("./src/db/index.ts");
      await pool.end().catch(() => undefined);
    } catch {
      /* no pool */
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
