/**
 * Regression (Issue #54, production preflight 2026-10-27): /api/health
 * must report `users.session_version` SPECIFICALLY.
 *
 * The owner-observed production health response showed
 * `optional_user_columns: true` while production lacked
 * `session_version`. Those are different features:
 * `optional_user_columns` probes users(username, must_change_password)
 * from 0006; it says nothing about session revocation. And the health
 * probe's default feature list did not include `session_revocation`
 * at all, so the endpoint could report green while `verifyToken` was
 * failing closed. This suite pins, against a disposable database:
 *
 *   1. the default probe list contains a `session_revocation` entry
 *      mapped to drizzle/0019_session_revocation.sql;
 *   2. it reports present=false when the column is missing and does
 *      NOT create the column (health is read-only);
 *   3. it reports present=true once the column exists;
 *   4. `optional_user_columns` remains a separate, broader check.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/health-session-revocation-probe-db.test.ts
 */
import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

const DB_NAME = `easylearn_healthprobe_${crypto.randomBytes(4).toString("hex")}`;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`✅ PASS: ${name}`); passed++; })
    .catch((e) => { console.error(`❌ FAIL: ${name}\n   ${(e as Error).message}`); failed++; });
}

async function main() {
  const { Client } = requireFromRepo("pg");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    /* Shared bootstrap (PR #66 follow-up): one credential pair, a startup watchdog,
       guaranteed stop + cleanup, and a hard failure instead of a silent skip when CI
       requires this suite. */
    const { startEmbeddedPostgres } = requireFromRepo("./tests/helpers/embedded-postgres.js");
    const port = 59901 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const embedded = await startEmbeddedPostgres({
      dbName: DB_NAME,
      port,
      requireEnv: "EASY_LEARN_REQUIRE_HEALTH_SESSION_PROBE",
    });
    if (!embedded) return; // SKIP printed by the helper (only when the suite is not required)
    adminUrl = embedded.adminUrl;
    stopServer = embedded.stop;
  }
  const scratchUrl = (() => {
    const u = new URL(adminUrl as string);
    u.pathname = `/${DB_NAME}`;
    return u.toString();
  })();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  await admin.end();
  const db = new Client({ connectionString: scratchUrl });
  await db.connect();
  try {
    process.env.DATABASE_URL = scratchUrl;
    process.env.EASY_LEARN_TEST_DATABASE = "true";

    /* Minimal users table WITHOUT session_version (the drifted shape). */
    await db.query(`CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username varchar(100), must_change_password boolean NOT NULL DEFAULT false)`);

    const { probeSchemaFeatures } = await import("@/lib/schema-resilience");

    await test("default health probe includes session_revocation mapped to 0019", async () => {
      const statuses = await probeSchemaFeatures();
      const entry = statuses.find((s) => s.feature === "session_revocation");
      assert(entry, "default probe list must contain session_revocation");
      assert.strictEqual(entry!.migration, "drizzle/0019_session_revocation.sql");
      assert.strictEqual(entry!.autoRepairable, true, "session_revocation is repairable on demand");
    });

    await test("probe reports session_revocation absent AND does not create it (read-only)", async () => {
      const statuses = await probeSchemaFeatures();
      const entry = statuses.find((s) => s.feature === "session_revocation");
      assert.strictEqual(entry!.present, false, "column is missing, probe must say so");
      const cols = (await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='session_version'`
      )).rows;
      assert.strictEqual(cols.length, 0, "health probe must never run DDL");
    });

    await test("optional_user_columns is a separate check (true while session_revocation is false)", async () => {
      const statuses = await probeSchemaFeatures();
      const optional = statuses.find((s) => s.feature === "optional_user_columns");
      assert(optional, "optional_user_columns entry must exist");
      assert.strictEqual(optional!.present, true, "username/must_change_password exist in this fixture");
      assert.strictEqual(optional!.migration, "drizzle/0006_user_identity_columns.sql");
    });

    await test("probe reports session_revocation present once the column exists", async () => {
      await db.query(`ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0`);
      const statuses = await probeSchemaFeatures();
      const entry = statuses.find((s) => s.feature === "session_revocation");
      assert.strictEqual(entry!.present, true);
    });
  } finally {
    /* Cleanup on every outcome: terminate lingering pool backends, drop the scratch DB
       (verified, not swallowed), stop the embedded cluster + remove its data dir. */
    await db.end().catch(() => undefined);
    let scratchCleanup: { ok: boolean; error: Error | null } = { ok: true, error: null };
    const cleanupClient = new Client({ connectionString: adminUrl });
    try {
      await cleanupClient.connect();
      const { dropScratchDatabase } = requireFromRepo("./tests/helpers/scratch-db.js");
      scratchCleanup = await dropScratchDatabase(cleanupClient, DB_NAME, { label: "health-session-revocation-probe" });
    } catch (cleanupError) {
      scratchCleanup = { ok: false, error: cleanupError as Error };
    } finally {
      await cleanupClient.end().catch(() => undefined);
    }
    if (stopServer) await stopServer();
    const { assertCleanupSucceeded } = requireFromRepo("./tests/helpers/scratch-db.js");
    assertCleanupSucceeded(scratchCleanup, failed > 0 ? new Error(`${failed} test(s) failed`) : null);
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
