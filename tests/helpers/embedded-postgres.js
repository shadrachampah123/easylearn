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
 * Cleanup contract (hardened in this revision — a cleanup failure FAILS the suite,
 * it is never swallowed):
 *
 *   - stop() is idempotent ONLY after a *confirmed* shutdown. If any shutdown
 *     attempt throws or times out, stop() is not latched: it escalates to direct
 *     process cleanup (any process whose command line references OUR data dir —
 *     `postgres -D <dir>`, `initdb --pgdata=<dir>`), and throws with a precise
 *     report if shutdown still cannot be confirmed. A caller may safely retry.
 *   - `pg.stop()` "success" is NOT accepted as proof: the wrapper resolves
 *     immediately when it holds no child handle (a startup watchdog timeout is
 *     exactly such a case — initdb can outlive it), so a post-stop process scan
 *     must clear before shutdown counts as confirmed. A startup watchdog timeout
 *     therefore CANNOT leave an underlying PostgreSQL process running.
 *   - The temporary data directory is removed only AFTER confirmed shutdown,
 *     and a removal failure throws — no stale state is hidden.
 *   - A startup watchdog (`EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS`, default 120s) so
 *     initialise/start/credential-probe can never hang the harness; a shutdown
 *     watchdog (`EASY_LEARN_EMBEDDED_PG_SHUTDOWN_TIMEOUT_MS`, default 30s) and a
 *     bounded direct-cleanup window (`EASY_LEARN_EMBEDDED_PG_ORPHAN_WAIT_MS`,
 *     default 30s) so teardown can never hang either.
 *   - A fail-fast credential probe: if the just-started server rejects our
 *     password, we learn it here, loudly — not 200 lines later.
 *   - Honest skips: when the wrapper package is unavailable the suite may skip
 *     (exit 0) — unless the caller passes `requireEnv` and that CI flag is set,
 *     in which case a skip is a hard failure (exit 1), mirroring the existing
 *     `EASY_LEARN_REQUIRE_*` idiom.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/** One credential pair for initdb AND the connection URL — never two. */
const EMBEDDED_PG_USER = "easylearn";
const EMBEDDED_PG_PASSWORD = "easylearn";

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
/** Graceful `pg.stop()` attempts before escalating to direct process cleanup. */
const SHUTDOWN_ATTEMPTS = 3;
/** How long direct cleanup keeps killing/verifying before declaring failure. */
const DEFAULT_ORPHAN_WAIT_MS = 30_000;
const ORPHAN_POLL_MS = 100;

function loadEmbeddedPostgres() {
  try {
    const mod = require("embedded-postgres");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function envOverrideMs(name, fallback) {
  const override = Number(process.env[name]);
  return Number.isFinite(override) && override > 0 ? override : fallback;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PIDs (excluding our own) whose full command line contains `needle` — we pass
 * the data dir, which the wrapper embeds in every child argv (`postgres -D
 * <dir>`, `initdb --pgdata=<dir>`). Throws when the process table cannot be
 * enumerated: guessing "clean" when we cannot look would hide leftovers.
 */
function pidsReferencing(needle) {
  let listing;
  try {
    listing = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  } catch (error) {
    throw new Error(`cannot enumerate processes with \`ps\` for cleanup verification: ${error.message}`);
  }
  const pids = [];
  for (const line of listing.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    if (!match[2].includes(needle)) continue;
    pids.push(pid);
  }
  return pids;
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone — that is the goal state */
    }
  }
}

/**
 * Kill/verify loop: until no process references `dataDir` AND `canStopScanning()`
 * (i.e. the abandoned startup closure has settled, so it cannot spawn anything
 * new), SIGKILL everything that references the dir. Bounded by `budgetMs`.
 * Returns { clear, probeError } — `clear:false` means NOT verified clean.
 */
async function eliminateProcessesReferencing({ dataDir, canStopScanning, budgetMs, probePids, kill }) {
  const probe = probePids ?? pidsReferencing;
  const doKill = kill ?? killPids;
  const deadline = Date.now() + budgetMs;
  let clearSamples = 0;
  while (Date.now() <= deadline) {
    let pids;
    try {
      pids = probe(dataDir);
    } catch (probeError) {
      return { clear: false, probeError };
    }
    if (pids.length > 0) {
      doKill(pids);
      clearSamples = 0;
    } else if (canStopScanning()) {
      clearSamples += 1;
      if (clearSamples >= 2) return { clear: true, probeError: null };
    }
    await sleep(ORPHAN_POLL_MS);
  }
  return { clear: false, probeError: null };
}

/**
 * The managed teardown for one cluster. Never swallows a shutdown failure:
 *
 *   1. Graceful `pg.stop()` under a watchdog, retried up to `attempts` times.
 *      Every failure is printed.
 *   2. Confirmation: the wrapper's stop() can resolve without having stopped
 *      anything (no child handle), so shutdown only counts when startup has
 *      settled AND no process references the data dir. Otherwise escalate to
 *      direct process cleanup with the same confirmation standard.
 *   3. Failure to confirm THROWS (message says the dir was kept, and stop()
 *      stays retryable). Only a confirmed shutdown latches `confirmed = true`
 *      and proceeds to remove the data dir; a removal error also throws.
 */
function createManagedStop(pg, options) {
  const { dataDir, port } = options;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const attempts = options.attempts ?? SHUTDOWN_ATTEMPTS;
  const orphanBudgetMs = options.orphanBudgetMs ?? DEFAULT_ORPHAN_WAIT_MS;
  const isStartupSettled = options.isStartupSettled ?? (() => true);

  let confirmed = false;

  const stop = async () => {
    if (confirmed) return; // idempotent ONLY after a confirmed shutdown
    let lastError = null;
    let gracefullyStopped = false;

    for (let attempt = 1; attempt <= attempts && !gracefullyStopped; attempt++) {
      try {
        await withWatchdog(
          pg.stop(),
          shutdownTimeoutMs,
          `embedded PostgreSQL shutdown (port ${port}, attempt ${attempt}/${attempts})`
        );
        gracefullyStopped = true;
      } catch (attemptError) {
        lastError = attemptError;
        console.error(
          `⚠️  embedded PostgreSQL shutdown attempt ${attempt}/${attempts} on port ${port} did not complete: ${attemptError.message}`
        );
      }
    }

    if (gracefullyStopped && isStartupSettled() && (options.probePids ?? pidsReferencing)(dataDir).length === 0) {
      confirmed = true;
    } else {
      const reason = lastError
        ? `graceful stop failed: ${lastError.message}`
        : "graceful stop returned, but the cluster is not verifiably down";
      console.error(
        `⚠️  embedded PostgreSQL shutdown on port ${port} is not confirmed (${reason}) — escalating to direct process cleanup for ${dataDir}`
      );
      let result;
      try {
        result = await eliminateProcessesReferencing({
          dataDir,
          canStopScanning: isStartupSettled,
          budgetMs: orphanBudgetMs,
          probePids: options.probePids,
          kill: options.killPids,
        });
      } catch (escalationError) {
        result = { clear: false, probeError: escalationError };
      }
      if (result.clear) {
        confirmed = true;
        console.error(`⚠️  direct process cleanup confirmed: nothing references ${dataDir}`);
      } else {
        const verifyNote = result.probeError ? `; verification failed too: ${result.probeError.message}` : "";
        throw new Error(
          `embedded PostgreSQL shutdown on port ${port} could not be confirmed (${reason}${verifyNote}); ` +
            `${dataDir} was NOT removed and stop() was NOT latched — inspect for leftover postmasters and retry.`
        );
      }
    }

    /* Removal happens ONLY now, after confirmed shutdown; a removal failure is
       reported loudly instead of leaving hidden stale state. */
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (removalError) {
      throw new Error(
        `embedded PostgreSQL on port ${port} is confirmed stopped, but removing ${dataDir} failed: ${removalError.message}`
      );
    }
  };

  return { stop, isConfirmedStopped: () => confirmed };
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

  const startupTimeoutMs = envOverrideMs("EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS", DEFAULT_STARTUP_TIMEOUT_MS);
  const shutdownTimeoutMs = envOverrideMs("EASY_LEARN_EMBEDDED_PG_SHUTDOWN_TIMEOUT_MS", DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const orphanBudgetMs = envOverrideMs("EASY_LEARN_EMBEDDED_PG_ORPHAN_WAIT_MS", DEFAULT_ORPHAN_WAIT_MS);
  const dataDir = path.join(os.tmpdir(), `${dbName}-data`);
  fs.rmSync(dataDir, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: EMBEDDED_PG_USER,
    password: EMBEDDED_PG_PASSWORD,
    port,
    persistent: false,
  });

  /* A watchdog race abandons the await, NOT the work: track whether startup ever
     settles so teardown knows nothing more can spawn underneath it. */
  let startupSettled = false;
  const startupWork = (async () => {
    await pg.initialise();
    await pg.start();
  })();
  startupWork.then(
    () => { startupSettled = true; },
    () => { startupSettled = true; }
  );

  const managed = createManagedStop(pg, {
    dataDir,
    port,
    shutdownTimeoutMs,
    orphanBudgetMs,
    isStartupSettled: () => startupSettled,
  });

  /* Built from the same constants as the cluster, so URL and initdb can never drift apart. */
  const adminUrl = `postgres://${EMBEDDED_PG_USER}:${EMBEDDED_PG_PASSWORD}@127.0.0.1:${port}/postgres`;
  try {
    await withWatchdog(startupWork, startupTimeoutMs, `embedded PostgreSQL startup (port ${port})`);

    /* Fail fast: connect with the exact credentials the suite will use, so a
       credential/cluster mismatch is a clear startup error instead of a later
       mystery — and so we never proceed to hang on a half-started cluster. */
    const { Client } = require("pg");
    const probe = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
    try {
      await withWatchdog(probe.connect(), startupTimeoutMs, `embedded PostgreSQL credential probe (port ${port})`);
    } finally {
      await probe.end().catch(() => undefined);
    }

    console.log(`📦 Embedded PostgreSQL started on port ${port}`);
    return { adminUrl, port, user: EMBEDDED_PG_USER, password: EMBEDDED_PG_PASSWORD, dataDir, stop: managed.stop };
  } catch (error) {
    console.error(`❌ Embedded PostgreSQL bootstrap failed on port ${port}: ${error.message}`);
    /* Startup may have been abandoned mid-flight by the watchdog — teardown still
       runs through the SAME confirmed-shutdown contract, so initdb/postmaster of
       a timed-out startup cannot survive, and the data dir goes only after that
       is confirmed. A cleanup failure here must not mask the bootstrap error,
       but it must also not vanish. */
    try {
      await managed.stop();
    } catch (cleanupError) {
      const combined = new Error(
        `embedded PostgreSQL bootstrap failed on port ${port}: ${error.message}; ` +
          `cleanup of the failed bootstrap ALSO failed: ${cleanupError.message}`
      );
      combined.cause = error;
      combined.cleanupError = cleanupError;
      throw combined;
    }
    throw error;
  }
}

module.exports = {
  EMBEDDED_PG_USER,
  EMBEDDED_PG_PASSWORD,
  startEmbeddedPostgres,
  /** Test seams for tests/embedded-postgres-lifecycle.test.ts — not for suites. */
  _testing: {
    createManagedStop,
    pidsReferencing,
    eliminateProcessesReferencing,
  },
};
