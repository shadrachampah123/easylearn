"use strict";

/**
 * Shared bootstrap for suites that run against a disposable embedded PostgreSQL
 * (used when TEST_DATABASE_URL is not set).
 *
 * Why this exists (PR #66 follow-up to the independent PR #65 review, MEDIUM-2)
 * -----------------------------------------------------------------------------
 * Four session-revocation suites each carried an inline copy of an embedded
 * bootstrap with two defects:
 *
 *   1. The cluster was initialised with one password while the connection URL
 *      used another, so every embedded run failed with FATAL 28P01
 *      (password authentication failed) — invisible in CI because CI always
 *      sets TEST_DATABASE_URL.
 *   2. On that failure the suite printed the error but never exited: the
 *      spawned postmaster is an unmanaged child whose handles keep the Node
 *      event loop alive, and `embedded-postgres`'s exit hooks only run on a
 *      graceful exit. A bare `npm run test:db` therefore hung forever with no
 *      diagnosis.
 *
 * This helper centralises one correct implementation:
 *
 *   - ONE credential pair used for both initdb and every URL.
 *   - A startup watchdog (`EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS`, default 120s) so
 *     initialise/start/credential-probe can never hang the harness.
 *   - A fail-fast credential probe: if the just-started server rejects our
 *     password, we learn it here, loudly — not 200 lines later.
 *   - Guaranteed cleanup: any failure stops the postmaster and removes the
 *     data directory before the error propagates; the returned `stop()` is
 *     idempotent and also removes the data directory.
 *   - Honest skips: when the wrapper package is unavailable the suite may skip
 *     (exit 0) — unless the caller passes `requireEnv` and that CI flag is set,
 *     in which case a skip is a hard failure (exit 1), mirroring the existing
 *     `EASY_LEARN_REQUIRE_*` idiom.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** One credential pair for initdb AND the connection URL — never two. */
const EMBEDDED_PG_USER = "easylearn";
const EMBEDDED_PG_PASSWORD = "easylearn";

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

function loadEmbeddedPostgres() {
  try {
    const mod = require("embedded-postgres");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function startupTimeoutMs() {
  const override = Number(process.env.EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_STARTUP_TIMEOUT_MS;
}

/** Reject `promise` if it does not settle within `ms`. */
function withWatchdog(promise, ms, label) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not finish within ${ms} ms — refusing to hang the harness`)),
      ms
    );
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

/**
 * Start a disposable embedded PostgreSQL, or skip/fail per policy.
 *
 * @param {object} options
 * @param {string} options.dbName      scratch database name; the data dir is derived from it
 * @param {number} options.port        TCP port to bind (caller picks a suite-specific range)
 * @param {string} [options.requireEnv] name of an EASY_LEARN_REQUIRE_* flag: when set to
 *                                      "true", an unavailable wrapper is a FAILURE (exit 1),
 *                                      not a skip
 * @returns {Promise<null | {
 *   adminUrl: string, port: number, user: string, password: string,
 *   dataDir: string, stop: () => Promise<void>
 * }>} null means "skip" (wrapper package unavailable and not required)
 */
async function startEmbeddedPostgres({ dbName, port, requireEnv }) {
  const EmbeddedPostgres = loadEmbeddedPostgres();
  if (!EmbeddedPostgres) {
    const message = "⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.";
    if (requireEnv && process.env[requireEnv] === "true") {
      console.error(
        `❌ FAIL: ${requireEnv}=true — this suite must run, not skip. ` +
          "Provide TEST_DATABASE_URL or `npm ci` (embedded-postgres is a devDependency)."
      );
      process.exit(1);
    }
    console.log(message);
    return null;
  }

  const timeoutMs = startupTimeoutMs();
  const dataDir = path.join(os.tmpdir(), `${dbName}-data`);
  fs.rmSync(dataDir, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: EMBEDDED_PG_USER,
    password: EMBEDDED_PG_PASSWORD,
    port,
    persistent: false,
  });

  let stopped = false;
  /** Idempotent: stop the postmaster (frees the event loop) and remove the data dir. */
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await withWatchdog(pg.stop(), timeoutMs, `embedded PostgreSQL shutdown (port ${port})`).catch(
      () => undefined
    );
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  /* Built from the same constants as the cluster, so URL and initdb can never drift apart. */
  const adminUrl = `postgres://${EMBEDDED_PG_USER}:${EMBEDDED_PG_PASSWORD}@127.0.0.1:${port}/postgres`;
  try {
    await withWatchdog(
      (async () => {
        await pg.initialise();
        await pg.start();
      })(),
      timeoutMs,
      `embedded PostgreSQL startup (port ${port})`
    );

    /* Fail fast: connect with the exact credentials the suite will use, so a
       credential/cluster mismatch is a clear startup error instead of a later
       mystery — and so we never proceed to hang on a half-started cluster. */
    const { Client } = require("pg");
    const probe = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
    try {
      await withWatchdog(probe.connect(), timeoutMs, `embedded PostgreSQL credential probe (port ${port})`);
    } finally {
      await probe.end().catch(() => undefined);
    }

    console.log(`📦 Embedded PostgreSQL started on port ${port}`);
    return { adminUrl, port, user: EMBEDDED_PG_USER, password: EMBEDDED_PG_PASSWORD, dataDir, stop };
  } catch (error) {
    console.error(`❌ Embedded PostgreSQL bootstrap failed on port ${port}: ${error.message}`);
    await stop();
    throw error;
  }
}

module.exports = {
  EMBEDDED_PG_USER,
  EMBEDDED_PG_PASSWORD,
  startEmbeddedPostgres,
};
