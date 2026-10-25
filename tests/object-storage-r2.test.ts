/**
 * Cloudflare R2 / S3-compatible object-storage configuration and presigning tests.
 *
 * These are pure unit tests: no network, no database, no credentials. They pin the
 * behaviour the upload path depends on, so a change to the hand-rolled SigV4 presigner
 * or to the environment-variable contract fails loudly instead of quietly returning
 * URLs that R2 rejects with `SignatureDoesNotMatch`.
 *
 * The known-answer signatures below were independently reproduced with AWS's own
 * signing primitives (`@smithy/signature-v4`) given the same parameter set, and with
 * `@aws-sdk/s3-request-presigner` once all query parameters matched. They are not
 * self-referential: if canonicalisation, encoding or the signing key derivation
 * changes, these values change and the test fails.
 *
 * Run: npx tsx tests/object-storage-r2.test.ts
 */
import assert from "assert";
import {
  getObjectStorageConfig,
  presignedUploadUrl,
  presignUrl,
  objectDownloadUrl,
  newObjectKey,
  type ObjectStorageConfig,
} from "@/lib/object-storage";

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

/* ── Environment harness ──────────────────────────────────────────────────────
   Every test starts from a clean slate: leaked variables from one case must never
   make the next one pass. */

const MANAGED = [
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_FORCE_PATH_STYLE",
  "OBJECT_STORAGE_PUBLIC_URL",
  "OBJECT_STORAGE_UPLOAD_EXPIRY",
  "OBJECT_STORAGE_DOWNLOAD_EXPIRY",
] as const;

function withEnv(values: Partial<Record<(typeof MANAGED)[number], string>>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, values);
  try {
    fn();
  } finally {
    for (const key of MANAGED) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

/* A fixed clock so presigned URLs are reproducible. */
const FIXED_NOW = new Date("2026-10-22T20:18:35.000Z");

const R2 = {
  OBJECT_STORAGE_BUCKET: "easylearn-files",
  OBJECT_STORAGE_ENDPOINT: "https://abc123accountid.r2.cloudflarestorage.com",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secretEXAMPLEkey",
} as const;

const KEY = "uploads/assignment/1111-2222.pdf";

function signatureOf(url: string): string {
  const value = new URL(url).searchParams.get("X-Amz-Signature");
  assert.ok(value, "presigned URL must carry X-Amz-Signature");
  return value as string;
}

console.log("📝 Object storage (Cloudflare R2) configuration + presigning tests\n");

/* ── 1. Environment-variable contract ── */

test("R2: bucket + endpoint + access key + secret enable object storage", () => {
  withEnv(R2, () => {
    const config = getObjectStorageConfig();
    assert.strictEqual(config.enabled, true, "all three required variables are present");
    assert.strictEqual(config.bucket, "easylearn-files");
    assert.strictEqual(config.endpoint, "https://abc123accountid.r2.cloudflarestorage.com");
    assert.strictEqual(config.accessKeyId, "AKIDEXAMPLE");
    assert.strictEqual(config.secretAccessKey, "secretEXAMPLEkey");
  });
});

test("R2: storage stays disabled when ANY of the three required variables is missing", () => {
  for (const missing of [
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ACCESS_KEY_ID",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  ] as const) {
    withEnv({ ...R2, [missing]: "" }, () => {
      assert.strictEqual(
        getObjectStorageConfig().enabled,
        false,
        `${missing} missing must disable storage (the presign route then answers 503)`
      );
    });
  }
});

test("R2: endpoint implies region 'auto' and path-style addressing", () => {
  withEnv({ ...R2, OBJECT_STORAGE_REGION: "" }, () => {
    const config = getObjectStorageConfig();
    assert.strictEqual(config.region, "auto", "R2 must sign with region 'auto'");
    assert.strictEqual(config.forcePathStyle, true, "R2 speaks path-style");
  });
});

test("AWS S3 (no endpoint): virtual-hosted style and us-east-1 by default", () => {
  withEnv(
    {
      OBJECT_STORAGE_BUCKET: "easylearn-files",
      OBJECT_STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "secretEXAMPLEkey",
    },
    () => {
      const config = getObjectStorageConfig();
      assert.strictEqual(config.region, "us-east-1");
      assert.strictEqual(config.forcePathStyle, false);
      const url = presignedUploadUrl(config, KEY, "application/pdf").url;
      assert.ok(
        url.startsWith("https://easylearn-files.s3.us-east-1.amazonaws.com/"),
        `expected virtual-hosted style, got ${url}`
      );
    }
  );
});

test("explicit region and FORCE_PATH_STYLE override the R2 defaults", () => {
  withEnv({ ...R2, OBJECT_STORAGE_REGION: "us-west-2", OBJECT_STORAGE_FORCE_PATH_STYLE: "false" }, () => {
    const config = getObjectStorageConfig();
    assert.strictEqual(config.region, "us-west-2");
    assert.strictEqual(config.forcePathStyle, false);
  });
});

test("values pasted with surrounding quotes and whitespace are tolerated", () => {
  withEnv(
    {
      OBJECT_STORAGE_BUCKET: ' "easylearn-files" ',
      OBJECT_STORAGE_ENDPOINT: '"https://abc123accountid.r2.cloudflarestorage.com/"',
      OBJECT_STORAGE_ACCESS_KEY_ID: " 'AKIDEXAMPLE' ",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: ' "secretEXAMPLEkey" ',
      OBJECT_STORAGE_REGION: '"auto"',
    },
    () => {
      const config = getObjectStorageConfig();
      assert.strictEqual(config.enabled, true);
      assert.strictEqual(config.bucket, "easylearn-files");
      assert.strictEqual(config.accessKeyId, "AKIDEXAMPLE");
      assert.strictEqual(config.secretAccessKey, "secretEXAMPLEkey");
      assert.strictEqual(
        config.endpoint,
        "https://abc123accountid.r2.cloudflarestorage.com",
        "a trailing slash on the endpoint would produce /bucket/bucket/key"
      );
    }
  );
});

test("expiry values: defaults, override, and invalid input falls back", () => {
  withEnv(R2, () => {
    const config = getObjectStorageConfig();
    assert.strictEqual(config.uploadExpirySeconds, 900);
    assert.strictEqual(config.downloadExpirySeconds, 3600);
  });
  withEnv({ ...R2, OBJECT_STORAGE_UPLOAD_EXPIRY: "120", OBJECT_STORAGE_DOWNLOAD_EXPIRY: "60" }, () => {
    const config = getObjectStorageConfig();
    assert.strictEqual(config.uploadExpirySeconds, 120);
    assert.strictEqual(config.downloadExpirySeconds, 60);
  });
  withEnv({ ...R2, OBJECT_STORAGE_UPLOAD_EXPIRY: "not-a-number", OBJECT_STORAGE_DOWNLOAD_EXPIRY: "-5" }, () => {
    const config = getObjectStorageConfig();
    assert.strictEqual(config.uploadExpirySeconds, 900, "invalid expiry falls back to the default");
    assert.strictEqual(config.downloadExpirySeconds, 3600, "non-positive expiry falls back to the default");
  });
});

/* ── 2. URL shape ── */

test("R2: the signed PUT URL is path-style /<bucket>/<key>", () => {
  withEnv(R2, () => {
    const { url } = presignedUploadUrl(getObjectStorageConfig(), KEY, "application/pdf");
    assert.strictEqual(
      new URL(url).pathname,
      "/easylearn-files/uploads/assignment/1111-2222.pdf",
      "R2 expects the bucket as the first path segment"
    );
  });
});

test("the object key is RFC3986-encoded segment by segment (slashes preserved)", () => {
  withEnv(R2, () => {
    const config = getObjectStorageConfig();
    const url = presignedUploadUrl(config, "uploads/assignment/a b+c.pdf", "application/pdf").url;
    assert.strictEqual(
      new URL(url).pathname,
      "/easylearn-files/uploads/assignment/a%20b%2Bc.pdf",
      "spaces become %20 and '+' becomes %2B; the separators themselves stay literal"
    );
    const unicode = presignedUploadUrl(config, "uploads/assignment/café-日本.pdf", "application/pdf").url;
    assert.strictEqual(new URL(unicode).pathname, "/easylearn-files/uploads/assignment/caf%C3%A9-%E6%97%A5%E6%9C%AC.pdf");
  });
});

/* ── 3. Known-answer signatures ───────────────────────────────────────────────
   Fixed clock + fixed credentials. These exact digests were reproduced with AWS's
   own signing implementation for the same parameter set. */

test("known answer: presigned PUT signature is stable (R2, content-type signed)", () => {
  withEnv(R2, () => {
    const { url } = presignUrl(getObjectStorageConfig(), {
      method: "PUT",
      key: KEY,
      expiresSeconds: 900,
      contentType: "application/pdf",
      now: FIXED_NOW,
    });
    assert.strictEqual(
      signatureOf(url),
      "4afc73f2908f7b17a6436763d1cd1ad6e87c8a618f9f91545f86879388419308",
      "SigV4 canonicalisation changed — verify against the AWS SDK before updating this value"
    );
  });
});

test("known answer: presigned GET signature is stable (R2)", () => {
  withEnv(R2, () => {
    const { url } = presignUrl(getObjectStorageConfig(), {
      method: "GET",
      key: KEY,
      expiresSeconds: 3600,
      now: FIXED_NOW,
    });
    assert.strictEqual(
      signatureOf(url),
      "17e2b8aaaae99db056f593636707354580b2f87da9ffc5f2dfb57e1d49a00e6e",
      "SigV4 canonicalisation changed — verify against the AWS SDK before updating this value"
    );
  });
});

/* ── 4. Signing contract the browser must honour ── */

test("PUT signs content-type, and returns the exact header the client must echo", () => {
  withEnv(R2, () => {
    const { url, headers } = presignedUploadUrl(getObjectStorageConfig(), KEY, "video/mp4");
    assert.strictEqual(
      new URL(url).searchParams.get("X-Amz-SignedHeaders"),
      "content-type;host",
      "content-type must be signed or a client could upload a different type than was validated"
    );
    assert.deepStrictEqual(headers, { "Content-Type": "video/mp4" });
  });
});

test("GET signs only host (no content-type on downloads)", () => {
  withEnv(R2, () => {
    const url = objectDownloadUrl(getObjectStorageConfig(), KEY);
    assert.strictEqual(new URL(url).searchParams.get("X-Amz-SignedHeaders"), "host");
  });
});

test("presigned URL declares UNSIGNED-PAYLOAD and a bounded expiry", () => {
  withEnv(R2, () => {
    const { url } = presignedUploadUrl(getObjectStorageConfig(), KEY, "application/pdf");
    const params = new URL(url).searchParams;
    assert.strictEqual(params.get("X-Amz-Content-Sha256"), "UNSIGNED-PAYLOAD");
    assert.strictEqual(params.get("X-Amz-Expires"), "900");
    assert.strictEqual(params.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.ok(params.get("X-Amz-Credential")?.endsWith("/auto/s3/aws4_request"), "credential scope uses the signing region");
    /* SigV4 rejects expiries beyond seven days. */
    assert.ok(Number(params.get("X-Amz-Expires")) <= 604800);
  });
});

/* ── 5. Secret handling ── */

test("the secret access key never leaks into the URL, the headers or the key name", () => {
  withEnv(R2, () => {
    const config = getObjectStorageConfig();
    const upload = presignedUploadUrl(config, KEY, "application/pdf");
    const download = objectDownloadUrl(config, KEY);
    for (const [label, text] of [
      ["upload URL", upload.url],
      ["upload headers", JSON.stringify(upload.headers)],
      ["download URL", download],
    ] as const) {
      assert.ok(
        !text.includes("secretEXAMPLEkey"),
        `the secret access key must never appear in the ${label}`
      );
    }
  });
});

/* ── 6. Download strategy ── */

test("a private bucket uses a signed GET URL by default", () => {
  withEnv(R2, () => {
    const url = objectDownloadUrl(getObjectStorageConfig(), KEY);
    assert.ok(url.includes("X-Amz-Signature="), "private buckets are read through a presigned GET");
  });
});

test("OBJECT_STORAGE_PUBLIC_URL switches downloads to the public base URL when explicitly allowed", () => {
  withEnv({ ...R2, OBJECT_STORAGE_PUBLIC_URL: "https://files.example.com/" }, () => {
    const url = objectDownloadUrl(getObjectStorageConfig(), "uploads/assignment/1111-2222.pdf", {
      allowPublic: true,
    });
    assert.strictEqual(
      url,
      "https://files.example.com/uploads/assignment/1111-2222.pdf",
      "the trailing slash on the public base must not double up"
    );
  });
});

test("protected files never use public URL even when OBJECT_STORAGE_PUBLIC_URL is set", () => {
  withEnv({ ...R2, OBJECT_STORAGE_PUBLIC_URL: "https://files.example.com/" }, () => {
    const url = objectDownloadUrl(getObjectStorageConfig(), KEY);
    assert.ok(
      url.includes("X-Amz-Signature="),
      "protected files must use presigned URLs, not public URLs"
    );
    assert.ok(!url.startsWith("https://files.example.com/"), "protected file leaked to public URL");
  });
});

/* ── 7. Key generation ── */

test("newObjectKey is purpose-scoped, unique per call and extension-normalised", () => {
  withEnv(R2, () => {
    const a = newObjectKey("assignment", "pdf");
    const b = newObjectKey("assignment", "pdf");
    assert.ok(a.startsWith("uploads/assignment/"), `unexpected key ${a}`);
    assert.ok(a.endsWith(".pdf"));
    assert.notStrictEqual(a, b, "each upload must receive a distinct key");
    assert.strictEqual(newObjectKey("submission", "").split(".").length, 1, "no stray dot without an extension");
  });
});

/* ── 8. Type-level guard ── */

test("config carries every field the signing helpers require", () => {
  withEnv(R2, () => {
    const config: ObjectStorageConfig = getObjectStorageConfig();
    for (const field of [
      "bucket",
      "endpoint",
      "region",
      "accessKeyId",
      "secretAccessKey",
    ] as const) {
      assert.strictEqual(typeof config[field], "string", `${field} must be a string`);
    }
    assert.strictEqual(typeof config.forcePathStyle, "boolean");
    assert.strictEqual(typeof config.uploadExpirySeconds, "number");
    assert.strictEqual(typeof config.downloadExpirySeconds, "number");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
