/**
 * Phase 2E Regression — Cross-school dashboard & reporting aggregation.
 *
 * Proves the four confirmed latent multi-school findings from the Phase 2E read-only audit
 * are closed, against a real PostgreSQL database and the REAL App Router handlers:
 *
 *   F1  subject counts (`dashboard/admin`, `dashboard/stats`) are scoped to the school
 *   F2  parent dashboard announcements are scoped to the school
 *   F3  teacher class selection + downstream aggregates (`dashboard/teacher`, `reports`)
 *       are scoped to the school and no longer rely on `teacherId` alone
 *   F4  learner reports / stats / dashboards never fold another school's activity into a
 *       multi-school learner's view (`learner-reports`, `learner/stats`,
 *       `dashboard/learner`, `dashboard/parent`)
 *
 * The F4 fixture deliberately gives one learner ACTIVE memberships in BOTH schools plus
 * activity rows in both, so a query that only filters on `learnerId` would leak — the fix
 * must exclude the other school's rows while keeping the caller's own.
 *
 * Same infrastructure as tests/tenant-assignments-submissions-regression.test.ts:
 *   - TEST_DATABASE_URL → any PostgreSQL (a scratch db is created and dropped)
 *   - embedded-postgres  → throwaway server (`npm i --no-save embedded-postgres`)
 *   - otherwise the suite SKIPS (exit 0)
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

const DB_NAME = `easylearn_2e_dash_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = "phase-2e-dashboard-regression-test-secret";
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

    const q = async (sql: string, vals: unknown[] = []) => (await db.query(sql, vals)).rows;
    const one = async (sql: string, vals: unknown[] = []) => (await q(sql, vals))[0];

    const migrationRun = runMigrations();
    if (migrationRun.status !== 0) {
      throw new Error(`run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`);
    }

    const passwordHash: string = await bcrypt.hash("Phase2e-Test-Password!", 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Dashboard School A', 'DSA', 'dash-school-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Dashboard School B', 'DSB', 'dash-school-b') RETURNING id`
    )).id as string;

    type Fixture = {
      key: string;
      role: string;
      memberships: { schoolId: string; role: string; createdAt?: string }[];
    };
    const fixtures: Fixture[] = [
      { key: "admin-a", role: "school_admin", memberships: [{ schoolId: schoolA, role: "school_admin" }] },
      { key: "teacher-a", role: "teacher", memberships: [{ schoolId: schoolA, role: "teacher" }] },
      { key: "learner-a", role: "learner", memberships: [{ schoolId: schoolA, role: "learner" }] },
      { key: "parent-a", role: "parent", memberships: [{ schoolId: schoolA, role: "parent" }] },
      { key: "admin-b", role: "school_admin", memberships: [{ schoolId: schoolB, role: "school_admin" }] },
      { key: "teacher-b", role: "teacher", memberships: [{ schoolId: schoolB, role: "teacher" }] },
      { key: "learner-b", role: "learner", memberships: [{ schoolId: schoolB, role: "learner" }] },
      { key: "parent-b", role: "parent", memberships: [{ schoolId: schoolB, role: "parent" }] },
      // Multi-school learner (F4): active in BOTH schools, School A first.
      { key: "dual", role: "learner", memberships: [
        { schoolId: schoolA, role: "learner", createdAt: "2025-01-01T00:00:00Z" },
        { schoolId: schoolB, role: "learner", createdAt: "2025-02-01T00:00:00Z" },
      ] },
      // Multi-school teacher (F3): teaches in BOTH schools, School A first.
      { key: "dual-teacher", role: "teacher", memberships: [
        { schoolId: schoolA, role: "teacher", createdAt: "2025-01-01T00:00:00Z" },
        { schoolId: schoolB, role: "teacher", createdAt: "2025-02-01T00:00:00Z" },
      ] },
    ];

    const ids: Record<string, string> = {};
    for (const fixture of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, 'Phase2E', $5, true) RETURNING id`,
        [`${fixture.key}-${DB_NAME}@example.test`, `${fixture.key}-${DB_NAME.slice(-8)}`, passwordHash, fixture.role, fixture.key]
      );
      ids[fixture.key] = row.id;
      for (const membership of fixture.memberships) {
        await q(
          `INSERT INTO school_users (school_id, user_id, role, status, created_at) VALUES ($1, $2, $3, 'active', $4)`,
          [membership.schoolId, row.id, membership.role, membership.createdAt ?? new Date()]
        );
      }
    }

    const yearA = (await one(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current) VALUES ($1,'2025/26 A','2025-09-01','2026-07-01',true) RETURNING id`,
      [schoolA]
    )).id as string;
    const yearB = (await one(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current) VALUES ($1,'2025/26 B','2025-09-01','2026-07-01',true) RETURNING id`,
      [schoolB]
    )).id as string;

    const subjectA = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1,'Maths A','MTH-A') RETURNING id`, [schoolA]
    )).id as string;
    const subjectB = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1,'Maths B','MTH-B') RETURNING id`, [schoolB]
    )).id as string;

    const classA = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id) VALUES ($1,'Class A','primary',$2,$3) RETURNING id`,
      [schoolA, ids["teacher-a"], yearA]
    )).id as string;
    const classB = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id) VALUES ($1,'Class B','primary',$2,$3) RETURNING id`,
      [schoolB, ids["teacher-b"], yearB]
    )).id as string;

    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4,$5)`, [
      schoolA, ids["teacher-a"], classA, subjectA, yearA,
    ]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4,$5)`, [
      schoolB, ids["teacher-b"], classB, subjectB, yearB,
    ]);
    // The multi-school teacher teaches one class in EACH school.
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4,$5)`, [
      schoolA, ids["dual-teacher"], classA, subjectA, yearA,
    ]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4,$5)`, [
      schoolB, ids["dual-teacher"], classB, subjectB, yearB,
    ]);

    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
      schoolA, ids["learner-a"], classA, yearA,
    ]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
      schoolB, ids["learner-b"], classB, yearB,
    ]);

    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id, relationship) VALUES ($1,$2,$3,'guardian')`, [
      schoolA, ids["parent-a"], ids["learner-a"],
    ]);
    // School A's parent is also linked to the multi-school learner (within School A).
    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id, relationship) VALUES ($1,$2,$3,'guardian')`, [
      schoolA, ids["parent-a"], ids["dual"],
    ]);
    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id, relationship) VALUES ($1,$2,$3,'guardian')`, [
      schoolB, ids["parent-b"], ids["learner-b"],
    ]);

    const assignA = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score) VALUES ($1,'Assignment A',$2,$3,$4,'published',100) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;
    const assignB = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score) VALUES ($1,'Assignment B',$2,$3,$4,'published',100) RETURNING id`,
      [schoolB, classB, subjectB, ids["teacher-b"]]
    )).id as string;
    // The multi-school teacher owns an assignment in EACH school.
    const assignDualA = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score) VALUES ($1,'Dual Assignment A',$2,$3,$4,'published',100) RETURNING id`,
      [schoolA, classA, subjectA, ids["dual-teacher"]]
    )).id as string;
    const assignDualB = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score) VALUES ($1,'Dual Assignment B',$2,$3,$4,'published',100) RETURNING id`,
      [schoolB, classB, subjectB, ids["dual-teacher"]]
    )).id as string;

    await q(`INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at) VALUES ($1,$2,$3,'graded',80,100,80,now())`, [
      schoolA, assignA, ids["learner-a"],
    ]);
    await q(`INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at) VALUES ($1,$2,$3,'graded',90,100,90,now())`, [
      schoolB, assignB, ids["learner-b"],
    ]);
    // Multi-school learner activity: a graded submission in EACH school.
    await q(`INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at) VALUES ($1,$2,$3,'graded',70,100,70,now())`, [
      schoolA, assignA, ids["dual"],
    ]);
    await q(`INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at) VALUES ($1,$2,$3,'graded',95,100,95,now())`, [
      schoolB, assignB, ids["dual"],
    ]);

    const quizA = (await one(
      `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published) VALUES ($1,'Quiz A',$2,$3,$4,true) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;
    const quizB = (await one(
      `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published) VALUES ($1,'Quiz B',$2,$3,$4,true) RETURNING id`,
      [schoolB, classB, subjectB, ids["teacher-b"]]
    )).id as string;

    await q(`INSERT INTO quiz_attempts (school_id, quiz_id, learner_id, score, completed_at) VALUES ($1,$2,$3,60,now())`, [
      schoolA, quizA, ids["dual"],
    ]);
    await q(`INSERT INTO quiz_attempts (school_id, quiz_id, learner_id, score, completed_at) VALUES ($1,$2,$3,99,now())`, [
      schoolB, quizB, ids["dual"],
    ]);

    await q(`INSERT INTO attendance (school_id, learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,$3,CURRENT_DATE,true,$4)`, [
      schoolA, ids["learner-a"], classA, ids["teacher-a"],
    ]);
    await q(`INSERT INTO attendance (school_id, learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,$3,CURRENT_DATE,true,$4)`, [
      schoolA, ids["dual"], classA, ids["teacher-a"],
    ]);
    await q(`INSERT INTO attendance (school_id, learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,$3,CURRENT_DATE,true,$4)`, [
      schoolB, ids["dual"], classB, ids["teacher-b"],
    ]);
    await q(`INSERT INTO attendance (school_id, learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,$3,CURRENT_DATE,false,$4)`, [
      schoolB, ids["learner-b"], classB, ids["teacher-b"],
    ]);

    await q(`INSERT INTO announcements (school_id, title, content, author_id, is_public) VALUES ($1,'Announce A','school a news',$2,false)`, [
      schoolA, ids["teacher-a"],
    ]);
    await q(`INSERT INTO announcements (school_id, title, content, author_id, is_public) VALUES ($1,'Announce B','school b news',$2,false)`, [
      schoolB, ids["teacher-b"],
    ]);

    const auth = await import("@/lib/auth");
    const tokens: Record<string, string> = {};
    for (const fixture of fixtures) {
      tokens[fixture.key] = await auth.createToken({
        userId: ids[fixture.key],
        role: fixture.role,
        email: `${fixture.key}@example.test`,
      });
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
      try { json = await res.clone().json(); } catch { /* non-JSON */ }
      return { status: res.status, json, text: JSON.stringify(json ?? "") };
    };

    console.log("\n🎯 Phase 2E Regression — cross-school dashboard & reporting aggregation\n");

    /* ════════════════ F1 — subject counts ════════════════ */

    await test("F1: admin dashboard subject count is scoped to the school", async () => {
      const r = await call("dashboard/admin", { token: tokens["admin-a"] });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.rawStats.subjects, 1, "School A must count only its own subject");
    });

    await test("F1: dashboard/stats subject count is scoped to the school", async () => {
      const r = await call("dashboard/stats", { token: tokens["admin-a"] });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.subjects, 1, "School A must count only its own subject");
      const rb = await call("dashboard/stats", { token: tokens["admin-b"] });
      assert.equal(rb.status, 200);
      assert.equal(rb.json.data.subjects, 1, "School B must count only its own subject");
    });

    /* ════════════════ F2 — parent announcements ════════════════ */

    await test("F2: parent dashboard announcements never show another school's notices", async () => {
      const r = await call("dashboard/parent", { token: tokens["parent-a"], query: { learnerId: ids["learner-a"] } });
      assert.equal(r.status, 200);
      const announcements = r.json.data.announcements as { title: string }[];
      const titles = announcements.map((a) => a.title);
      assert(titles.includes("Announce A"), "own school's announcement must be present");
      assert(!titles.includes("Announce B"), "other school's announcement must NOT leak");
    });

    /* ════════════════ F3 — teacher class selection & aggregates ════════════════ */

    await test("F3: a multi-school teacher's dashboard lists only the resolved school's classes", async () => {
      const r = await call("dashboard/teacher", { token: tokens["dual-teacher"] });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.rawStats.myClasses, 1, "must see only School A's class, not both");
      const classNames = (r.json.data.classes as { className: string }[]).map((c) => c.className);
      assert(classNames.includes("Class A"), "School A's class must be listed");
      assert(!classNames.includes("Class B"), "School B's class must NOT be listed");
    });

    await test("F3: a multi-school teacher's assignment aggregate is scoped to the school", async () => {
      const r = await call("dashboard/teacher", { token: tokens["dual-teacher"] });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.rawStats.assignments, 1, "only the School A assignment is counted");
    });

    await test("F3: the reports teacher branch is scoped to the school", async () => {
      const r = await call("reports", { token: tokens["dual-teacher"] });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.overview.totalAssignments, 1, "only the School A assignment is counted");
    });

    await test("F3: a single-school teacher still sees their own classes and assignments", async () => {
      const r = await call("dashboard/teacher", { token: tokens["teacher-a"] });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.rawStats.myClasses, 1, "teacher-a teaches one class");
      const classNames = (r.json.data.classes as { className: string }[]).map((c) => c.className);
      assert(classNames.includes("Class A"), "teacher-a's class must be present");
    });

    /* ════════════════ F4 — multi-school learner activity ════════════════ */

    await test("F4: learner reports exclude another school's assignments/quizzes for a multi-school learner", async () => {
      const r = await call("learner-reports", { token: tokens["admin-a"], query: { learnerId: ids["dual"] } });
      assert.equal(r.status, 200);
      assert(r.json.data.report, "report must be returned");
      assert(r.text.includes("Assignment A"), "own school's assignment grade must be present");
      assert(!r.text.includes("Assignment B"), "other school's assignment grade must NOT leak");
      assert(r.text.includes("Quiz A"), "own school's quiz attempt must be present");
      assert(!r.text.includes("Quiz B"), "other school's quiz attempt must NOT leak");
    });

    await test("F4: learner statistics count only the caller's school for a multi-school learner", async () => {
      const r = await call("learner/stats", { token: tokens["admin-a"], query: { learnerId: ids["dual"] } });
      assert.equal(r.status, 200);
      const stats = r.json.data.stats;
      assert.equal(stats.assignments.total, 1, "one School A submission, not two");
      assert.equal(stats.quizzes.completed, 1, "one School A quiz attempt, not two");
      assert.equal(stats.attendance.total, 1, "one School A attendance row, not two");
    });

    await test("F4: learner dashboard recent grades exclude another school for a multi-school learner", async () => {
      const r = await call("dashboard/learner", { token: tokens["admin-a"], query: { learnerId: ids["dual"] } });
      assert.equal(r.status, 200);
      assert(r.text.includes("Assignment A"), "own school's grade must be present");
      assert(!r.text.includes("Assignment B"), "other school's grade must NOT leak");
    });

    await test("F4: parent dashboard averages and attendance are scoped for a multi-school learner", async () => {
      const r = await call("dashboard/parent", { token: tokens["parent-a"], query: { learnerId: ids["dual"] } });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.rawStats.averageGrade, 70, "only School A's graded submission is averaged");
      assert.equal(r.json.data.rawStats.totalAttendance, 1, "only School A's attendance row is counted");
      const titles = (r.json.data.announcements as { title: string }[]).map((a) => a.title);
      assert(!titles.includes("Announce B"), "other school's announcement must NOT leak on the parent dashboard");
    });

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  } finally {
    try {
      const { pool } = await import("@/db");
      await pool.end();
    } catch {
      /* ignore */
    }
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
