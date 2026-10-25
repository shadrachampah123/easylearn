/**
 * Phase 2E — Migration 0017 validation (LIVE DATABASE).
 *
 * Proves the migration contract against a real PostgreSQL:
 *   1. Full chain 0000…0017 applies cleanly and is idempotent.
 *   2. Deterministic relational backfill resolves NULL school_id from parents.
 *   3. Single-school residual stamp fills remaining required-table NULLs.
 *   4. Multi-school + unresolvable NULL → migration ABORTS (no wrong-school guess).
 *   5. NOT NULL enforced on all A-class tables except activity_logs.
 *   6. Existing non-NULL school_id values are preserved.
 *   7. Existing school_id FKs remain.
 *   8. UNIQUE (school_id, id) targets exist.
 *   9. activity_logs stays nullable (platform events).
 *
 * Providers: TEST_DATABASE_URL → embedded-postgres → SKIP (exit 0).
 */

import assert from "assert";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain, GATED_MIGRATIONS } = requireFromRepo("./tests/helpers/migrations.js");
const DB_NAME = `easylearn_0017_test_${crypto.randomBytes(4).toString("hex")}`;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${(error as Error).message}`);
      failed++;
    });
}

function assertEq(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(
      `${message || "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

const REQUIRED_NOT_NULL = [
  "academic_years",
  "terms",
  "departments",
  "classes",
  "subjects",
  "teacher_classes",
  "learner_classes",
  "parent_learners",
  "assignments",
  "submissions",
  "uploaded_files",
  "resources",
  "quizzes",
  "quiz_attempts",
  "announcements",
  "notifications",
  "attendance",
  "timetable_entries",
  "messages",
  "dashboard_card_overrides",
  "gallery_items",
  "news",
  "faqs",
  "downloads",
];

async function main() {
  const { Client } = requireFromRepo("pg");

  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      console.log("   Install with `npm i --no-save embedded-postgres` and re-run.");
      return;
    }
    const port = 55729 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`),
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
    const url = new URL(adminUrl as string);
    url.pathname = `/${DB_NAME}`;
    return url.toString();
  })();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  const db = new Client({ connectionString: scratchUrl });
  await db.connect();

  const runMigrations = () => runMigrationChain({ databaseUrl: scratchUrl });

  // Re-execute 0017's SQL directly only inside this disposable test database. The migration
  // runner now consults its history ledger and correctly skips already-recorded migrations.
  const run0017Only = async () => {
    try {
      await db.query("BEGIN");
      const source = fs.readFileSync(path.join(REPO_ROOT, "0017_school_id_not_null.sql"), "utf8");
      const statements = source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
      for (const statement of statements) await db.query(statement);
      await db.query("COMMIT");
      return { status: 0, stdout: "0017 SQL re-executed in disposable test transaction", stderr: "" };
    } catch (error: any) {
      await db.query("ROLLBACK").catch(() => {});
      return { status: 1, stdout: "", stderr: error.message };
    }
  };

  try {
    console.log("\n🎯 Migration 0017 — school_id NOT NULL validation\n");

    await test("Migration files exist (root + drizzle) and runner registers 0017", () => {
      assert(fs.existsSync(path.join(REPO_ROOT, "0017_school_id_not_null.sql")), "root copy");
      assert(
        fs.existsSync(path.join(REPO_ROOT, "drizzle", "0017_school_id_not_null.sql")),
        "drizzle copy"
      );
      const root = fs.readFileSync(path.join(REPO_ROOT, "0017_school_id_not_null.sql"), "utf8");
      const drizzle = fs.readFileSync(
        path.join(REPO_ROOT, "drizzle", "0017_school_id_not_null.sql"),
        "utf8"
      );
      assertEq(root, drizzle, "root and drizzle copies must be identical");
      const compositeRoot = fs.readFileSync(path.join(REPO_ROOT, "0018_composite_school_foreign_keys.sql"), "utf8");
      const compositeDrizzle = fs.readFileSync(path.join(REPO_ROOT, "drizzle", "0018_composite_school_foreign_keys.sql"), "utf8");
      assertEq(compositeRoot, compositeDrizzle, "0018 root and drizzle copies must be identical");
      assert(
        compositeRoot.includes("current_setting('server_version_num')::integer < 150000"),
        "0018 must fail clearly before DDL when PostgreSQL is older than 15"
      );
      const runner = fs.readFileSync(path.join(REPO_ROOT, "run-migration.js"), "utf8");
      assert(runner.includes('"0017_school_id_not_null.sql"'), "run-migration.js must list 0017");
      assert(runner.includes('"0018_composite_school_foreign_keys.sql"'), "run-migration.js must list 0018");
      assert(runner.includes('"0019_session_revocation.sql"'), "run-migration.js must list 0019");
    });

    let result = runMigrations();
    await test("Full chain 0000…0019 applies successfully", () => {
      assertEq(
        result.status,
        0,
        `run-migration.js exited ${result.status}:\n${((result.stdout || "") + (result.stderr || "")).slice(-4000)}`
      );
      assert(String(result.stdout).includes("🎉 Migration complete"), "completion banner");
      assert(
        /0017/i.test(String(result.stdout)),
        "runner output should mention 0017 statements or notices"
      );
    });

    await test("Idempotent: second full-chain run exits 0", () => {
      const second = runMigrations();
      assertEq(
        second.status,
        0,
        `second run exited ${second.status}:\n${((second.stdout || "") + (second.stderr || "")).slice(-4000)}`
      );
      assert(String(second.stdout).includes("already recorded with matching checksums"), "second run must skip from ledger");
    });

    const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

    await test("Runner records ordered checksummed migration history", async () => {
      const rows = await q(`SELECT filename, checksum FROM easylearn_schema_migrations ORDER BY filename`);
      assertEq(rows.length, 20, "all migrations 0000 through 0019 recorded");
      for (const row of rows) {
        assert(/^[0-9a-f]{64}$/.test(row.checksum), `${row.filename} has a SHA-256 checksum`);
      }
      assertEq(rows[19].filename, "0019_session_revocation.sql", "0019 is the final applied migration");
    });

    await test("Session revocation: users.session_version exists after the ordinary runner (0019, independent review I-1)", async () => {
      const col = await one(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'session_version'`
      );
      assert(col, "session_version must exist after run-migration.js — previously only lazy runtime repair created it");
      assertEq(col.is_nullable, "NO", "session_version is NOT NULL");
    });

    await test("Runner rejects checksum drift and migration-history gaps", async () => {
      const first = await one(
        `SELECT filename, checksum FROM easylearn_schema_migrations WHERE filename = $1`,
        ["0000_wet_legion.sql"]
      );
      await db.query(
        `UPDATE easylearn_schema_migrations SET checksum = repeat('0', 64) WHERE filename = $1`,
        [first.filename]
      );
      const drift = runMigrations();
      const driftOutput = `${drift.stdout || ""}${drift.stderr || ""}`;
      assert(drift.status !== 0, "modified applied checksum must stop the runner");
      assert(driftOutput.includes("Checksum mismatch"), "checksum failure should identify drift");
      await db.query(`UPDATE easylearn_schema_migrations SET checksum = $2 WHERE filename = $1`, [first.filename, first.checksum]);

      const missing = await one(
        `SELECT filename, checksum, applied_at FROM easylearn_schema_migrations WHERE filename = $1`,
        ["0003_timetable.sql"]
      );
      await db.query(`DELETE FROM easylearn_schema_migrations WHERE filename = $1`, [missing.filename]);
      const gap = runMigrations();
      const gapOutput = `${gap.stdout || ""}${gap.stderr || ""}`;
      assert(gap.status !== 0, "a ledger gap before later applied migrations must stop the runner");
      assert(gapOutput.includes("history has a gap"), "gap failure should be explicit");
      await db.query(
        `INSERT INTO easylearn_schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, $3)`,
        [missing.filename, missing.checksum, missing.applied_at]
      );
    });

    await test("Runner serializes concurrent invocations with its advisory lock", async () => {
      const lockKey = [1163416649, 1296125510];
      await db.query("SELECT pg_advisory_lock($1, $2)", lockKey);
      let held = true;
      const child = spawn(process.execPath, ["run-migration.js"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: scratchUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const completion = new Promise<{ status: number | null; output: string }>((resolve, reject) => {
          let output = "";
          child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
          child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
          child.on("error", reject);
          child.on("close", (status) => resolve({ status, output }));
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const waiting = await one(`
          SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
             AND query LIKE '%pg_advisory_lock%'
        `);
        assertEq(waiting.count > 0, true, "second runner should be waiting on the held migration lock");
        assertEq(child?.exitCode, null, "second runner must not exit while the migration lock is held");
        await db.query("SELECT pg_advisory_unlock($1, $2)", lockKey);
        held = false;
        const result = await completion;
        assertEq(result.status, 0, `serialized runner should finish cleanly: ${result.output.slice(-2500)}`);
        assert(result.output.includes("already recorded with matching checksums"), "serialized runner should recheck history after acquiring the lock");
      } finally {
        if (held) await db.query("SELECT pg_advisory_unlock($1, $2)", lockKey).catch(() => {});
        if (child.exitCode === null) child.kill("SIGTERM");
      }
    });

    await test("NOT NULL on required A-tables; activity_logs stays nullable", async () => {
      const rows = await q(
        `SELECT table_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'school_id'
          ORDER BY table_name`
      );
      const byTable = Object.fromEntries(rows.map((r: any) => [r.table_name, r.is_nullable]));
      for (const t of REQUIRED_NOT_NULL) {
        assertEq(byTable[t], "NO", `${t}.school_id must be NOT NULL`);
      }
      assertEq(byTable["activity_logs"], "YES", "activity_logs.school_id must stay nullable");
      assertEq(byTable["school_users"], "NO", "school_users.school_id stays NOT NULL");
    });

    await test("Existing school_id FKs to schools(id) still present", async () => {
      const rows = await q(
        `SELECT tc.table_name, tc.constraint_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND kcu.column_name = 'school_id'
            AND ccu.table_name = 'schools'
          ORDER BY tc.table_name`
      );
      const tables = new Set(rows.map((r: any) => r.table_name));
      for (const t of [...REQUIRED_NOT_NULL, "activity_logs"]) {
        assert(tables.has(t), `missing school_id FK on ${t}`);
      }
    });

    await test("UNIQUE (school_id, id) targets exist", async () => {
      const { rows } = await db.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND indexname LIKE '%_school_id_id_unique'
          ORDER BY indexname`
      );
      assertEq(rows.length, REQUIRED_NOT_NULL.length, "one unique target per required A-table");
    });

    await test("school_id indexes from 0016 still present", async () => {
      const { rows } = await db.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND indexname LIKE '%_school_idx'`
      );
      assert(rows.length >= 25, `expected ≥25 school_id indexes, got ${rows.length}`);
    });

    // ── Deterministic backfill + preserve existing values ──
    // Temporarily relax NOT NULL to seed a NULL row, prove relational fill, then re-run 0017.
    await test("Deterministic backfill: terms.school_id derived from academic_years", async () => {
      const cbism = await one(`SELECT id FROM schools WHERE slug = 'cbism' LIMIT 1`);
      assert(cbism?.id, "cbism school must exist from 0015");

      // Relax NOT NULL only for this controlled fixture (test DB only).
      await db.query(`ALTER TABLE terms ALTER COLUMN school_id DROP NOT NULL`);
      await db.query(`ALTER TABLE academic_years ALTER COLUMN school_id DROP NOT NULL`);

      const year = await one(
        `INSERT INTO academic_years (school_id, name, start_date, end_date)
         VALUES ($1, '0017-year', '2026-01-01', '2026-12-31') RETURNING id`,
        [cbism.id]
      );
      const term = await one(
        `INSERT INTO terms (name, academic_year_id, start_date, end_date)
         VALUES ('term_1', $1, '2026-01-01', '2026-04-01') RETURNING id, school_id`,
        [year.id]
      );
      assertEq(term.school_id, null, "fixture term starts NULL");

      // A second year with a DIFFERENT school would be multi-school; keep single school.
      const rerun = await run0017Only();
      assertEq(
        rerun.status,
        0,
        `0017 re-run failed:\n${((rerun.stdout || "") + (rerun.stderr || "")).slice(-3000)}`
      );

      const filled = await one(`SELECT school_id FROM terms WHERE id = $1`, [term.id]);
      assertEq(filled.school_id, cbism.id, "term must inherit academic_years.school_id");

      // Existing non-NULL on the year must be preserved.
      const yearRow = await one(`SELECT school_id FROM academic_years WHERE id = $1`, [year.id]);
      assertEq(yearRow.school_id, cbism.id, "pre-existing school_id must be preserved");
    });

    await test("NOT NULL rejects unattributed inserts after 0017", async () => {
      try {
        await db.query(
          `INSERT INTO departments (name) VALUES ('no-school-dept')`
        );
        throw new Error("expected 23502 NOT NULL violation");
      } catch (error: any) {
        if (error.message === "expected 23502 NOT NULL violation") throw error;
        assertEq(error.code, "23502", `wrong error: ${error.message}`);
      }
    });

    await test("activity_logs still accepts NULL school_id", async () => {
      const row = await one(
        `INSERT INTO activity_logs (action, description) VALUES ('login', 'platform') RETURNING school_id`
      );
      assertEq(row.school_id, null, "platform activity may be NULL");
    });

    // ── Multi-school abort: unresolved NULL must not be guessed ──
    await test("Multi-school + unresolvable NULL → 0017 aborts (no wrong-school stamp)", async () => {
      // Create a second school and a NULL gallery row with no deterministic owner.
      const schoolB = await one(
        `INSERT INTO schools (name, short_name, slug) VALUES ('Other School', 'OS', 'other-school') RETURNING id`
      );
      await db.query(`ALTER TABLE gallery_items ALTER COLUMN school_id DROP NOT NULL`);
      await db.query(
        `INSERT INTO gallery_items (title, image_url) VALUES ('orphan-gallery', 'https://example.test/x.jpg')`
      );

      const aborted = await run0017Only();
      assert(
        aborted.status !== 0,
        "0017 must fail when multi-school + unresolved NULL remain"
      );
      const out = ((aborted.stdout || "") + (aborted.stderr || "")).toLowerCase();
      assert(
        out.includes("refusing not null") || out.includes("unresolved null") || out.includes("❌"),
        `abort output should explain the blocker, got: ${out.slice(-1500)}`
      );

      // The orphan must still be NULL — never silently stamped to CBISM or school B.
      const orphan = await one(
        `SELECT school_id FROM gallery_items WHERE title = 'orphan-gallery'`
      );
      assertEq(orphan.school_id, null, "unresolvable row must NOT be assigned to any school");

      // Cleanup so later checks stay clean: attribute + re-enforce.
      await db.query(
        `UPDATE gallery_items SET school_id = $1 WHERE school_id IS NULL`,
        [schoolB.id]
      );
      const fixed = await run0017Only();
      assertEq(
        fixed.status,
        0,
        `cleanup 0017 re-run failed:\n${((fixed.stdout || "") + (fixed.stderr || "")).slice(-2000)}`
      );
    });

    await test("Preserves valid school_id across re-run (two schools)", async () => {
      const schools = await q(`SELECT id, slug FROM schools ORDER BY slug`);
      assert(schools.length >= 2, "need ≥2 schools after multi-school fixture");
      const a = schools.find((s: any) => s.slug === "cbism")?.id;
      const b = schools.find((s: any) => s.slug === "other-school")?.id;
      assert(a && b, "cbism + other-school");

      const deptA = await one(
        `INSERT INTO departments (school_id, name) VALUES ($1, 'Dept-A-0017') RETURNING id, school_id`,
        [a]
      );
      const deptB = await one(
        `INSERT INTO departments (school_id, name) VALUES ($1, 'Dept-B-0017') RETURNING id, school_id`,
        [b]
      );
      assertEq(deptA.school_id, a);
      assertEq(deptB.school_id, b);

      const rerun = await run0017Only();
      assertEq(rerun.status, 0, "re-run must succeed with fully attributed data");

      const againA = await one(`SELECT school_id FROM departments WHERE id = $1`, [deptA.id]);
      const againB = await one(`SELECT school_id FROM departments WHERE id = $1`, [deptB.id]);
      assertEq(againA.school_id, a, "school A attribution preserved");
      assertEq(againB.school_id, b, "school B attribution preserved");
    });

    await test("Production read-only checkpoint SQL runs only against disposable PostgreSQL here", async () => {
      const checkpoint = fs.readFileSync(path.join(REPO_ROOT, "docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md"), "utf8");
      const sqlBlocks = Array.from(checkpoint.matchAll(/```sql\n([\s\S]*?)\n```/g), (match) => match[1]);
      assert(sqlBlocks.length >= 2, "read-only checkpoint and conditional ledger SQL blocks must exist");
      for (const sql of sqlBlocks) await db.query(sql);
    });

    await test("Runner baseline requires confirmation and only records a sequential prefix", async () => {
      await db.query(`DROP TABLE easylearn_schema_migrations`);
      const prefix = [
        "0000_wet_legion.sql", "0001_assignment_grading.sql", "0002_optional_email.sql",
        "0003_timetable.sql", "0004_dashboard_overrides.sql", "0005_activity_enhancements.sql",
        "0006_user_identity_columns.sql", "0007_quiz_images.sql", "0008_easyai_grading.sql",
        "0009_file_uploads.sql", "0010_object_storage.sql", "0011_attendance_unique_constraint.sql",
        "0012_login_attempts.sql", "0013_multi_school_foundation.sql", "0014_drop_single_school_guard.sql",
        "0015_cbism_school_and_membership_backfill.sql", "0016_school_id_columns.sql",
        "0017_school_id_not_null.sql", "0019_session_revocation.sql",
        "0018_composite_school_foreign_keys.sql",
      ];
      const baselineEnv = { ...process.env, DATABASE_URL: scratchUrl };
      const unconfirmed = spawnSync(process.execPath, ["run-migration.js", "--baseline", prefix.join(",")], {
        cwd: REPO_ROOT, env: baselineEnv, encoding: "utf8",
      });
      const unconfirmedOutput = `${unconfirmed.stdout || ""}${unconfirmed.stderr || ""}`;
      assert(unconfirmed.status !== 0, "baseline without explicit operator confirmation must fail");
      assert(unconfirmedOutput.includes("Baseline refused"), "baseline refusal should be explicit");
      assertEq((await one(`SELECT to_regclass('public.easylearn_schema_migrations') AS relation`)).relation, null, "unconfirmed baseline creates no ledger");

      const invalidPrefix = spawnSync(process.execPath, ["run-migration.js", "--baseline", "0001_assignment_grading.sql"], {
        cwd: REPO_ROOT,
        env: { ...baselineEnv, CONFIRM_MIGRATION_BASELINE: "I_HAVE_VERIFIED_THESE_MIGRATIONS" },
        encoding: "utf8",
      });
      assert(invalidPrefix.status !== 0, "non-prefix baseline must fail before database mutation");
      assert(`${invalidPrefix.stdout || ""}${invalidPrefix.stderr || ""}`.includes("sequential prefix"), "invalid baseline should explain required ordering");

      const tableCountBefore = Number((await one(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`)).count);
      /* A baseline must not be usable to record a GATED migration as applied without the
         same explicit confirmation the gated path requires. */
      const gatedPrefix = prefix[prefix.length - 1];
      const gatedGate = GATED_MIGRATIONS[gatedPrefix];
      assert(gatedGate, "the last migration of the prefix is expected to be gated");
      const gatedBaseline = spawnSync(process.execPath, ["run-migration.js", "--baseline", prefix.join(",")], {
        cwd: REPO_ROOT,
        env: { ...baselineEnv, CONFIRM_MIGRATION_BASELINE: "I_HAVE_VERIFIED_THESE_MIGRATIONS" },
        encoding: "utf8",
      });
      const gatedBaselineOutput = `${gatedBaseline.stdout || ""}${gatedBaseline.stderr || ""}`;
      assert(gatedBaseline.status !== 0, "a baseline that includes a gated migration must be refused without its confirmation");
      assert(
        gatedBaselineOutput.includes("Baseline refused") && gatedBaselineOutput.includes(gatedPrefix),
        "the baseline refusal must name the gated migration"
      );

      const confirmed = spawnSync(process.execPath, ["run-migration.js", "--baseline", prefix.join(",")], {
        cwd: REPO_ROOT,
        env: {
          ...baselineEnv,
          CONFIRM_MIGRATION_BASELINE: "I_HAVE_VERIFIED_THESE_MIGRATIONS",
          [gatedGate.env]: gatedGate.token,
        },
        encoding: "utf8",
      });
      assertEq(confirmed.status, 0, `explicit baseline should succeed in this disposable test DB: ${(confirmed.stdout || "") + (confirmed.stderr || "")}`);
      assert((confirmed.stdout || "").includes("no migration SQL was executed"), "baseline must clearly report it did not apply SQL");
      const tableCountAfter = Number((await one(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`)).count);
      assertEq(tableCountAfter, tableCountBefore + 1, "baseline should add only the migration ledger table");
      assertEq(Number((await one(`SELECT count(*)::int AS count FROM easylearn_schema_migrations`)).count), prefix.length, "baseline records only the supplied sequential prefix");
    });

    await test("A gated migration is never applied automatically and needs an explicit confirmation", async () => {
      /* 0018 adds 26 composite tenant foreign keys. It is gated: the standard
         "apply everything" run must NOT apply it, and an explicit run must be refused
         until the operator confirms that the read-only preflight has been reviewed. */
      const gateFile = "0018_composite_school_foreign_keys.sql";
      const gate = GATED_MIGRATIONS[gateFile];
      assert(gate, "0018 must be registered as a gated migration");

      const gateDbName = `${DB_NAME}_gate`;
      await admin.query(`DROP DATABASE IF EXISTS "${gateDbName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${gateDbName}"`);
      const gateUrl = (() => {
        const url = new URL(scratchUrl);
        url.pathname = `/${gateDbName}`;
        return url.toString();
      })();
      const gateDb = new Client({ connectionString: gateUrl });
      await gateDb.connect();
      const gateOne = async (sql: string, values: unknown[] = []) =>
        (await gateDb.query(sql, values)).rows[0];

      /* The composite tenant foreign keys are exactly the foreign keys whose key list
         starts with (school_id, ...). The single-column school_id FKs added by 0016
         reference schools(id) and must NOT be counted here. */
      const constraintCount = async () =>
        Number(
          (
            await gateOne(
              `SELECT count(*)::int AS count FROM pg_constraint
                WHERE contype = 'f' AND pg_get_constraintdef(oid) LIKE '%(school_id,%'`
            )
          ).count
        );

      try {
        /* 1. The ordinary run applies everything else and SKIPS the gated migration. */
        const ordinary = spawnSync(process.execPath, ["run-migration.js"], {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: gateUrl },
          encoding: "utf8",
        });
        const ordinaryOutput = `${ordinary.stdout || ""}${ordinary.stderr || ""}`;
        assertEq(ordinary.status, 0, `the ordinary run must still succeed: ${ordinaryOutput.slice(-2000)}`);
        assert(
          ordinaryOutput.includes("GATED MIGRATION NOT APPLIED"),
          "the ordinary run must announce that the gated migration was skipped"
        );
        assert(ordinaryOutput.includes(gate.env), "the skip notice must name the confirmation variable");
        const recorded = await gateOne(
          `SELECT count(*)::int AS count FROM easylearn_schema_migrations WHERE filename = $1`,
          [gateFile]
        );
        assertEq(recorded.count, 0, "the gated migration must not be recorded as applied");
        assertEq(await constraintCount(), 0, "the gated migration's constraints must not exist");

        /* 2. An explicit run without the confirmation token is REFUSED. */
        const unconfirmed = spawnSync(process.execPath, ["run-migration.js", gateFile], {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: gateUrl },
          encoding: "utf8",
        });
        const unconfirmedOutput = `${unconfirmed.stdout || ""}${unconfirmed.stderr || ""}`;
        assert(unconfirmed.status !== 0, "an unconfirmed gated migration must fail");
        assert(
          unconfirmedOutput.includes("Refusing to apply"),
          "the refusal must be explicit and must explain the preflight requirement"
        );
        const stillUnrecorded = await gateOne(
          `SELECT count(*)::int AS count FROM easylearn_schema_migrations WHERE filename = $1`,
          [gateFile]
        );
        assertEq(stillUnrecorded.count, 0, "a refused gated migration must not be recorded");
        assertEq(await constraintCount(), 0, "a refused gated migration must not change the schema");

        /* 3. With the confirmation token the migration is applied. */
        const confirmed = spawnSync(process.execPath, ["run-migration.js", gateFile], {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: gateUrl, [gate.env]: gate.token },
          encoding: "utf8",
        });
        const confirmedOutput = `${confirmed.stdout || ""}${confirmed.stderr || ""}`;
        assertEq(confirmed.status, 0, `the confirmed gated migration must succeed: ${confirmedOutput.slice(-2000)}`);
        const nowRecorded = await gateOne(
          `SELECT count(*)::int AS count FROM easylearn_schema_migrations WHERE filename = $1`,
          [gateFile]
        );
        assertEq(nowRecorded.count, 1, "the confirmed gated migration must be recorded");
        assertEq(await constraintCount(), 26, "the confirmed gated migration must add its 26 constraints");
      } finally {
        await gateDb.end().catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS "${gateDbName}" WITH (FORCE)`).catch(() => undefined);
      }
    });

    await test("Runner fails closed on an existing schema without migration history", async () => {
      await db.query(`DROP TABLE easylearn_schema_migrations`);
      const untracked = runMigrations();
      const output = `${untracked.stdout || ""}${untracked.stderr || ""}`;
      assert(untracked.status !== 0, "untracked existing database must not replay the migration chain");
      assert(output.includes("Existing public tables were found"), "runner should explain the baseline requirement");
      const ledger = await one(`SELECT to_regclass('public.easylearn_schema_migrations') AS relation`);
      assertEq(ledger.relation, null, "refusal must not create or modify the missing ledger");
    });

    console.log(`\n📊 Migration 0017/0018 results: ${passed} passed, ${failed} failed\n`);
  } finally {
    await db.end().catch(() => {});
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    } catch {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
      } catch {
        /* best effort */
      }
    }
    await admin.end().catch(() => {});
    if (stopServer) await stopServer().catch(() => {});
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
