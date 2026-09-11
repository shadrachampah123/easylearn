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
 *   6. the single-school-era guard rejects a second active membership (23505)
 *      while a 'disabled' membership frees the user for another school
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
      assertEq(result.status, 0, `run-migration.js exited ${result.status}:\n${(result.stdout || "") + (result.stderr || "")}`.slice(0, 2000));
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

    /* ── 6. Single-school-era guard ── */

    await test("Guard: a second ACTIVE membership in another school is rejected", async () => {
      await expectError(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher')`,
        [schoolB.id, user1.id],
        "23505",
        "second school for same user"
      );
    });

    await test("Guard: a DISABLED membership frees the user for another school", async () => {
      await db.query(`UPDATE "school_users" SET "status" = 'disabled' WHERE "id" = $1`, [membership1.id]);
      const { rows } = await db.query(
        `INSERT INTO "school_users" ("school_id", "user_id", "role") VALUES ($1, $2, 'teacher') RETURNING id`,
        [schoolB.id, user1.id]
      );
      assert(/^[0-9a-f-]{36}$/i.test(rows[0].id), "membership in school B allowed after disabling school A");
      await db.query(`DELETE FROM "school_users" WHERE "id" = $1`, [rows[0].id]);
      await db.query(`UPDATE "school_users" SET "status" = 'active' WHERE "id" = $1`, [membership1.id]);
    });

    await test("Guard: re-enabling a second active membership is rejected too", async () => {
      // Defensive cleanup in case an earlier step left rows behind.
      await db.query(`DELETE FROM "school_users" WHERE "school_id" = $1 AND "user_id" = $2`, [schoolB.id, user1.id]);
      // Create it disabled, then try to activate while A is active.
      await db.query(
        `INSERT INTO "school_users" ("school_id", "user_id", "role", "status") VALUES ($1, $2, 'teacher', 'disabled')`,
        [schoolB.id, user1.id]
      );
      await expectError(
        `UPDATE "school_users" SET "status" = 'active' WHERE "school_id" = $1 AND "user_id" = $2`,
        [schoolB.id, user1.id],
        "23505",
        "activate second membership"
      );
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
        `INSERT INTO "school_users" ("school_id", "user_id", "role", "status") VALUES ($1, $2, 'learner', 'disabled')`,
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
      assertEq(second.status, 0, `second run exited ${second.status}:\n${(second.stdout || "") + (second.stderr || "")}`.slice(0, 2000));
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
