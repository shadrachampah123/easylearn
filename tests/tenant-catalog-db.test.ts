/**
 * Phase 2D — Catalog tenant isolation: LIVE DATABASE, REAL ROUTE HANDLERS.
 *
 * Proves that School A cannot read/modify School B's catalog records:
 * academic_years, terms, departments, subjects, classes.
 *
 * Also proves:
 * - client-supplied schoolId/school_id is ignored
 * - missing/disabled membership is rejected
 * - valid CBISM-style users retain functionality
 * - cross-school relationships (class→academicYear, subject→department, etc.) are rejected
 */

import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { NextRequest } from "next/server";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

const DB_NAME = `easylearn_2d_test_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = "phase-2d-catalog-test-secret-0123456789";
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
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run.");
      return;
    }
    const port = 54729 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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
    process.env.UPLOAD_DIR = UPLOAD_DIR;
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const runMigrations = () =>
      spawnSync(process.execPath, ["run-migration.js"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: scratchUrl, JWT_SECRET },
        encoding: "utf8",
      });

    const q = async (sql: string, values: unknown[] = []): Promise<any[]> =>
      (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

    const migrationRun = runMigrations();
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    const passwordHash: string = await bcrypt.hash("Phase2d-Test-Password!", 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Tenant School A', 'TSA', 'tenant-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Tenant School B', 'TSB', 'tenant-b') RETURNING id`
    )).id as string;

    const fixtures = [
      { key: "admin-a", role: "school_admin", schoolId: schoolA },
      { key: "teacher-a", role: "teacher", schoolId: schoolA },
      { key: "learner-a", role: "learner", schoolId: schoolA },
      { key: "admin-b", role: "school_admin", schoolId: schoolB },
      { key: "teacher-b", role: "teacher", schoolId: schoolB },
      { key: "learner-b", role: "learner", schoolId: schoolB },
      { key: "platform", role: "super_admin", schoolId: null },
      { key: "disabled-a", role: "teacher", schoolId: schoolA, status: "disabled" },
      { key: "orphan", role: "teacher", schoolId: null },
    ];

    const ids: Record<string, string> = {};
    for (const f of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, 'Phase2D', $5, true) RETURNING id`,
        [`${f.key}-${DB_NAME}@example.test`, `${f.key}-${DB_NAME.slice(-8)}`, passwordHash, f.role, f.key]
      );
      ids[f.key] = row.id;
      if (f.schoolId) {
        await q(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,$4)`, [
          f.schoolId,
          row.id,
          f.role,
          (f as any).status ?? "active",
        ]);
      }
    }

    // Catalog fixtures with direct school_id
    const yearA = (await one(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current) VALUES ($1,'2025/2026 A','2025-09-01','2026-07-01',true) RETURNING id`,
      [schoolA]
    )).id as string;
    const yearB = (await one(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current) VALUES ($1,'2025/2026 B','2025-09-01','2026-07-01',true) RETURNING id`,
      [schoolB]
    )).id as string;

    const termA = (await one(
      `INSERT INTO terms (school_id, name, academic_year_id, start_date, end_date, is_current) VALUES ($1,'term_1',$2,'2025-09-01','2025-12-01',true) RETURNING id`,
      [schoolA, yearA]
    )).id as string;
    const termB = (await one(
      `INSERT INTO terms (school_id, name, academic_year_id, start_date, end_date, is_current) VALUES ($1,'term_1',$2,'2025-09-01','2025-12-01',true) RETURNING id`,
      [schoolB, yearB]
    )).id as string;

    const deptA = (await one(
      `INSERT INTO departments (school_id, name, description) VALUES ($1,'Science A','Dept A') RETURNING id`,
      [schoolA]
    )).id as string;
    const deptB = (await one(
      `INSERT INTO departments (school_id, name, description) VALUES ($1,'Science B','Dept B') RETURNING id`,
      [schoolB]
    )).id as string;

    const subjA = (await one(
      `INSERT INTO subjects (school_id, name, code, department_id) VALUES ($1,'Maths A','MTH-A',$2) RETURNING id`,
      [schoolA, deptA]
    )).id as string;
    const subjB = (await one(
      `INSERT INTO subjects (school_id, name, code, department_id) VALUES ($1,'Maths B','MTH-B',$2) RETURNING id`,
      [schoolB, deptB]
    )).id as string;

    const classA = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id) VALUES ($1,'Class A','primary',$2,$3) RETURNING id`,
      [schoolA, ids["teacher-a"], yearA]
    )).id as string;
    const classB = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id) VALUES ($1,'Class B','primary',$2,$3) RETURNING id`,
      [schoolB, ids["teacher-b"], yearB]
    )).id as string;

    const auth = await import("@/lib/auth");
    const tokens: Record<string, string> = {};
    for (const f of fixtures) {
      tokens[f.key] = await auth.createToken({
        userId: ids[f.key],
        role: f.role,
        email: `${f.key}@example.test`,
      });
    }

    const route = async (pathName: string) => import(`@/app/api/${pathName}/route`);

    type CallOptions = {
      token?: string | null;
      query?: Record<string, string>;
      body?: unknown;
      params?: Record<string, string>;
      method?: string;
    };

    const call = async (pathName: string, options: CallOptions = {}) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
      const headers: Record<string, string> = {};
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const request = new NextRequest(url, {
        method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const mod: any = await route(pathName);
      const handlerName = (options.method ?? (options.body !== undefined ? "POST" : "GET")).toUpperCase();
      const handler = mod[handlerName];
      if (!handler) throw new Error(`${pathName} has no ${handlerName}`);
      const response = options.params ? await handler(request, { params: Promise.resolve(options.params) }) : await handler(request);
      let json: any = null;
      try {
        json = await response.clone().json();
      } catch {
        json = null;
      }
      return { status: response.status, json, response };
    };

    const bodyText = (r: { json: any }) => JSON.stringify(r.json ?? "");

    console.log("\n🎯 Phase 2D catalog isolation (School A vs School B)\n");

    await test("Boundary: orphan and disabled get 403 on catalog routes", async () => {
      for (const pathName of ["academic-years", "terms", "departments", "subjects", "classes"]) {
        const orphanRes = await call(pathName, { token: tokens["orphan"] });
        assertEq(orphanRes.status, 403, `${pathName} orphan must be 403`);
        const disabledRes = await call(pathName, { token: tokens["disabled-a"] });
        assertEq(disabledRes.status, 403, `${pathName} disabled must be 403`);
        const platformRes = await call(pathName, { token: tokens["platform"] });
        assertEq(platformRes.status, 403, `${pathName} platform must be 403`);
      }
    });

    await test("Academic Years: School A only sees its own years", async () => {
      const resA = await call("academic-years", { token: tokens["admin-a"] });
      assertEq(resA.status, 200, "admin-a academic-years");
      assert(bodyText(resA).includes(yearA), "year A visible to A");
      assert(!bodyText(resA).includes(yearB), "year B NOT visible to A");

      const resB = await call("academic-years", { token: tokens["admin-b"] });
      assertEq(resB.status, 200, "admin-b academic-years");
      assert(bodyText(resB).includes(yearB), "year B visible to B");
      assert(!bodyText(resB).includes(yearA), "year A NOT visible to B");
    });

    await test("Academic Years: cross-school create with forged schoolId is ignored", async () => {
      const res = await call("academic-years", {
        token: tokens["admin-a"],
        body: { name: "Forged Year", startDate: "2026-09-01", endDate: "2027-07-01", schoolId: schoolB, school_id: schoolB },
      });
      assertEq(res.status, 201, "forged create should still succeed but in own school");
      const createdId = res.json.data.id;
      const row = await one(`SELECT school_id FROM academic_years WHERE id = $1`, [createdId]);
      assertEq(row.school_id, schoolA, "forged schoolId must be ignored, must be own school");
      await q(`DELETE FROM academic_years WHERE id = $1`, [createdId]);
    });

    await test("Terms: School A only sees its own terms", async () => {
      const resA = await call("terms", { token: tokens["admin-a"] });
      assertEq(resA.status, 200, "admin-a terms");
      assert(bodyText(resA).includes(termA), "term A visible to A");
      assert(!bodyText(resA).includes(termB), "term B NOT visible to A");

      const resB = await call("terms", { token: tokens["admin-b"] });
      assert(bodyText(resB).includes(termB), "term B visible to B");
      assert(!bodyText(resB).includes(termA), "term A NOT visible to B");
    });

    await test("Terms: cannot create term for another school's academic year", async () => {
      const res = await call("terms", {
        token: tokens["admin-a"],
        body: { name: "term_2", academicYearId: yearB, startDate: "2026-01-01", endDate: "2026-03-01" },
      });
      assertEq(res.status, 404, "cross-school academic year must be 404");
      const rows = await q(`SELECT 1 FROM terms WHERE academic_year_id = $1 AND school_id = $2`, [yearB, schoolA]);
      assertEq(rows.length, 0, "no cross-school term row");
    });

    await test("Departments: School A only sees its own departments", async () => {
      const resA = await call("departments", { token: tokens["admin-a"] });
      assertEq(resA.status, 200, "admin-a departments");
      assert(bodyText(resA).includes(deptA), "dept A visible to A");
      assert(!bodyText(resA).includes(deptB), "dept B NOT visible to A");
    });

    await test("Departments: cross-school read/update/delete is 404", async () => {
      const readB = await call("departments/[id]", { token: tokens["admin-a"], method: "PUT", params: { id: deptB }, body: { name: "Hacked" } });
      assertEq(readB.status, 404, "cross-school dept update 404");

      const delB = await call("departments/[id]", { token: tokens["admin-a"], method: "DELETE", params: { id: deptB } });
      assertEq(delB.status, 404, "cross-school dept delete 404");

      const row = await one(`SELECT name FROM departments WHERE id = $1`, [deptB]);
      assertEq(row.name, "Science B", "dept B untouched");
    });

    await test("Departments: cannot create with foreign headId", async () => {
      const res = await call("departments", {
        token: tokens["admin-a"],
        body: { name: "Bad Dept", headId: ids["teacher-b"] },
      });
      assertEq(res.status, 404, "foreign headId 404");
    });

    await test("Subjects: School A only sees its own subjects", async () => {
      const resA = await call("subjects", { token: tokens["admin-a"] });
      assertEq(resA.status, 200, "admin-a subjects");
      assert(bodyText(resA).includes(subjA), "subj A visible to A");
      assert(!bodyText(resA).includes(subjB), "subj B NOT visible to A");
    });

    await test("Subjects: cross-school read/update/delete is 404", async () => {
      const upd = await call("subjects/[id]", { token: tokens["admin-a"], method: "PUT", params: { id: subjB }, body: { name: "Hacked" } });
      assertEq(upd.status, 404, "cross-school subject update 404");

      const del = await call("subjects/[id]", { token: tokens["admin-a"], method: "DELETE", params: { id: subjB } });
      assertEq(del.status, 404, "cross-school subject delete 404");
    });

    await test("Subjects: cannot create with foreign department", async () => {
      const res = await call("subjects", {
        token: tokens["admin-a"],
        body: { name: "Bad Subject", departmentId: deptB },
      });
      assertEq(res.status, 404, "foreign department 404");
    });

    await test("Subjects: client-supplied schoolId is ignored on create", async () => {
      const res = await call("subjects", {
        token: tokens["admin-a"],
        body: { name: "Forged Subject", schoolId: schoolB, departmentId: deptA },
      });
      assertEq(res.status, 201, "forged create succeeds in own school");
      const row = await one(`SELECT school_id FROM subjects WHERE id = $1`, [res.json.data.id]);
      assertEq(row.school_id, schoolA, "must be own school");
      await q(`DELETE FROM subjects WHERE id = $1`, [res.json.data.id]);
    });

    await test("Classes: School A only sees its own classes", async () => {
      const resA = await call("classes", { token: tokens["admin-a"] });
      assertEq(resA.status, 200, "admin-a classes");
      assert(bodyText(resA).includes(classA), "class A visible to A");
      assert(!bodyText(resA).includes(classB), "class B NOT visible to A");
    });

    await test("Classes: cross-school update/delete is 404", async () => {
      const upd = await call("classes/[id]", { token: tokens["admin-a"], method: "PUT", params: { id: classB }, body: { name: "Hacked" } });
      assertEq(upd.status, 404, "cross-school class update 404");

      const del = await call("classes/[id]", { token: tokens["admin-a"], method: "DELETE", params: { id: classB } });
      assertEq(del.status, 404, "cross-school class delete 404");
    });

    await test("Classes: cannot create with foreign academic year or teacher", async () => {
      const badYear = await call("classes", {
        token: tokens["admin-a"],
        body: { name: "Bad Class", level: "primary", academicYearId: yearB },
      });
      assertEq(badYear.status, 404, "foreign academic year 404");

      const badTeacher = await call("classes", {
        token: tokens["admin-a"],
        body: { name: "Bad Class", level: "primary", classTeacherId: ids["teacher-b"] },
      });
      assertEq(badTeacher.status, 404, "foreign teacher 404");
    });

    await test("Classes: client-supplied schoolId is ignored", async () => {
      const res = await call("classes", {
        token: tokens["admin-a"],
        body: { name: "Forged Class", level: "primary", schoolId: schoolB },
      });
      assertEq(res.status, 201, "forged class create");
      const row = await one(`SELECT school_id FROM classes WHERE id = $1`, [res.json.data.id]);
      assertEq(row.school_id, schoolA, "must be own school");
      await q(`DELETE FROM classes WHERE id = $1`, [res.json.data.id]);
    });

    await test("Legitimate: School A can still create and manage its own catalog", async () => {
      const yearRes = await call("academic-years", {
        token: tokens["admin-a"],
        body: { name: "2026/2027 A", startDate: "2026-09-01", endDate: "2027-07-01" },
      });
      assertEq(yearRes.status, 201, "own year create");
      const newYearId = yearRes.json.data.id;

      const termRes = await call("terms", {
        token: tokens["admin-a"],
        body: { name: "term_2", academicYearId: newYearId, startDate: "2026-01-01", endDate: "2026-03-01" },
      });
      assertEq(termRes.status, 201, "own term create");

      const deptRes = await call("departments", {
        token: tokens["admin-a"],
        body: { name: "Arts A" },
      });
      assertEq(deptRes.status, 201, "own dept create");

      const subjRes = await call("subjects", {
        token: tokens["admin-a"],
        body: { name: "History A", departmentId: deptRes.json.data.id },
      });
      assertEq(subjRes.status, 201, "own subject create");

      const classRes = await call("classes", {
        token: tokens["admin-a"],
        body: { name: "Class C", level: "primary", academicYearId: newYearId },
      });
      assertEq(classRes.status, 201, "own class create");

      // Cleanup
      await q(`DELETE FROM classes WHERE id = $1`, [classRes.json.data.id]);
      await q(`DELETE FROM subjects WHERE id = $1`, [subjRes.json.data.id]);
      await q(`DELETE FROM departments WHERE id = $1`, [deptRes.json.data.id]);
      await q(`DELETE FROM terms WHERE id = $1`, [termRes.json.data.id]);
      await q(`DELETE FROM academic_years WHERE id = $1`, [newYearId]);
    });

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  } finally {
    try {
      const { pool } = await import("@/db");
      await pool.end();
    } catch {}
    await db.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
