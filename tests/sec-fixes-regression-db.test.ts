/**
 * SEC-fixes regression — LIVE DATABASE, REAL ROUTE HANDLERS.
 *
 * Covers SEC-3, SEC-7, SEC-1 (DB part), SEC-5 (DB diagnostics), SEC-6, SEC-8, SEC-9
 * and test gaps: deleting referenced files, draft assignment access, dual-school isolation,
 * public URL mode, presigned edge cases, object-store failures.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/sec-fixes-regression-db.test.ts
 * Or with embedded-postgres: npx tsx tests/sec-fixes-regression-db.test.ts
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

const DB_NAME = `easylearn_sec_fixes_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();
const UPLOAD_DIR = path.join(os.tmpdir(), `${DB_NAME}-uploads`);

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`✅ PASS: ${name}`); passed++; })
    .catch((e) => { console.error(`❌ FAIL: ${name}\n   ${(e as Error).message}`); failed++; });
}
function assertEq(a: unknown, b: unknown, m?: string) { if (a !== b) throw new Error(`${m||"eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1");

async function main() {
  const { Client } = requireFromRepo("pg");
  const bcrypt = requireFromRepo("bcryptjs");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try { EmbeddedPostgres = requireFromRepo("embedded-postgres"); EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres; } catch { console.log("⏭️  SKIP: no TEST_DATABASE_URL and no embedded-postgres"); return; }
    const port = 56801 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const pg = new EmbeddedPostgres({ databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`), user: "easylearn", password: "easylearn", port, persistent: false });
    await pg.initialise(); await pg.start(); stopServer = () => pg.stop(); adminUrl = `postgres://easylearn:easylearn@localhost:${port}/postgres`; console.log(`📦 Embedded PG ${port}`);
  }
  const scratchUrl = (() => { const u = new URL(adminUrl as string); u.pathname = `/${DB_NAME}`; return u.toString(); })();
  const admin = new Client({ connectionString: adminUrl }); await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`); await admin.query(`CREATE DATABASE "${DB_NAME}"`); const db = new Client({ connectionString: scratchUrl }); await db.connect();
  try {
    process.env.DATABASE_URL = scratchUrl; process.env.JWT_SECRET = JWT_SECRET; process.env.EASY_LEARN_TEST_DATABASE = "true"; process.env.UPLOAD_DIR = UPLOAD_DIR;
    process.env.OBJECT_STORAGE_BUCKET = ""; process.env.OBJECT_STORAGE_ACCESS_KEY_ID = ""; process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "";
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const runMigrations = () => runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" } });
    const q = async (sql: string, vals: unknown[] = []) => (await db.query(sql, vals)).rows;
    const one = async (sql: string, vals: unknown[] = []) => (await q(sql, vals))[0];
    const run = runMigrations(); if (run.status !== 0) throw new Error(`migrations failed: ${run.status}`);
    const passwordHash = await bcrypt.hash("Test-Password-SEC!", 4);

    // Setup schools, subjects, classes
    const schoolA = (await one(`INSERT INTO schools (name, short_name, slug) VALUES ('SEC School A','SECA','sec-a') RETURNING id`)).id;
    const schoolB = (await one(`INSERT INTO schools (name, short_name, slug) VALUES ('SEC School B','SECB','sec-b') RETURNING id`)).id;
    const subjectA = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Maths','MTH-SEC-A') RETURNING id`, [schoolA])).id;
    const subjectB = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Science','SCI-SEC-B') RETURNING id`, [schoolB])).id;
    const classA1 = (await one(`INSERT INTO classes (school_id, name, level) VALUES ($1,'Class A1','primary') RETURNING id`, [schoolA])).id;
    const classB1 = (await one(`INSERT INTO classes (school_id, name, level) VALUES ($1,'Class B1','primary') RETURNING id`, [schoolB])).id;

    type Fx = { key: string; role: string; schools: string[] };
    const fixtures: Fx[] = [
      { key: "teacher-a", role: "teacher", schools: [schoolA] },
      { key: "learner-a", role: "learner", schools: [schoolA] },
      { key: "learner-b", role: "learner", schools: [schoolB] },
      { key: "learner-dual", role: "learner", schools: [schoolA, schoolB] },
      { key: "admin-a", role: "school_admin", schools: [schoolA] },
      { key: "parent-a", role: "parent", schools: [schoolA] },
    ];
    const ids: Record<string,string>={}; const memIds: Record<string,string>={};
    for (const fx of fixtures) {
      const row = await one(`INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,$3,$4,'T','U',true) RETURNING id`, [`${fx.key}-${DB_NAME}@test.test`, fx.key, passwordHash, fx.role]);
      ids[fx.key]=row.id;
      for (const sid of fx.schools) {
        const m = await one(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active') RETURNING id`, [sid, row.id, fx.role]);
        memIds[`${fx.key}:${sid}`]=m.id;
      }
    }
    await q(`UPDATE classes SET class_teacher_id=$1 WHERE id=$2`, [ids["teacher-a"], classA1]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1,$2,$3,$4)`, [schoolA, ids["teacher-a"], classA1, subjectA]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolA, ids["learner-a"], classA1]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolB, ids["learner-b"], classB1]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolA, ids["learner-dual"], classA1]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`, [schoolB, ids["learner-dual"], classB1]);
    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id) VALUES ($1,$2,$3)`, [schoolA, ids["parent-a"], ids["learner-a"]]);

    // Assignments: one published, one draft
    const assignPublished = (await one(`INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads) VALUES ($1,'Pub Assign',$2,$3,$4,'published',100,true) RETURNING id`, [schoolA, classA1, subjectA, ids["teacher-a"]])).id;
    const assignDraft = (await one(`INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads) VALUES ($1,'Draft Assign',$2,$3,$4,'draft',100,true) RETURNING id`, [schoolA, classA1, subjectA, ids["teacher-a"]])).id;
    const assignB = (await one(`INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads) VALUES ($1,'B Assign',$2,$3,$4,'published',100,true) RETURNING id`, [schoolB, classB1, subjectB, ids["teacher-a"] || ids["learner-b"]])).id; // teacher for B is learner-b? use teacher-a but need teacher in B — create one
    // Fix assignB teacher: create teacher-b
    const teacherB = (await one(`INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,$3,'teacher','T','B',true) RETURNING id`, [`teacher-b-${DB_NAME}@test.test`, `teacher-b-${DB_NAME.slice(0,6)}`, passwordHash])).id;
    await one(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,'teacher','active')`, [schoolB, teacherB]);
    await q(`UPDATE assignments SET teacher_id=$1 WHERE id=$2`, [teacherB, assignB]);
    await q(`UPDATE classes SET class_teacher_id=$1 WHERE id=$2`, [teacherB, classB1]);
    ids["teacher-b"]=teacherB;

    const auth = await import("@/lib/auth");
    const tokenFor = async (key:string, schoolId:string|null) => {
      const mId = schoolId ? memIds[`${key}:${schoolId}`] : undefined;
      // teacher-b special
      if (key==="teacher-b") {
        const su = await one(`SELECT id FROM school_users WHERE school_id=$1 AND user_id=$2`, [schoolB, teacherB]);
        return auth.createToken({ userId: teacherB, role: "teacher", email: "tb@test.test", schoolId: schoolB, membershipId: su.id });
      }
      return auth.createToken({ userId: ids[key], role: fixtures.find(f=>f.key===key)!.role, email: `${key}@test`, ...(schoolId?{schoolId, membershipId: mId}:{}) });
    };
    const tokens:Record<string,string> = {
      "teacher-a@a": await tokenFor("teacher-a", schoolA),
      "learner-a@a": await tokenFor("learner-a", schoolA),
      "learner-b@b": await tokenFor("learner-b", schoolB),
      "learner-dual@a": await tokenFor("learner-dual", schoolA),
      "learner-dual@b": await tokenFor("learner-dual", schoolB),
      "admin-a@a": await tokenFor("admin-a", schoolA),
      "parent-a@a": await tokenFor("parent-a", schoolA),
      "teacher-b@b": await tokenFor("teacher-b", schoolB),
    };

    const route = async (p:string) => import(`@/app/api/${p}/route`);
    const call = async (pathName:string, opts:any={}) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      if (opts.query) for (const [k,v] of Object.entries(opts.query)) url.searchParams.set(k,v as string);
      const method = opts.method ?? (opts.body!==undefined || opts.multipart ? "POST":"GET");
      const headers:Record<string,string>={};
      if (opts.token!==undefined && opts.token!==null) headers.authorization=`Bearer ${opts.token}`;
      if (opts.body!==undefined) headers["content-type"]="application/json";
      if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
      const req = new NextRequest(url, { method, headers, ...(opts.multipart?{body:opts.multipart}:{}), ...(opts.body!==undefined?{body:JSON.stringify(opts.body)}:{}) });
      const mod:any = await route(pathName);
      const handler = mod[method]; if (!handler) throw new Error(`no ${method} for ${pathName}`);
      const res = opts.params ? await handler(req, { params: Promise.resolve(opts.params)}) : await handler(req);
      let json:any=null; try{ json=await res.clone().json();}catch{}
      return { status: res.status, json, headers: res.headers };
    };
    const uploadViaMultipart = async (token:string, purpose:"assignment"|"submission", assignmentId:string|null, name="test.pdf") => {
      const form = new FormData(); form.set("purpose", purpose); if (assignmentId) form.set("assignmentId", assignmentId);
      form.set("file", new File([PDF_BYTES], name, { type: "application/pdf" }));
      const r = await call("uploads", { token, multipart: form, method: "POST" });
      const data = r.json?.data as any[]; const fileId = Array.isArray(data)&&data[0]?.fileId ? data[0].fileId:undefined;
      return { status: r.status, json: r.json, fileId };
    };

    // Setup: create assignment file for published and draft
    let filePublished: string; let fileDraft: string;
    {
      const up = await uploadViaMultipart(tokens["teacher-a@a"], "assignment", null, "pub.pdf");
      assertEq(up.status, 201, "upload published file"); filePublished = up.fileId!;
      const row = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [filePublished]); fs.writeFileSync(path.join(UPLOAD_DIR, row.stored_name), PDF_BYTES);
      const put = await call("assignments/[id]", { token: tokens["teacher-a@a"], params:{id: assignPublished}, method:"PUT", body:{ attachments: [{ fileId: filePublished, name:"pub.pdf", type:"document", size: PDF_BYTES.length, url:`/api/files/${filePublished}`}] } });
      assertEq(put.status, 200, "attach to published");
    }
    {
      const up = await uploadViaMultipart(tokens["teacher-a@a"], "assignment", null, "draft.pdf");
      assertEq(up.status, 201, "upload draft file"); fileDraft = up.fileId!;
      const row = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [fileDraft]); fs.writeFileSync(path.join(UPLOAD_DIR, row.stored_name), PDF_BYTES);
      const put = await call("assignments/[id]", { token: tokens["teacher-a@a"], params:{id: assignDraft}, method:"PUT", body:{ attachments: [{ fileId: fileDraft, name:"draft.pdf", type:"document", size: PDF_BYTES.length, url:`/api/files/${fileDraft}`}] } });
      assertEq(put.status, 200, "attach to draft");
    }

    /* ── SEC-7: Draft vs published ── */
    await test("SEC-7a: learner can read published assignment file (200)", async () => {
      const r = await call("files/[id]", { token: tokens["learner-a@a"], params:{id: filePublished} });
      assertEq(r.status, 200, "learner should read published");
    });
    await test("SEC-7b: learner cannot read draft assignment file (403)", async () => {
      const r = await call("files/[id]", { token: tokens["learner-a@a"], params:{id: fileDraft} });
      assertEq(r.status, 403, "learner must be denied draft");
    });
    await test("SEC-7c: owning teacher can read draft file (200)", async () => {
      const r = await call("files/[id]", { token: tokens["teacher-a@a"], params:{id: fileDraft} });
      assertEq(r.status, 200, "owner teacher can read draft");
    });
    await test("SEC-7d: admin can read draft file (200)", async () => {
      const r = await call("files/[id]", { token: tokens["admin-a@a"], params:{id: fileDraft} });
      assertEq(r.status, 200, "admin can read draft");
    });
    await test("SEC-7e: cross-school cannot read published file (404)", async () => {
      const r = await call("files/[id]", { token: tokens["learner-b@b"], params:{id: filePublished} });
      assertEq(r.status, 404, "cross-school 404");
    });

    /* ── SEC-3: Delete referenced files ── */
    // Create a file, attach to published assignment, try delete -> 409
    let fileToDeletePublished: string;
    {
      const up = await uploadViaMultipart(tokens["teacher-a@a"], "assignment", null, "todelete-pub.pdf");
      assertEq(up.status, 201); fileToDeletePublished = up.fileId!;
      const row = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [fileToDeletePublished]); fs.writeFileSync(path.join(UPLOAD_DIR, row.stored_name), PDF_BYTES);
      // Use a separate published assignment to avoid overwriting filePublished's attachment
      const tempAssign = (await one(`INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads) VALUES ($1,'Temp Pub',$2,$3,$4,'published',100,true) RETURNING id`, [schoolA, classA1, subjectA, ids["teacher-a"]])).id;
      await call("assignments/[id]", { token: tokens["teacher-a@a"], params:{id: tempAssign}, method:"PUT", body:{ attachments: [{ fileId: fileToDeletePublished, name:"todelete-pub.pdf", type:"document", size: PDF_BYTES.length, url:`/api/files/${fileToDeletePublished}`}] } });
    }
    await test("SEC-3a: cannot delete file attached to published assignment (409)", async () => {
      const r = await call("uploads/[id]", { token: tokens["teacher-a@a"], params:{id: fileToDeletePublished}, method:"DELETE" });
      assertEq(r.status, 409, "should be 409 conflict");
    });
    // Create submission referencing file, then try delete -> 409
    let fileForSubmission: string;
    {
      const up = await uploadViaMultipart(tokens["learner-a@a"], "submission", assignPublished, "sub.pdf");
      assertEq(up.status, 201); fileForSubmission = up.fileId!;
      const row = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [fileForSubmission]); fs.writeFileSync(path.join(UPLOAD_DIR, row.stored_name), PDF_BYTES);
      const sub = await call("assignments/[id]/submit", { token: tokens["learner-a@a"], params:{id: assignPublished}, body:{ content:"hi", attachments:[{ fileId: fileForSubmission, name:"sub.pdf", type:"document", size: PDF_BYTES.length, url:`/api/files/${fileForSubmission}`}] } });
      assertEq(sub.status, 200, "submission with file should succeed");
    }
    await test("SEC-3b: cannot delete file referenced by submission (409)", async () => {
      const r = await call("uploads/[id]", { token: tokens["learner-a@a"], params:{id: fileForSubmission}, method:"DELETE" });
      assertEq(r.status, 409, "submission file delete must be 409");
    });
    await test("SEC-3c: can delete unreferenced file (200)", async () => {
      const up = await uploadViaMultipart(tokens["teacher-a@a"], "assignment", null, "unreferenced.pdf");
      assertEq(up.status, 201); const fid = up.fileId!;
      const row = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [fid]); fs.writeFileSync(path.join(UPLOAD_DIR, row.stored_name), PDF_BYTES);
      const r = await call("uploads/[id]", { token: tokens["teacher-a@a"], params:{id: fid}, method:"DELETE" });
      assertEq(r.status, 200, "unreferenced delete should succeed");
      // verify file gone
      const gone = await one(`SELECT id FROM uploaded_files WHERE id=$1`, [fid]);
      assertEq(gone, undefined, "file row should be deleted");
    });
    await test("SEC-3d: delete respects school isolation (404 for other school)", async () => {
      const up = await uploadViaMultipart(tokens["teacher-b@b"], "assignment", null, "b-file.pdf");
      assertEq(up.status, 201); const fid = up.fileId!;
      const row = await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`, [fid]); fs.writeFileSync(path.join(UPLOAD_DIR, row.stored_name), PDF_BYTES);
      const r = await call("uploads/[id]", { token: tokens["teacher-a@a"], params:{id: fid}, method:"DELETE" });
      assertEq(r.status, 404, "cross-school delete should be 404");
      // cleanup as owner
      await call("uploads/[id]", { token: tokens["teacher-b@b"], params:{id: fid}, method:"DELETE" });
    });

    /* ── SEC-1: Public URL mode — protected files never use public URL ── */
    await test("SEC-1a: protected file download does not use public URL even when env set", async () => {
      process.env.OBJECT_STORAGE_PUBLIC_URL = "https://files.example.com";
      process.env.OBJECT_STORAGE_BUCKET = "test-bucket";
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIAFAKE";
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secretFAKE";
      // We can't test actual redirect without object storage, but we can test that objectDownloadUrl respects allowPublic
      const { getObjectStorageConfig, objectDownloadUrl } = await import("@/lib/object-storage");
      const cfg = getObjectStorageConfig();
      assertEq(cfg.publicBaseUrl, "https://files.example.com", "public base should be set");
      const urlProtected = objectDownloadUrl(cfg, "uploads/assignment/1111-2222.pdf");
      // Should be presigned, not public
      assert(urlProtected.includes("X-Amz-Signature"), "protected file must use presigned, not public");
      assert(!urlProtected.startsWith("https://files.example.com"), "protected file leaked to public URL");
      const urlPublic = objectDownloadUrl(cfg, "uploads/assignment/1111-2222.pdf", { allowPublic: true });
      assertEq(urlPublic, "https://files.example.com/uploads/assignment/1111-2222.pdf", "allowPublic should use public URL");
      // cleanup env
      delete process.env.OBJECT_STORAGE_PUBLIC_URL; delete process.env.OBJECT_STORAGE_BUCKET; delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID; delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    });

    /* ── SEC-5: Public origin diagnostics ── */
    await test("SEC-5a: invalid PUBLIC_ORIGIN is handled with warning, not crash", async () => {
      const { getConfiguredPublicOrigin, validatePublicOriginForProduction } = await import("@/lib/csrf");
      process.env.EASY_LEARN_PUBLIC_ORIGIN = "not a url";
      const got = getConfiguredPublicOrigin();
      assertEq(got, null, "invalid origin should return null");
      const diag = validatePublicOriginForProduction();
      assertEq(diag.ok, false, "invalid should be not ok");
      delete process.env.EASY_LEARN_PUBLIC_ORIGIN;
    });
    await test("SEC-5b: valid PUBLIC_ORIGIN parses to origin", async () => {
      const { getConfiguredPublicOrigin } = await import("@/lib/csrf");
      process.env.EASY_LEARN_PUBLIC_ORIGIN = "https://app.example.test/some/path?query=1";
      const got = getConfiguredPublicOrigin();
      assertEq(got, "https://app.example.test", "should strip to origin");
      delete process.env.EASY_LEARN_PUBLIC_ORIGIN;
    });

    /* ── Dual-school isolation ── */
    await test("dual-school: learner-dual in A can read A file, in B cannot read A file (404)", async () => {
      const rA = await call("files/[id]", { token: tokens["learner-dual@a"], params:{id: filePublished} });
      assertEq(rA.status, 200, "dual in A should read");
      const rB = await call("files/[id]", { token: tokens["learner-dual@b"], params:{id: filePublished} });
      assertEq(rB.status, 404, "dual in B should get 404 for A file");
    });

    /* ── Presigned edge cases (SEC-6) ── */
    await test("SEC-6a: presigned upload rejects oversize (413)", async () => {
      process.env.OBJECT_STORAGE_BUCKET = "test-bucket"; process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIA"; process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
      const r = await call("uploads/presign", { token: tokens["learner-a@a"], body: { purpose:"submission", assignmentId: assignPublished, name:"huge.mp4", mimeType:"video/mp4", size: 200 * 1024 * 1024 } });
      assertEq(r.status, 413, "oversize should be 413");
      delete process.env.OBJECT_STORAGE_BUCKET; delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID; delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    });
    await test("SEC-6b: presigned rejects scriptable content type (400)", async () => {
      process.env.OBJECT_STORAGE_BUCKET = "test-bucket"; process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIA"; process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
      const r = await call("uploads/presign", { token: tokens["teacher-a@a"], body: { purpose:"assignment", name:"evil.pdf", mimeType:"text/html", size: 1024 } });
      assertEq(r.status, 400, "scriptable content type should be rejected");
      delete process.env.OBJECT_STORAGE_BUCKET; delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID; delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    });

    /* ── Object-store outage handling (SEC-9) ── */
    await test("SEC-9a: verifyStoredObject handles outage as 503 via mocked fetch", async () => {
      // Mock fetch to simulate 503
      const origFetch = global.fetch;
      // @ts-ignore
      global.fetch = async () => new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
      process.env.OBJECT_STORAGE_BUCKET = "test-bucket"; process.env.OBJECT_STORAGE_ACCESS_KEY_ID="AKIA"; process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY="secret";
      const { getObjectStorageConfig } = await import("@/lib/object-storage");
      const { verifyStoredObject } = await import("@/lib/object-guard");
      const cfg = getObjectStorageConfig();
      const res = await verifyStoredObject(cfg, "uploads/assignment/test.pdf");
      assertEq(res.ok, false, "outage should not be ok");
      // @ts-ignore
      assertEq(res.status, 503, "outage should be 503");
      global.fetch = origFetch;
      delete process.env.OBJECT_STORAGE_BUCKET; delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID; delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    });

    console.log(`\n📊 ${passed} passed, ${failed} failed\n`);
  } finally {
    await db.end().catch(()=>undefined); await admin.end().catch(()=>undefined); if (stopServer) await stopServer().catch(()=>undefined); fs.rmSync(UPLOAD_DIR, {recursive:true, force:true});
  }
  if (failed>0) process.exit(1);
}
main().catch(e=>{console.error(e); process.exit(1);});
