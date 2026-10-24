/**
 * Regression test for PR #45 review finding R5:
 * `tests/quiz-access-db.test.ts` must never exit 0 with zero assertions when database
 * or migration setup fails.
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..");

test("quiz-access-db.test.ts exits nonzero when migration setup fails before assertions", () => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl, "TEST_DATABASE_URL is required");

  const preloadFile = path.join(
    os.tmpdir(),
    `quiz-harness-preload-${process.pid}-${Date.now()}.cjs`
  );
  fs.writeFileSync(
    preloadFile,
    `
const childProcess = require("node:child_process");
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function patchedSpawnSync(cmd, args, opts) {
  if (Array.isArray(args) && args[0] === "run-migration.js") {
    return { status: 42, stdout: "", stderr: "injected migration failure", pid: 0, output: [], signal: null };
  }
  return realSpawnSync.apply(this, arguments);
};
`,
    "utf8"
  );

  try {
    const existingNodeOptions = process.env.NODE_OPTIONS || "";
    const result = spawnSync(
      process.execPath,
      ["./node_modules/.bin/tsx", "tests/quiz-access-db.test.ts"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          EASY_LEARN_TEST_DATABASE: "true",
          TEST_DATABASE_URL: adminUrl,
          NODE_OPTIONS: `${existingNodeOptions} --require ${preloadFile}`.trim(),
        },
      }
    );

    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.notEqual(
      result.status,
      0,
      `expected nonzero exit code on migration setup failure, got 0:\n${combined}`
    );
    assert.ok(
      !/📊 quiz access: \d+ passed/.test(combined),
      `expected zero test summary after setup failure:\n${combined}`
    );
  } finally {
    fs.rmSync(preloadFile, { force: true });
  }
});
