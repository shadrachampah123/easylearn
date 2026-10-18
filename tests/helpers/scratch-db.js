"use strict";

/**
 * Shared helper for the disposable test suites: own the lifecycle of a throwaway
 * PostgreSQL database.
 *
 * Why this exists
 * ---------------
 * The LOW-5 finding of the PR #32 migration-safety review: several suites created a
 * scratch database and never dropped it, so a full `npm run test:all` left a trail of
 * databases behind on the admin database. On a CI runner this is invisible (the service
 * container is destroyed with the job), but on a long-lived developer or self-hosted
 * database the scratch databases accumulate.
 *
 * Two more properties matter, and neither is provided by the old ad-hoc teardown:
 *
 *   1. The teardown must run even when a **setup** step fails. The old pattern created
 *      the database *before* entering the suite's `try` block, so a suite that died
 *      between `CREATE DATABASE` and the `try` could never drop it.
 *   2. A **failed teardown must not be swallowed silently**. The old pattern used
 *      `.catch(() => undefined)`, which turned "the scratch database could not be
 *      removed" into silence. It must be surfaced with an actionable message — without
 *      ever replacing the original test failure.
 *
 * The contract
 * ------------
 *   - `createScratchDatabase()` removes any stale database with the same name, creates a
 *     fresh one and connects a client. If any step fails it removes whatever it created
 *     before re-throwing, so a failed setup never leaves a database behind.
 *   - `dropScratchDatabase()` terminates the backends still attached to the database and
 *     then drops it, retrying a few times. It **never throws**: it returns
 *     `{ ok, error }` so the caller decides how to report the outcome.
 *   - `assertCleanupSucceeded()` composes the two outcomes:
 *       · the test body already failed → the ORIGINAL failure is what fails the suite;
 *         the cleanup failure is printed and attached to it as `cleanupError`;
 *       · the test body succeeded → the cleanup failure fails the suite on its own.
 *
 * Usage
 * -----
 *   const scratch = await createScratchDatabase({ admin, adminUrl, dbName: DB_NAME, label: "my-suite" });
 *   const db = scratch.db;
 *   let primaryError = null;
 *   try {
 *     ... the suite body ...
 *   } catch (error) {
 *     primaryError = error;
 *     throw error;
 *   } finally {
 *     const cleanup = await scratch.dispose();
 *     assertCleanupSucceeded(cleanup, primaryError);
 *   }
 */

const { Client } = require("pg");

/** How many times a drop is retried before it is reported as a failure. */
const DROP_ATTEMPTS = 3;

/** Pause between drop attempts, in milliseconds (grows with the attempt number). */
const DROP_BACKOFF_MS = 100;

function describeError(error) {
  if (!error) return "unknown error";
  return error.message ? error.message : String(error);
}

/**
 * Terminate every backend still attached to `dbName` (including idle ones), so the
 * database can be dropped.
 */
async function terminateBackends(admin, dbName) {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()`,
    [dbName]
  );
}

/**
 * Drop a disposable database. Never throws.
 *
 * @param {import("pg").Client} admin  a client connected to the admin database
 * @param {string} dbName              the scratch database to remove
 * @param {{label?: string}} [options] `label` is used in the error message
 * @returns {Promise<{ok: boolean, error: Error|null}>}
 */
async function dropScratchDatabase(admin, dbName, options = {}) {
  const label = options.label || dbName;
  let lastError = null;

  for (let attempt = 1; attempt <= DROP_ATTEMPTS; attempt += 1) {
    try {
      await terminateBackends(admin, dbName);
      try {
        /* WITH (FORCE) needs PostgreSQL 13+; fall back for older servers. */
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch (forceError) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      }

      const remaining = await admin.query(
        `SELECT count(*)::int AS n FROM pg_database WHERE datname = $1`,
        [dbName]
      );
      if (remaining.rows[0].n === 0) {
        return { ok: true, error: null };
      }
      lastError = new Error(`the database still exists after DROP DATABASE`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, DROP_BACKOFF_MS * attempt));
  }

  return {
    ok: false,
    error: new Error(
      `Failed to drop the disposable test database "${dbName}" (${label}) after ` +
        `${DROP_ATTEMPTS} attempts: ${describeError(lastError)}. ` +
        `Remove it manually with: DROP DATABASE "${dbName}" WITH (FORCE); ` +
        `and check for a backend that is still attached to it.`
    ),
  };
}

/**
 * Create a disposable database and connect a client to it.
 *
 * Any stale database with the same name is removed first (a previous run that was
 * killed leaves one behind). If the creation or the connection fails, whatever was
 * created is removed again before the error is re-thrown.
 *
 * @param {object} options
 * @param {import("pg").Client} options.admin     a client connected to the admin database
 * @param {string} options.adminUrl                the admin connection string
 * @param {string} options.dbName                  the scratch database to create
 * @param {string} [options.label]                 a human label for error messages
 * @param {object} [options.clientOptions]         extra options for the `pg` client
 * @returns {Promise<{dbName: string, scratchUrl: string, db: import("pg").Client, dispose: () => Promise<{ok: boolean, error: Error|null}>}>}
 */
async function createScratchDatabase({ admin, adminUrl, dbName, label, clientOptions = {} }) {
  const name = label || dbName;

  const stale = await dropScratchDatabase(admin, dbName, { label: name });
  if (!stale.ok) {
    throw stale.error;
  }

  const scratchUrl = (() => {
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    return url.toString();
  })();

  let db = null;
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    db = new Client({ connectionString: scratchUrl, ...clientOptions });
    await db.connect();
  } catch (error) {
    if (db) {
      await db.end().catch(() => undefined);
    }
    const cleanup = await dropScratchDatabase(admin, dbName, { label: name });
    if (!cleanup.ok) {
      throw new Error(
        `${describeError(error)} — and the cleanup of the disposable database "${dbName}" ` +
          `failed as well: ${describeError(cleanup.error)}`
      );
    }
    throw error;
  }

  return {
    dbName,
    scratchUrl,
    db,
    /**
     * Close the client and drop the database. Never throws: the outcome is returned so
     * the caller can compose it with the outcome of the test body.
     */
    dispose: async () => {
      if (db) {
        const client = db;
        db = null;
        await client.end().catch(() => undefined);
      }
      return dropScratchDatabase(admin, dbName, { label: name });
    },
  };
}

/**
 * Compose the outcome of a teardown with the outcome of the test body.
 *
 * - The teardown failed and the body failed too → the ORIGINAL failure is what fails the
 *   suite. The cleanup failure is printed (never silently swallowed) and attached to the
 *   original error as `cleanupError`.
 * - The teardown failed and the body succeeded → the cleanup failure fails the suite.
 *
 * @param {{ok: boolean, error: Error|null}|Array<{ok: boolean, error: Error|null}>} cleanup
 * @param {unknown} primaryError  the error the test body threw, or null
 */
function assertCleanupSucceeded(cleanup, primaryError) {
  const outcomes = Array.isArray(cleanup) ? cleanup : [cleanup];
  const failures = outcomes.filter((outcome) => outcome && !outcome.ok);
  if (failures.length === 0) {
    return;
  }

  const messages = failures.map((failure) => failure.error.message);
  const combined = new Error(
    `Disposable test database cleanup failed:\n   - ${messages.join("\n   - ")}`
  );

  if (!primaryError) {
    /* Nothing else failed: the cleanup failure is the failure. */
    throw combined;
  }

  console.error(`❌ ${combined.message}`);
  if (primaryError instanceof Error && !primaryError.cleanupError) {
    primaryError.cleanupError = combined;
  }
}

module.exports = {
  createScratchDatabase,
  dropScratchDatabase,
  assertCleanupSucceeded,
  terminateBackends,
};
