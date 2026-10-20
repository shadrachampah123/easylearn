/**
 * The object-storage upload and retrieval path, against a REAL S3-compatible server.
 *
 * Every other suite in this repository either mocks the object store or only
 * inspects the URLs this application builds. That left the most important
 * question unanswered: what does the store ACTUALLY do with those URLs?
 *
 * This suite runs a real S3 API server (s3rver — a from-scratch implementation
 * of the S3 REST API, including the SigV4 query-string authentication and the
 * `response-*` override handling) and drives the application's real route
 * handlers against it and against a real PostgreSQL.
 *
 * What it proves:
 *
 *   1. The full round trip works: presign → PUT the bytes → GET /api/files/<id>
 *      → 307 → the store serves the object.
 *   2. The store DOES apply the signed `response-content-type`,
 *      `response-content-disposition` and `response-cache-control` overrides.
 *   3. The store CANNOT apply `X-Content-Type-Options` or a
 *      `Content-Security-Policy`: the S3 API allows exactly six `response-*`
 *      overrides and the store REJECTS any other one. This is the provider
 *      limitation, measured rather than assumed.
 *   4. The store's response carries no cache directive unless the application
 *      signs one, so a private file must be signed as `private`.
 *   5. The presigned download URL is a BEARER credential: it grants access with
 *      no application session at all, for as long as it is valid.
 *   6. The application now verifies the object before it hands out a URL to
 *      it: bytes that do not match the key's extension, and objects over the
 *      size limit, are refused (404).
 *
 * Honest limits of this suite (stated so nobody over-reads it):
 *   - s3rver does NOT verify AWS Signature Version 4 signatures
 *     ("Signature version 4 calculation is unimplemeneted" in its
 *     authentication middleware), so these tests say NOTHING about whether a
 *     forged signature would be accepted by a real store. The signing
 *     structure is covered by tests/object-storage-content-policy.test.ts.
 *   - The store used here is an S3-compatible implementation, not AWS S3
 *     itself. The `response-*` set it enforces is the one AWS documents, and
 *     the error it returns names that document.
 *
 * Database providers: TEST_DATABASE_URL → any PostgreSQL; embedded-postgres →
 * throwaway server; otherwise the suite SKIPS (exit 0).
 */

import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

const DB_NAME = `easylearn_objlive_test_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();
const UPLOAD_DIR = path.join(os.tmpdir(), `${DB_NAME}-uploads`);
const BUCKET = "easylearn-live-bucket";
const ACCESS_KEY = "S3RVER";
const SECRET_KEY = "S3RVER";

/** A minimal, valid PDF: the allow-list checks the `%PDF-` signature. */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n",
  "latin1"
);
/** A 1×1 PNG. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex"
);

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
      console.error(`   ${(error as Error).message}`);
      failed++;
    });
}

function assertEq(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(
      `${message || "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

async function main() {
  const { Client } = requireFromRepo("pg");
  const bcrypt = requireFromRepo("bcryptjs");

  /* ── The real S3-compatible server ─────────────────────────────────────── */
  let S3rver: any = null;
  try {
    /* The module IS the S3rver class. (`module.exports.default` is Koa's
       Application, not the server — do not unwrap it.) */
    S3rver = requireFromRepo("s3rver");
  } catch {
    console.log("⏭️  SKIP: s3rver is not installed.");
    console.log("   Install it with `npm i --no-save s3rver` and re-run the suite.");
    return;
  }

  const storeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `${DB_NAME}-s3`));
  const port = 47000 + (crypto.randomBytes(2).readUInt16BE(0) % 2000);
  const store = new S3rver({
    address: "127.0.0.1",
    port,
    directory: storeDirectory,
    silent: true,
    allowMismatchedSignatures: false,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  await store.run();
  console.log(`📦 S3-compatible server started on 127.0.0.1:${port}`);

  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      await store.close();
      fs.rmSync(storeDirectory, { recursive: true, force: true });
      return;
    }
    const dbPort = 57629 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`),
      user: "easylearn",
      password: "easylearn",
      port: dbPort,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    stopServer = () => pg.stop();
    adminUrl = `postgres://easylearn:easylearn@localhost:${dbPort}/postgres`;
    console.log(`📦 Embedded PostgreSQL started on port ${dbPort}`);
  }

  const scratchUrl = (() => {
    const url = new URL(adminUrl as string);
    url.pathname = `/${DB_NAME}`;
    return url.toString();
  })();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  const db = new Client({ connectionString: scratchUrl });
  await db.connect();

  try {
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.UPLOAD_DIR = UPLOAD_DIR;
    /* Point the application at the real S3-compatible server. */
    process.env.OBJECT_STORAGE_BUCKET = BUCKET;
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = ACCESS_KEY;
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = SECRET_KEY;
    process.env.OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    process.env.OBJECT_STORAGE_FORCE_PATH_STYLE = "true";
    delete process.env.OBJECT_STORAGE_PUBLIC_URL;
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const runMigrations = () => runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET } });
    const q = async (sql: string, values: unknown[] = []): Promise<any[]> =>
      (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

    const migrationRun = runMigrations();
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    /* ── Fixture: one school, one teacher ─────────────────────────────────── */

    const passwordHash: string = await bcrypt.hash("ObjectLive-Test-Password!", 4);
    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Object Live School', 'OLS', 'obj-live') RETURNING id`
    )).id as string;
    const teacher = (await one(
      `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, $3, 'teacher', 'Object', 'Live', true) RETURNING id`,
      [`teacher-${DB_NAME}@example.test`, `teacher-${DB_NAME.slice(-8)}`, passwordHash]
    )).id as string;
    const membership = (await one(
      `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'teacher', 'active') RETURNING id`,
      [schoolA, teacher]
    )).id as string;

    const auth = await import("@/lib/auth");
    const token = await auth.createToken({
      userId: teacher,
      role: "teacher",
      email: "teacher@example.test",
      schoolId: schoolA,
      membershipId: membership,
    });

    const route = async (pathName: string) => import(`@/app/api/${pathName}/route`);

    type CallOptions = {
      token?: string | null;
      body?: unknown;
      params?: Record<string, string>;
      method?: string;
      multipart?: FormData;
    };

    const call = async (pathName: string, options: CallOptions = {}) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      const method = options.method ?? (options.body !== undefined || options.multipart ? "POST" : "GET");
      const headers: Record<string, string> = {};
      if (options.token !== null && options.token !== undefined) {
        headers.authorization = `Bearer ${options.token}`;
      }
      if (options.body !== undefined) headers["content-type"] = "application/json";

      const request = new NextRequest(url, {
        method,
        headers,
        ...(options.multipart ? { body: options.multipart } : {}),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const mod: any = await route(pathName);
      const handler = mod[method.toUpperCase()];
      if (!handler) throw new Error(`${pathName} has no ${method.toUpperCase()} handler`);

      const response = options.params
        ? await handler(request, { params: Promise.resolve(options.params) })
        : await handler(request);

      let json: any = null;
      try {
        json = await response.clone().json();
      } catch {
        json = null;
      }
      return { status: response.status, json, response };
    };

    /** Presign an upload through the real route. */
    const presign = async (name: string, size: number, mimeType = "application/pdf") => {
      const result = await call("uploads/presign", {
        token,
        method: "POST",
        body: { purpose: "assignment", name, mimeType, size },
      });
      assertEq(result.status, 201, "the presign must be accepted");
      return result.json.data as {
        fileId: string;
        upload: { method: string; url: string; headers: Record<string, string> };
      };
    };

    console.log("\n☁️  Object storage against a real S3-compatible server\n");

    /* ══════════════ 1. The round trip ══════════════ */

    let pdfFileId = "";
    let pdfUpload: { url: string; headers: Record<string, string> } | null = null;
    await test("1.1 presign → PUT → GET /api/files/<id> serves the object", async () => {
      const prepared = await presign("notes.pdf", PDF_BYTES.length);
      pdfFileId = prepared.fileId;
      pdfUpload = prepared.upload;

      const put = await fetch(pdfUpload.url, {
        method: "PUT",
        headers: pdfUpload.headers,
        body: PDF_BYTES,
      });
      assertEq(put.status, 200, "the store must accept the signed PUT");

      const served = await call("files/[id]", { token, params: { id: pdfFileId } });
      assertEq(served.status, 307, "the route must redirect to the store");
      const location = served.response.headers.get("location");
      assert(location, "the redirect must carry a Location");
      assert(location.includes("X-Amz-Signature="), "the redirect target must be a signed URL");

      const final = await fetch(location);
      assertEq(final.status, 200, "the store must serve the object");
      const body = Buffer.from(await final.arrayBuffer());
      assert(body.equals(PDF_BYTES), "the served bytes must be the uploaded bytes");
    });

    /* ══════════════ 2. What the store applies ══════════════ */

    await test("2.1 the store applies the signed content type and disposition", async () => {
      const served = await call("files/[id]", { token, params: { id: pdfFileId } });
      const location = served.response.headers.get("location")!;
      const final = await fetch(location);
      assertEq(
        final.headers.get("content-type"),
        "application/pdf",
        "the store must serve the server-determined content type"
      );
      assert(
        (final.headers.get("content-disposition") || "").startsWith("attachment;"),
        "a document must be served as a download, not inline"
      );
    });

    await test("2.2 the store applies the signed private cache directive", async () => {
      const served = await call("files/[id]", { token, params: { id: pdfFileId } });
      const location = served.response.headers.get("location")!;
      const final = await fetch(location);
      assertEq(
        final.headers.get("cache-control"),
        "private, max-age=3600",
        "a private file must not be storable by a shared cache"
      );
    });

    /* ══════════════ 3. What the store CANNOT do — the provider limit ══════════════ */

    await test("3.1 the store's response carries no nosniff and no CSP", async () => {
      const served = await call("files/[id]", { token, params: { id: pdfFileId } });
      const location = served.response.headers.get("location")!;
      const final = await fetch(location);
      assertEq(
        final.headers.get("x-content-type-options"),
        null,
        "the object store's response carries no X-Content-Type-Options"
      );
      assertEq(
        final.headers.get("content-security-policy"),
        null,
        "the object store's response carries no Content-Security-Policy"
      );
    });

    await test("3.2 the store REJECTS any response-header override outside the S3 set", async () => {
      const served = await call("files/[id]", { token, params: { id: pdfFileId } });
      const location = served.response.headers.get("location")!;
      const tampered = location.replace(
        "response-content-type",
        "response-x-content-type-options"
      );
      const response = await fetch(tampered);
      assertEq(response.status, 400, "the store must refuse an unsupported override");
      const body = await response.text();
      assert(
        body.includes("InvalidArgument"),
        "the store must report the override as invalid: " + body.slice(0, 200)
      );
      assert(
        body.includes("not in the set of overridable response headers"),
        "the store must name the S3-documented set: " + body.slice(0, 200)
      );
    });

    /* ══════════════ 4. The presigned download is a bearer credential ══════════════ */

    await test("4.1 the presigned download URL grants access with no session at all", async () => {
      const served = await call("files/[id]", { token, params: { id: pdfFileId } });
      const location = served.response.headers.get("location")!;
      /* No cookie, no Authorization header, no application request: the URL alone. */
      const response = await fetch(location);
      assertEq(
        response.status,
        200,
        "the presigned URL is a bearer credential — anyone holding it can read the file"
      );
    });

    /* ══════════════ 5. The application verifies the object before serving it ══════════════ */

    await test("5.1 bytes that do not match the key's extension are refused", async () => {
      const prepared = await presign("picture.png", PNG_BYTES.length, "image/png");
      /* The client lies: it sends HTML under a .png key. */
      const put = await fetch(prepared.upload.url, {
        method: "PUT",
        headers: prepared.upload.headers,
        body: "<!DOCTYPE html><script>fetch('/api/users')</script>",
      });
      assertEq(put.status, 200, "the store accepts the bytes (it cannot validate them)");

      const served = await call("files/[id]", { token, params: { id: prepared.fileId } });
      assertEq(
        served.status,
        404,
        "the application must refuse an object whose bytes are not what the key says"
      );
    });

    await test("5.2 an object over the size limit is refused", async () => {
      /* Bypass the presign route's size check the way a hostile client would:
         mint the PUT URL directly, then store more than the 50 MB limit. */
      const storage = await import("@/lib/object-storage");
      const config = storage.getObjectStorageConfig();
      const key = storage.newObjectKey("assignment", "pdf");
      const signed = storage.presignedUploadUrl(config, key, "application/pdf");
      const oversize = Buffer.alloc(50 * 1024 * 1024 + 1, 0x41);
      const put = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: oversize,
      });
      assertEq(put.status, 200, "the store accepts the bytes");

      const row = (await one(
        `INSERT INTO uploaded_files (school_id, uploader_id, purpose, original_name, stored_name, mime_type, category, size_bytes, storage_backend)
         VALUES ($1, $2, 'assignment', 'huge.pdf', $3, 'application/pdf', 'document', 5, 'object') RETURNING id`,
        [schoolA, teacher, key]
      )).id as string;

      const served = await call("files/[id]", { token, params: { id: row } });
      assertEq(
        served.status,
        404,
        "an object over the size limit must not be served, whatever the client declared"
      );
    });

    await test("5.3 a legitimate object is served, and the verdict is remembered", async () => {
      const prepared = await presign("diagram.png", PNG_BYTES.length, "image/png");
      const put = await fetch(prepared.upload.url, {
        method: "PUT",
        headers: prepared.upload.headers,
        body: PNG_BYTES,
      });
      assertEq(put.status, 200, "the store must accept the bytes");

      const first = await call("files/[id]", { token, params: { id: prepared.fileId } });
      assertEq(first.status, 307, "a legitimate object must be served");
      const location = first.response.headers.get("location")!;
      const final = await fetch(location);
      assertEq(final.headers.get("content-type"), "image/png", "the forced type must be the image type");
      assert(
        (final.headers.get("content-disposition") || "").startsWith("inline;"),
        "an image may be served inline"
      );

      const second = await call("files/[id]", { token, params: { id: prepared.fileId } });
      assertEq(second.status, 307, "the second read must be served as well");
    });

    await test("5.4 a deleted object is reported as not found", async () => {
      const prepared = await presign("temporary.pdf", PDF_BYTES.length);
      const put = await fetch(prepared.upload.url, {
        method: "PUT",
        headers: prepared.upload.headers,
        body: PDF_BYTES,
      });
      assertEq(put.status, 200, "the store must accept the bytes");
      const served = await call("files/[id]", { token, params: { id: prepared.fileId } });
      assertEq(served.status, 307, "the object must be served while it exists");

      const storage = await import("@/lib/object-storage");
      const config = storage.getObjectStorageConfig();
      const row = await one(`SELECT stored_name FROM uploaded_files WHERE id = $1`, [prepared.fileId]);
      const deleted = await storage.deleteObject(config, row.stored_name);
      assert(deleted, "the object must be deletable");

      const gone = await call("files/[id]", { token, params: { id: prepared.fileId } });
      assertEq(gone.status, 404, "an object that no longer exists must be reported as not found");
    });

    /* ══════════════ 6. The local path is unaffected ══════════════ */

    await test("6.1 the local upload path still works", async () => {
      const form = new FormData();
      form.set("purpose", "assignment");
      form.set("file", new File([PDF_BYTES], "local.pdf", { type: "application/pdf" }));
      const result = await call("uploads", { token, multipart: form });
      assertEq(result.status, 201, "the local upload must still be accepted");
      const fileId = result.json?.data?.[0]?.fileId as string;
      assert(fileId, "the local upload must return a fileId");
      const served = await call("files/[id]", { token, params: { id: fileId } });
      assertEq(served.status, 200, "the local file must be served by the application");
      assertEq(
        served.response.headers.get("x-content-type-options"),
        "nosniff",
        "the application-controlled response keeps nosniff"
      );
      assert(
        (served.response.headers.get("content-security-policy") || "").includes("sandbox"),
        "the application-controlled response keeps the sandbox CSP"
      );
    });

    console.log(`\n📊 ${passed} passed, ${failed} failed\n`);
  } finally {
    await db.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    await store.close().catch(() => undefined);
    fs.rmSync(storeDirectory, { recursive: true, force: true });
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  }

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("Object-storage live suite crashed:", error);
  process.exit(1);
});
