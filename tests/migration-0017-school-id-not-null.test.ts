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
import { spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
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

  const runMigrations = () =>
    spawnSync(process.execPath, ["run-migration.js"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: "utf8",
    });

  const run0017Only = () =>
    spawnSync(process.execPath, ["run-migration.js", "0017_school_id_not_null.sql"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: "utf8",
    });

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
      const runner = fs.readFileSync(path.join(REPO_ROOT, "run-migration.js"), "utf8");
      assert(runner.includes('"0017_school_id_not_null.sql"'), "run-migration.js must list 0017");
    });

    let result = runMigrations();
    await test("Full chain 0000…0017 applies successfully", () => {
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
    });

    const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

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
      const rerun = run0017Only();
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

      const aborted = run0017Only();
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
      const fixed = run0017Only();
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

      const rerun = run0017Only();
      assertEq(rerun.status, 0, "re-run must succeed with fully attributed data");

      const againA = await one(`SELECT school_id FROM departments WHERE id = $1`, [deptA.id]);
      const againB = await one(`SELECT school_id FROM departments WHERE id = $1`, [deptB.id]);
      assertEq(againA.school_id, a, "school A attribution preserved");
      assertEq(againB.school_id, b, "school B attribution preserved");
    });

    console.log(`\n📊 Migration 0017 results: ${passed} passed, ${failed} failed\n`);
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
