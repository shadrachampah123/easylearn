/**
 * The object-storage upload and download path.
 *
 * PR #40 changed this path — the presigned PUT is now bound to the server's
 * content type, and the download forces the server-determined content type
 * and a safe disposition onto the object store's own response — but it left
 * the path with NO automated coverage at all. These tests are that coverage.
 *
 * The path matters because the bytes go straight from the browser to the
 * bucket: the server never sees them, so the only thing that stands between
 * an uploaded file and a scriptable response is what the server decides here.
 *
 * The three properties that must hold:
 *
 *   1. The content type bound into the signed PUT is the SERVER's, derived
 *      from the extension allow-list — never the type the client declared.
 *   2. The download URL forces the server-determined content type and the
 *      safe disposition onto the object store's response, and both are
 *      SIGNED, so they cannot be swapped out by whoever holds the URL.
 *   3. A client that declares a scriptable content type is refused.
 *
 * These are unit tests: they do not need a database or a running server.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import {
  getObjectStorageConfig,
  newObjectKey,
  objectDownloadUrl,
  presignedUploadUrl,
  presignUrl,
  readObjectPrefix,
} from "@/lib/object-storage";
import { ruleForExtension, SCRIPTABLE_CONTENT_TYPES } from "@/lib/upload-content";

const REPO_ROOT = path.join(__dirname, "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    });
}

const CONFIG = {
  enabled: true,
  bucket: "easylearn-test",
  endpoint: "https://s3.example.test",
  region: "auto",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  forcePathStyle: true,
  publicBaseUrl: undefined as string | undefined,
  uploadExpirySeconds: 900,
  downloadExpirySeconds: 3600,
};

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

/** The signature of a presigned URL, or null when there is none. */
function signatureOf(url: string): string | null {
  const match = /[?&]X-Amz-Signature=([^&]+)/.exec(url);
  return match ? match[1] : null;
}

/** The query parameters of a URL. */
function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

async function main() {
  console.log("☁️  Running object-storage content-policy tests\n");

  /* ── 1. The download URL forces the server's type and disposition ─────── */
  await test("The download URL forces the content type onto the object store's response", () => {
    const url = objectDownloadUrl(CONFIG, "uploads/assignment/file.png", {
      contentType: "image/png",
      disposition: 'inline; filename="file.png"',
    });
    const query = queryOf(url);
    assert.strictEqual(query.get("response-content-type"), "image/png");
    assert.match(query.get("response-content-disposition") || "", /^inline;/);
  });

  await test("The download URL carries no overrides when none are given", () => {
    const url = objectDownloadUrl(CONFIG, "uploads/assignment/file.png");
    const query = queryOf(url);
    assert.strictEqual(query.get("response-content-type"), null);
    assert.strictEqual(query.get("response-content-disposition"), null);
  });

  await test("The response-header overrides are SIGNED, so they cannot be swapped out", () => {
    const withOverrides = presignUrl(CONFIG, {
      method: "GET",
      key: "uploads/assignment/file.png",
      expiresSeconds: 3600,
      responseContentType: "image/png",
      responseContentDisposition: "attachment; filename=\"file.png\"",
      now: FIXED_NOW,
    }).url;
    const withoutOverrides = presignUrl(CONFIG, {
      method: "GET",
      key: "uploads/assignment/file.png",
      expiresSeconds: 3600,
      now: FIXED_NOW,
    }).url;

    assert.ok(signatureOf(withOverrides), "the signed URL must carry a signature");
    assert.notStrictEqual(
      signatureOf(withOverrides),
      signatureOf(withoutOverrides),
      "changing the response-header overrides must change the signature"
    );

    /* And the parameters are part of the canonical query string, not appended
       after the signature. */
    const query = queryOf(withOverrides);
    assert.strictEqual(query.get("response-content-type"), "image/png");
    assert.ok(
      withOverrides.indexOf("response-content-type") < withOverrides.indexOf("X-Amz-Signature"),
      "the overrides must be inside the signed part of the URL"
    );
  });

  await test("A public bucket URL carries the overrides as query parameters too", () => {
    const url = objectDownloadUrl(
      { ...CONFIG, publicBaseUrl: "https://cdn.example.test/" },
      "uploads/assignment/file.png",
      { contentType: "image/png", disposition: "attachment; filename=\"file.png\"", allowPublic: true }
    );
    assert.ok(url.startsWith("https://cdn.example.test/uploads/assignment/file.png?"));
    const query = queryOf(url);
    assert.strictEqual(query.get("response-content-type"), "image/png");
    assert.match(query.get("response-content-disposition") || "", /^attachment;/);
  });

  /* ── 2. The signed PUT carries the server's content type ──────────────── */
  await test("The signed PUT binds the content type it is given", () => {
    const presigned = presignedUploadUrl(CONFIG, "uploads/assignment/file.png", "image/png");
    assert.strictEqual(presigned.headers["Content-Type"], "image/png");
    assert.match(
      queryOf(presigned.url).get("X-Amz-SignedHeaders") || "",
      /content-type/,
      "the content type must be part of the signed headers"
    );
  });

  await test("The signed PUT's signature depends on the content type", () => {
    const png = presignedUploadUrl(CONFIG, "uploads/assignment/file.png", "image/png").url;
    const html = presignedUploadUrl(CONFIG, "uploads/assignment/file.png", "text/html").url;
    assert.notStrictEqual(
      signatureOf(png),
      signatureOf(html),
      "a different content type must produce a different signature"
    );
  });

  /* ── 3. The object key keeps the validated extension ──────────────────── */
  await test("The object key ends in the extension the allow-list accepted", () => {
    assert.match(newObjectKey("assignment", "png"), /\.png$/);
    assert.match(newObjectKey("submission", "mp4"), /\.mp4$/);
    assert.ok(
      !newObjectKey("assignment", "").includes("."),
      "a file with no extension must not produce a key with a trailing dot"
    );
  });

  /* ── 4. The presign route uses the SERVER's type ──────────────────────── */
  await test("The presign route derives the content type from the allow-list", () => {
    const source = read("src/app/api/uploads/presign/route.ts");
    assert.ok(source.includes("ruleForExtension"), "the allow-list must decide the type");
    assert.ok(
      /const contentType = rule\.contentType;/.test(source),
      "the bound content type must be the allow-list's"
    );
    assert.ok(
      !/const contentType = mimeType/.test(source),
      "the bound content type must not come from the client"
    );
    assert.ok(
      /presignedUploadUrl\(config, key, contentType\)/.test(source),
      "the server's content type must be the one that is signed into the PUT"
    );
  });

  await test("The presign route refuses a client that declares a scriptable type", () => {
    const source = read("src/app/api/uploads/presign/route.ts");
    assert.ok(source.includes("SCRIPTABLE_CONTENT_TYPES"), "the scriptable types must be checked");
    for (const type of SCRIPTABLE_CONTENT_TYPES) {
      assert.ok(type.length > 0);
    }
    assert.ok(
      /SCRIPTABLE_CONTENT_TYPES\.has\(declaredType\)/.test(source),
      "the declared type must be refused when it is scriptable"
    );
  });

  await test("The presign route refuses an extension that is not on the allow-list", () => {
    const source = read("src/app/api/uploads/presign/route.ts");
    assert.ok(
      /const rule = ruleForExtension\(extension\);/.test(source) &&
        /if \(!rule\)/.test(source),
      "an extension that is not on the allow-list must be refused"
    );
  });

  /* ── 5. The file route's object-storage redirect carries the overrides ── */
  await test("The file route's object-storage redirect forces the type and disposition", () => {
    const source = read("src/app/api/files/[id]/route.ts");
    assert.ok(
      /objectDownloadUrl\(config, row\.storedName, \{/.test(source),
      "the redirect must pass the type and disposition to the download URL"
    );
    assert.ok(
      /contentType,\s*\n\s*disposition,/.test(source),
      "both the content type and the disposition must be passed"
    );
  });

  await test("The file route does not serve the stored mime_type column", () => {
    const source = read("src/app/api/files/[id]/route.ts");
    assert.ok(
      !/row\.mimeType/.test(source),
      "the stored mime_type column must not be used to decide what is served"
    );
  });

  /* ── 6. The configuration ─────────────────────────────────────────────── */
  await test("Object storage is disabled unless the bucket and the keys are all set", () => {
    const previous = {
      bucket: process.env.OBJECT_STORAGE_BUCKET,
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    };
    try {
      delete process.env.OBJECT_STORAGE_BUCKET;
      delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
      delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
      assert.strictEqual(getObjectStorageConfig().enabled, false);

      process.env.OBJECT_STORAGE_BUCKET = "b";
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "k";
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "s";
      assert.strictEqual(getObjectStorageConfig().enabled, true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  await test("No allow-listed extension is served with a scriptable content type", () => {
    for (const extension of ["png", "jpg", "pdf", "txt", "mp4", "zip", "mp3"]) {
      const rule = ruleForExtension(extension);
      assert.ok(rule, `.${extension} must be on the allow-list`);
      assert.ok(
        !SCRIPTABLE_CONTENT_TYPES.has(rule.contentType.split(";")[0].trim()),
        `.${extension} must not be served with a scriptable type`
      );
    }
  });

  await test("readObjectPrefix reports totalSize from Content-Range (R2 'bytes 0-1023/2048')", async () => {
    /* Regression for the live-harness failure: R2 answers a ranged GET
       with Content-Length: 1024 (partial body) and
       Content-Range: bytes 0-1023/2048. The total lives after the slash
       at the END of Content-Range. A previous live assertion looked for
       "2048/" and failed on a correctly reported size; the production
       parser must yield 2048. Mocked fetch: no network, no credentials. */
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.alloc(1024, "a"), {
        status: 206,
        headers: {
          "Content-Length": "1024",
          "Content-Range": "bytes 0-1023/2048",
          "Content-Type": "application/pdf",
        },
      })) as typeof fetch;
    try {
      const prefix = await readObjectPrefix(CONFIG, "uploads/size-test.pdf", 1024);
      assert.ok(prefix, "prefix must be returned");
      assert.strictEqual(prefix.totalSize, 2048, "totalSize must come from Content-Range");
      assert.strictEqual(prefix.bytes.length, 1024, "prefix must be bounded to maxBytes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} object-storage content-policy tests passed`);
}

main().catch((error: unknown) => {
  console.error("Object-storage suite failed to run:", error);
  process.exitCode = 1;
});
