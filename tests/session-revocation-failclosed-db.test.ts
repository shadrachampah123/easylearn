/**
 * Regression (Issue #54 follow-up): session revocation must FAIL CLOSED.
 *
 * Pre-fix, verifyToken wrapped the session_version check in a catch-all
 * that accepted the token on ANY failure (missing column, schema helper
 * failure, database error), and the change-password route fell back to
 * changing the password without revoking. With AUTO_SCHEMA_REPAIR=false
 * (locked-down DB role / strict migration policy) a token issued before
 * a password change — or before logout — was silently accepted forever.
 *
 * This suite proves, through the REAL route/verification path:
 *   1. missing session_version column + repair disabled
 *      → verifyToken throws SessionRevocationCheckError (never resolves);
 *   2. the same state → POST /api/auth/change-password answers 503 and
 *      the stored password is UNCHANGED;
 *   3. users table unreachable (renamed) → verifyToken throws, not accepts.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/session-revocation-failclosed-db.test.ts
 * (CI hard-requires execution via EASY_LEARN_REQUIRE_SESSION_REVOCATION_DB=true; a silent skip fails the job)
 */
import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

/* Repair OFF for the whole process, set before any app module is imported:
   this is the locked-down deployment in which the old code failed open. */
process.env.AUTO_SCHEMA_REPAIR = "false";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

const DB_NAME = `easylearn_failclosed_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();

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
  const bcrypt = requireFromRepo("bcryptjs");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    /* Shared bootstrap: ONE credential pair for the cluster and the URL, a startup
       watchdog, and a guaranteed stop + data-dir cleanup even on failure (PR #66
       follow-up: this suite previously initialised the cluster with a different
       password than its connection URL, then hung forever when auth was refused). */
    const { startEmbeddedPostgres } = requireFromRepo("./tests/helpers/embedded-postgres.js");
    const port = 58801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const embedded = await startEmbeddedPostgres({
      dbName: DB_NAME,
      port,
      requireEnv: "EASY_LEARN_REQUIRE_SESSION_REVOCATION_DB",
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
    const created = await createScratchDatabase({ admin, adminUrl: adminUrl as string, dbName: DB_NAME, label: "session-revocation-failclosed" });
    scratch = created;
    const scratchUrl = created.scratchUrl;
    const db = created.db;
    process.env.DATABASE_URL = scratchUrl; process.env.JWT_SECRET = JWT_SECRET; process.env.EASY_LEARN_TEST_DATABASE = "true";
    const run = runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" } });
    assert.strictEqual(run.status, 0, "migrations must succeed");

    const oldHash = await bcrypt.hash("Old-Password-1!", 4);
    const user = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,'learner','Fail','Closed',true) RETURNING id`,
      [`failclosed-${DB_NAME}@test.test`, oldHash]
    )).rows[0];

    const auth = await import("@/lib/auth");
    const token = await auth.createToken({ userId: user.id, role: "learner", email: "failclosed@test.test" });

    /* Simulate an unmigrated database: drop the column BEFORE any
       revocation check runs in this process, with repair disabled. */
    /* The migration chain leaves 0019 to lazy creation, so first put the
       column in place (the migrated state), then remove it. */
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE users DROP COLUMN session_version`);

    await test("missing column + repair disabled: verifyToken refuses (throws), never accepts", async () => {
      await assert.rejects(
        () => auth.verifyToken(token),
        (e: unknown) => auth.isSessionRevocationCheckError(e),
        "expected SessionRevocationCheckError"
      );
    });

    await test("missing column: password change is refused 503 and the password is unchanged", async () => {
      const { POST } = await import("@/app/api/auth/change-password/route");
      const req = new NextRequest("http://localhost/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: "Old-Password-1!", newPassword: "New-Password-2!" }),
      });
      const res = await POST(req);
      assert.strictEqual(res.status, 503, `expected 503, got ${res.status}`);
      const row = (await db.query(`SELECT password_hash FROM users WHERE id=$1`, [user.id])).rows[0];
      assert(await bcrypt.compare("Old-Password-1!", row.password_hash), "old password must still be stored");
      assert(!(await bcrypt.compare("New-Password-2!", row.password_hash)), "new password must NOT be stored");
    });

    await test("database error (users table unreachable): verifyToken throws, never accepts", async () => {
      await db.query(`ALTER TABLE users RENAME TO users_hidden_failclosed`);
      try {
        await assert.rejects(
          () => auth.verifyToken(token),
          (e: unknown) => auth.isSessionRevocationCheckError(e),
          "expected SessionRevocationCheckError"
        );
      } finally {
        await db.query(`ALTER TABLE users_hidden_failclosed RENAME TO users`);
      }
    });
  } finally {
    /* Cleanup runs on EVERY outcome (pass, fail, or throw): drop the scratch DB,
       close the admin client, stop the embedded cluster and remove its data dir.
       A cleanup failure fails the suite instead of being swallowed. */
    const scratchCleanup = scratch ? await scratch.dispose() : { ok: true, error: null };
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer();
    assertCleanupSucceeded(scratchCleanup, failed > 0 ? new Error(`${failed} test(s) failed`) : null);
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
