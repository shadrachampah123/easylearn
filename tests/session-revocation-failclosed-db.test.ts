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
 */
import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";
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
    let EmbeddedPostgres: any = null;
    try { EmbeddedPostgres = requireFromRepo("embedded-postgres"); EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres; } catch { console.log("⏭️  SKIP: no TEST_DATABASE_URL and no embedded-postgres"); return; }
    const port = 58801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
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
    await db.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    fs.rmSync(path.join(os.tmpdir(), `${DB_NAME}-data`), { recursive: true, force: true });
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
