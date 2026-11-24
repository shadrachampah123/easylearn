/**
 * Regression (PR #55 independent review, R-1): an administrative password
 * reset must revoke the account's existing sessions.
 *
 * Before this fix, PATCH /api/users/[id] (platform-admin reset) updated
 * only the password hash, so a victim's outstanding 24h tokens survived
 * the very reset meant to lock an attacker out — the same defect class
 * the PR fixed for the self-service change-password route.
 *
 * Proves through the REAL handler: reset succeeds, the pre-reset token
 * no longer verifies, the new password is stored, and a token minted at
 * the bumped session version verifies.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/admin-password-reset-revocation-db.test.ts
 * (CI hard-requires execution via EASY_LEARN_REQUIRE_SESSION_REVOCATION_DB=true; a silent skip fails the job)
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

const DB_NAME = `easylearn_adminreset_${crypto.randomBytes(4).toString("hex")}`;
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
    const port = 60801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
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
    const created = await createScratchDatabase({ admin, adminUrl: adminUrl as string, dbName: DB_NAME, label: "admin-password-reset-revocation" });
    scratch = created;
    const scratchUrl = created.scratchUrl;
    const db = created.db;
    process.env.DATABASE_URL = scratchUrl; process.env.JWT_SECRET = JWT_SECRET; process.env.EASY_LEARN_TEST_DATABASE = "true";
    const run = runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" } });
    assert.strictEqual(run.status, 0, "migrations must succeed");

    const hash = await bcrypt.hash("Victim-Old-1!", 4);
    const adminUser = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,'super_admin','Platform','Admin',true) RETURNING id`,
      [`admin-${DB_NAME}@test.test`, hash]
    )).rows[0];
    const victim = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,'learner','Victim','User',true) RETURNING id`,
      [`victim-${DB_NAME}@test.test`, hash]
    )).rows[0];

    const auth = await import("@/lib/auth");
    const { PATCH } = await import("@/app/api/users/[id]/route");

    const adminToken = await auth.createToken({ userId: adminUser.id, role: "super_admin", email: "admin@test.test" });
    const victimTokenBefore = await auth.createToken({ userId: victim.id, role: "learner", email: "victim@test.test" });

    await test("victim token verifies before the reset", async () => {
      assert(await auth.verifyToken(victimTokenBefore), "pre-reset token should verify");
    });

    const req = new NextRequest(`http://localhost/api/users/${victim.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ password: "Victim" + "-New-2!" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: victim.id }) });

    await test("platform-admin reset succeeds", async () => {
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    });

    await test("pre-reset token is revoked by the reset", async () => {
      assert.strictEqual(await auth.verifyToken(victimTokenBefore), null, "pre-reset token must no longer verify");
    });

    await test("new password is stored, marked temporary, and a token at the bumped version verifies", async () => {
      const row = (await db.query(`SELECT password_hash, session_version, must_change_password FROM users WHERE id=$1`, [victim.id])).rows[0];
      assert(await bcrypt.compare("Victim-New-2!", row.password_hash), "new password must be stored");
      assert.strictEqual(row.must_change_password, true, "administrative reset must require a password change at next login");
      const fresh = await auth.createToken({ userId: victim.id, role: "learner", email: "victim@test.test", sessionVersion: row.session_version });
      assert(await auth.verifyToken(fresh), "post-reset token should verify");
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
