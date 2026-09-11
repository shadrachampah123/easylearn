/**
 * Phase 2A Tenant Foundation — LIVE DATABASE tests
 *
 * Applies the full migration chain (0000…0013) to a scratch PostgreSQL
 * database and verifies the actual database behavior of `schools` and
 * `school_users`:
 *
 *   1. schools can be represented correctly (defaults, timestamps, uuid PKs)
 *   2. school slugs are unique (23505) and constrained to URL-safe values/statuses (23514)
 *   3. a user can belong to a school via school_users
 *   4. the same user cannot have duplicate membership in the same school (23505)
 *   5. foreign keys are valid (23503) and cascade correctly
 *   6. multi-school membership: the SAME user can belong to School A AND
 *      School B (the single-school guard from 0013 is dropped by 0014)
 *   7. migrations are idempotent (running twice exits 0)
 *   8. no legacy table gained a school_id column
 *
 * Database providers (first match wins):
 *   - TEST_DATABASE_URL  → any PostgreSQL you point at (needs CREATE DATABASE
 *                          privilege; a scratch db is created and dropped)
 *   - embedded-postgres  → if installed (`npm i --no-save embedded-postgres`),
 *                          a throwaway server is started on a random port
 *   - otherwise the suite SKIPS (exit 0) so CI without a database still passes
 */

const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.join(__dirname, "..");
const DB_NAME = `easylearn_2a_test_${crypto.randomBytes(4).toString("hex")}`;

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${error.message}`);
      failed++;
    });
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const { Client } = require(path.join(REPO_ROOT, "node_modules", "pg"));

  let stopServer = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    let EmbeddedPostgres = null;
    try {
      ({ default: EmbeddedPostgres } = require("embedded-postgres"));
    } catch {
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run `npm run test:db`.");
      skipped++;
      return;
    }
    const port = 54329 + (crypto.randomBytes(2).readUInt16BE(0) % 2000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(require("os").tmpdir(), `${DB_NAME}-data`),
      user: "easylearn",
      password: "easylearn",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    stopServer = () => pg.stop();
    adminUrl = `postgres://easylearn:easylearn@localhost:${port}/postgres`;
    console.log(`📦 Embedded PostgreSQL started on port ${port}`);
  }

  const scratchUrl = (() => {
    try {
      const url = new URL(adminUrl);
      url.pathname = `/${DB_NAME}`;
      return url.toString();
    } catch {
      // postgres://user:pass@host:port/db form guaranteed by URL parsing above;
      // fall back to appending if it ever fails.
      return `${adminUrl.replace(/\/$/, "")}/${DB_NAME}`;
    }
  })();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  try {
    /* ── Provision the scratch database and run the project's real migration runner ── */

    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);

    const runMigrations = () =>
      spawnSync(process.execPath, ["run-migration.js"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: scratchUrl },
        encoding: "utf8",
      });

    let result = runMigrations();
    await test("Migration runner applies 0000…0013 successfully", () => {
      assertEq(result.status, 0, `run-migration.js exited ${result.status}:\n${(result.stdout || "") + (result.stderr || "")}`.slice(0, 8000));
      if (!String(result.stdout).includes("🎉 Migration complete")) {
        throw new Error("runner did not report completion");
      }
    });

    await test("Runner verification lists schools + school_users", () => {
      if (!/schools|school_users/.test(String(result.stdout))) {
        throw new Error("verification output missing the new tables");
      }
    });

    const db = new Client({ connectionString: scratchUrl });
    await db.connect();

    const expectError = async (sql, values, code, label) => {
      try {
        await db.query(sql, values);
      } catch (error) {
        assertEq(error.code, code, `${label} — wrong error code (message: ${error.message})`);
        return;
      }
      throw new Error(`${label} — expected error ${code} but the statement succeeded`);
    };

    /* ── 1. Schools can be represented correctly ── */

    let schoolA, schoolB, user1, user2;

    await test("Schools: insert with defaults yields uuid id + active status + timestamps", async () => {
      const { rows } = await db.query(
        `INSERT INTO "schools" ("name", "short_name", "slug") VALUES ($1, $2, $3) RETURNING *`,
        ["Test School A", "TSA", "test-school-a"]
      );
      schoolA = rows[0];
      assertEq(rows.length, 1, "one row inserted");
      assert(/^[0-9a-f-]{36}$/i.test(schoolA.id), "id must be a uuid");
      assertEq(schoolA.status, "active", "default status");
      assert(schoolA.created_at instanceof Date, "created_at set");
      assert(schoolA.updated_at instanceof Date, "updated_at set");
    });

    await test("Schools: slugs are unique", async () => {
      await expectError(
        `INSERT INTO "schools" ("name", "short_name", "slug") VALUES ($1, $2, $3)`,
        ["Another School", "AS", "test-school-a"],
        "23505",
        "duplicate slug"
      );
    });

    await test("Schools: lifecycle status is constrained", async () => {
      await expectError(
        `INSERT INTO "schools" ("name", "short_name", "slug", "status") VALUES ($1, $2, $3, $4)`,
        ["Bad School", "BS", "bad-school", "deleted"],
        "23514",
        "invalid status"
      );
    });

    await test("Schools: slug must be URL-safe", async () => {
      await expectError(
        `INSERT INTO "schools" ("name", "short_name", "slug") VALUES ($1, $2, $3)`,
        ["Bad Slug School", "BSS", "Bad_Slug!"],
        "23514",
        "invalid slug format"
      );
    });

    await test("Schools: second school can be created", async () => {
      const { rows } = await db.query(
        `INSERT INTO "schools" ("name", "short_name", "slug") VALUES ($1, $2, $3) RETURNING id`,
        ["Test School B", "TSB", "test-school-b"]
      );
      schoolB = rows[0];
      assert(/^[0-9a-f-]{36}$/i.test(schoolB.id), "second school id must be a uuid");
    });

    /* ── Users (existing table — unchanged) ── */

    await test("Users: legacy user creation is unaffected", async () => {
      const bcrypt = require(path.join(REPO_ROOT, "node_modules", "bcryptjs"));
      const hash = await bcrypt.hash("x-test-only", 4);
      const { rows } = await db.query(
        `INSERT INTO "users" ("email", "password_hash", "role", "first_name", "last_name")
         VALUES ($1, $2, 'teacher', 'Test', 'TeacherA') RETURNING id`,
        [`teacher-a-${DB_NAME}@example.test`, hash]
      );
      user1 = rows[0];
      const { rows: rows2 } = await db.query(
        `INSERT INTO "users" ("email", "password_hash", "role", "first_name", "last_name")
         VALUES ($1, $2, 'learner', 'Test', 'LearnerA') RETURNING id`,
        [`learner-a-${DB_NAME}@example.test`, hash]
      );
      user2 = rows2[0];
      assert(/^[0-9a-f-]{36}$/i.test(user1.id) && /^[0-9a-f-]{36}$/i.test(user2.id), "user uuids");
    });

    /* ── 3./4. Membership: valid, duplicate, and FK behavior ── */

    let membership1;

    await test("Membership: a user can belong to a school", async () => {
      const { rows } = await db.query(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher') RETURNING *`,
        [schoolA.id, user1.id]
      );
      membership1 = rows[0];
      assertEq(rows[0].status, "active", "default membership status");
      assert(membership1.created_at instanceof Date, "membership created_at set");
    });

    await test("Membership: duplicate (school, user) is rejected", async () => {
      await expectError(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher')`,
        [schoolA.id, user1.id],
        "23505",
        "duplicate membership"
      );
    });

    await test("Membership: foreign keys are enforced (school)", async () => {
      await expectError(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher')`,
        ["11111111-1111-1111-1111-111111111111", user2.id],
        "23503",
        "unknown school_id"
      );
    });

    await test("Membership: foreign keys are enforced (user)", async () => {
      await expectError(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher')`,
        [schoolA.id, "22222222-2222-2222-2222-222222222222"],
        "23503",
        "unknown user_id"
      );
    });

    await test("Membership: role reuses the existing user_role enum", async () => {
      await expectError(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'platform_admin')`,
        [schoolA.id, user1.id],
        "22P02",
        "invalid enum value"
      );
    });

    /* ── 6. Multi-school membership (0014 dropped the single-school guard) ── */

    await test("Multi-school: the same user can belong to School A", async () => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM "school_users" WHERE "user_id" = $1 AND "school_id" = $2`,
        [user1.id, schoolA.id]
      );
      assertEq(rows[0].n, 1, "user1 must hold exactly one School A membership");
    });

    await test("Multi-school: the same user can ALSO belong to School B", async () => {
      const { rows } = await db.query(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher') RETURNING *`,
        [schoolB.id, user1.id]
      );
      assertEq(rows.length, 1, "second-school membership inserted");
      const { rows: both } = await db.query(
        `SELECT count(*)::int AS n FROM "school_users" WHERE "user_id" = $1`,
        [user1.id]
      );
      assertEq(both[0].n, 2, "user1 must now hold memberships in TWO schools");
    });

    await test("Multi-school: the same user cannot be added twice to School A", async () => {
      await expectError(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher')`,
        [schoolA.id, user1.id],
        "23505",
        "duplicate membership in School A"
      );
      await expectError(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'learner')`,
        [schoolA.id, user1.id],
        "23505",
        "duplicate membership in School A with a different role"
      );
    });

    await test("Multi-school: guard is a NON-UNIQUE placeholder, (school_id, user_id) unique remains", async () => {
      // 0014 replaces 0013's unique guard with a non-unique same-name placeholder
      // so that re-running 0013 (CREATE ... IF NOT EXISTS) never resurrects the
      // single-school restriction.
      const placeholder = await db.query(
        `SELECT i."indisunique" FROM "pg_indexes" x
           JOIN "pg_class" c ON c."relname" = x."indexname"
           JOIN "pg_index" i ON i."indexrelid" = c."oid"
          WHERE x."indexname" = 'school_users_one_school_per_user'`
      );
      assertEq(placeholder.rowCount, 1, "placeholder index must exist");
      assertEq(placeholder.rows[0].indisunique, false, "placeholder must be NON-unique (multi-school allowed)");
      const pairUnique = await db.query(
        `SELECT i."indisunique" FROM "pg_indexes" x
           JOIN "pg_class" c ON c."relname" = x."indexname"
           JOIN "pg_index" i ON i."indexrelid" = c."oid"
          WHERE x."indexname" = 'school_users_school_user_unique'`
      );
      assertEq(pairUnique.rowCount, 1, "(school_id, user_id) unique index must exist");
      assertEq(pairUnique.rows[0].indisunique, true, "(school_id, user_id) must be UNIQUE");
    });

    await test("Membership: membership status is constrained", async () => {
      await expectError(
        `UPDATE "school_users" SET "status" = 'paused' WHERE "id" = $1`,
        [membership1.id],
        "23514",
        "invalid membership status"
      );
    });

    /* ── 5. Cascades ── */

    await test("Cascade: deleting a school removes its memberships", async () => {
      const { rows } = await db.query(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'learner')`,
        [schoolA.id, user2.id]
      );
      await db.query(`DELETE FROM "schools" WHERE "id" = $1`, [schoolA.id]);
      const { rows: remaining } = await db.query(
        `SELECT count(*)::int AS n FROM "school_users" WHERE "school_id" = $1`,
        [schoolA.id]
      );
      assertEq(remaining[0].n, 0, "memberships must cascade with school");
      // Restore state for later tests: recreate school A row with the same id.
      await db.query(
        `INSERT INTO "schools" ("id", "name", "short_name", "slug") VALUES ($1, $2, $3, $4)`,
        [schoolA.id, "Test School A", "TSA", "test-school-a"]
      );
      await db.query(
        `INSERT INTO "school_users" ("id", "school_id", "user_id", "role", "status") VALUES ($1, $2, $3, 'teacher', 'active')`,
        [membership1.id, schoolA.id, user1.id]
      );
    });

    /* ── 7. Idempotency ── */

    await test("Migrations are idempotent (second run exits 0)", () => {
      const second = runMigrations();
      assertEq(second.status, 0, `second run exited ${second.status}:\n${(second.stdout || "") + (second.stderr || "")}`.slice(0, 8000));
    });

    await test("Multi-school still works after the second full migration run", async () => {
      // A naive follow-up fix would let 0013's CREATE UNIQUE INDEX IF NOT EXISTS
      // resurrect the single-school guard on every re-run (failing once multi-school
      // data exists). Prove the end state survives: insert a fresh user into BOTH
      // schools and confirm the existing two-school membership is intact.
      await db.query(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'learner')`,
        [schoolA.id, user2.id]
      );
      const { rows } = await db.query(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'learner') RETURNING id`,
        [schoolB.id, user2.id]
      );
      assert(/^[0-9a-f-]{36}$/i.test(rows[0].id), "user2 joined both schools after the re-run");
      const { rows: user1Pairs } = await db.query(
        `SELECT count(*)::int AS n FROM "school_users" WHERE "user_id" = $1`,
        [user1.id]
      );
      assertEq(user1Pairs[0].n, 2, "user1's two pre-existing memberships must survive re-runs");
    });

    /* ── 8. Legacy schema untouched ── */

    await test("Boundary: school_id exists ONLY on school_users", async () => {
      const { rows } = await db.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'school_id'`
      );
      assertEq(rows.map((r) => r.table_name).sort().join(","), "school_users", "school_id columns");
    });

    await test("Boundary: exactly the 35 legacy tables + 2 new tables exist", async () => {
      const { rows } = await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      const tables = new Set(rows.map((r) => r.table_name));
      const expected = [
        "users","academic_years","terms","departments","classes","subjects","teacher_classes",
        "learner_classes","parent_learners","assignments","submissions","uploaded_files",
        "assignment_questions","assignment_answers","assignment_corrections","resources","quizzes",
        "quiz_questions","quiz_attempts","announcements","notifications","attendance","login_attempts",
        "attendance_duplicates_backup","timetable_entries","messages","activity_logs",
        "dashboard_card_overrides","achievements","learner_achievements","learner_points",
        "gallery_items","news","faqs","downloads",
      ];
      for (const t of expected) {
        if (!tables.has(t)) throw new Error(`legacy table missing: ${t}`);
      }
      if (!tables.has("schools") || !tables.has("school_users")) {
        throw new Error("new tenant tables missing");
      }
      assertEq(tables.size, expected.length + 2, "total table count");
    });

    await db.end();
  } finally {
    // ── Cleanup: drop scratch db, stop server ──
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    } catch {
      try { await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`); } catch { /* best effort */ }
    }
    await admin.end().catch(() => {});
    if (stopServer) await stopServer().catch(() => {});
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("❌ FATAL:", error);
  process.exit(1);
});
