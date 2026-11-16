/**
 * Regression: embedded PostgreSQL lifecycle hygiene (PR #66 follow-up review).
 *
 * The shared bootstrap must never leave PostgreSQL running or hide a cleanup
 * failure; this suite exercises the exact failure modes:
 *
 *   1. Happy path: start → stop → no process references the data dir, the dir
 *      is gone, and a second stop() is a harmless no-op.
 *   2. Startup watchdog timeout on a REAL cluster (75 ms budget): the bootstrap
 *      fails fast, and the abandoned initdb/postmaster is gone with the data
 *      dir afterwards — a startup timeout cannot leave PostgreSQL running.
 *   3. Deliberately FAILING shutdown (injected failing stop() + a real marker
 *      process referencing the data dir): stop() retries, escalates to direct
 *      process cleanup, reports loudly, confirms, and removes the dir.
 *   4. Timed-out shutdown with unverifiable cleanup (injected): stop() THROWS,
 *      does NOT latch "stopped", does NOT remove the data dir — and a retry
 *      with sane probes succeeds and removes it (safe retries).
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/embedded-postgres-lifecycle.test.ts
 * (CI hard-requires execution via EASY_LEARN_REQUIRE_EMBEDDED_PG_LIFECYCLE=true; a silent skip fails the job)
 */
import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`✅ PASS: ${name}`); passed++; })
    .catch((e) => { console.error(`❌ FAIL: ${name}\n   ${(e as Error).message}`); failed++; });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Capture console.error for one async action; returns the captured lines. */
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result?: T; lines: string[]; threw?: any }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const result = await fn();
    return { result, lines };
  } catch (threw) {
    return { lines, threw };
  } finally {
    console.error = original;
  }
}

async function main() {
  const { startEmbeddedPostgres, _testing } = requireFromRepo("./tests/helpers/embedded-postgres.js");
  const { createManagedStop, pidsReferencing } = _testing;

  const tag = crypto.randomBytes(4).toString("hex");

  let skipped = 0;
  const skipNote = (name: string) => {
    skipped++;
    console.log(`⏭️  SKIP: ${name} (embedded-postgres unavailable; with EASY_LEARN_REQUIRE_EMBEDDED_PG_LIFECYCLE=true the bootstrap fails the suite before this point)`);
  };

  await test("happy path: confirmed shutdown frees the postmaster AND the data dir; stop() is idempotent", async () => {
    const dbName = `easylearn_lifecycle_ok_${tag}`;
    const embedded = await startEmbeddedPostgres({
      dbName,
      port: 62501 + (crypto.randomBytes(1)[0] ?? 0),
      requireEnv: "EASY_LEARN_REQUIRE_EMBEDDED_PG_LIFECYCLE",
    });
    if (!embedded) { skipNote("happy path"); return; }
    assert.ok(fs.existsSync(embedded.dataDir), "data dir must exist while running");
    assert.ok(pidsReferencing(embedded.dataDir).length > 0, "a postmaster must reference the data dir while running");

    await embedded.stop();
    assert.strictEqual(pidsReferencing(embedded.dataDir).length, 0, "no process may reference the data dir after stop()");
    assert.ok(!fs.existsSync(embedded.dataDir), "data dir must be removed after confirmed shutdown");

    await embedded.stop(); // second call is a no-op AFTER a confirmed shutdown
  });

  await test("startup watchdog timeout: bootstrap fails fast, no initdb/postmaster or data dir survives", async () => {
    const dbName = `easylearn_lifecycle_wd_${tag}`;
    const dataDir = path.join(os.tmpdir(), `${dbName}-data`);
    const previousTimeout = process.env.EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS;
    const previousBudget = process.env.EASY_LEARN_EMBEDDED_PG_ORPHAN_WAIT_MS;
    process.env.EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS = "75"; // initdb takes seconds — the watchdog must fire first
    process.env.EASY_LEARN_EMBEDDED_PG_ORPHAN_WAIT_MS = "15000";
    try {
      const outcome = await startEmbeddedPostgres({
        dbName,
        port: 62601 + (crypto.randomBytes(1)[0] ?? 0),
        requireEnv: "EASY_LEARN_REQUIRE_EMBEDDED_PG_LIFECYCLE",
      }).then(
        (embedded: any) => ({ embedded, error: null as any }),
        (error: any) => ({ embedded: null as any, error }),
      );
      if (outcome.embedded === null && !outcome.error) { skipNote("startup watchdog timeout"); return; }
      if (outcome.embedded) {
        /* initdb finished within 75 ms would invalidate the premise — clean up and fail. */
        await outcome.embedded.stop();
        throw new Error("the 75 ms watchdog budget must fire before a multi-second initdb/start completes");
      }
      assert.match(
        String(outcome.error.message),
        /startup \(port \d+\) did not finish within 75 ms/,
        "the startup watchdog must be the reported failure",
      );
      /* The catch path of the bootstrap awaited its own teardown before rethrowing,
         so by the time assert.rejects resolved, cleanup must already be complete. */
      await sleep(250); // settle margin for process-table visibility
      assert.strictEqual(
        pidsReferencing(dataDir).length,
        0,
        "the startup watchdog timeout must not leave an underlying PostgreSQL process running",
      );
      assert.ok(!fs.existsSync(dataDir), "the data dir must be gone after the failed bootstrap's cleanup");
    } finally {
      if (previousTimeout === undefined) delete process.env.EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS;
      else process.env.EASY_LEARN_EMBEDDED_PG_TIMEOUT_MS = previousTimeout;
      if (previousBudget === undefined) delete process.env.EASY_LEARN_EMBEDDED_PG_ORPHAN_WAIT_MS;
      else process.env.EASY_LEARN_EMBEDDED_PG_ORPHAN_WAIT_MS = previousBudget;
    }
  });

  await test("deliberately failing shutdown: retries, escalates, kills the leftover, removes the dir, reports loudly", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "easylearn-lifecycle-failstop-"));
    fs.writeFileSync(path.join(dataDir, "marker"), "x");
    /* A REAL stray process referencing the dir — exactly what a botched pg.stop()
       leaves behind; escalation must be able to find and kill it. unref() + a
       final safety kill guarantee this marker can never outlive the test. */
    const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 500)", dataDir], { stdio: "ignore" });
    stray.unref();
    const strayPid = stray.pid!;
    const struggle = { stopCalls: 0 };
    const fakePg = { stop: async () => { struggle.stopCalls++; throw new Error("simulated pg.stop() failure"); } };

    try {
      await sleep(300); // let the stray appear in the process table
      assert.ok(pidsReferencing(dataDir).length > 0, "stray marker process must be visible before the test");

      const { stop, isConfirmedStopped } = createManagedStop(fakePg, {
        dataDir,
        port: 0,
        attempts: 3,
        shutdownTimeoutMs: 500,
        orphanBudgetMs: 8_000,
        isStartupSettled: () => true,
      });

      const { lines } = await captureErrors(() => stop());
      assert.ok(struggle.stopCalls === 3, `stop() must retry pg.stop() exactly 3 times, got ${struggle.stopCalls}`);
      assert.ok(lines.some((l) => l.includes("did not complete") && l.includes("attempt 1/3")), "each failed attempt is reported");
      assert.ok(lines.some((l) => l.includes("escalating to direct process cleanup")), "the escalation is reported, not silent");
      assert.ok(isConfirmedStopped(), "shutdown is confirmed once nothing references the dir");
      assert.strictEqual(pidsReferencing(dataDir).length, 0, "the stray process must be gone");
      assert.ok(!fs.existsSync(dataDir), "the data dir must be removed after confirmed shutdown");
      assert.throws(() => process.kill(strayPid, 0), /ESRCH/, "stray pid must not survive escalation");

      await stop(); // idempotent after confirmation — no more pg.stop() calls
      assert.strictEqual(struggle.stopCalls, 3, "a confirmed stop() must not stop again");
    } finally {
      try { process.kill(strayPid, "SIGKILL"); } catch { /* already dead — the goal state */ }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("timed-out shutdown + unverifiable cleanup: stop() THROWS, keeps the dir, stays retryable; retry succeeds", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "easylearn-lifecycle-timeout-"));
    try {
      fs.writeFileSync(path.join(dataDir, "marker"), "x");

      const calls = { stopCount: 0 };
      let stopBehaviour: "hang" | "ok" = "hang";
      const fakePg = {
        stop: async () => {
          calls.stopCount++;
          if (stopBehaviour === "hang") await new Promise(() => {}); // never settles → watchdog timeout
        },
      };
      /* First the process table always reports a "leftover" and killing is a no-op:
         cleanup can never confirm, so stop() must THROW and keep the dir. Then the
         environment heals (real probes), and the retry must succeed. */
      let probe: (dir: string) => number[] = () => [4242];
      const { stop, isConfirmedStopped } = createManagedStop(fakePg, {
        dataDir,
        port: 0,
        attempts: 2,
        shutdownTimeoutMs: 200,
        orphanBudgetMs: 600,
        isStartupSettled: () => true,
        probePids: (dir: string) => probe(dir),
        killPids: () => { /* deliberate no-op: nothing dies */ },
      });

      const { lines, threw } = await captureErrors(() => stop());
      assert.ok(threw, "stop() must throw when shutdown cannot be confirmed");
      assert.match(String(threw.message), /could not be confirmed/, "the error must say the shutdown was not confirmed");
      assert.match(String(threw.message), /NOT removed/, "the error must say the data dir was kept");
      assert.ok(!isConfirmedStopped(), "stop() must NOT latch 'stopped' on failure");
      assert.ok(fs.existsSync(dataDir), "the data dir must be kept when shutdown is unconfirmed");
      assert.strictEqual(calls.stopCount, 2, "graceful stop was attempted exactly `attempts` times");
      assert.ok(lines.some((l) => l.includes("did not finish within 200 ms")), "the shutdown timeout is reported");

      /* Safe retry: same managed stop, healed environment. */
      stopBehaviour = "ok";
      probe = (dir) => pidsReferencing(dir); // real scan — nothing references this fake dir
      await stop();
      assert.ok(isConfirmedStopped(), "the retry confirms shutdown");
      assert.ok(!fs.existsSync(dataDir), "the retry removes the data dir");
      assert.strictEqual(calls.stopCount, 3, "the retry actually re-ran pg.stop() (not latched)");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
