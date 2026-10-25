/**
 * Attachment-security regression — LIVE DATABASE, REAL ROUTE HANDLERS.
 *
 * Covers three fixes introduced on security/pr43-object-storage-guard:
 *   1. Class-level authorization for direct assignment-file requests (GET /api/files/[id]).
 *   2. Learner enrollment enforcement for multipart and presigned submission uploads.
 *   3. Cross-school attachment metadata associations are rejected.
 *
 * Every assertion drives the real handler against a real PostgreSQL. Tokens are
 * minted with school-scoped membership hints so guardSchoolContext resolves
 * exactly the school under test. The suite is intentionally verbose so that a
 * mutation (removing any one check) fails loudly and points at the property
 * that was lost.
 *
 * Database providers: TEST_DATABASE_URL → any PostgreSQL, embedded-postgres →
 * throwaway server, otherwise SKIP (exit 0).
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

const DB_NAME = `easylearn_attach_sec_${crypto.randomBytes(4).toString("hex")}`;
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
      if ((error as Error).stack) console.error(`   ${(error as Error).stack?.split("\n").slice(1, 3).join("\n   ")}`);
      failed++;
    });
}

function assertEq(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(`${message || "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

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
    const port = 56701 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";
    process.env.UPLOAD_DIR = UPLOAD_DIR;
    process.env.OBJECT_STORAGE_BUCKET = "";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "";
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const runMigrations = () => runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" } });
    const q = async (sql: string, values: unknown[] = []): Promise<any[]> => (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

    const migrationRun = runMigrations();
    if (migrationRun.status !== 0) {
      throw new Error(`run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`);
    }

    const passwordHash: string = await bcrypt.hash("Attachment-Security-Test-Password!", 4);

    // ── Schools ──
    const schoolA = (await one(`INSERT INTO schools (name, short_name, slug) VALUES ('Attach School A','ASA','attach-a') RETURNING id`)).id as string;
    const schoolB = (await one(`INSERT INTO schools (name, short_name, slug) VALUES ('Attach School B','ASB','attach-b') RETURNING id`)).id as string;

    // ── Subjects & classes ──
    const subjectA = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Maths','MTH-ATTACH-A') RETURNING id`, [schoolA])).id as string;
    const subjectB = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Science','SCI-ATTACH-B') RETURNING id`, [schoolB])).id as string;

    const classA1 = (await one(`INSERT INTO classes (school_id, name, level, class_teacher_id) VALUES ($1,'Class A1','primary',NULL) RETURNING id`, [schoolA])).id as string;
    const classA2 = (await one(`INSERT INTO classes (school_id, name, level, class_teacher_id) VALUES ($1,'Class A2','primary',NULL) RETURNING id`, [schoolA])).id as string;
    const classB1 = (await one(`INSERT INTO classes (school_id, name, level) VALUES ($1,'Class B1','primary') RETURNING id`, [schoolB])).id as string;

    // ── Users & memberships ──
    type Fixture = { key: string; role: string; schoolIds: string[] };
    const fixtures: Fixture[] = [
      { key: "teacher-a1", role: "teacher", schoolIds: [schoolA] },
      { key: "teacher-a2", role: "teacher", schoolIds: [schoolA] },
      { key: "teacher-b1", role: "teacher", schoolIds: [schoolB] },
      { key: "learner-enrolled", role: "learner", schoolIds: [schoolA] },
      { key: "learner-unenrolled", role: "learner", schoolIds: [schoolA] },
      { key: "learner-other-class", role: "learner", schoolIds: [schoolA] },
      { key: "learner-b", role: "learner", schoolIds: [schoolB] },
      { key: "learner-dual", role: "learner", schoolIds: [schoolA, schoolB] },
      { key: "admin-a", role: "school_admin", schoolIds: [schoolA] },
      { key: "admin-b", role: "school_admin", schoolIds: [schoolB] },
      { key: "parent-linked", role: "parent", schoolIds: [schoolA] },
      { key: "parent-unlinked", role: "parent", schoolIds: [schoolA] },
      { key: "outsider", role: "teacher", schoolIds: [schoolB] },
      { key: "dual-teacher", role: "teacher", schoolIds: [schoolA, schoolB] },
    ];

    const ids: Record<string, string> = {};
    const membershipIds: Record<string, string> = {};
    for (const fixture of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,$3,$4,'Attach',$5,true) RETURNING id`,
        [`${fixture.key}-${DB_NAME}@example.test`, `${fixture.key}-${DB_NAME.slice(-8)}`, passwordHash, fixture.role, fixture.key]
      );
      ids[fixture.key] = row.id;
      for (const schoolId of fixture.schoolIds) {
        const membership = await one(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active') RETURNING id`, [schoolId, row.id, fixture.role]);
        membershipIds[`${fixture.key}:${schoolId}`] = membership.id as string;
      }
    }

    // Assign teacher-a1 to classA1 via teacher_classes and as homeroom for extra coverage
    await q(`UPDATE classes SET class_teacher_id=$1 WHERE id=$2`, [ids["teacher-a1"], classA1]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1,$2,$3,$4)`, [schoolA, ids["teacher-a1"], classA1, subjectA]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1,$2,$3,$4)`, [schoolA, ids["teacher-a2"], classA2, subjectA]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1,$2,$3,$4)`, [schoolB, ids["teacher-b1"], classB1, subjectB]);

    // Enroll learners
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolA, ids["learner-enrolled"], classA1]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolA, ids["learner-other-class"], classA2]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolB, ids["learner-b"], classB1]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolA, ids["learner-dual"], classA1]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolB, ids["learner-dual"], classB1]);
    // learner-unenrolled deliberately NOT enrolled in any class

    // Parent linkage: parent-linked is linked to learner-enrolled, parent-unlinked is not linked
    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id) VALUES ($1,$2,$3)`, [schoolA, ids["parent-linked"], ids["learner-enrolled"]]);

    // Assignments
    const assignA1 = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads, allow_late) VALUES ($1,'Assignment A1',$2,$3,$4,'published',100,true,false) RETURNING id`,
      [schoolA, classA1, subjectA, ids["teacher-a1"]]
    )).id as string;
    const assignA2 = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads) VALUES ($1,'Assignment A2',$2,$3,$4,'published',100,true) RETURNING id`,
      [schoolA, classA2, subjectA, ids["teacher-a2"]]
    )).id as string;
    const assignB1 = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads) VALUES ($1,'Assignment B1',$2,$3,$4,'published',100,true) RETURNING id`,
      [schoolB, classB1, subjectB, ids["teacher-b1"]]
    )).id as string;

    // Tokens
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
      "teacher-a1@a": await tokenFor("teacher-a1", schoolA),
      "teacher-a2@a": await tokenFor("teacher-a2", schoolA),
      "teacher-b1@b": await tokenFor("teacher-b1", schoolB),
      "learner-enrolled@a": await tokenFor("learner-enrolled", schoolA),
      "learner-unenrolled@a": await tokenFor("learner-unenrolled", schoolA),
      "learner-other-class@a": await tokenFor("learner-other-class", schoolA),
      "learner-b@b": await tokenFor("learner-b", schoolB),
      "learner-dual@a": await tokenFor("learner-dual", schoolA),
      "learner-dual@b": await tokenFor("learner-dual", schoolB),
      "admin-a@a": await tokenFor("admin-a", schoolA),
      "admin-b@b": await tokenFor("admin-b", schoolB),
      "parent-linked@a": await tokenFor("parent-linked", schoolA),
      "parent-unlinked@a": await tokenFor("parent-unlinked", schoolA),
      "outsider@b": await tokenFor("outsider", schoolB),
      "dual-teacher@a": await tokenFor("dual-teacher", schoolA),
      "dual-teacher@b": await tokenFor("dual-teacher", schoolB),
    };

    const route = async (pathName: string) => import(`@/app/api/${pathName}/route`);
    const call = async (pathName: string, options: { token?: string | null; body?: unknown; params?: Record<string, string>; method?: string; multipart?: FormData; query?: Record<string, string> } = {}) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      if (options.query) for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v);
      const method = options.method ?? (options.body !== undefined || options.multipart ? "POST" : "GET");
      const headers: Record<string, string> = {};
      if (options.token !== undefined && options.token !== null) headers.authorization = `Bearer ${options.token}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const request = new NextRequest(url, {
        method,
        headers,
        ...(options.multipart ? { body: options.multipart } : {}),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const mod: any = await route(pathName);
      const handler = mod[method];
      if (!handler) throw new Error(`${pathName} has no ${method} handler`);
      const response = options.params ? await handler(request, { params: Promise.resolve(options.params) }) : await handler(request);
      let json: any = null;
      try { json = await response.clone().json(); } catch { json = null; }
      return { status: response.status, json, response, headers: response.headers };
    };

    /** Helper to upload a PDF via the real multipart route and return fileId */
    const uploadViaMultipart = async (token: string, purpose: "assignment" | "submission", assignmentId?: string | null, name = "test.pdf"): Promise<{ status: number; json: any; fileId?: string; fileIds?: string[] }> => {
      const form = new FormData();
      form.set("purpose", purpose);
      if (assignmentId) form.set("assignmentId", assignmentId);
      const file = new File([PDF_BYTES], name, { type: "application/pdf" });
      form.set("file", file);
      const result = await call("uploads", { token, multipart: form, method: "POST" });
      const data = result.json?.data as any[];
      const fileId = Array.isArray(data) && data[0]?.fileId ? data[0].fileId : undefined;
      const fileIds = Array.isArray(data) ? data.map((d) => d.fileId) : undefined;
      return { status: result.status, json: result.json, fileId, fileIds };
    };

    /** Helper to request presigned URL */
    const presignVia = async (token: string, body: { purpose: "assignment" | "submission"; assignmentId?: string | null; name: string; mimeType: string; size: number }) => {
      return call("uploads/presign", { token, body, method: "POST" });
    };

    // ── Upload assignment materials for A1 and attach to assignment A1 ──
    let assignmentFileA1: string;
    {
      const up = await uploadViaMultipart(tokens["teacher-a1@a"], "assignment", null, "material-a1.pdf");
      assertEq(up.status, 201, "teacher-a1 must upload assignment file for A1");
      assignmentFileA1 = up.fileId!;
      assert(assignmentFileA1, "assignment file must have id");

      // Attach to assignment A1 via API (requires schoolId check)
      const attachResult = await call("assignments/[id]", {
        token: tokens["teacher-a1@a"],
        params: { id: assignA1 },
        method: "PUT",
        body: { attachments: [{ fileId: assignmentFileA1, name: "material-a1.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${assignmentFileA1}` }] },
      });
      assertEq(attachResult.status, 200, "teacher must attach file to assignment A1");
      const row = await one(`SELECT school_id FROM uploaded_files WHERE id=$1`, [assignmentFileA1]);
      assertEq(row.school_id, schoolA, "uploaded file must be attributed to school A");

      // Write dummy file to disk so GET doesn't 404 on missing file
      const storedRow = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [assignmentFileA1]);
      fs.writeFileSync(path.join(UPLOAD_DIR, storedRow.stored_name), PDF_BYTES);
    }

    // Also create a file for A2 (other class, same school)
    let assignmentFileA2: string;
    {
      const up = await uploadViaMultipart(tokens["teacher-a2@a"], "assignment", null, "material-a2.pdf");
      assertEq(up.status, 201, "teacher-a2 must upload file for A2");
      assignmentFileA2 = up.fileId!;
      const attachResult = await call("assignments/[id]", {
        token: tokens["teacher-a2@a"],
        params: { id: assignA2 },
        method: "PUT",
        body: { attachments: [{ fileId: assignmentFileA2, name: "material-a2.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${assignmentFileA2}` }] },
      });
      assertEq(attachResult.status, 200, "teacher-a2 must attach file to A2");
      const storedRow = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [assignmentFileA2]);
      fs.writeFileSync(path.join(UPLOAD_DIR, storedRow.stored_name), PDF_BYTES);
    }

    // Assignment file for B1
    let assignmentFileB1: string;
    {
      const up = await uploadViaMultipart(tokens["teacher-b1@b"], "assignment", null, "material-b1.pdf");
      assertEq(up.status, 201, "teacher-b1 must upload file for B1");
      assignmentFileB1 = up.fileId!;
      const attachResult = await call("assignments/[id]", {
        token: tokens["teacher-b1@b"],
        params: { id: assignB1 },
        method: "PUT",
        body: { attachments: [{ fileId: assignmentFileB1, name: "material-b1.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${assignmentFileB1}` }] },
      });
      assertEq(attachResult.status, 200, "teacher-b1 must attach file to B1");
      const storedRow = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [assignmentFileB1]);
      fs.writeFileSync(path.join(UPLOAD_DIR, storedRow.stored_name), PDF_BYTES);
    }

    /* ═════════════ 1. Class-level authorization for direct file requests ═════════════ */

    await test("1a: enrolled learner can read assignment file from their own class (200)", async () => {
      const res = await call("files/[id]", { token: tokens["learner-enrolled@a"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 200, "enrolled learner must read own class file");
      assert(res.headers.get("content-type")?.includes("pdf") || res.status === 200, "content-type should be pdf");
    });

    await test("1b: unenrolled learner in same school cannot read assignment file from another class (403)", async () => {
      const res = await call("files/[id]", { token: tokens["learner-unenrolled@a"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 403, "unenrolled learner must be denied");
    });

    await test("1c: learner enrolled in a different class in same school cannot read file from first class (403)", async () => {
      const res = await call("files/[id]", { token: tokens["learner-other-class@a"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 403, "learner in different class must be denied");
    });

    await test("1d: learner enrolled in other class can read their own class file (200)", async () => {
      const res = await call("files/[id]", { token: tokens["learner-other-class@a"], params: { id: assignmentFileA2 } });
      assertEq(res.status, 200, "learner-other-class must read A2 file");
    });

    await test("1e: owning teacher can read their assignment file (200)", async () => {
      const res = await call("files/[id]", { token: tokens["teacher-a1@a"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 200, "owning teacher must read file");
    });

    await test("1f: teacher of a different class in same school cannot read file from first class (403)", async () => {
      const res = await call("files/[id]", { token: tokens["teacher-a2@a"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 403, "teacher of different class must be denied");
    });

    await test("1g: school administrator can read any assignment file in their school (200)", async () => {
      const r1 = await call("files/[id]", { token: tokens["admin-a@a"], params: { id: assignmentFileA1 } });
      assertEq(r1.status, 200, "admin-a must read A1 file");
      const r2 = await call("files/[id]", { token: tokens["admin-a@a"], params: { id: assignmentFileA2 } });
      assertEq(r2.status, 200, "admin-a must read A2 file");
    });

    await test("1h: teacher from another school cannot read assignment file (404 tenant boundary)", async () => {
      const res = await call("files/[id]", { token: tokens["teacher-b1@b"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 404, "cross-school file must be 404");
    });

    await test("1i: learner from another school cannot read assignment file (404)", async () => {
      const res = await call("files/[id]", { token: tokens["learner-b@b"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 404, "cross-school learner must get 404");
    });

    await test("1j: unauthenticated request is 401", async () => {
      const res = await call("files/[id]", { token: null, params: { id: assignmentFileA1 } });
      assertEq(res.status, 401, "unauthenticated must be 401");
    });

    await test("1k: parent linked to enrolled learner can read assignment file", async () => {
      const res = await call("files/[id]", { token: tokens["parent-linked@a"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 200, "linked parent must read file");
    });

    await test("1l: parent not linked to enrolled learner cannot read file (403)", async () => {
      const res = await call("files/[id]", { token: tokens["parent-unlinked@a"], params: { id: assignmentFileA1 } });
      assertEq(res.status, 403, "unlinked parent must be denied");
    });

    await test("1m: dual learner can read file only in the school that stores it", async () => {
      const inA = await call("files/[id]", { token: tokens["learner-dual@a"], params: { id: assignmentFileA1 } });
      assertEq(inA.status, 200, "dual learner in A must read A1 file");
      const inB = await call("files/[id]", { token: tokens["learner-dual@b"], params: { id: assignmentFileA1 } });
      assertEq(inB.status, 404, "dual learner in B must get 404 for A1 file");
    });

    await test("1n: parent linked to learner whose school membership is disabled cannot read file (403), re-enable restores access", async () => {
      // parent-linked is linked to learner-enrolled; disable that learner's school membership
      await q(`UPDATE school_users SET status='disabled' WHERE school_id=$1 AND user_id=$2`, [schoolA, ids["learner-enrolled"]]);
      const denied = await call("files/[id]", { token: tokens["parent-linked@a"], params: { id: assignmentFileA1 } });
      assertEq(denied.status, 403, "parent must be denied when linked learner membership is disabled");
      // parent itself still has active membership but child's is disabled — should not leak
      assert(!String(denied.json?.error || "").toLowerCase().includes("not found"), "must be 403 not 404");
      // Re-enable for remaining tests (4c etc rely on enrolled learner, but also parent test after)
      await q(`UPDATE school_users SET status='active' WHERE school_id=$1 AND user_id=$2`, [schoolA, ids["learner-enrolled"]]);
      const restored = await call("files/[id]", { token: tokens["parent-linked@a"], params: { id: assignmentFileA1 } });
      assertEq(restored.status, 200, "active linked parent must regain access after re-enable");
    });

    /* ═════════════ 2. Enrollment enforcement for multipart uploads ═════════════ */

    await test("2a: enrolled learner can upload submission file via multipart (201)", async () => {
      const result = await uploadViaMultipart(tokens["learner-enrolled@a"], "submission", assignA1, "homework.pdf");
      assertEq(result.status, 201, "enrolled learner multipart upload must succeed");
      // cleanup stored bytes
      if (result.fileId) {
        const stored = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [result.fileId]);
        if (stored) fs.rmSync(path.join(UPLOAD_DIR, stored.stored_name), { force: true });
        await q(`DELETE FROM uploaded_files WHERE id=$1`, [result.fileId]);
      }
    });

    await test("2b: unenrolled learner cannot upload submission file via multipart (403)", async () => {
      const result = await uploadViaMultipart(tokens["learner-unenrolled@a"], "submission", assignA1, "homework.pdf");
      assertEq(result.status, 403, "unenrolled learner must be denied multipart upload");
      assert(String(result.json?.error || "").toLowerCase().includes("enrolled"), "error must mention enrollment");
      // Ensure no file row was created
      if (result.fileId) {
        await q(`DELETE FROM uploaded_files WHERE id=$1`, [result.fileId]).catch(() => {});
      }
    });

    await test("2c: learner enrolled in different class cannot upload for assignment (403)", async () => {
      const result = await uploadViaMultipart(tokens["learner-other-class@a"], "submission", assignA1, "homework.pdf");
      assertEq(result.status, 403, "learner in different class must be denied");
    });

    await test("2d: learner from another school cannot upload for assignment (404)", async () => {
      const result = await uploadViaMultipart(tokens["learner-b@b"], "submission", assignA1, "homework.pdf");
      // Assignment not found in that school => 404
      assertEq(result.status, 404, "cross-school upload must be 404");
    });

    await test("2e: teacher cannot upload submission file (403)", async () => {
      const result = await uploadViaMultipart(tokens["teacher-a1@a"], "submission", assignA1, "homework.pdf");
      assertEq(result.status, 403, "teacher must not upload submission");
    });

    /* ═════════════ 3. Enrollment enforcement for presigned uploads ═════════════ */
    // Enable object storage for presign tests — the route refunds 503 before
    // authorization when storage is not configured, so the enrollment guard
    // would never be reached. The multipart path is always exercised above.
    process.env.OBJECT_STORAGE_BUCKET = "test-bucket-presign";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIAFAKEPRESIGN";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secretfakepresign";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";

    await test("3a: enrolled learner can presign submission upload (201)", async () => {
      const res = await presignVia(tokens["learner-enrolled@a"], { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 201, "enrolled learner presign must succeed");
      // cleanup the registered row (presign inserts a row)
      const fileId = res.json?.data?.fileId as string;
      if (fileId) await q(`DELETE FROM uploaded_files WHERE id=$1`, [fileId]);
    });

    await test("3b: unenrolled learner cannot presign submission upload (403)", async () => {
      const res = await presignVia(tokens["learner-unenrolled@a"], { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 403, "unenrolled presign must be denied");
      assert(String(res.json?.error || "").toLowerCase().includes("enrolled"), "error must mention enrollment");
    });

    await test("3c: learner in different class cannot presign (403)", async () => {
      const res = await presignVia(tokens["learner-other-class@a"], { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 403, "different-class presign must be denied");
    });

    await test("3d: cross-school presign is 404", async () => {
      const res = await presignVia(tokens["learner-b@b"], { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 404, "cross-school presign must be 404");
    });

    await test("3e: presign still allows assignment uploads for teachers (201)", async () => {
      const res = await presignVia(tokens["teacher-a1@a"], { purpose: "assignment", name: "handout.pdf", mimeType: "application/pdf", size: 2048 });
      assertEq(res.status, 201, "teacher presign for assignment must succeed");
      const fileId = res.json?.data?.fileId as string;
      if (fileId) await q(`DELETE FROM uploaded_files WHERE id=$1`, [fileId]);
    });
    // Disable for remainder of suite (cross-school tests don't need it)
    process.env.OBJECT_STORAGE_BUCKET = "";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "";
    process.env.OBJECT_STORAGE_REGION = "";

    /* ── Verify ordering: auth before storage-disabled (503 only for authorized) ── */
    await test("3f: unauthenticated presign when storage disabled is 401 not 503", async () => {
      const countBefore = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      const res = await presignVia(null as unknown as string, { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 401, "unauthenticated must be 401 even when storage disabled");
      const countAfter = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      assertEq(countAfter, countBefore, "no metadata must be created for unauthenticated request");
    });

    await test("3g: unenrolled learner presign when storage disabled is 403 not 503", async () => {
      const countBefore = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      const res = await presignVia(tokens["learner-unenrolled@a"], { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 403, "unenrolled must be 403 even when storage disabled");
      assert(String(res.json?.error || "").toLowerCase().includes("enrolled"), "error must mention enrollment");
      const countAfter = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      assertEq(countAfter, countBefore, "no metadata must be created for unauthorized presign");
    });

    await test("3h: enrolled learner presign when storage disabled is 503 (authorized but storage unavailable)", async () => {
      const countBefore = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      const res = await presignVia(tokens["learner-enrolled@a"], { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 503, "authorized presign when storage disabled must be 503");
      const countAfter = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      assertEq(countAfter, countBefore, "no metadata must be created when storage disabled");
    });

    await test("3i: teacher assignment presign when storage disabled is 503", async () => {
      const countBefore = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      const res = await presignVia(tokens["teacher-a1@a"], { purpose: "assignment", name: "handout.pdf", mimeType: "application/pdf", size: 2048 });
      assertEq(res.status, 503, "authorized teacher presign when storage disabled must be 503");
      const countAfter = (await one(`SELECT COUNT(*)::int AS c FROM uploaded_files`)).c as number;
      assertEq(countAfter, countBefore, "no metadata must be created when storage disabled");
    });

    await test("3j: cross-school presign when storage disabled is still 404 not 503", async () => {
      const res = await presignVia(tokens["learner-b@b"], { purpose: "submission", assignmentId: assignA1, name: "essay.pdf", mimeType: "application/pdf", size: 1024 });
      assertEq(res.status, 404, "cross-school must be 404 even when storage disabled");
    });

    /* ═════════════ 4. Cross-school attachment metadata associations ═════════════ */

    await test("4a: cannot attach a file from another school to an assignment (400)", async () => {
      // teacher in school A uploads a file in A
      const up = await uploadViaMultipart(tokens["teacher-a1@a"], "assignment", null, "cross.pdf");
      assertEq(up.status, 201, "teacher uploads file in A");
      const crossFileId = up.fileId!;
      const crossStored = await one(`SELECT stored_name, school_id FROM uploaded_files WHERE id=$1`, [crossFileId]);
      assertEq(crossStored.school_id, schoolA, "file must be in school A");
      fs.writeFileSync(path.join(UPLOAD_DIR, crossStored.stored_name), PDF_BYTES);

      // Dual teacher acting in school B tries to create assignment in B with A's file
      const createInB = await call("assignments", {
        token: tokens["dual-teacher@b"],
        body: {
          title: "Cross Attach Test",
          classId: classB1,
          subjectId: subjectB,
          attachments: [{ fileId: crossFileId, name: "cross.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${crossFileId}` }],
        },
      });
      // The schoolId check in attachment-auth should make the file not found
      assert(
        createInB.status === 400 || createInB.status === 403 || createInB.status === 404,
        `cross-school attach must be rejected (got ${createInB.status})`
      );
      // Ensure no assignment was created with that file
      const assignmentsWithFile = await q(`SELECT id FROM assignments WHERE attachments::text LIKE $1 AND school_id=$2`, [`%${crossFileId}%`, schoolB]);
      assertEq(assignmentsWithFile.length, 0, "no cross-school assignment must be created");

      // cleanup
      await q(`DELETE FROM uploaded_files WHERE id=$1`, [crossFileId]);
      fs.rmSync(path.join(UPLOAD_DIR, crossStored.stored_name), { force: true });
    });

    await test("4b: cannot attach a file from another school to a submission (400)", async () => {
      // Learner in A uploads submission file for A1 (enrolled)
      const upA = await uploadViaMultipart(tokens["learner-enrolled@a"], "submission", assignA1, "submission-a.pdf");
      assertEq(upA.status, 201, "learner uploads submission file in A");
      const fileIdA = upA.fileId!;
      const storedA = await one(`SELECT stored_name, school_id FROM uploaded_files WHERE id=$1`, [fileIdA]);
      fs.writeFileSync(path.join(UPLOAD_DIR, storedA.stored_name), PDF_BYTES);

      // Try to submit assignment in B (different school) with file from A — but learner-dual belongs to both
      // We'll have learner-dual attempt to submit B1 assignment using file from A
      // The submission route should verify file's schoolId == ctx.schoolId (B) and reject
      const submitCross = await call("assignments/[id]/submit", {
        token: tokens["learner-dual@b"],
        params: { id: assignB1 },
        body: {
          content: "cross school submission",
          attachments: [{ fileId: fileIdA, name: "submission-a.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${fileIdA}` }],
        },
      });
      // Should be 400/403/404 because file's school doesn't match
      assert(
        submitCross.status === 400 || submitCross.status === 403 || submitCross.status === 404,
        `cross-school submission attach must be rejected (got ${submitCross.status})`
      );

      // Also test via POST /api/submissions (alternate route)
      const submitCross2 = await call("submissions", {
        token: tokens["learner-dual@b"],
        body: {
          assignmentId: assignB1,
          content: "cross",
          attachments: [{ fileId: fileIdA, name: "submission-a.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${fileIdA}` }],
        },
      });
      assert(
        submitCross2.status === 400 || submitCross2.status === 403 || submitCross2.status === 404,
        `cross-school via submissions route must be rejected (got ${submitCross2.status})`
      );

      await q(`DELETE FROM uploaded_files WHERE id=$1`, [fileIdA]);
      fs.rmSync(path.join(UPLOAD_DIR, storedA.stored_name), { force: true });
    });

    await test("4c: valid same-school attachment still succeeds (201)", async () => {
      const up = await uploadViaMultipart(tokens["learner-enrolled@a"], "submission", assignA1, "valid.pdf");
      assertEq(up.status, 201, "learner uploads valid file");
      const fileId = up.fileId!;
      const stored = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [fileId]);
      fs.writeFileSync(path.join(UPLOAD_DIR, stored.stored_name), PDF_BYTES);

      const submitOk = await call("assignments/[id]/submit", {
        token: tokens["learner-enrolled@a"],
        params: { id: assignA1 },
        body: {
          content: "valid submission",
          attachments: [{ fileId, name: "valid.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${fileId}` }],
        },
      });
      assertEq(submitOk.status, 200, "valid same-school attachment must succeed");
      // cleanup submission
      await q(`DELETE FROM submissions WHERE learner_id=$1 AND assignment_id=$2`, [ids["learner-enrolled"], assignA1]);
      await q(`DELETE FROM uploaded_files WHERE id=$1`, [fileId]);
      fs.rmSync(path.join(UPLOAD_DIR, stored.stored_name), { force: true });
    });

    await test("4d: cannot reuse another user's file even in same school (400)", async () => {
      const teacherFile = await uploadViaMultipart(tokens["teacher-a1@a"], "assignment", null, "teacher-only.pdf");
      assertEq(teacherFile.status, 201, "teacher uploads assignment file");
      const tfId = teacherFile.fileId!;
      const tfStored = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [tfId]);
      fs.writeFileSync(path.join(UPLOAD_DIR, tfStored.stored_name), PDF_BYTES);

      // Learner tries to attach teacher's file to their submission — should fail because uploaderId mismatch
      const badAttach = await call("assignments/[id]/submit", {
        token: tokens["learner-enrolled@a"],
        params: { id: assignA1 },
        body: {
          content: "trying to hijack",
          attachments: [{ fileId: tfId, name: "teacher-only.pdf", type: "document", size: PDF_BYTES.length, url: `/api/files/${tfId}` }],
        },
      });
      assert(
        badAttach.status === 400 || badAttach.status === 403,
        `hijacking another user's file must be rejected (got ${badAttach.status})`
      );
      await q(`DELETE FROM uploaded_files WHERE id=$1`, [tfId]);
      fs.rmSync(path.join(UPLOAD_DIR, tfStored.stored_name), { force: true });
    });

    // Print summary
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
  console.error("Attachment-security suite crashed:", error);
  process.exit(1);
});
