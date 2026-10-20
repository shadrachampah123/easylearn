/**
 * The disposable-database lifecycle helper — contract tests.
 *
 * The LOW-5 finding of the PR #32 migration-safety review: several test suites created a
 * scratch PostgreSQL database and never dropped it, so a full `npm run test:all` left a
 * trail of databases behind on the admin database. The fix routes every suite through
 * `tests/helpers/scratch-db.js`, and this suite pins the helper's contract so the fix
 * cannot silently regress:
 *
 *   1. The teardown removes the database even when the test body throws.
 *   2. The teardown removes the database even when a SETUP step fails (a suite that dies
 *      between `CREATE DATABASE` and its `try` block used to leak it).
 *   3. A stale database left behind by a killed run is removed before a new one is created.
 *   4. A cleanup failure is NEVER swallowed silently: it is surfaced with an actionable
 *      message.
 *   5. A cleanup failure never replaces the original test failure — the original is what
 *      fails the suite, and the cleanup failure is attached to it.
 *   6. The database really is gone afterwards (verified against the catalog, not assumed).
 */

import assert from "assert";
import path from "path";
import os from "os";
import crypto from "crypto";
import { createRequire } from "module";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { createScratchDatabase, dropScratchDatabase, assertCleanupSucceeded } =
  requireFromRepo("./tests/helpers/scratch-db.js");

const RUN_ID = crypto.randomBytes(4).toString("hex");
const JWT_SECRET = createTestJwtSecret();
const REQUIRE_ENV = "EASY_LEARN_REQUIRE_SCRATCH_DB_LIFECYCLE";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed += 1;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${(error as Error).message}`);
      failed += 1;
    });
}

async function main(): Promise<void> {
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
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run the suite.");
      if (process.env[REQUIRE_ENV] === "true") {
        console.error(
          `❌ FAIL: ${REQUIRE_ENV}=true — the scratch-database lifecycle suite must run, not skip.`
        );
        process.exitCode = 1;
      }
      return;
    }
    const port = 61129 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `easylearn_scratch_lifecycle_${RUN_ID}-data`),
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
  admin.on("error", () => undefined);
  await admin.connect();

  const dbName = (label: string) => `easylearn_scratch_contract_${label}_${RUN_ID}`;

  const exists = async (name: string): Promise<boolean> => {
    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM pg_database WHERE datname = $1`,
      [name]
    );
    return rows.rows[0].n > 0;
  };

  console.log("\n🧩 Disposable test database lifecycle — contract tests\n");

  await test("the teardown removes the database when the test body succeeded", async () => {
    const name = dbName("happy");
    const scratch = await createScratchDatabase({
      admin,
      adminUrl: adminUrl as string,
      dbName: name,
      label: "contract-happy",
    });
    assert(await exists(name), "the scratch database must exist before the teardown");

    const cleanup = await scratch.dispose();
    assert(cleanup.ok, `the teardown must succeed: ${cleanup.error?.message}`);
    assert(!(await exists(name)), "the scratch database must be gone after the teardown");
  });

  await test("the teardown removes the database when the test body threw", async () => {
    const name = dbName("bodyfail");
    const scratch = await createScratchDatabase({
      admin,
      adminUrl: adminUrl as string,
      dbName: name,
      label: "contract-bodyfail",
    });
    const original = new Error("the original test failure");

    let primaryError: any = null;
    let thrown: any = null;
    try {
      throw original;
    } catch (error) {
      primaryError = error;
      thrown = error;
    } finally {
      const cleanup = await scratch.dispose();
      assertCleanupSucceeded(cleanup, primaryError);
    }

    assert(thrown === original, "the original failure must be the one that propagates");
    assert(!(await exists(name)), "the scratch database must be gone after a failed body");
  });

  await test("a failed setup removes the database it created", async () => {
    const name = dbName("setupfail");
    /* The admin client still works, but the scratch URL points at a port nothing is
       listening on — so the client connection fails AFTER the database was created. */
    await assert.rejects(
      () =>
        createScratchDatabase({
          admin,
          adminUrl: "postgres://easylearn@127.0.0.1:1/postgres",
          dbName: name,
          label: "contract-setupfail",
        }),
      /ECONNREFUSED|connect|Client|timeout/i
    );
    assert(
      !(await exists(name)),
      "a failed setup must not leave the disposable database behind"
    );
  });

  await test("a stale database from a killed run is removed before a new one is created", async () => {
    const name = dbName("stale");
    await admin.query(`CREATE DATABASE "${name}"`);
    assert(await exists(name), "the stale database must exist before the suite runs");

    const scratch = await createScratchDatabase({
      admin,
      adminUrl: adminUrl as string,
      dbName: name,
      label: "contract-stale",
    });
    const cleanup = await scratch.dispose();
    assert(cleanup.ok, `the teardown must succeed: ${cleanup.error?.message}`);
    assert(!(await exists(name)), "the stale database must be gone");
  });

  await test("a cleanup failure is surfaced with an actionable message, never swallowed", async () => {
    const broken = new Client({ connectionString: adminUrl });
    await broken.connect();
    await broken.end(); /* the client is closed: every query on it now fails */

    const cleanup = await dropScratchDatabase(broken, dbName("nevercreated"), {
      label: "contract-broken",
    });
    assert(!cleanup.ok, "a failing drop must report a failure instead of pretending to succeed");
    assert(cleanup.error, "a failing drop must carry an error");
    const message = cleanup.error.message;
    assert(
      /Failed to drop the disposable test database/.test(message),
      `the message must name the problem: ${message}`
    );
    assert(
      /DROP DATABASE/.test(message),
      `the message must tell the operator what to do: ${message}`
    );
  });

  await test("a cleanup failure does not replace the original test failure", async () => {
    const broken = new Client({ connectionString: adminUrl });
    await broken.connect();
    await broken.end();

    const cleanup = await dropScratchDatabase(broken, dbName("nevercreated"), {
      label: "contract-broken",
    });
    const original = new Error("the original test failure");

    /* Must NOT throw: the original failure is what fails the suite. */
    assertCleanupSucceeded(cleanup, original);
    assert(
      (original as any).cleanupError,
      "the cleanup failure must be attached to the original failure"
    );
    assert(
      /Failed to drop the disposable test database/.test((original as any).cleanupError.message),
      "the attached cleanup failure must carry the actionable message"
    );
  });

  await test("a cleanup failure fails the suite when the test body succeeded", async () => {
    const broken = new Client({ connectionString: adminUrl });
    await broken.connect();
    await broken.end();

    const cleanup = await dropScratchDatabase(broken, dbName("nevercreated"), {
      label: "contract-broken",
    });
    assert.throws(
      () => assertCleanupSucceeded(cleanup, null),
      /Failed to drop the disposable test database/,
      "a cleanup failure must fail the suite when nothing else failed"
    );
  });

  await admin.end().catch(() => undefined);
  if (stopServer) await stopServer().catch(() => undefined);

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("❌ FATAL:", error);
  process.exitCode = 1;
});
