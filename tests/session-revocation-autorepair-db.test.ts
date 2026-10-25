/**
 * Compatibility guard (Issue #54 follow-up): failing CLOSED must not lock
 * out a deployment that simply has not run drizzle/0019 yet, when the
 * application's default lazy-repair strategy is enabled.
 *
 * With AUTO_SCHEMA_REPAIR at its default (enabled), verifyToken's schema
 * check recreates session_version, the pre-migration token (version 0)
 * still verifies, and a subsequent password change revokes it normally.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/session-revocation-autorepair-db.test.ts
 */
import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

/* Default repair behaviour explicitly: do NOT disable it in this suite. */
delete process.env.AUTO_SCHEMA_REPAIR;

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

const DB_NAME = `easylearn_autorepair_${crypto.randomBytes(4).toString("hex")}`;
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
    const port = 59801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
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

    const oldHash = await bcrypt.hash("Old-Password-1!", 4);
    const user = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,'learner','Auto','Repair',true) RETURNING id`,
      [`autorepair-${DB_NAME}@test.test`, oldHash]
    )).rows[0];

    const auth = await import("@/lib/auth");
    const tokenBefore = await auth.createToken({ userId: user.id, role: "learner", email: "autorepair@test.test" });

    /* Unmigrated database, dropped BEFORE any revocation check runs. */
    /* The migration chain leaves 0019 to lazy creation, so first put the
       column in place (the migrated state), then remove it. */
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE users DROP COLUMN session_version`);

    await test("missing column + default repair: column is recreated and the token still verifies (no lockout)", async () => {
      const claims = await auth.verifyToken(tokenBefore);
      assert(claims, "pre-migration token should verify after lazy repair");
      const col = (await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='session_version'`
      )).rows;
      assert.strictEqual(col.length, 1, "session_version must have been recreated");
    });

    await test("after repair, a password change succeeds and revokes the pre-change token", async () => {
      const { POST } = await import("@/app/api/auth/change-password/route");
      const req = new NextRequest("http://localhost/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenBefore}` },
        body: JSON.stringify({ currentPassword: "Old-Password-1!", newPassword: "New-Password-2!" }),
      });
      const res = await POST(req);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      assert.strictEqual(await auth.verifyToken(tokenBefore), null, "pre-change token must be revoked");
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
