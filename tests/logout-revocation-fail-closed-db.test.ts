/**
 * Logout revocation regression tests.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/logout-revocation-fail-closed-db.test.ts
 */
import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

process.env.AUTO_SCHEMA_REPAIR = "false";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations } = requireFromRepo("./tests/helpers/migrations.js");
const DB_NAME = `easylearn_logout_revoke_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();

async function main() {
  const { Client } = requireFromRepo("pg");
  const bcrypt = requireFromRepo("bcryptjs");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const { startEmbeddedPostgres } = requireFromRepo("./tests/helpers/embedded-postgres.js");
    const port = 59301 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const embedded = await startEmbeddedPostgres({
      dbName: DB_NAME,
      port,
      requireEnv: "EASY_LEARN_REQUIRE_LOGOUT_REVOCATION_DB",
    });
    if (!embedded) return;
    adminUrl = embedded.adminUrl;
    stopServer = embedded.stop;
  }

  const { createScratchDatabase, assertCleanupSucceeded } = requireFromRepo("./tests/helpers/scratch-db.js");
  const admin = new Client({ connectionString: adminUrl });
  let scratch: any = null;
  try {
    await admin.connect();
    scratch = await createScratchDatabase({
      admin,
      adminUrl: adminUrl as string,
      dbName: DB_NAME,
      label: "logout-revocation-fail-closed",
    });
    const db = scratch.db;
    const scratchUrl = scratch.scratchUrl;
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";

    const migrationRun = runMigrations({
      databaseUrl: scratchUrl,
      env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" },
    });
    assert.strictEqual(migrationRun.status, 0, "migration chain must succeed");
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0`);

    const passwordHash = await bcrypt.hash("Logout-Test-Password-1!", 4);
    const user = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, 'learner', 'Logout', 'Test', true) RETURNING id`,
      [`logout-${DB_NAME}@test.test`, passwordHash]
    )).rows[0];

    const auth = await import("@/lib/auth");
    const { POST } = await import("@/app/api/auth/logout/route");
    const token = await auth.createToken({
      userId: user.id,
      role: "learner",
      email: "logout@test.test",
      sessionVersion: 0,
    });
    const logout = (credential: string) => POST(new NextRequest("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}` },
    }));

    const first = await logout(token);
    assert.strictEqual(first.status, 200, "valid logout should succeed");
    let row = (await db.query("SELECT session_version FROM users WHERE id=$1", [user.id])).rows[0];
    assert.strictEqual(row.session_version, 1, "logout must increment session_version");
    assert.strictEqual(await auth.verifyToken(token), null, "old token must be rejected after logout");
    console.log("PASS: valid logout increments session_version and invalidates the old token");

    const repeated = await logout(token);
    assert.strictEqual(repeated.status, 200, "already-revoked but correctly signed token can logout again");
    row = (await db.query("SELECT session_version FROM users WHERE id=$1", [user.id])).rows[0];
    assert.strictEqual(row.session_version, 2, "repeated logout must still increment session_version");
    console.log("PASS: an already-revoked signed token can still trigger revocation");

    const invalid = await logout("not-a-valid-jwt");
    assert.strictEqual(invalid.status, 200, "invalid token only clears the browser cookie");
    row = (await db.query("SELECT session_version FROM users WHERE id=$1", [user.id])).rows[0];
    assert.strictEqual(row.session_version, 2, "invalid token must not change any user's session version");
    console.log("PASS: invalid token cannot trigger an arbitrary user revocation");

    await db.query("ALTER TABLE users RENAME TO users_hidden_logout_test");
    try {
      const failed = await logout(token);
      assert.strictEqual(failed.status, 503, "database failure must not be reported as successful logout");
      const setCookie = failed.headers.get("set-cookie") ?? "";
      assert(setCookie.includes("Max-Age=0"), "browser cookie must be cleared even on server-side failure");
      console.log("PASS: DB failure returns 503 while clearing the browser cookie");
    } finally {
      await db.query("ALTER TABLE users_hidden_logout_test RENAME TO users");
    }
  } finally {
    const cleanup = scratch ? await scratch.dispose() : { ok: true, error: null };
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer();
    assertCleanupSucceeded(cleanup);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
