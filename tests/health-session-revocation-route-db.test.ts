/**
 * Regression (PR #66 follow-up, review finding MEDIUM-1): /api/health must not
 * report the service as fully healthy when session revocation cannot work.
 *
 * The production incident behind Issue #54 (2026-10-27): the health endpoint
 * answered HTTP 200 / ok:true / "Login and registration services are ready."
 * while, if AUTO_SCHEMA_REPAIR were off and users.session_version absent,
 * verifyToken would be failing closed and every authenticated request would 503.
 * PR #65 added the explicit probe field; this PR makes the status honest:
 *
 *   1. missing users.session_version + AUTO_SCHEMA_REPAIR=false
 *      → GET /api/health answers 503, ok:false, and names the migration;
 *   2. missing users.session_version + repair enabled (default)
 *      → still 200 (the next authenticated request self-heals the idempotent
 *      DDL — a read-only probe cannot know whether the role may run it), but
 *      the response names the drift in optionalMigrations/migrationWarnings;
 *   3. column present + AUTO_SCHEMA_REPAIR=false
 *      → healthy 200 (behaviour preserved when the schema is healthy).
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/health-session-revocation-route-db.test.ts
 * (CI hard-requires execution via EASY_LEARN_REQUIRE_HEALTH_SESSION_ROUTE=true; a silent skip fails the job)
 */
import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

const DB_NAME = `easylearn_healthroute_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`✅ PASS: ${name}`); passed++; })
    .catch((e) => { console.error(`❌ FAIL: ${name}\n   ${(e as Error).message}`); failed++; });
}

interface HealthBody {
  ok: boolean;
  message: string;
  checks: {
    schemaReady: boolean;
    optionalMigrations: Record<string, boolean>;
    migrationWarnings: string[];
  };
}

async function main() {
  const { Client } = requireFromRepo("pg");

  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const { startEmbeddedPostgres } = requireFromRepo("./tests/helpers/embedded-postgres.js");
    const port = 61901 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const embedded = await startEmbeddedPostgres({
      dbName: DB_NAME,
      port,
      requireEnv: "EASY_LEARN_REQUIRE_HEALTH_SESSION_ROUTE",
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
    const created = await createScratchDatabase({ admin, adminUrl: adminUrl as string, dbName: DB_NAME, label: "health-session-revocation-route" });
    scratch = created;
    const db = created.db;

    process.env.DATABASE_URL = created.scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";

    /* A users table that satisfies the 9 core `schemaReady` columns but lacks
       session_version — the drifted shape found in production. */
    await db.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(255),
        password_hash varchar(255),
        role varchar(50),
        first_name varchar(100),
        last_name varchar(100),
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    /* The fixture must also carry login_attempts. Since the H-1 remediation
       (2026-11-19) the login throttle fails CLOSED, and /api/health reports 503 when the
       throttle table is missing while AUTO_SCHEMA_REPAIR is off — otherwise it would
       claim "Login and registration services are ready" while every sign-in returns 503,
       which is the exact mistake this suite exists to prevent for session revocation.
       Creating it here keeps this suite's subject (session_version) the only drift under
       test; the throttle gate itself is asserted in tests/login-rate-limit-db.test.ts. */
    await db.query(`
      CREATE TABLE login_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        identifier varchar(255) NOT NULL,
        ip_address varchar(50),
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);

    const { GET } = await import("@/app/api/health/route");
    const call = async (): Promise<{ status: number; body: HealthBody }> => {
      const res = await GET();
      return { status: res.status, body: (await res.json()) as HealthBody };
    };

    await test("missing column + repair disabled: health answers 503 and names the migration", async () => {
      process.env.AUTO_SCHEMA_REPAIR = "false";
      const { status, body } = await call();
      assert.strictEqual(status, 503, `expected 503, got ${status}`);
      assert.strictEqual(body.ok, false, "ok must be false");
      assert.match(body.message, /session revocation/i, "message must name session revocation");
      assert.match(body.message, /0019_session_revocation/, "message must name the migration");
      assert.strictEqual(body.checks.schemaReady, true, "core schema is fine — the failure is session revocation, not the users table");
      assert.strictEqual(body.checks.optionalMigrations.session_revocation, false);
    });

    await test("missing column + repair enabled: health stays 200 but reports the drift", async () => {
      delete process.env.AUTO_SCHEMA_REPAIR;
      const { status, body } = await call();
      assert.strictEqual(status, 200, `expected 200, got ${status}`);
      assert.strictEqual(body.ok, true, "ok stays true while repair can self-heal the column");
      assert.strictEqual(body.checks.optionalMigrations.session_revocation, false, "the drift must be reported, not hidden");
      assert(
        body.checks.migrationWarnings.some((warning) => warning.includes("0019_session_revocation.sql")),
        "a warning naming 0019 must be present",
      );
    });

    await test("column present + repair disabled: healthy behaviour is preserved (200)", async () => {
      await db.query(`ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0`);
      process.env.AUTO_SCHEMA_REPAIR = "false";
      const { status, body } = await call();
      assert.strictEqual(status, 200, `expected 200, got ${status}`);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.checks.optionalMigrations.session_revocation, true);
      assert(
        !body.checks.migrationWarnings.some((warning) => warning.includes("0019_session_revocation.sql")),
        "no 0019 warning once the column exists",
      );
    });
  } finally {
    const scratchCleanup = scratch ? await scratch.dispose() : { ok: true, error: null };
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer();
    assertCleanupSucceeded(scratchCleanup, failed > 0 ? new Error(`${failed} test(s) failed`) : null);
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
