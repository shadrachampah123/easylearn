/**
 * Behavioural regression tests for the multipart upload path when object storage is
 * configured.
 *
 * These drive the REAL `POST /api/uploads` route handler against a REAL PostgreSQL and
 * a REAL filesystem, because the defect they pin was invisible to every source-level
 * check:
 *
 *   The first attempt at this fix refused the multipart path whenever
 *   `isObjectStorageEnabled()` was true, reasoning that "object storage configured"
 *   means "no writable filesystem". That is false. A deployment can legitimately have
 *   BOTH a bucket and a writable disk, and the multipart path is still the supported
 *   route for small files there. Three existing suites caught the regression:
 *
 *     - object-storage-live.test.ts           "6.1 the local upload path still works"
 *     - tenant-write-attribution-db.test.ts   "a local multipart upload is attributed…"
 *     - tenant-file-attribution-db.test.ts    A1/A2/B1/B2/B3
 *
 *   The corrected rule asks the FILESYSTEM, not the configuration:
 *
 *     object storage ON  + writable disk   → accept the multipart upload (201)
 *     object storage ON  + read-only disk  → refuse safely (409), write nothing
 *
 * The two cases below hold the object-storage configuration CONSTANT and vary only the
 * writability of the upload directory, so a pass on both proves the route distinguishes
 * the two conditions rather than keying off configuration alone.
 *
 * Database providers: TEST_DATABASE_URL → any PostgreSQL; embedded-postgres → throwaway
 * server; otherwise the suite SKIPS (exit 0).
 *
 * Run: npx tsx tests/upload-multipart-disk-fallback.test.ts
 */

import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";
import { MULTIPART_DISABLED_MESSAGE } from "@/lib/upload-mode";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

const DB_NAME = `easylearn_diskfallback_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();
const UPLOAD_DIR = path.join(os.tmpdir(), `${DB_NAME}-uploads`);

/** A minimal, valid PDF: the allow-list checks the `%PDF-` signature. */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n",
  "latin1"
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

  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      return;
    }
    const dbPort = 58629 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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
  } else {
    console.log("📦 Using TEST_DATABASE_URL");
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

  const writableMode = 0o755;
  const makeWritable = () => {
    try {
      fs.chmodSync(UPLOAD_DIR, writableMode);
    } catch {
      /* ignore */
    }
  };

  try {
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.UPLOAD_DIR = UPLOAD_DIR;
    /* The documented disposable-test opt-in that permits a non-TLS connection to a
       LOCAL database. It is set here because this suite creates and drops its own
       throwaway database; every npm script that runs a DB suite sets the same flag.
       It must never be set for a production invocation. */
    process.env.EASY_LEARN_TEST_DATABASE = "true";

    /* ── Object storage is CONFIGURED for every case ──────────────────────────
       Fake but well-formed values: this suite never signs or PUTs an object, it only
       needs `isObjectStorageEnabled()` to be true so the route takes the guarded
       branch. Nothing here is a real credential. */
    process.env.OBJECT_STORAGE_BUCKET = "easylearn-diskfallback-test";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "diskfallback-test-access-key-id";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "diskfallback-test-secret-access-key";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    delete process.env.OBJECT_STORAGE_ENDPOINT;
    delete process.env.OBJECT_STORAGE_PUBLIC_URL;

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    makeWritable();

    const migrationRun = runMigrationChain({
      databaseUrl: scratchUrl,
      env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" },
    });
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    const one = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];

    /* ── Fixture: one school, one teacher ───────────────────────────────────── */
    const passwordHash: string = await bcrypt.hash("DiskFallback-Test-Password!", 4);
    const schoolId = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Disk Fallback School', 'DFS', $1) RETURNING id`,
      [`disk-fallback-${DB_NAME.slice(-8)}`]
    )).id as string;
    const teacher = (await one(
      `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, $3, 'teacher', 'Disk', 'Fallback', true) RETURNING id`,
      [`teacher-${DB_NAME}@example.test`, `teacher-${DB_NAME.slice(-8)}`, passwordHash]
    )).id as string;
    const membership = (await one(
      `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'teacher', 'active') RETURNING id`,
      [schoolId, teacher]
    )).id as string;

    const auth = await import("@/lib/auth");
    const token = await auth.createToken({
      userId: teacher,
      role: "teacher",
      email: "teacher@example.test",
      schoolId,
      membershipId: membership,
    });

    const storageConfig = await import("@/lib/object-storage");
    const route: any = await import("@/app/api/uploads/route");

    const uploadPdf = async () => {
      const form = new FormData();
      form.set("purpose", "assignment");
      form.set("file", new File([PDF_BYTES], "worksheet.pdf", { type: "application/pdf" }));
      const request = new NextRequest(new URL("http://localhost:3000/api/uploads"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
      const response = await route.POST(request);
      let json: any = null;
      try {
        json = await response.clone().json();
      } catch {
        json = null;
      }
      return { status: response.status, json };
    };

    const filesOnDisk = () =>
      fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : [];

    console.log("\n🗂️  Multipart upload vs. filesystem writability (object storage ON)\n");

    /* ══════════ 1. Object storage ON + WRITABLE disk ⇒ local upload accepted ══════════ */

    await test("object storage is enabled for both cases (the condition held constant)", () => {
      assertEq(
        storageConfig.isObjectStorageEnabled(),
        true,
        "this suite is meaningless unless object storage is configured"
      );
    });

    await test("1.1 object storage ON + writable disk: the multipart upload is accepted (201)", async () => {
      assertEq(fs.accessSync(UPLOAD_DIR, fs.constants.W_OK), undefined, "the test directory must be writable");

      const result = await uploadPdf();
      assertEq(
        result.status,
        201,
        "a writable deployment with a bucket configured must still accept the local upload — refusing it breaks the documented 'the local path is unaffected' guarantee"
      );

      const attachment = result.json?.data?.[0];
      assert.ok(attachment?.fileId, "the accepted upload must return a fileId");
      assertEq(attachment.name, "worksheet.pdf", "the stored attachment must keep its name");
    });

    await test("1.2 object storage ON + writable disk: the bytes really reach the disk", () => {
      const onDisk = filesOnDisk();
      assert.ok(
        onDisk.length > 0,
        `201 must mean bytes were stored, but ${UPLOAD_DIR} is empty`
      );
    });

    /* ══════════ 2. Object storage ON + READ-ONLY disk ⇒ refuse safely ══════════ */

    await test("2.1 object storage ON + read-only disk: refused with 409, not a 500", async () => {
      const before = filesOnDisk().length;

      /* The ONLY difference from case 1: the directory is no longer writable. This is
         the condition a serverless bundle presents, and the configuration is untouched. */
      fs.chmodSync(UPLOAD_DIR, 0o555);
      assert.throws(
        () => fs.accessSync(UPLOAD_DIR, fs.constants.W_OK),
        "the test must actually make the directory unwritable for this to prove anything"
      );

      try {
        const result = await uploadPdf();
        assertEq(
          result.status,
          409,
          "an impossible disk write must be refused up front, not attempted and failed as an opaque 500"
        );
        assertEq(
          result.json?.error,
          MULTIPART_DISABLED_MESSAGE,
          "the refusal must carry the actionable message so the client can retry on the direct path"
        );
        assertEq(
          filesOnDisk().length,
          before,
          "a refused request must not leave a partial file behind"
        );
      } finally {
        makeWritable();
      }
    });

    await test("2.2 the directory is writable again, and uploads resume (no sticky state)", async () => {
      assertEq(fs.accessSync(UPLOAD_DIR, fs.constants.W_OK), undefined, "the test must restore permissions");
      const result = await uploadPdf();
      assertEq(result.status, 201, "the route must not cache the earlier refusal");
    });

    /* ══════════ 3. The probe must not MUTATE anything ══════════
       The writability probe runs before `authorizeUpload`, so it must answer the
       question without creating the directory. These two cases pin that: a missing
       directory is not a refusal, and a refusal must leave the filesystem untouched. */

    await test("3.1 a missing upload directory is not mistaken for a read-only one", async () => {
      const missing = path.join(os.tmpdir(), `${DB_NAME}-not-yet-created`, "uploads");
      assert.ok(!fs.existsSync(missing), "the fixture path must not exist yet");

      const previous = process.env.UPLOAD_DIR;
      process.env.UPLOAD_DIR = missing;
      try {
        const result = await uploadPdf();
        assertEq(
          result.status,
          201,
          "a directory that does not exist yet is created by the write path; the probe must walk up to a writable ancestor instead of refusing"
        );
        assert.ok(
          fs.existsSync(missing),
          "the successful upload must have created the directory"
        );
      } finally {
        if (previous === undefined) delete process.env.UPLOAD_DIR;
        else process.env.UPLOAD_DIR = previous;
        fs.rmSync(path.dirname(missing), { recursive: true, force: true });
      }
    });

    await test("3.2 a refusal creates nothing (the probe has no side effects)", async () => {
      /* A read-only parent with a not-yet-existing child: the probe must walk up, find
         the parent unwritable, and refuse — WITHOUT creating the child first. */
      const readOnlyParent = fs.mkdtempSync(path.join(os.tmpdir(), `${DB_NAME}-ro-`));
      const nested = path.join(readOnlyParent, "nested", "uploads");
      fs.chmodSync(readOnlyParent, 0o555);

      const previous = process.env.UPLOAD_DIR;
      process.env.UPLOAD_DIR = nested;
      try {
        const result = await uploadPdf();
        assertEq(result.status, 409, "an unwritable parent must refuse the upload");
        assertEq(result.json?.error, MULTIPART_DISABLED_MESSAGE);
        assert.ok(
          !fs.existsSync(path.join(readOnlyParent, "nested")),
          "the refused request must not have created the directory — the probe runs before authorization and must be read-only"
        );
      } finally {
        fs.chmodSync(readOnlyParent, 0o755);
        if (previous === undefined) delete process.env.UPLOAD_DIR;
        else process.env.UPLOAD_DIR = previous;
        fs.rmSync(readOnlyParent, { recursive: true, force: true });
      }
    });

    await test("3.3 an UNAUTHORIZED request cannot make the server create the directory", async () => {
      /* The sharpest form of the side-effect question. A teacher is authenticated but is
         NOT allowed to upload with purpose=submission (only learners may), so this
         request is refused by authorizeUpload. The writability probe runs BEFORE that
         check: if it creates the directory while merely asking whether it could be
         written, an unauthorized caller has made the server touch the filesystem.

         The earlier version of this guard did exactly that with
         `mkdir(dir, { recursive: true })`, so this test fails against it and passes
         only when the probe is non-mutating. */
      const fresh = path.join(os.tmpdir(), `${DB_NAME}-unauthorized`, "uploads");
      assert.ok(!fs.existsSync(fresh), "the fixture path must not exist yet");

      const previous = process.env.UPLOAD_DIR;
      process.env.UPLOAD_DIR = fresh;
      try {
        const form = new FormData();
        form.set("purpose", "submission"); // a teacher may not submit
        form.set("file", new File([PDF_BYTES], "worksheet.pdf", { type: "application/pdf" }));
        const request = new NextRequest(new URL("http://localhost:3000/api/uploads"), {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
        });
        const response = await route.POST(request);

        assertEq(response.status, 403, "a teacher uploading a submission must be refused");
        assert.ok(
          !fs.existsSync(fresh),
          "an unauthorized request must not create the upload directory — the probe runs before authorization and must not mutate the filesystem"
        );
      } finally {
        if (previous === undefined) delete process.env.UPLOAD_DIR;
        else process.env.UPLOAD_DIR = previous;
        fs.rmSync(path.dirname(fresh), { recursive: true, force: true });
      }
    });

    console.log(`\n📊 ${passed} passed, ${failed} failed\n`);
  } finally {
    makeWritable();
    /* Close the application's own pool before dropping the scratch database, otherwise
       DROP DATABASE ... WITH (FORCE) kills live backends and the pool logs a cascade of
       "terminating connection due to administrator command" noise. */
    try {
      const { pool } = await import("@/db");
      await pool.end();
    } catch {
      /* best effort */
    }
    await db.end().catch(() => undefined);
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    } catch {
      /* best effort */
    }
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  }

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("multipart disk-fallback suite crashed:", error);
  process.exit(1);
});
