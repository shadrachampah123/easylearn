/**
 * Regression (Issue #54 audit): changing a password must revoke sessions.
 *
 * Before the fix, POST /api/auth/change-password updated only the password
 * hash (at bcrypt cost 10, unlike hashPassword's 12) and left
 * users.session_version untouched, so a JWT issued before the change —
 * e.g. a stolen one — kept verifying for the rest of its 24h life. Logout
 * already revoked via session_version (PR #51); a password change, the
 * canonical "lock the attacker out" action, must do the same.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/change-password-revocation-db.test.ts
 * (CI hard-requires execution via EASY_LEARN_REQUIRE_SESSION_REVOCATION_DB=true; a silent skip fails the job)
 * (falls back to embedded-postgres when installed)
 */
import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

const DB_NAME = `easylearn_chgpw_${crypto.randomBytes(4).toString("hex")}`;
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
    const port = 57801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
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
    const created = await createScratchDatabase({ admin, adminUrl: adminUrl as string, dbName: DB_NAME, label: "change-password-revocation" });
    scratch = created;
    const scratchUrl = created.scratchUrl;
    const db = created.db;
    process.env.DATABASE_URL = scratchUrl; process.env.JWT_SECRET = JWT_SECRET; process.env.EASY_LEARN_TEST_DATABASE = "true";
    const run = runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" } });
    assert.strictEqual(run.status, 0, "migrations must succeed");

    const oldHash = await bcrypt.hash("Old-Password-1!", 4);
    const user = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,'learner','Change','Me',true) RETURNING id`,
      [`chgpw-${DB_NAME}@test.test`, oldHash]
    )).rows[0];

    const auth = await import("@/lib/auth");
    const { POST } = await import("@/app/api/auth/change-password/route");

    const tokenBefore = await auth.createToken({ userId: user.id, role: "learner", email: "chgpw@test.test" });

    await test("token verifies before the password change", async () => {
      assert(await auth.verifyToken(tokenBefore), "pre-change token should verify");
    });

    const req = new NextRequest("http://localhost/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenBefore}` },
      body: JSON.stringify({ currentPassword: "Old-Password-1!", newPassword: "New-Password-2!" }),
    });
    const res = await POST(req);

    await test("password change succeeds with the correct current password", async () => {
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    });

    await test("token issued before the change is revoked", async () => {
      assert.strictEqual(await auth.verifyToken(tokenBefore), null, "pre-change token must no longer verify");
    });

    await test("stored hash uses cost 12 and matches the new password", async () => {
      const row = (await db.query(`SELECT password_hash FROM users WHERE id=$1`, [user.id])).rows[0];
      assert(row.password_hash.startsWith("$2a$12$") || row.password_hash.startsWith("$2b$12$"), `unexpected hash prefix: ${row.password_hash.slice(0, 7)}`);
      assert(await bcrypt.compare("New-Password-2!", row.password_hash), "new password must verify");
      assert(!(await bcrypt.compare("Old-Password-1!", row.password_hash)), "old password must not verify");
    });

    await test("a fresh token (new session version) still verifies", async () => {
      const row = (await db.query(`SELECT session_version FROM users WHERE id=$1`, [user.id])).rows[0];
      const fresh = await auth.createToken({ userId: user.id, role: "learner", email: "chgpw@test.test", sessionVersion: row.session_version ?? 0 });
      assert(await auth.verifyToken(fresh), "post-change token should verify");
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
