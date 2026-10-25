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
 */
import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";
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
    let EmbeddedPostgres: any = null;
    try { EmbeddedPostgres = requireFromRepo("embedded-postgres"); EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres; } catch { console.log("⏭️  SKIP: no TEST_DATABASE_URL and no embedded-postgres"); return; }
    const port = 60801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const pg = new EmbeddedPostgres({ databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`), user: "easylearn", password: "[SECURITY_DATA]", port, persistent: false });
    await pg.initialise(); await pg.start(); stopServer = () => pg.stop(); adminUrl = `postgres://easylearn:easylearn@127.0.0.1:${port}/postgres`; console.log(`📦 Embedded PG ${port}`);
  }
  const scratchUrl = (() => { const u = new URL(adminUrl as string); u.pathname = `/${DB_NAME}`; return u.toString(); })();
  const admin = new Client({ connectionString: adminUrl }); await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`); await admin.query(`CREATE DATABASE "${DB_NAME}"`); await admin.end();
  const db = new Client({ connectionString: scratchUrl }); await db.connect();
  try {
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

    await test("new password is stored and a token at the bumped version verifies", async () => {
      const row = (await db.query(`SELECT password_hash, session_version FROM users WHERE id=$1`, [victim.id])).rows[0];
      assert(await bcrypt.compare("Victim-New-2!", row.password_hash), "new password must be stored");
      const fresh = await auth.createToken({ userId: victim.id, role: "learner", email: "victim@test.test", sessionVersion: row.session_version });
      assert(await auth.verifyToken(fresh), "post-reset token should verify");
    });
  } finally {
    await db.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    fs.rmSync(path.join(os.tmpdir(), `${DB_NAME}-data`), { recursive: true, force: true });
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
