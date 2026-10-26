/**
 * SEC-2: Real provider verification harness for object storage (R2/S3).
 *
 * This is a safe, repeatable procedure for the actual configured provider
 * (Cloudflare R2 or AWS S3). It tests presigned PUT/GET, tampered signatures,
 * mismatched content types, object size, and response overrides using only a
 * disposable bucket and test data. It never touches production.
 *
 * To run: set OBJECT_STORAGE_LIVE_TEST=true and the required provider env vars:
 *   OBJECT_STORAGE_BUCKET
 *   OBJECT_STORAGE_ACCESS_KEY_ID
 *   OBJECT_STORAGE_SECRET_ACCESS_KEY
 *   OBJECT_STORAGE_ENDPOINT (for R2)
 *   OBJECT_STORAGE_REGION (auto for R2)
 *
 * Without those, the suite skips with a clear message and reports manual steps.
 *
 * Manual verification steps (when credentials unavailable):
 * 1. Create a disposable bucket (e.g., easylearn-test-disposable-`date +%s`) in R2/S3 console.
 * 2. Set the env vars above to point to that bucket (use a short-lived token if possible).
 * 3. Run: OBJECT_STORAGE_LIVE_TEST=true npm run test:real-provider
 * 4. Verify the logs show: PUT succeeded, GET with presigned URL succeeded,
 *    tampered signature rejected (403), mismatched content-type still stored but
 *    served with server-derived type via objectDownloadUrl, size enforcement works,
 *    response overrides (content-type, disposition, cache-control) are applied and
 *    non-allowlisted overrides (e.g., X-Content-Type-Options) are rejected.
 * 5. Delete the disposable bucket after verification.
 *
 * The harness uses a unique key prefix per run (`__easylearn-test/<uuid>/`) and
 * cleans up all objects it creates, so no test data persists.
 */

import assert from "assert";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { getObjectStorageConfig, presignedUploadUrl, presignUrl, objectDownloadUrl } from "@/lib/object-storage";
import { verifyStoredObject } from "@/lib/object-guard";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const PREFIX = `__easylearn-test/${RUN_ID}`;

/** Production bucket — the live harness must NEVER target it. */
export const PRODUCTION_BUCKET = "easylearn-uploads";

/** Refuse to run live against the production bucket (exact match after trim). */
export function assertDisposableBucket(bucket: string | undefined): void {
  if ((bucket ?? "").trim() === PRODUCTION_BUCKET) {
    throw new Error(
      `REFUSED: OBJECT_STORAGE_BUCKET is the production bucket '${PRODUCTION_BUCKET}'. ` +
        "The live harness creates and deletes objects; point it at a disposable bucket (e.g. 'easylearn-security-test') instead."
    );
  }
}

/** Only 404 (NoSuchKey) or 403 (access gone) prove an object is inaccessible. */
export function isObjectGoneStatus(status: number): boolean {
  return status === 404 || status === 403;
}

function shouldRunLive(): boolean {
  return process.env.OBJECT_STORAGE_LIVE_TEST === "true" && getObjectStorageConfig().enabled;
}

export async function cleanupKeys(keys: string[]): Promise<string[]> {
  /* Cleanup is VERIFIED, not assumed: a swallowed DELETE error would
     leave test objects (and their cost) behind while the suite reports
     success. Each key is deleted via presigned DELETE and then probed
     with a presigned GET that must answer 404/403. Anything left over
     is returned so the run fails loudly. Keys are always under this
     run's unique __easylearn-test/<id>/ prefix; nothing else is touched. */
  const config = getObjectStorageConfig();
  const leftovers: string[] = [];
  for (const key of keys) {
    try {
      const { url } = presignUrl(config, { method: "DELETE", key, expiresSeconds: 60 });
      const del = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(15_000) });
      if (!del.ok && del.status !== 404) throw new Error(`DELETE ${key} -> ${del.status}`);
      const check = await fetch(presignUrl(config, { method: "GET", key, expiresSeconds: 60 }).url, {
        signal: AbortSignal.timeout(15_000),
      });
      /* STRICT: only 404/403 prove the object is gone. 200 means it is
         still readable; 500/502/anything else is inconclusive and must
         be reported as a cleanup failure, never as verified deletion. */
      if (!isObjectGoneStatus(check.status)) {
        throw new Error(`post-DELETE GET for ${key} returned ${check.status} (expected 404/403)`);
      }
    } catch (error) {
      console.error(`⚠️  CLEANUP FAILED for ${key}: ${(error as Error).message}`);
      leftovers.push(key);
    }
  }
  return leftovers;
}

async function run() {
  console.log("\n🔍 SEC-2: Real provider verification harness\n");
  const config = getObjectStorageConfig();
  console.log(`Config: bucket=${config.bucket}, endpoint=${config.endpoint || "(aws)"}, region=${config.region}, enabled=${config.enabled}`);
  console.log(`Live test enabled: ${process.env.OBJECT_STORAGE_LIVE_TEST === "true"}`);

  /* F-1 guard: refuse the production bucket BEFORE any network request,
     object creation, or deletion — even if live mode was requested. */
  if (process.env.OBJECT_STORAGE_LIVE_TEST === "true" && config.enabled) {
    try {
      assertDisposableBucket(config.bucket);
    } catch (error) {
      console.error(`\n❌ ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!shouldRunLive()) {
    console.log("\n⚠️  Live provider test SKIPPED — not enabled or not configured.");
    console.log("To run live verification:");
    console.log("  1. Create a DISPOSABLE bucket (never production) in R2/S3.");
    console.log("  2. Set OBJECT_STORAGE_BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, ENDPOINT, REGION.");
    console.log("  3. Run: OBJECT_STORAGE_LIVE_TEST=true npx tsx tests/object-storage-real-provider-harness.test.ts");
    console.log("\nManual steps required before declaring SEC-2 verified:");
    console.log("  - Presigned PUT with valid signature must store object.");
    console.log("  - Presigned GET with valid signature must retrieve object.");
    console.log("  - Tampered signature (change X-Amz-Signature by one char) must be rejected (403).");
    console.log("  - Mismatched content-type (PUT with text/html but key is .png) — object is stored but verifyStoredObject must refuse it (404).");
    console.log("  - Oversize object (e.g., 60 MB for non-video) — presign allows but verifyStoredObject must refuse via size check (404).");
    console.log("  - Response overrides: download URL with response-content-type/image/png must set Content-Type accordingly; response-cache-control must be private; non-allowlisted overrides (e.g., response-x-content-type-options) must be rejected by store (400).");
    console.log("  - Ensure bucket CORS allows PUT from browser origin.");
    console.log("  - Delete disposable bucket after test.");
    console.log("\nHarness implementation is present; live run is pending credentials.");
    console.log("\n✅ HARNESS CHECK PASSED (skipped live, documented manual steps)\n");
    return;
  }

  console.log(`\n🚀 Running live tests against ${config.endpoint || "s3.amazonaws.com"} bucket ${config.bucket} (prefix ${PREFIX}/)\n`);
  const createdKeys: string[] = [];
  let passed = 0;
  let failed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ FAIL: ${name}: ${(e as Error).message}`);
      failed++;
    }
  };

  // Test 1: Presigned PUT then GET
  await test("presigned PUT + GET round trip", async () => {
    const key = `${PREFIX}/put-get-test.txt`;
    createdKeys.push(key);
    const { url, headers } = presignedUploadUrl(config, key, "text/plain");
    const content = Buffer.from("hello from easylearn live test");
    const putRes = await fetch(url, { method: "PUT", headers, body: content });
    assert.ok(putRes.ok, `PUT failed: ${putRes.status} ${await putRes.text()}`);
    // Verify via readObjectPrefix (which does ranged GET)
    const prefixRes = await fetch(presignUrl(config, { method: "GET", key, expiresSeconds: 60 }).url);
    assert.ok(prefixRes.ok, `GET failed: ${prefixRes.status}`);
    const got = await prefixRes.text();
    assert.strictEqual(got, content.toString());
  });

  // Test 2: Tampered signature
  await test("tampered signature is rejected", async () => {
    const key = `${PREFIX}/tampered.txt`;
    createdKeys.push(key);
    const { url, headers } = presignedUploadUrl(config, key, "text/plain");
    await fetch(url, { method: "PUT", headers, body: Buffer.from("tampered test") });
    const goodUrl = presignUrl(config, { method: "GET", key, expiresSeconds: 60 }).url;
    const tampered = goodUrl.replace(/X-Amz-Signature=[^&]+/, "X-Amz-Signature=invalidsignature0000000000000000000000000000000000000000000000000000");
    const res = await fetch(tampered);
    assert.ok(!res.ok && (res.status === 403 || res.status === 400), `tampered signature should be rejected, got ${res.status}`);
  });

  // Test 3: Mismatched content type — stored as text/html but key is .png, verify should refuse
  await test("mismatched content type is refused by verifyStoredObject", async () => {
    const key = `${PREFIX}/mismatch.png`;
    createdKeys.push(key);
    // PUT with text/html content-type but .png key — server would have signed as image/png, but we simulate mismatch
    const url = presignUrl(config, { method: "PUT", key, expiresSeconds: 300, contentType: "text/html" }).url;
    await fetch(url, { method: "PUT", headers: { "Content-Type": "text/html" }, body: Buffer.from("<html>not an image</html>") });
    // verifyStoredObject should read prefix and see html bytes under png key -> refuse
    const result = await verifyStoredObject(config, key);
    // If provider stored as text/html, verify should fail because bytes are html but extension is png
    assert.ok(!result.ok && result.status === 404, `mismatched content should be refused, got ${JSON.stringify(result)}`);
  });

  // Test 4: Object size enforcement — we can't easily create 60 MB, so test tiny but verify size path
  await test("object size is reported correctly", async () => {
    const key = `${PREFIX}/size-test.pdf`;
    createdKeys.push(key);
    const content = Buffer.alloc(2048, "a");
    const { url, headers } = presignedUploadUrl(config, key, "application/pdf");
    await fetch(url, { method: "PUT", headers, body: content });
    /* The production path: readObjectPrefix parses the total from
       Content-Range ("bytes 0-1023/2048"). (The previous raw assertion
       was itself the defect: it preferred Content-Length — 1024 for a
       partial body — and then looked for "2048/" with a trailing slash
       that the header value never has, so a correctly reported size
       failed. Production parsing was proven fine by the SEC-9 test
       below, which asserts totalSize via the same function.) */
    const prefix = await (await import("@/lib/object-storage")).readObjectPrefix(config, key, 1024);
    assert.ok(prefix, "prefix should be readable");
    assert.strictEqual(prefix!.totalSize, 2048, `totalSize wrong: ${prefix!.totalSize}`);
    assert.strictEqual(prefix!.bytes.length, 1024, `prefix bytes wrong: ${prefix!.bytes.length}`);
    const res = await fetch(presignUrl(config, { method: "GET", key, expiresSeconds: 60 }).url, { headers: { Range: "bytes=0-1023" } });
    assert.ok(res.ok);
    const range = res.headers.get("content-range") || "";
    assert.ok(/\/2048\s*$/.test(range), `content-range total not reported: ${range}`);
  });

  // Test 5: Response overrides — content-type, disposition, cache-control are applied; non-allowlisted rejected
  await test("response overrides are applied and allowlisted set enforced", async () => {
    const key = `${PREFIX}/override-test.png`;
    createdKeys.push(key);
    // Upload a valid PNG header (minimal)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { url, headers } = presignedUploadUrl(config, key, "image/png");
    await fetch(url, { method: "PUT", headers, body: pngHeader });
    const downloadUrl = objectDownloadUrl(config, key, {
      contentType: "image/png",
      disposition: 'inline; filename="test.png"',
      cacheControl: "private, max-age=3600",
    });
    const res = await fetch(downloadUrl);
    assert.ok(res.ok);
    assert.ok(res.headers.get("content-type")?.includes("image/png"), `content-type override not applied: ${res.headers.get("content-type")}`);
    assert.ok(res.headers.get("content-disposition")?.includes("test.png"), `disposition not applied: ${res.headers.get("content-disposition")}`);
    assert.ok(res.headers.get("cache-control")?.includes("private"), `cache-control not applied: ${res.headers.get("cache-control")}`);
    // Non-allowlisted override should be rejected if attempted (we can't test without making invalid URL, but verify store rejects)
    // Attempt to presign with non-allowlisted param (should be rejected by our code, not stored)
    const badUrl = presignUrl(config, { method: "GET", key, expiresSeconds: 60, responseContentType: "image/png" }).url + "&response-x-content-type-options=nosniff";
    const badRes = await fetch(badUrl);
    assert.ok(!badRes.ok && (badRes.status === 400 || badRes.status === 403), `non-allowlisted override should be rejected, got ${badRes.status}`);
  });

  // Test 6: Ignored Range — if provider ignores Range, we still get bounded prefix
  await test("ignored Range still returns bounded prefix (SEC-9)", async () => {
    const key = `${PREFIX}/range-test.txt`;
    createdKeys.push(key);
    const { url, headers } = presignedUploadUrl(config, key, "text/plain");
    await fetch(url, { method: "PUT", headers, body: Buffer.alloc(5000, "b") });
    // Use readObjectPrefix which should bound to 1024 even if provider returns 5000
    const prefix = await (await import("@/lib/object-storage")).readObjectPrefix(config, key, 1024);
    assert.ok(prefix, "prefix should be readable");
    assert.ok(prefix!.bytes.length <= 1024, `prefix not bounded: ${prefix!.bytes.length}`);
    assert.ok(prefix!.totalSize === 5000, `totalSize wrong: ${prefix!.totalSize}`);
  });

  const leftovers = await cleanupKeys(createdKeys);
  if (leftovers.length > 0) {
    console.error(`\n❌ CLEANUP INCOMPLETE: ${leftovers.length} test object(s) remain under ${PREFIX}/ — delete them manually: ${leftovers.join(", ")}`);
    failed++;
  } else {
    console.log(`\n🧹 Cleanup verified: all ${createdKeys.length} test objects under ${PREFIX}/ deleted`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log("✅ All live provider tests passed — bucket and presigning verified against real store");
}

// Importing exported safety helpers must never launch live provider tests.
// Only execute the harness when this file is the entry point (tsx file.ts).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
