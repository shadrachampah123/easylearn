/**
 * Upload regression tests for the mobile upload failure.
 *
 * Two production defects are pinned here, against the REAL code — not a copy of its
 * logic:
 *
 * 1. `Bearer null` — a browser that interpolated a missing credential used to send the
 *    literal header `Authorization: Bearer null`. The parser in `src/lib/auth.ts`
 *    accepted any non-empty bearer value, returned the string "null" as the token, and
 *    never consulted the session cookie, so a valid cookie session became a 401.
 *    Safari's ITP clears script-writable storage far more aggressively than cookies,
 *    which is why this hit mobile only, and why the cookie fallback is the fix.
 *
 * 2. Opaque 500 — on a read-only filesystem (what a serverless bundle presents) the
 *    multipart path could never store the file, and the failure surfaced as a generic
 *    500. `POST /api/uploads` now probes writability and refuses that case (409)
 *    instead of attempting an impossible disk write. The guard must sit AFTER
 *    authentication so an anonymous caller still gets a plain 401, and it must be
 *    NON-MUTATING because it runs before the upload is authorized. Note that object
 *    storage being configured is NOT itself a reason to refuse: a deployment may have
 *    a bucket and a writable disk, where the local path is still valid.
 *
 * The client-side helpers that once lived in `src/lib/upload-mode.ts` are deliberately
 * NOT tested: the browser now authenticates with the `httpOnly` cookie through
 * `apiFetch` and sends no `Authorization` header at all, so those helpers were removed.
 *
 * Run: npx tsx tests/upload-mode-regression.test.ts
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { getTokenFromRequest } from "@/lib/auth";
import { MULTIPART_DISABLED_MESSAGE, describeUploadFailure } from "@/lib/upload-mode";

const REPO_ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${(error as Error).message}`);
    failed += 1;
  }
}

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

console.log("📝 Upload-path regression tests (mobile Bearer/cookie + server guard)\n");

/* ── 1. Token handling ──
   Exercises the REAL parser in src/lib/auth.ts. */

const requestWith = (headers: Record<string, string>) =>
  new Request("http://localhost/api/uploads", { headers });

test("Bearer null must NOT be treated as a credential — the cookie must win", () => {
  /* The exact header a browser produced from `Bearer ${token}` when the token was null. */
  const token = getTokenFromRequest(
    requestWith({ authorization: "Bearer null", cookie: "el_token=SESSION_FROM_COOKIE" })
  );
  assert.strictEqual(
    token,
    "SESSION_FROM_COOKIE",
    "a placeholder bearer value must fall through to the cookie, otherwise a valid mobile session 401s"
  );
});

test("Bearer undefined / blank / whitespace placeholders also fall through", () => {
  for (const value of ["Bearer undefined", "Bearer  ", "Bearer\t"]) {
    const token = getTokenFromRequest(
      requestWith({ authorization: value, cookie: "el_token=COOKIE" })
    );
    assert.strictEqual(token, "COOKIE", `"${value}" must not shadow the cookie`);
  }
});

test("a real bearer token still takes precedence over the cookie", () => {
  const token = getTokenFromRequest(
    requestWith({ authorization: "Bearer REAL_TOKEN", cookie: "el_token=OTHER" })
  );
  assert.strictEqual(token, "REAL_TOKEN", "the documented non-browser bearer path must keep working");
});

test("no credential at all yields null (fail closed)", () => {
  assert.strictEqual(getTokenFromRequest(requestWith({})), null);
  assert.strictEqual(
    getTokenFromRequest(requestWith({ authorization: "Bearer null" })),
    null,
    "placeholder bearer with no cookie must authenticate nothing"
  );
});

/* ── 2. Server-side object-storage guard ──
   Source-level, so it runs without a database or a bucket. */

const uploadsRoute = read("src/app/api/uploads/route.ts");
const postBody = uploadsRoute.slice(uploadsRoute.indexOf("export async function POST"));

test("object storage makes the multipart endpoint refuse the disk path (409)", () => {
  assert.ok(
    postBody.includes("isObjectStorageEnabled()"),
    "the route must ask whether object storage is configured"
  );
  assert.ok(
    postBody.includes("MULTIPART_DISABLED_MESSAGE"),
    "the refusal must carry the actionable message, not a generic one"
  );
  assert.ok(
    /MULTIPART_DISABLED_MESSAGE,\s*409/.test(postBody),
    "the refusal must be a 409 Conflict, not a 500"
  );
});

test("the disk-path guard runs AFTER authentication (anonymous callers still get 401)", () => {
  const guardAt = postBody.indexOf("guardSchoolContext(");
  const storageAt = postBody.indexOf("isObjectStorageEnabled()");
  assert.ok(guardAt >= 0, "POST must authenticate with guardSchoolContext");
  assert.ok(storageAt >= 0, "POST must check the storage backend");
  assert.ok(
    guardAt < storageAt,
    "the storage guard must follow authentication, so an anonymous request is answered with 401 and learns nothing about the deployment's storage configuration"
  );
});

test("the route no longer logs the raw error object", () => {
  assert.ok(
    !uploadsRoute.includes('console.error("Upload error:", error)'),
    "raw error logging can leak driver messages, paths and connection strings"
  );
  assert.ok(
    postBody.includes("describeUploadFailure("),
    "both failure paths must use the safe diagnostic helper"
  );
  const uses = postBody.match(/console\.error\(describeUploadFailure\(/g) || [];
  assert.ok(uses.length >= 2, `expected both catches to log safely, found ${uses.length}`);
});

/* ── 3. Messages and safe diagnostics ── */

test("the multipart-unavailable message is actionable", () => {
  assert.ok(MULTIPART_DISABLED_MESSAGE.includes("cloud object storage"));
  assert.ok(
    /unavailable|retry/i.test(MULTIPART_DISABLED_MESSAGE),
    "the message must tell the user what to do"
  );
  assert.ok(
    !/could not be uploaded/i.test(MULTIPART_DISABLED_MESSAGE),
    "the old opaque sentence must not be reused"
  );
});

test("describeUploadFailure reports a code without leaking messages or values", () => {
  const error = Object.assign(
    new Error("EROFS: read-only file system, open '/var/task/storage/uploads/x'"),
    { name: "Error", code: "EROFS" }
  );
  const line = describeUploadFailure(error, { backend: "local", fileCount: 2 });
  assert.ok(line.includes("code=EROFS"), "the syscall code is the whole point of the diagnostic");
  assert.ok(line.includes("backend=local"));
  assert.ok(line.includes("files=2"));
  assert.ok(!line.includes("/var/task"), "filesystem paths must not be logged");
  assert.ok(!line.includes("read-only file system"), "raw driver messages must not be logged");
});

test("describeUploadFailure tolerates a thrown non-Error value", () => {
  const line = describeUploadFailure("boom", { backend: "local", fileCount: 1 });
  assert.ok(line.includes("code=UNKNOWN"));
  assert.ok(!line.includes("boom"), "a non-Error payload must not be stringified into the log");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
