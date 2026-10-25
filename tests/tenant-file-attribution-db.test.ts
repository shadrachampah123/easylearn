/**
 * Tenant attribution of uploaded files — LIVE DATABASE, REAL ROUTE HANDLERS.
 *
 * Regression suite for the multi-school file defect (F-2 of the PR #40 review):
 * a user who belongs to TWO schools uploaded a file and then received 404 for it in the
 * very school that had just accepted the upload.
 *
 * Root cause: `sqlFileInSchool()` attributed a file RELATIONALLY — the set of schools that
 * could "reach" it (the uploader's active memberships ∪ the assignment's school) had to
 * contain EXACTLY one school (`sqlOwnedBySchool`). A uploader with two active memberships
 * produced a two-school set, so the file was denied in BOTH schools.
 *
 * The fix attributes a file by its own `uploaded_files.school_id` — the school that wrote
 * it — exactly as `sqlAssignmentInSchool()` already attributes assignments (Phase 2D). The
 * relational rule survives as the fallback for legacy rows whose `school_id` is still NULL.
 *
 * The cases proved here:
 *   A. ONE school      → the uploader reads their own file (200) in their own school.
 *   B. MULTIPLE schools→ the uploader reads their own file (200) in the school that
 *                        stored it, and NOT in their other school (404). The other school's
 *                        administrator is denied it too (404).
 *   C. UNAUTHORIZED    → a member of an unrelated school is denied (404); a user with no
 *                        membership at all is refused at the gate (403) before the file is
 *                        ever looked up.
 *   D. CROSS-SCHOOL    → school B can never read school A's file, whichever route, and a
 *                        dual member's file is never visible from their second school.
 *   E. REVOCATION      → a deactivated membership loses access to the file immediately.
 *   F. LEGACY FALLBACK → a row whose `school_id` is NULL is still attributed RELATIONALLY
 *                        and is still denied to both schools when it is ambiguous.
 *
 * Database providers (same approach as tests/tenant-write-attribution-db.test.ts):
 *   - TEST_DATABASE_URL → any PostgreSQL
 *   - embedded-postgres → throwaway server
 *   - otherwise the suite SKIPS (exit 0)
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

const DB_NAME = `easylearn_filattrib_test_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();
const UPLOAD_DIR = path.join(os.tmpdir(), `${DB_NAME}-uploads`);

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

/** A minimal, valid-enough PDF: the server's allow-list checks the `%PDF-` signature. */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n",
  "latin1"
);

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
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run the suite.");
      return;
    }
    const port = 56629 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`),
      user: "easylearn",
      password: "easylearn",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    stopServer = () => pg.stop();
    adminUrl = `postgres://easylearn:easylearn@localhost:${port}/postgres`;
    console.log(`📦 Embedded PostgreSQL started on port ${port}`);
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
    /* The application modules must see the scratch database. Set BEFORE the first `@/db`
       import — the pool is created at import time. */
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.UPLOAD_DIR = UPLOAD_DIR;
    process.env.OBJECT_STORAGE_BUCKET = "easylearn-filattrib-test-bucket";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIA2ETESTFAKEFAKEFAKEFA";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "2etestfakefakefakefakefakefakefakefakefake";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const runMigrations = () => runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" } });

    const q = async (sql: string, values: unknown[] = []): Promise<any[]> =>
      (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

    const migrationRun = runMigrations();
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    /* ── Fixture: three schools ── */

    const passwordHash: string = await bcrypt.hash("FileAttribution-Test-Password!", 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Attribution School A', 'ASA', 'attr-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Attribution School B', 'ASB', 'attr-b') RETURNING id`
    )).id as string;
    const schoolC = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Attribution School C', 'ASC', 'attr-c') RETURNING id`
    )).id as string;

    type Fixture = { key: string; role: string; schoolIds: string[] };
    const fixtures: Fixture[] = [
      { key: "single", role: "teacher", schoolIds: [schoolA] },
      { key: "dual", role: "teacher", schoolIds: [schoolA, schoolB] },
      { key: "outsider", role: "teacher", schoolIds: [schoolC] },
      { key: "admin-a", role: "school_admin", schoolIds: [schoolA] },
      { key: "admin-b", role: "school_admin", schoolIds: [schoolB] },
      { key: "learner-dual", role: "learner", schoolIds: [schoolA, schoolB] },
      { key: "nomember", role: "teacher", schoolIds: [] },
    ];

    const ids: Record<string, string> = {};
    const membershipIds: Record<string, string> = {}; // `${key}:${schoolId}` → membership id
    for (const fixture of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, 'File', $5, true) RETURNING id`,
        [
          `${fixture.key}-${DB_NAME}@example.test`,
          `${fixture.key}-${DB_NAME.slice(-8)}`,
          passwordHash,
          fixture.role,
          fixture.key,
        ]
      );
      ids[fixture.key] = row.id;
      for (const schoolId of fixture.schoolIds) {
        const membership = await one(
          `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
          [schoolId, row.id, fixture.role]
        );
        membershipIds[`${fixture.key}:${schoolId}`] = membership.id as string;
      }
    }

    /* A School A class + assignment (the assignment gives the relational file predicate a
       second school to reach when the uploader belongs to School B). */
    const subjectA = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Maths', 'MTH-ATTR') RETURNING id`,
      [schoolA]
    )).id as string;
    const classA = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id) VALUES ($1, 'Class A', 'primary', $2) RETURNING id`,
      [schoolA, ids["single"]]
    )).id as string;
    await q(
      `INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1, $2, $3, $4)`,
      [schoolA, ids["single"], classA, subjectA]
    );
    const assignA = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads)
       VALUES ($1, 'Attribution Assignment', $2, $3, $4, 'published', 100, true) RETURNING id`,
      [schoolA, classA, subjectA, ids["single"]]
    )).id as string;
    // Enrollment is now required for submission uploads (security/pr43 follow-up).
    // The original INSERT ... SELECT academic_years would insert 0 rows when no
    // academic year exists, leaving the learner unenrolled and causing the new
    // enrollment guard to correctly reject the upload. Insert directly.
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [schoolA, ids["learner-dual"], classA]).catch(() => undefined);
    // Keep the original academic-year attempt for backward compatibility where it exists
    await q(
      `INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id)
       SELECT $1, $2, $3, id FROM academic_years WHERE school_id = $1 LIMIT 1 ON CONFLICT DO NOTHING`,
      [schoolA, ids["learner-dual"], classA]
    ).catch(() => undefined);

    /* ── Tokens: a school-scoped token carries the membership id as its hint ── */

    const auth = await import("@/lib/auth");
    const tokenFor = async (key: string, schoolId: string | null): Promise<string> => {
      const membershipId = schoolId ? membershipIds[`${key}:${schoolId}`] : undefined;
      return auth.createToken({
        userId: ids[key],
        role: fixtures.find((f) => f.key === key)!.role,
        email: `${key}@example.test`,
        ...(schoolId ? { schoolId, membershipId } : {}),
      });
    };

    const tokens: Record<string, string> = {
      "single@a": await tokenFor("single", schoolA),
      "dual@a": await tokenFor("dual", schoolA),
      "dual@b": await tokenFor("dual", schoolB),
      "outsider@c": await tokenFor("outsider", schoolC),
      "admin-a": await tokenFor("admin-a", schoolA),
      "admin-b": await tokenFor("admin-b", schoolB),
      "learner-dual@a": await tokenFor("learner-dual", schoolA),
      "learner-dual@b": await tokenFor("learner-dual", schoolB),
      nomember: await tokenFor("nomember", null),
    };

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

    /** Upload one PDF through the REAL upload route and return the new file id. */
    const upload = async (
      token: string,
      options: { purpose?: "assignment" | "submission"; assignmentId?: string; name?: string } = {}
    ): Promise<string> => {
      const form = new FormData();
      form.set("purpose", options.purpose ?? "assignment");
      if (options.assignmentId) form.set("assignmentId", options.assignmentId);
      form.set("file", new File([PDF_BYTES], options.name ?? "notes.pdf", { type: "application/pdf" }));
      const result = await call("uploads", { token, multipart: form });
      assertEq(result.status, 201, "the upload must be accepted");
      const fileId = result.json?.data?.[0]?.fileId as string;
      assert(fileId, "the upload response must include the new fileId");
      return fileId;
    };

    console.log("\n🎯 Uploaded-file tenant attribution (one school / multiple schools / unauthorized / cross-school)\n");

    /* ════════════════ A. ONE school ════════════════ */

    let singleFile = "";
    await test("A1: a single-school uploader can read their own file", async () => {
      singleFile = await upload(tokens["single@a"]);
      const result = await call("files/[id]", { token: tokens["single@a"], params: { id: singleFile } });
      assertEq(result.status, 200, "the uploader must be able to read their own file");
      assertEq(
        result.response.headers.get("content-type"),
        "application/pdf",
        "the file must be served with the server-derived content type"
      );
    });

    await test("A2: the stored file is attributed to the uploading school", async () => {
      const row = await one(`SELECT school_id FROM uploaded_files WHERE id = $1`, [singleFile]);
      assertEq(row.school_id, schoolA, "the file must be attributed to School A");
    });

    /* ════════════════ B. MULTIPLE schools — the defect ════════════════ */

    let dualFile = "";
    await test("B1: a multi-school uploader can read their own file in the school that stored it", async () => {
      dualFile = await upload(tokens["dual@a"]);
      const row = await one(`SELECT school_id FROM uploaded_files WHERE id = $1`, [dualFile]);
      assertEq(row.school_id, schoolA, "the file must be attributed to the uploader's selected school");

      const result = await call("files/[id]", { token: tokens["dual@a"], params: { id: dualFile } });
      assertEq(
        result.status,
        200,
        "the uploader must be able to read their own file in School A (was 404 before the fix)"
      );
    });

    await test("B2: the same file is NOT readable in the uploader's other school", async () => {
      const result = await call("files/[id]", { token: tokens["dual@b"], params: { id: dualFile } });
      assertEq(
        result.status,
        404,
        "a School A file must stay invisible in School B, even for its uploader"
      );
    });

    await test("B3: the same file is NOT readable by the other school's administrator", async () => {
      const result = await call("files/[id]", { token: tokens["admin-b"], params: { id: dualFile } });
      assertEq(result.status, 404, "School B's administrator must not read School A's file");
    });

    await test("B4: the file IS readable by its own school's administrator", async () => {
      const result = await call("files/[id]", { token: tokens["admin-a"], params: { id: dualFile } });
      assertEq(result.status, 200, "School A's administrator must read School A's file");
    });

    await test("B5: a file uploaded while acting in School B is invisible in School A", async () => {
      const fileB = await upload(tokens["dual@b"]);
      const row = await one(`SELECT school_id FROM uploaded_files WHERE id = $1`, [fileB]);
      assertEq(row.school_id, schoolB, "the file must be attributed to School B");

      const inB = await call("files/[id]", { token: tokens["dual@b"], params: { id: fileB } });
      assertEq(inB.status, 200, "the uploader must read their own School B file");
      const inA = await call("files/[id]", { token: tokens["dual@a"], params: { id: fileB } });
      assertEq(inA.status, 404, "a School B file must stay invisible in School A");
    });

    /* ════════════════ C. UNAUTHORIZED users ════════════════ */

    await test("C1: a member of an unrelated school is denied the file (404)", async () => {
      const result = await call("files/[id]", { token: tokens["outsider@c"], params: { id: dualFile } });
      assertEq(result.status, 404, "an unrelated school's member must not read the file");
    });

    await test("C2: a user with no membership is refused at the gate (403), before the file is read", async () => {
      const result = await call("files/[id]", { token: tokens.nomember, params: { id: dualFile } });
      assertEq(result.status, 403, "a user without a membership must be refused");
      assert(
        String(result.json?.error || "").toLowerCase().includes("membership"),
        "the refusal must name the missing membership"
      );
    });

    await test("C3: an unauthenticated request is refused (401)", async () => {
      const result = await call("files/[id]", { token: null, params: { id: dualFile } });
      assertEq(result.status, 401, "an unauthenticated request must be refused");
    });

    /* ════════════════ D. CROSS-SCHOOL access ════════════════ */

    await test("D1: School B's administrator cannot read School A's single-school file either", async () => {
      const result = await call("files/[id]", { token: tokens["admin-b"], params: { id: singleFile } });
      assertEq(result.status, 404, "cross-school access must stay denied");
    });

    await test("D2: a dual member cannot delete the other school's copy of their file", async () => {
      const result = await call("uploads/[id]", {
        token: tokens["dual@b"],
        params: { id: dualFile },
        method: "DELETE",
      });
      assertEq(result.status, 404, "the delete route must use the same school boundary");
      const still = await one(`SELECT id FROM uploaded_files WHERE id = $1`, [dualFile]);
      assert(still, "the file must NOT have been deleted");
    });

    await test("D3: the uploader CAN delete their own file in the school that stored it", async () => {
      const fileId = await upload(tokens["dual@a"]);
      const result = await call("uploads/[id]", {
        token: tokens["dual@a"],
        params: { id: fileId },
        method: "DELETE",
      });
      assertEq(result.status, 200, "the uploader must be able to delete their own file");
      const gone = await one(`SELECT id FROM uploaded_files WHERE id = $1`, [fileId]);
      assert(!gone, "the file row must be gone");
    });

    /* ════════════════ E. Revocation ════════════════ */

    await test("E1: a deactivated membership loses access to the file immediately", async () => {
      const fileId = await upload(tokens["dual@a"]);
      await q(
        `UPDATE school_users SET status = 'disabled' WHERE school_id = $1 AND user_id = $2`,
        [schoolA, ids["dual"]]
      );
      try {
        const result = await call("files/[id]", { token: tokens["dual@a"], params: { id: fileId } });
        assertEq(result.status, 403, "a disabled membership must lose tenant access");
      } finally {
        await q(
          `UPDATE school_users SET status = 'active' WHERE school_id = $1 AND user_id = $2`,
          [schoolA, ids["dual"]]
        );
      }
    });

    /* ════════════════ F. Legacy NULL-school_id rows keep the relational rule ════════════════ */

    await test("F1: a legacy row with a NULL school_id is still attributed relationally", async () => {
      // 0017 made `uploaded_files.school_id` NOT NULL, so a NULL row can only be produced
      // by a pre-0017 database. Relax the constraint to reproduce one, then restore it.
      await q(`ALTER TABLE uploaded_files ALTER COLUMN school_id DROP NOT NULL`);
      let legacyFile = "";
      try {
        const row = await one(
          `INSERT INTO uploaded_files (school_id, uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
           VALUES (NULL, $1, 'assignment', $2, 'legacy.pdf', 'stored-legacy.pdf', 'application/pdf', 'document', $3) RETURNING id`,
          [ids["dual"], assignA, PDF_BYTES.length]
        );
        legacyFile = row.id as string;
        fs.writeFileSync(path.join(UPLOAD_DIR, "stored-legacy.pdf"), PDF_BYTES);

        // The uploader reaches the row from BOTH schools (their membership and School A's
        // assignment), so the relational rule finds it unattributable and denies BOTH.
        for (const token of [tokens["dual@a"], tokens["dual@b"], tokens["admin-a"], tokens["admin-b"]]) {
          const result = await call("files/[id]", { token, params: { id: legacyFile } });
          assertEq(
            result.status,
            404,
            "a legacy NULL-school_id row that two schools can reach must be denied to both"
          );
        }
      } finally {
        await q(`DELETE FROM uploaded_files WHERE id IN (SELECT id FROM uploaded_files WHERE school_id IS NULL)`);
        await q(`ALTER TABLE uploaded_files ALTER COLUMN school_id SET NOT NULL`);
        fs.rmSync(path.join(UPLOAD_DIR, "stored-legacy.pdf"), { force: true });
      }
    });

    /* ════════════════ G. Submission files keep their per-file access control ════════════════ */

    await test("G1: a dual learner's own submission is readable in their school only", async () => {
      const fileId = await upload(tokens["learner-dual@a"], {
        purpose: "submission",
        assignmentId: assignA,
        name: "homework.pdf",
      });
      const inA = await call("files/[id]", { token: tokens["learner-dual@a"], params: { id: fileId } });
      assertEq(inA.status, 200, "the learner must read their own submission");
      const inB = await call("files/[id]", { token: tokens["learner-dual@b"], params: { id: fileId } });
      assertEq(inB.status, 404, "the submission must stay invisible in the learner's other school");
      const byOther = await call("files/[id]", { token: tokens["admin-b"], params: { id: fileId } });
      assertEq(byOther.status, 404, "another school must not read the submission");
    });

    /* ════════════════ H. The predicate itself ════════════════ */

    await test("H1: the purely relational predicate still denies a dual-reachable file", async () => {
      const tenant = await import("@/lib/tenant");
      const { uploadedFiles } = await import("@/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const { db: appDb } = await import("@/db");
      const row = await one(`SELECT school_id FROM uploaded_files WHERE id = $1`, [dualFile]);
      assertEq(row.school_id, schoolA, "precondition: the file is attributed to School A");
      // The relational predicate is the legacy fallback: it must still refuse a file that
      // two schools can reach, so the fallback can never re-open the isolation hole.
      const relational = tenant.sqlFileOwnedRelationally(schoolA, uploadedFiles.id);
      assert(relational, "the relational predicate must exist");
      const rows = await appDb
        .select({ id: uploadedFiles.id })
        .from(uploadedFiles)
        .where(and(eq(uploadedFiles.id, dualFile), relational))
        .limit(1);
      assertEq(
        rows.length,
        0,
        "the relational predicate must NOT admit a file that two schools can reach"
      );
    });

    console.log(`\n📊 ${passed} passed, ${failed} failed\n`);
  } finally {
    await db.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  }

  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("File-attribution suite crashed:", error);
  process.exit(1);
});
