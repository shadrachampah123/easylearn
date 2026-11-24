"use strict";

/**
 * Exercises the migration runner's process-wide advisory lock on an isolated database.
 * The blocker keeps a transaction-scoped lock while the real runner processes wait. This
 * pins the blocker to one backend even if the test target is behind transaction pooling;
 * the migration runner itself rejects known Neon `-pooler` endpoints because its lock is
 * session-scoped and must remain attached to one backend across its multiple transactions.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Client, Pool } = require("pg");
const {
  HISTORY_TABLE,
  MIGRATIONS,
  buildPoolConfig,
} = require("../run-migration.js");

const ROOT = path.join(__dirname, "..");
const LOCK_KEY = [1163416649, 1296125510];
const GATED_MIGRATION = "0018_composite_school_foreign_keys.sql";
const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function taggedUrl(rawUrl, applicationName) {
  const url = new URL(rawUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function databaseIdentityQuery() {
  return `SELECT current_database() AS database_name,
                 current_user AS database_user,
                 inet_server_addr()::text AS server_address,
                 inet_server_port() AS server_port,
                 pg_backend_pid() AS backend_pid,
                 current_setting('server_version') AS server_version,
                 (SELECT oid FROM pg_database WHERE datname = current_database()) AS database_oid`;
}

function advisoryRowsQuery() {
  return `SELECT l.pid,
                 l.database::text AS database_oid,
                 l.classid::text AS classid,
                 l.objid::text AS objid,
                 l.objsubid,
                 l.granted,
                 a.application_name,
                 a.datname AS database_name,
                 a.usename AS database_user,
                 a.state,
                 a.wait_event_type,
                 a.wait_event
            FROM pg_locks l
            LEFT JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE l.locktype = 'advisory'
             AND l.classid = $1::oid
             AND l.objid = $2::oid
             AND l.objsubid = 2
           ORDER BY l.granted DESC, l.pid`;
}

async function readAdvisoryRows(client) {
  const result = await client.query(advisoryRowsQuery(), LOCK_KEY);
  return result.rows;
}

async function waitFor(predicate, description, diagnostic) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await diagnostic();
    const match = predicate(last);
    if (match) return match;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${description} timed out after ${WAIT_TIMEOUT_MS} ms. Last observation: ${JSON.stringify(last)}`);
}

function startRunner(databaseUrl, label) {
  const applicationName = `migration-lock-${label}-${crypto.randomUUID()}`;
  const child = spawn(process.execPath, [path.join(ROOT, "run-migration.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: taggedUrl(databaseUrl, applicationName),
      EASY_LEARN_TEST_DATABASE: "true",
      EASY_LEARN_MIGRATION_LOCK_DIAGNOSTICS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let resolveIdentity;
  const identity = new Promise((resolve) => { resolveIdentity = resolve; });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    stdoutBuffer += text;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      const prefix = "Migration lock backend identity: ";
      if (line.startsWith(prefix)) {
        try { resolveIdentity(JSON.parse(line.slice(prefix.length))); } catch {}
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, applicationName }));
  });
  return { child, done, identity, applicationName };
}

function runRunner(databaseUrl, label) {
  const applicationName = `migration-lock-${label}-${crypto.randomUUID()}`;
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [path.join(ROOT, "run-migration.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: taggedUrl(databaseUrl, applicationName),
      EASY_LEARN_TEST_DATABASE: "true",
      EASY_LEARN_MIGRATION_LOCK_DIAGNOSTICS: "true",
    },
    encoding: "utf8",
    timeout: 240_000,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

async function waitForRunnerWaiter(observer, runner, databaseIdentity, expectedWaiters) {
  const identity = await Promise.race([
    runner.identity,
    runner.done.then((result) => {
      throw new Error(
        `Runner exited before reporting its backend identity; code=${result.code}, signal=${result.signal}. ` +
          `STDOUT:\\n${result.stdout}\\nSTDERR:\\n${result.stderr}`
      );
    }),
  ]);
  assert.equal(identity.application_name, runner.applicationName, "runner backend did not retain its unique application_name");
  assert.equal(String(identity.database_oid), String(databaseIdentity.database_oid), "runner connected to a different database OID");
  assert.equal(identity.database_name, databaseIdentity.database_name, "runner connected to a different database");
  assert.equal(identity.database_user, databaseIdentity.database_user, "runner connected as a different role");

  return waitFor(
    (rows) => {
      const ownRows = rows.filter((row) => Number(row.pid) === Number(identity.backend_pid));
      if (ownRows.some((row) => row.database_oid !== String(databaseIdentity.database_oid))) {
        throw new Error(
          `Runner backend PID ${identity.backend_pid} has no matching database OID ${databaseIdentity.database_oid}: ` +
            `${JSON.stringify(ownRows)}. The runner and blocker do not share the expected database.`
        );
      }
      const own = ownRows.filter((row) => !row.granted);
      const waiting = rows.filter((row) => row.database_oid === String(databaseIdentity.database_oid) && !row.granted);
      if (own.length === 1 && waiting.length === expectedWaiters) {
        return { own: own[0], waiting, identity };
      }
      return null;
    },
    `${runner.applicationName} to appear as a waiter on the exact advisory lock`,
    async () => {
      const rows = await readAdvisoryRows(observer);
      if (runner.child.exitCode !== null || runner.child.signalCode !== null) {
        const result = await runner.done;
        const identityPrefix = "Migration lock backend identity: ";
        const identityLine = result.stdout.split("\n").find((line) => line.startsWith(identityPrefix));
        let runnerIdentity = null;
        if (identityLine) {
          try { runnerIdentity = JSON.parse(identityLine.slice(identityPrefix.length)); } catch {}
        }
        throw new Error(
          `Runner exited before becoming a visible advisory-lock waiter; code=${result.code}, signal=${result.signal}. ` +
            `Blocker identity=${JSON.stringify(databaseIdentity)}; runner identity=${JSON.stringify(runnerIdentity)}; ` +
            `lock rows=${JSON.stringify(rows)}\\nSTDOUT:\\n${result.stdout}\\nSTDERR:\\n${result.stderr}`
        );
      }
      return rows;
    }
  );
}

async function run() {
  // This test alone opts into plaintext for its isolated loopback PostgreSQL instance.
  process.env.EASY_LEARN_TEST_DATABASE = "true";
  process.env.EASY_LEARN_MIGRATION_LOCK_DIAGNOSTICS = "true";
  const adminUrl = process.env.TEST_DATABASE_URL;
  let embeddedStop = null;
  let databaseAdminUrl = adminUrl;

  if (!databaseAdminUrl) {
    const { startEmbeddedPostgres } = require("./helpers/embedded-postgres.js");
    const embedded = await startEmbeddedPostgres({
      dbName: `migration_runner_lock_${crypto.randomBytes(4).toString("hex")}`,
      port: 57929 + (crypto.randomBytes(2).readUInt16BE(0) % 1000),
      requireEnv: "EASY_LEARN_REQUIRE_MIGRATION_RUNNER_LOCK",
    });
    if (!embedded) return;
    databaseAdminUrl = embedded.adminUrl;
    embeddedStop = embedded.stop;
  }

  const admin = new Client({ connectionString: databaseAdminUrl });
  await admin.connect();
  const databaseName = `migration_lock_${crypto.randomBytes(6).toString("hex")}`;
  const targetUrl = new URL(databaseAdminUrl);
  targetUrl.pathname = `/${databaseName}`;
  const targetDatabaseUrl = targetUrl.toString();

  let blockerPool;
  let blocker;
  let transactionOpen = false;
  let first;
  let second;
  let primaryError = null;
  let created = false;

  try {
    /* Validate the endpoint mode before any database write. The runner uses this exact
       helper/config; the blocker Pool is built from it too, not a separate pg URL parser. */
    const runnerPoolConfig = buildPoolConfig(targetDatabaseUrl);
    blockerPool = new Pool({ ...runnerPoolConfig, max: 1, connectionTimeoutMillis: 10_000 });
    blockerPool.on("error", (error) => {
      // A backend may disappear during isolated-database teardown; keep cleanup errors
      // visible without allowing EventEmitter's unhandled-error behavior to mask the test.
      console.error(`Isolated lock-test pool connection error: ${error.message}`);
    });

    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;

    const init = runRunner(targetDatabaseUrl, "initialize");
    assert.equal(init.code, 0, `initial migration run failed:\n${init.stdout}\n${init.stderr}`);
    assert.match(init.stdout, /GATED MIGRATION NOT APPLIED: 0018_composite_school_foreign_keys\.sql/);

    blocker = await blockerPool.connect();
    const blockerIdentity = (await blocker.query(databaseIdentityQuery())).rows[0];
    await blocker.query("BEGIN");
    transactionOpen = true;
    await blocker.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", LOCK_KEY);

    const held = await readAdvisoryRows(blocker);
    const blockerLock = held.find((row) => row.database_oid === String(blockerIdentity.database_oid) && Number(row.pid) === blockerIdentity.backend_pid && row.granted);
    assert.ok(blockerLock, `blocker does not hold the exact two-key advisory lock: ${JSON.stringify(held)}`);
    assert.equal(blockerLock.classid, String(LOCK_KEY[0]));
    assert.equal(blockerLock.objid, String(LOCK_KEY[1]));
    assert.equal(blockerLock.objsubid, 2);

    first = startRunner(targetDatabaseUrl, "first");
    const firstWait = await waitForRunnerWaiter(blocker, first, blockerIdentity, 1);
    assert.equal(firstWait.identity.server_address, blockerIdentity.server_address, "first runner connected to a different server address");
    assert.equal(firstWait.identity.server_port, blockerIdentity.server_port, "first runner connected to a different server port");

    second = startRunner(targetDatabaseUrl, "second");
    const secondWait = await waitForRunnerWaiter(blocker, second, blockerIdentity, 2);
    assert.equal(secondWait.identity.server_address, blockerIdentity.server_address, "second runner connected to a different server address");
    assert.equal(secondWait.identity.server_port, blockerIdentity.server_port, "second runner connected to a different server port");
    console.log("PASS: blocker and both runners are visible in the same database OID; both runner backends wait on the exact (classid, objid, objsubid=2) advisory lock.");

    first.child.kill("SIGTERM");
    const firstResult = await first.done;
    assert.equal(firstResult.signal, "SIGTERM", `first runner did not terminate cleanly: ${JSON.stringify(firstResult)}`);
    /* On some CI kernels, killing the local client process does not immediately make
       PostgreSQL notice the reset TCP socket. Terminate only the exact isolated-test
       backend captured from that runner's pre-lock identity, then verify its lock row
       disappears while the other runner remains queued. */
    const terminated = await blocker.query("SELECT pg_terminate_backend($1::integer) AS terminated", [firstWait.identity.backend_pid]);
    assert.equal(terminated.rows[0].terminated, true, "could not terminate the first isolated runner backend");

    const oneWaiter = await waitFor(
      (rows) => {
        const waiting = rows.filter((row) => row.database_oid === String(blockerIdentity.database_oid) && !row.granted);
        const firstStillPresent = rows.some((row) => Number(row.pid) === Number(firstWait.identity.backend_pid));
        return waiting.length === 1 && !firstStillPresent ? waiting : null;
      },
      "terminated runner backend to disappear and release its waiting request",
      () => readAdvisoryRows(blocker)
    );
    assert.equal(Number(oneWaiter[0].pid), Number(secondWait.identity.backend_pid));
    assert.equal(transactionOpen, true);

    await blocker.query("COMMIT");
    transactionOpen = false;
    const secondResult = await second.done;
    assert.equal(secondResult.code, 0, `surviving runner failed:\n${secondResult.stdout}\n${secondResult.stderr}`);
    assert.match(secondResult.stdout, /migration lock acquired/i);
    const identityPrefix = "Migration lock backend identity: ";
    const identityLine = secondResult.stdout.split("\n").find((line) => line.startsWith(identityPrefix));
    assert.ok(identityLine, "surviving runner did not emit safe lock-backend diagnostics");
    const runnerIdentity = JSON.parse(identityLine.slice(identityPrefix.length));
    for (const field of ["database_name", "database_user", "server_address", "server_port", "server_version", "database_oid"]) {
      assert.equal(runnerIdentity[field], blockerIdentity[field], `runner and blocker disagree on ${field}`);
    }
    assert.notEqual(runnerIdentity.backend_pid, blockerIdentity.backend_pid, "runner and blocker unexpectedly share a backend PID");

    const final = runRunner(targetDatabaseUrl, "final");
    assert.equal(final.code, 0, `subsequent runner failed:\n${final.stdout}\n${final.stderr}`);
    assert.match(final.stdout, /GATED MIGRATION NOT APPLIED: 0018_composite_school_foreign_keys\.sql/);
    assert.match(final.stdout, /Migration complete!/i);

    const ledger = await blocker.query(`SELECT filename, checksum FROM public.${HISTORY_TABLE} ORDER BY filename`);
    const expected = MIGRATIONS.filter((name) => name !== GATED_MIGRATION).sort();
    assert.deepEqual(ledger.rows.map((row) => row.filename), expected, "ledger filenames differ from the normal-run migration set");
    for (const row of ledger.rows) {
      const rootFile = path.join(ROOT, row.filename);
      const migrationFile = fs.existsSync(rootFile) ? rootFile : path.join(ROOT, "drizzle", row.filename);
      const expectedChecksum = crypto.createHash("sha256").update(fs.readFileSync(migrationFile)).digest("hex");
      assert.match(row.checksum, /^[0-9a-f]{64}$/);
      assert.equal(row.checksum, expectedChecksum, `checksum mismatch for ${row.filename}`);
    }
    console.log(`PASS: fresh initialization, gate skip, two-runner serialization, waiting-runner termination, recovery, and ${ledger.rowCount} ledger checksums verified.`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (transactionOpen && blocker) await blocker.query("ROLLBACK").catch(() => {});
    for (const runner of [first, second]) {
      if (runner && runner.child.exitCode === null && runner.child.signalCode === null) {
        runner.child.kill("SIGKILL");
        await runner.done.catch(() => {});
      }
    }
    if (blocker) blocker.release();
    if (blockerPool) await blockerPool.end().catch(() => {});
    if (created) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch((error) => {
        console.error(`Cleanup requires attention for isolated test database ${databaseName}: ${error.message}`);
        if (!primaryError) process.exitCode = 1;
      });
    }
    await admin.end().catch(() => {});
    if (embeddedStop) await embeddedStop();
  }
}

run().catch((error) => {
  console.error("FAIL: migration-runner advisory-lock rehearsal");
  console.error(error);
  process.exitCode = 1;
});
