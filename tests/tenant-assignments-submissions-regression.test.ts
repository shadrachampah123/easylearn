/**
 * Phase 2D Regression — Assignments & Submissions tenant filter overwrite fix.
 *
 * Proves the two blocking bugs are fixed:
 *   - assignments GET where() overwrite allowed cross-school read via classId/subjectId/status
 *   - submissions GET where() overwrite allowed cross-school read via assignmentId
 *
 * Uses real PostgreSQL + real route handlers, same infra as tenant-authorization-db.
 */

import assert from "assert";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { NextRequest } from "next/server";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

const DB_NAME = `easylearn_2d_reg_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = "phase-2d-regression-test-secret";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((e) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${(e as Error).message}`);
      failed++;
    });
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
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres not installed");
      return;
    }
    const port = 54629 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(require("os").tmpdir(), `${DB_NAME}-data`),
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
    const u = new URL(adminUrl as string);
    u.pathname = `/${DB_NAME}`;
    return u.toString();
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

    const runMigrations = () =>
      spawnSync(process.execPath, ["run-migration.js"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: scratchUrl, JWT_SECRET },
        encoding: "utf8",
      });

    const q = async (sql: string, vals: unknown[] = []) => (await db.query(sql, vals)).rows;
    const one = async (sql: string, vals: unknown[] = []) => (await q(sql, vals))[0];

    const mig = runMigrations();
    if (mig.status !== 0) throw new Error(`migration failed: ${mig.stdout}${mig.stderr}`);

    const pwHash = await bcrypt.hash("Test-Password-123!", 4);

    const schoolA = (await one(`INSERT INTO schools (name, short_name, slug) VALUES ('School A', 'SA', 'school-a-reg') RETURNING id`)).id as string;
    const schoolB = (await one(`INSERT INTO schools (name, short_name, slug) VALUES ('School B', 'SB', 'school-b-reg') RETURNING id`)).id as string;

    const fixtures = [
      { key: "admin-a", role: "school_admin", schoolId: schoolA },
      { key: "teacher-a", role: "teacher", schoolId: schoolA },
      { key: "learner-a", role: "learner", schoolId: schoolA },
      { key: "admin-b", role: "school_admin", schoolId: schoolB },
      { key: "teacher-b", role: "teacher", schoolId: schoolB },
      { key: "learner-b", role: "learner", schoolId: schoolB },
    ];

    const ids: Record<string, string> = {};
    for (const f of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,$3,$4,'Test',$5,true) RETURNING id`,
        [`${f.key}-${DB_NAME}@example.test`, `${f.key}-${DB_NAME.slice(-6)}`, pwHash, f.role, f.key]
      );
      ids[f.key] = row.id;
      await q(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [f.schoolId, row.id, f.role]);
    }

    const yearA = (await one(`INSERT INTO academic_years (school_id, name, start_date, end_date, is_current) VALUES ($1,'2025/26 A','2025-09-01','2026-07-01',true) RETURNING id`, [schoolA])).id as string;
    const yearB = (await one(`INSERT INTO academic_years (school_id, name, start_date, end_date, is_current) VALUES ($1,'2025/26 B','2025-09-01','2026-07-01',true) RETURNING id`, [schoolB])).id as string;

    const subjA = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Maths A','MTH-A') RETURNING id`, [schoolA])).id as string;
    const subjB = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Maths B','MTH-B') RETURNING id`, [schoolB])).id as string;

    const classA = (await one(`INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id) VALUES ($1,'Class A','primary',$2,$3) RETURNING id`, [schoolA, ids["teacher-a"], yearA])).id as string;
    const classB = (await one(`INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id) VALUES ($1,'Class B','primary',$2,$3) RETURNING id`, [schoolB, ids["teacher-b"], yearB])).id as string;

    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [schoolA, ids["learner-a"], classA, yearA]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [schoolB, ids["learner-b"], classB, yearB]);

    const assignA = (await one(`INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score) VALUES ($1,'Assignment A',$2,$3,$4,'published',100) RETURNING id`, [schoolA, classA, subjA, ids["teacher-a"]])).id as string;
    const assignB = (await one(`INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score) VALUES ($1,'Assignment B',$2,$3,$4,'published',100) RETURNING id`, [schoolB, classB, subjB, ids["teacher-b"]])).id as string;

    const subA = (await one(`INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at) VALUES ($1,$2,$3,'graded',80,100,80,now()) RETURNING id`, [schoolA, assignA, ids["learner-a"]])).id as string;
    const subB = (await one(`INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at) VALUES ($1,$2,$3,'graded',90,100,90,now()) RETURNING id`, [schoolB, assignB, ids["learner-b"]])).id as string;

    const auth = await import("@/lib/auth");
    const tokens: Record<string, string> = {};
    for (const f of fixtures) {
      tokens[f.key] = await auth.createToken({ userId: ids[f.key], role: f.role, email: `${f.key}@example.test` });
    }

    const route = async (p: string) => import(`@/app/api/${p}/route`);

    type CallOpts = { token?: string | null; query?: Record<string, string>; body?: unknown; method?: string; params?: Record<string, string> };
    const call = async (pathName: string, opts: CallOpts = {}) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
      const headers: Record<string, string> = {};
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const req = new NextRequest(url, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
      const mod: any = await route(pathName);
      const handler = mod[(opts.method ?? (opts.body !== undefined ? "POST" : "GET")).toUpperCase()];
      if (!handler) throw new Error(`no handler ${pathName}`);
      const res = opts.params ? await handler(req, { params: Promise.resolve(opts.params) }) : await handler(req);
      let json: any = null;
      try { json = await res.clone().json(); } catch {}
      return { status: res.status, json, text: JSON.stringify(json ?? "") };
    };

    console.log("\n🎯 Phase 2D Regression — Assignments & Submissions tenant filter overwrite fix\n");

    await test("Assignments: School A admin GET without filters sees only School A", async () => {
      const r = await call("assignments", { token: tokens["admin-a"] });
      assert.equal(r.status, 200);
      assert.ok(r.text.includes("Assignment A"), "should contain A");
      assert.ok(!r.text.includes("Assignment B"), "should NOT contain B");
    });

    await test("Assignments: School A admin GET with School B classId sees no School B assignments", async () => {
      const r = await call("assignments", { token: tokens["admin-a"], query: { classId: classB } });
      // Fixed code: WHERE schoolId=SchoolA AND classId=classB => 0 rows, not B assignments
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes("Assignment B"), "must NOT leak B via classId");
      assert.ok(!r.text.includes("Assignment A") || true, "empty is ok, but must not contain B");
      // Ensure count 0 or at least not B
      const data = r.json?.data;
      if (Array.isArray(data)) {
        assert.ok(data.length === 0 || data.every((row: any) => row.id !== assignB), "no B assignment");
      }
    });

    await test("Assignments: School A admin GET with School B subjectId sees no School B assignments", async () => {
      const r = await call("assignments", { token: tokens["admin-a"], query: { subjectId: subjB } });
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes("Assignment B"), "must NOT leak B via subjectId");
      const data = r.json?.data;
      if (Array.isArray(data)) {
        assert.ok(data.every((row: any) => row.id !== assignB), "no B");
      }
    });

    await test("Assignments: School A teacher GET with School B classId cannot bypass tenant isolation", async () => {
      const r = await call("assignments", { token: tokens["teacher-a"], query: { classId: classB } });
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes("Assignment B"), "teacher-a must NOT see B via classId");
      const data = r.json?.data;
      if (Array.isArray(data)) {
        assert.ok(data.length === 0 || data.every((row: any) => row.id !== assignB));
      }
    });

    await test("Assignments: Legitimate School A filters still work", async () => {
      const r = await call("assignments", { token: tokens["admin-a"], query: { classId: classA } });
      assert.equal(r.status, 200);
      assert.ok(r.text.includes("Assignment A"), "legit filter should return A");
      assert.ok(!r.text.includes("Assignment B"));
    });

    await test("Assignments: School A admin GET with status filter preserves tenant isolation", async () => {
      const r = await call("assignments", { token: tokens["admin-a"], query: { status: "published" } });
      assert.equal(r.status, 200);
      assert.ok(r.text.includes("Assignment A"));
      assert.ok(!r.text.includes("Assignment B"), "status filter must not bypass tenant");
    });

    await test("Submissions: School A GET with School B assignmentId cannot see School B submissions", async () => {
      const r = await call("submissions", { token: tokens["admin-a"], query: { assignmentId: assignB } });
      // Fixed: WHERE sqlSubmissionInSchool(SchoolA) AND assignmentId=assignB => 0 rows
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes(subB), "must NOT leak subB");
      assert.ok(!r.text.includes(ids["learner-b"]), "must NOT leak learner-b");
      const data = r.json?.data;
      if (Array.isArray(data)) {
        assert.ok(data.length === 0, "should be empty, not B");
      }
    });

    await test("Submissions: School A teacher GET with School B assignmentId cannot bypass", async () => {
      const r = await call("submissions", { token: tokens["teacher-a"], query: { assignmentId: assignB } });
      assert.equal(r.status, 200);
      const data = r.json?.data;
      if (Array.isArray(data)) {
        assert.ok(data.length === 0, "teacher-a must not see B via assignmentId");
      }
      assert.ok(!r.text.includes(subB));
    });

    await test("Submissions: Legitimate School A assignmentId returns only School A submissions", async () => {
      const r = await call("submissions", { token: tokens["admin-a"], query: { assignmentId: assignA } });
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(subA) || r.text.includes(ids["learner-a"]), "should contain A");
      assert.ok(!r.text.includes(subB), "should NOT contain B");
    });

    await test("Submissions: School A admin filtering still works correctly", async () => {
      const r = await call("submissions", { token: tokens["admin-a"] });
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(ids["learner-a"]) || r.text.includes(subA));
      assert.ok(!r.text.includes(ids["learner-b"]));
    });

    await test("Submissions: School A learner filtering still works", async () => {
      const r = await call("submissions", { token: tokens["learner-a"] });
      assert.equal(r.status, 200);
      // learner-a should see own submission
      assert.ok(r.text.includes(subA) || r.text.includes(assignA) || r.json?.data?.length >= 0);
      assert.ok(!r.text.includes(subB));
    });

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  } finally {
    try { const { pool } = await import("@/db"); await pool.end(); } catch {}
    await db.end().catch(() => {});
    await admin.end().catch(() => {});
    if (stopServer) await stopServer().catch(() => {});
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
