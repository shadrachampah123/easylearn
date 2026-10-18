/**
 * Shared helper for the disposable test suites: apply the migration chain to a
 * throwaway database.
 *
 * The chain is applied the way an operator must apply it:
 *   1. `node run-migration.js` — the ordinary run. Gated migrations are SKIPPED by it on
 *      purpose, so the suite applies them in the second step, explicitly and with their
 *      confirmation token. A suite that only ran step 1 would silently test a schema
 *      without the composite tenant foreign keys.
 *   2. one explicit invocation per gated migration, with the confirmation token.
 *
 * The gated list is read from `run-migration.js` itself, so a new gated migration cannot
 * be forgotten here.
 */

const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..");
const { GATED_MIGRATIONS } = require(path.join(REPO_ROOT, "run-migration.js"));

/**
 * Apply the whole chain to a disposable database.
 *
 * @param {object} options
 * @param {string} options.databaseUrl  the scratch database connection string
 * @param {NodeJS.ProcessEnv} [options.env]  extra environment for the child process
 * @param {string} [options.fileName]  apply only this registered file
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runMigrations({ databaseUrl, env = {}, fileName }) {
  const baseEnv = { ...process.env, ...env, DATABASE_URL: databaseUrl };
  const run = (args, childEnv) =>
    spawnSync(process.execPath, ["run-migration.js", ...args], {
      cwd: REPO_ROOT,
      env: childEnv || baseEnv,
      encoding: "utf8",
    });

  const steps = [];
  if (fileName) {
    /* An explicitly named gated migration still needs its confirmation token. */
    const gate = GATED_MIGRATIONS[fileName];
    steps.push(run([fileName], gate ? { ...baseEnv, [gate.env]: gate.token } : baseEnv));
  } else {
    steps.push(run([]));
  }

  if (!fileName) {
    /* Apply every gated migration explicitly, with its confirmation token. */
    for (const [gatedFile, gate] of Object.entries(GATED_MIGRATIONS)) {
      steps.push(run([gatedFile], { ...baseEnv, [gate.env]: gate.token }));
    }
  }

  const status = steps.some((step) => step && step.status !== 0) ? 1 : 0;
  const stdout = steps.map((step) => (step ? step.stdout || "" : "")).join("");
  const stderr = steps.map((step) => (step ? step.stderr || "" : "")).join("");

  return { status, stdout, stderr, steps };
}

module.exports = { GATED_MIGRATIONS, REPO_ROOT, runMigrations };
