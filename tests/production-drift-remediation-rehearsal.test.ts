/**
 * Production-drift remediation rehearsal (Issue #54).
 *
 * Read-only catalog checks against production (documented in
 * SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md, PR #64) found the exact
 * shape this test rebuilds on a DISPOSABLE database:
 *
 *   - migrations 0013/0016/0017 effects present (schools, 26 school_id
 *     columns, all 24 UNIQUE (school_id, id) targets),
 *   - `public.easylearn_schema_migrations` ledger ABSENT,
 *   - `users.session_version` ABSENT (0019 never applied),
 *   - 0 of 26 composite tenant FKs (0018, gated, never applied).
 *
 * The rehearsal proves the proposed owner-approved remediation end to end
 * without touching any real database:
 *   1. A plain runner invocation REFUSES (no ledger + existing tables).
 *   2. Baseline of the verified prefix 0000..0017 requires the explicit
 *      confirmation token and records 18 checksummed rows.
 *   3. An ordinary run then applies only 0019 (session_version appears)
 *      and loudly skips the gated 0018.
 *   4. With a seeded cross-school mismatch, gated 0018 ABORTS atomically
 *      (no FKs installed, ledger untouched).
 *   5. After removing the offending row (rehearsal DB only), gated 0018
 *      installs and validates all 26 FKs; a final ordinary run verifies
 *      ledger-vs-catalog integrity and is idempotent.
 *
 * It also probes the competing root-cause explanation: the drift shape is
 * fully explained by "migrations applied outside the runner + gated 0018
 * never run + 0019 never run". A post-0017 `drizzle-kit push` would have
 * dropped 17 of the 24 UNIQUE targets (see
 * tests/migration-tenant-constraint-integrity.test.ts), which the
 * production inventory contradicts (24/24 present). This test does NOT
 * prove production history; it proves the remediation is safe for the
 * observed shape.
 */
import assert from "assert";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import type { Client as PgClient } from "pg";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { MIGRATIONS, GATED_MIGRATIONS, BASELINE_CONFIRMATION } =
  requireFromRepo("./run-migration.js");

const DB_NAME = `easylearn_drift_${crypto.randomBytes(4).toString("hex")}`;
const GATE_FILE = "0018_composite_school_foreign_keys.sql";
const GATE = GATED_MIGRATIONS[GATE_FILE];
/** Migrations whose effects the production inventory proves present. */
const APPLIED_PREFIX = MIGRATIONS.slice(0, MIGRATIONS.indexOf("0019_session_revocation.sql"));

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

function assertIncludes(haystack: string, needle: string, message?: string) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || "assertIncludes"}: expected output to contain ${JSON.stringify(needle)}\n--- output ---\n${haystack.slice(-3000)}`);
  }
}

interface RunResult { status: number; output: string }

function runNode(args: string[], databaseUrl: string, extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, EASY_LEARN_TEST_DATABASE: "true", ...extraEnv },
    encoding: "utf8",
    timeout: 240_000,
  });
  return { status: result.status ?? 1, output: `${result.stdout || ""}\n${result.stderr || ""}` };
}

/** Apply a migration SQL file directly (statement-breakpoint split), with NO ledger. */
async function applySqlFileDirectly(client: PgClient, fileName: string) {
  const rootPath = path.join(REPO_ROOT, fileName);
  const drizzlePath = path.join(REPO_ROOT, "drizzle", fileName);
  const filePath = fs.existsSync(rootPath) ? rootPath : drizzlePath;
  const sql = fs.readFileSync(filePath, "utf8");
  const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) await client.query(statement);
}

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
    const port = 56929 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const urlFor = (name: string) => {
    const url = new URL(adminUrl as string);
    url.pathname = `/${name}`;
    return url.toString();
  };
  await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  const driftUrl = urlFor(DB_NAME);
  const db = new Client({ connectionString: driftUrl });

  const scalar = async (sql: string, values: unknown[] = []) =>
    (await db.query(sql, values)).rows[0];

  try {
    await db.connect();

    /* ── Build the production-like drift shape (raw SQL, no ledger) ── */
    for (const fileName of APPLIED_PREFIX) {
      await applySqlFileDirectly(db, fileName);
    }
    console.log(`🧱 Drift shape built by applying ${APPLIED_PREFIX.length} migrations directly (0000..0017), no runner, no ledger`);

    const countComposite = async () =>
      Number((await scalar(
        `SELECT count(*)::int AS count FROM pg_constraint WHERE contype='f' AND pg_get_constraintdef(oid) LIKE '%(school_id,%'`
      )).count);
    const countUniqueTargets = async () =>
      Number((await scalar(
        `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname LIKE '%\\_school\\_id\\_id\\_unique'`
      )).count);
    const ledgerExists = async () =>
      Boolean((await scalar(`SELECT to_regclass('public.easylearn_schema_migrations') IS NOT NULL AS present`)).present);
    const hasSessionVersion = async () =>
      Boolean((await scalar(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='session_version') AS present`
      )).present);
    const ledgerCount = async () =>
      Number((await scalar(`SELECT count(*)::int AS count FROM public.easylearn_schema_migrations`)).count);

    await test("drift shape matches the production inventory (0013/0016/0017 present, ledger/0019/0018 absent)", async () => {
      assertEq(await ledgerExists(), false, "ledger must be absent");
      assertEq(await hasSessionVersion(), false, "session_version must be absent");
      assertEq(await countComposite(), 0, "composite tenant FKs must be 0");
      assertEq(await countUniqueTargets(), 24, "UNIQUE (school_id,id) targets must be 24");
      const schoolIdCols = Number((await scalar(
        `SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND column_name='school_id'`
      )).count);
      assert.ok(schoolIdCols >= 26, `expected >=26 school_id columns, got ${schoolIdCols}`);
    });

    await test("a plain runner invocation refuses a ledger-less existing database (no silent replay)", async () => {
      const run = runNode(["run-migration.js"], driftUrl);
      assertEq(run.status, 1, "runner must refuse");
      assertIncludes(run.output, "Refusing to replay migrations");
      assertEq(await ledgerExists(), false, "refusal must not create a ledger");
    });

    await test("baseline without the confirmation token is refused", async () => {
      const run = runNode(["run-migration.js", "--baseline", APPLIED_PREFIX.join(",")], driftUrl);
      assertEq(run.status, 1, "baseline without token must be refused");
      assertEq(await ledgerExists(), false);
    });

    await test("baseline of the verified 0000..0017 prefix records 18 checksummed rows and runs no SQL", async () => {
      const run = runNode(["run-migration.js", "--baseline", APPLIED_PREFIX.join(",")], driftUrl, {
        CONFIRM_MIGRATION_BASELINE: BASELINE_CONFIRMATION,
      });
      assertEq(run.status, 0, `baseline must succeed: ${run.output.slice(-2000)}`);
      assertEq(await ledgerCount(), APPLIED_PREFIX.length, "ledger must hold the baselined prefix");
      assertEq(await hasSessionVersion(), false, "baseline must not apply 0019 SQL");
      assertEq(await countComposite(), 0, "baseline must not apply 0018 SQL");
    });

    await test("an ordinary run after baseline applies only 0019 and loudly skips gated 0018", async () => {
      const run = runNode(["run-migration.js"], driftUrl);
      assertEq(run.status, 0, `ordinary run must succeed: ${run.output.slice(-2000)}`);
      assertIncludes(run.output, "GATED MIGRATION NOT APPLIED");
      assertEq(await hasSessionVersion(), true, "0019 must add users.session_version");
      assertEq(await countComposite(), 0, "gated 0018 must still be pending");
    });

    /* Seed a cross-school mismatch: a term in school B pointing at school A's year. */
    const schoolA = (await scalar(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Drift School A','DSA','drift-school-a') RETURNING id`
    )).id as string;
    const schoolB = (await scalar(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Drift School B','DSB','drift-school-b') RETURNING id`
    )).id as string;
    const yearA = (await scalar(
      `INSERT INTO academic_years (school_id,name,start_date,end_date,is_current) VALUES ($1,'2026/27','2026-09-01','2027-07-01',true) RETURNING id`,
      [schoolA]
    )).id as string;
    await scalar(
      `INSERT INTO terms (school_id, name, academic_year_id, start_date, end_date, is_current) VALUES ($1,'term_1',$2,'2026-09-01','2026-12-01',true) RETURNING id`,
      [schoolB, yearA]
    );

    await test("gated 0018 aborts atomically on the cross-school mismatch (nothing installed, ledger untouched)", async () => {
      const before = await ledgerCount();
      const run = runNode(["run-migration.js", GATE_FILE], driftUrl, { [GATE.env]: GATE.token });
      assertEq(run.status, 1, "0018 must abort on mismatched data");
      assertEq(await countComposite(), 0, "abort must leave zero composite FKs");
      assertEq(await ledgerCount(), before, "abort must not write the ledger");
    });

    /* Rehearsal-only data fix: remove the offending row (never done silently in production). */
    await db.query(`DELETE FROM terms WHERE school_id = $1 AND academic_year_id = $2`, [schoolB, yearA]);

    await test("gated 0018 then installs and validates all 26 composite FKs", async () => {
      const run = runNode(["run-migration.js", GATE_FILE], driftUrl, { [GATE.env]: GATE.token });
      assertEq(run.status, 0, `0018 must apply: ${run.output.slice(-2000)}`);
      assertIncludes(run.output, "26/26 present, validated and correct");
      assertEq(await countComposite(), 26, "all 26 composite FKs must exist");
      const unvalidated = Number((await scalar(
        `SELECT count(*)::int AS count FROM pg_constraint WHERE contype='f' AND NOT convalidated AND pg_get_constraintdef(oid) LIKE '%(school_id,%'`
      )).count);
      assertEq(unvalidated, 0, "all composite FKs must be validated");
    });

    await test("the cross-school insert is now rejected by the database itself", async () => {
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO terms (school_id, name, academic_year_id, start_date, end_date, is_current) VALUES ($1,'bad',$2,'2026-09-01','2026-12-01',false)`,
          [schoolB, yearA]
        );
      } catch {
        rejected = true;
      }
      assertEq(rejected, true, "composite FK must reject a cross-school reference");
    });

    await test("a final ordinary run is idempotent and verifies ledger-vs-catalog integrity", async () => {
      const run = runNode(["run-migration.js"], driftUrl);
      assertEq(run.status, 0, `final run must succeed: ${run.output.slice(-2000)}`);
      assertIncludes(run.output, "already recorded with matching checksums");
      assertIncludes(run.output, "26/26 present, validated and correct");
      assertEq(await ledgerCount(), MIGRATIONS.length, "ledger must record the full chain");
    });
  } finally {
    await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    if (stopServer) await stopServer().catch(() => {});
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
