/**
 * Regression tests for the SEC-2 live harness safety fixes (PR #59, F-1/F-2):
 *  - F-1: the live harness must refuse the production bucket
 *    (`easylearn-uploads`) before any network request/creation/deletion,
 *    while keeping the disposable bucket usable.
 *  - F-2: cleanup verification accepts ONLY 404/403 from the post-DELETE
 *    GET probe; 200/500/502/etc. must be reported as cleanup failures.
 *
 * Fully offline: mocked fetch / unreachable dummy endpoint, dummy
 * credentials, no bucket is ever contacted.
 */
import assert from "assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  assertDisposableBucket,
  cleanupKeys,
  isObjectGoneStatus,
  PRODUCTION_BUCKET,
} from "./object-storage-real-provider-harness.test";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌ FAIL: ${name}: ${(error as Error).message}`);
    failed++;
  }
}

const ENV_KEYS = [
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
] as const;

function setDummyStorageEnv(bucket: string) {
  process.env.OBJECT_STORAGE_BUCKET = bucket;
  process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "dummy-access-key";
  process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "dummy-secret-key";
  process.env.OBJECT_STORAGE_ENDPOINT = "http://127.0.0.1:9";
  process.env.OBJECT_STORAGE_REGION = "auto";
}

async function main() {
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const originalFetch = globalThis.fetch;
  try {
    await test("production bucket constant is easylearn-uploads", () => {
      assert.strictEqual(PRODUCTION_BUCKET, "easylearn-uploads");
    });

    await test("assertDisposableBucket refuses the production bucket (incl. padded)", () => {
      assert.throws(() => assertDisposableBucket("easylearn-uploads"), /REFUSED.*production bucket/);
      assert.throws(() => assertDisposableBucket("  easylearn-uploads  "), /REFUSED/);
    });

    await test("assertDisposableBucket allows the disposable bucket", () => {
      assert.doesNotThrow(() => assertDisposableBucket("easylearn-security-test"));
      assert.doesNotThrow(() => assertDisposableBucket("easylearn-test-disposable-123"));
      assert.doesNotThrow(() => assertDisposableBucket(undefined));
    });

    await test("importing harness helpers has no execution side effects", () => {
      const result = spawnSync(
        path.join(process.cwd(), "node_modules", ".bin", "tsx"),
        ["-e", "import './tests/object-storage-real-provider-harness.test.ts'"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            OBJECT_STORAGE_LIVE_TEST: "true",
            OBJECT_STORAGE_BUCKET: PRODUCTION_BUCKET,
            OBJECT_STORAGE_ACCESS_KEY_ID: "dummy-access-key",
            OBJECT_STORAGE_SECRET_ACCESS_KEY: "dummy-secret-key",
            OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9",
            OBJECT_STORAGE_REGION: "auto",
          },
        }
      );
      const out = `${result.stdout ?? ""}\\n${result.stderr ?? ""}`;
      assert.strictEqual(result.status, 0, `import should exit cleanly, got ${result.status}: ${out}`);
      assert.ok(!out.includes("SEC-2: Real provider verification harness"), `import must not execute harness: ${out}`);
      assert.ok(!out.includes("REFUSED"), `import must not run production-bucket guard: ${out}`);
    });

    await test("live harness process exits 1 and refuses production bucket before any live test", () => {
      const result = spawnSync(
        path.join(process.cwd(), "node_modules", ".bin", "tsx"),
        ["tests/object-storage-real-provider-harness.test.ts"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            OBJECT_STORAGE_LIVE_TEST: "true",
            OBJECT_STORAGE_BUCKET: "easylearn-uploads",
            OBJECT_STORAGE_ACCESS_KEY_ID: "dummy-access-key",
            OBJECT_STORAGE_SECRET_ACCESS_KEY: "dummy-secret-key",
            OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9",
            OBJECT_STORAGE_REGION: "auto",
          },
        }
      );
      const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}: ${out}`);
      assert.ok(out.includes("REFUSED"), `expected REFUSED message, got: ${out}`);
      assert.ok(!out.includes("Running live tests"), "harness must not start live tests against production");
    });

    await test("isObjectGoneStatus accepts only 404/403", () => {
      assert.strictEqual(isObjectGoneStatus(404), true);
      assert.strictEqual(isObjectGoneStatus(403), true);
      for (const s of [200, 201, 204, 301, 400, 401, 500, 502, 503]) {
        assert.strictEqual(isObjectGoneStatus(s), false, `status ${s} must not count as gone`);
      }
    });

    const cleanupScenario = async (getStatus: number) => {
      setDummyStorageEnv("easylearn-security-test");
      globalThis.fetch = (async (_url: unknown, init?: { method?: string }) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: getStatus });
      }) as typeof fetch;
      return cleanupKeys(["__easylearn-test/unit-test/probe.txt"]);
    };

    await test("cleanup verified when post-DELETE GET returns 404", async () => {
      assert.deepStrictEqual(await cleanupScenario(404), []);
    });

    await test("cleanup verified when post-DELETE GET returns 403", async () => {
      assert.deepStrictEqual(await cleanupScenario(403), []);
    });

    await test("cleanup FAILS when post-DELETE GET returns 200 (still readable)", async () => {
      assert.deepStrictEqual(await cleanupScenario(200), ["__easylearn-test/unit-test/probe.txt"]);
    });

    await test("cleanup FAILS when post-DELETE GET returns 500 (inconclusive)", async () => {
      assert.deepStrictEqual(await cleanupScenario(500), ["__easylearn-test/unit-test/probe.txt"]);
    });

    await test("cleanup FAILS when post-DELETE GET returns 502 (inconclusive)", async () => {
      assert.deepStrictEqual(await cleanupScenario(502), ["__easylearn-test/unit-test/probe.txt"]);
    });

    await test("cleanup FAILS when DELETE itself errors (403)", async () => {
      setDummyStorageEnv("easylearn-security-test");
      globalThis.fetch = (async (_url: unknown, init?: { method?: string }) => {
        if (init?.method === "DELETE") return new Response(null, { status: 403 });
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      const leftovers = await cleanupKeys(["__easylearn-test/unit-test/probe.txt"]);
      assert.deepStrictEqual(leftovers, ["__easylearn-test/unit-test/probe.txt"]);
    });

    await test("cleanup FAILS on network error instead of swallowing it", async () => {
      setDummyStorageEnv("easylearn-security-test");
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const leftovers = await cleanupKeys(["__easylearn-test/unit-test/probe.txt"]);
      assert.deepStrictEqual(leftovers, ["__easylearn-test/unit-test/probe.txt"]);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} object-storage harness-safety tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
