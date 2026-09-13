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
 *   F6  dashboard card overrides are scoped by their own direct `school_id`, not by
 *       creator membership — a multi-school admin's override must not appear on, be
 *       applied to, or be mutable from the other school (`dashboard/overrides`,
 *       `dashboard/overrides/[id]`, `dashboard/learner`)
 *   F7  (audit follow-up) DELETE `assignments/[id]/questions` is anchored to the
 *       assignment the caller was authorized on — a question id from another school's
 *       assignment must 404 instead of deleting
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

function assertEq(actual: unknown, expected: unknown, message: string) {
  assert.equal(
    actual,
    expected,
    `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
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
      // Multi-school administrator (F6): admin in BOTH schools, School A first — the
      // exact shape that made creator-membership scoping of dashboard overrides unsafe.
      { key: "dual-admin", role: "school_admin", memberships: [
        { schoolId: schoolA, role: "school_admin", createdAt: "2025-01-01T00:00:00Z" },
        { schoolId: schoolB, role: "school_admin", createdAt: "2025-02-01T00:00:00Z" },
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

    /* ════════════════ F6 — dashboard override school scoping ════════════════
       Overrides must be scoped by the row's own direct school_id (migrations
       0016/0017), not by "creator is a member of my school". The creator-membership
       predicate let an override created by a MULTI-SCHOOL admin (here: dual-admin, who
       owns School A's context) surface on School B's dashboards and let School B's
       admins mutate/delete it. Every test below fails against the pre-F6 predicate. */

    let f6OverrideId = "";

    await test("F6: an override created in School A's context is attributed to School A", async () => {
      const r = await call("dashboard/overrides", {
        token: tokens["dual-admin"],
        body: {
          cardKey: "2e-f6-card",
          dashboardRole: "learner",
          scopeType: "global",
          title: "F6 Card",
          value: "SCHOOL-A-ONLY",
        },
      });
      assertEq(r.status, 201, `expected 201, body: ${r.text}`);
      f6OverrideId = r.json.data?.id as string;
      assert(f6OverrideId, "override must be created");
      const row = await one(`SELECT school_id, created_by FROM dashboard_card_overrides WHERE id = $1`, [f6OverrideId]);
      assertEq(row?.school_id, schoolA, "school_id must be the caller's resolved (School A) context");
    });

    await test("F6: School B's admin list must not include the dual admin's School A override", async () => {
      const r = await call("dashboard/overrides", { token: tokens["admin-b"] });
      assert.equal(r.status, 200);
      const keys = (r.json.data as { cardKey: string }[]).map((o) => o.cardKey);
      assert(!keys.includes("2e-f6-card"), "creator-membership scoping must not widen School B's list");
    });

    await test("F6: the override applies on School A's learner dashboard but never on School B's", async () => {
      const ra = await call("dashboard/learner", { token: tokens["learner-a"] });
      assert.equal(ra.status, 200);
      assert(ra.text.includes("SCHOOL-A-ONLY"), "own-school override must still be applied");

      const rb = await call("dashboard/learner", { token: tokens["learner-b"] });
      assert.equal(rb.status, 200);
      assert(!rb.text.includes("SCHOOL-A-ONLY"), "School A's override must NOT be applied on School B's dashboard");
    });

    await test("F6: School B's admin cannot read, modify or delete School A's override row", async () => {
      const get = await call("dashboard/overrides/[id]", { token: tokens["admin-b"], method: "GET", params: { id: f6OverrideId } });
      assertEq(get.status, 404, `GET must 404 across schools, got ${get.status}`);

      const put = await call("dashboard/overrides/[id]", {
        token: tokens["admin-b"], method: "PUT", params: { id: f6OverrideId },
        body: { value: "TAMPERED-BY-B" },
      });
      assertEq(put.status, 404, `PUT must 404 across schools, got ${put.status}`);
      const afterPut = await one(`SELECT value FROM dashboard_card_overrides WHERE id = $1`, [f6OverrideId]);
      assertEq(afterPut?.value, "SCHOOL-A-ONLY", "value must be untouched by the cross-school PUT");

      const del = await call("dashboard/overrides/[id]", { token: tokens["admin-b"], method: "DELETE", params: { id: f6OverrideId } });
      assertEq(del.status, 404, `DELETE must 404 across schools, got ${del.status}`);
      const still = await one(`SELECT id FROM dashboard_card_overrides WHERE id = $1`, [f6OverrideId]);
      assert(still, "the row must still exist after the cross-school DELETE attempt");
    });

    await test("F6: School A's own admin keeps full management of the row", async () => {
      const put = await call("dashboard/overrides/[id]", {
        token: tokens["admin-a"], method: "PUT", params: { id: f6OverrideId },
        body: { value: "MANAGED-BY-A" },
      });
      assertEq(put.status, 200, `own-school PUT must succeed, got ${put.status}: ${put.text}`);
      const row = await one(`SELECT value FROM dashboard_card_overrides WHERE id = $1`, [f6OverrideId]);
      assertEq(row?.value, "MANAGED-BY-A", "own-school update must persist");
    });

    await test("F6: an override with a deleted creator stays manageable inside its own school", async () => {
      // created_by is nullable (ON DELETE set null): the pre-F6 creator-membership
      // predicate made such rows invisible and unmanageable for everybody.
      const orphan = await one(
        `INSERT INTO dashboard_card_overrides (school_id, card_key, dashboard_role, scope_type, value, is_enabled, is_visible, created_by)
         VALUES ($1, '2e-f6-orphan', 'learner', 'global', 'ORPHAN-IN-A', true, true, NULL) RETURNING id`,
        [schoolA]
      );
      const la = await call("dashboard/learner", { token: tokens["learner-a"] });
      assert(la.text.includes("ORPHAN-IN-A"), "the owning school must keep seeing (and applying) its own row");
      const listB = await call("dashboard/overrides", { token: tokens["admin-b"] });
      const keys = (listB.json.data as { cardKey: string }[]).map((o) => o.cardKey);
      assert(!keys.includes("2e-f6-orphan"), "the other school must not see the orphan row");

      const del = await call("dashboard/overrides/[id]", { token: tokens["admin-a"], method: "DELETE", params: { id: orphan.id } });
      assertEq(del.status, 200, "the owning school must be able to delete its own orphaned row");
    });

    await test("F6: the dual admin's School A context cannot list School B's overrides", async () => {
      const bCreate = await call("dashboard/overrides", {
        token: tokens["admin-b"],
        body: { cardKey: "2e-f6-card-b", dashboardRole: "learner", scopeType: "global", title: "B Card", value: "SCHOOL-B-ONLY" },
      });
      assertEq(bCreate.status, 201, `expected 201, body: ${bCreate.text}`);

      const dualList = await call("dashboard/overrides", { token: tokens["dual-admin"] });
      const keys = (dualList.json.data as { cardKey: string }[]).map((o) => o.cardKey);
      assert(keys.includes("2e-f6-card"), "dual admin sees their School A row in the School A context");
      assert(!keys.includes("2e-f6-card-b"), "the School A context must not list School B's row");

      const rb = await call("dashboard/learner", { token: tokens["learner-b"] });
      assert(rb.text.includes("SCHOOL-B-ONLY"), "School B's own override still applies on School B");
    });

    /* ════════════════ F7 audit finding — anchored question deletion ════════════════
       DELETE /api/assignments/[id]/questions validated the ASSIGNMENT (school + owner)
       but deleted the question by its own client-supplied id, without requiring it to
       belong to that assignment. Any staff member could thus remove another school's
       question row given its uuid. The audit fix mirrors the anchor the corrections
       POST already enforces.

       The fixture uses a clean School B class owned solely by the single-school
       teacher-b — the multi-school members in Class A/B make the relational
       "uniquely attributable" predicate (by design) deny their assignments, which
       would mask the parent-child check this test targets. */

    let questionA1 = "";
    let questionBD1 = "";
    let questionBD2 = "";

    const classD = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id) VALUES ($1,'Class D','primary',$2,$3) RETURNING id`,
      [schoolB, ids["teacher-b"], yearB]
    )).id as string;
    const assignBD = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score) VALUES ($1,'Assignment BD',$2,$3,$4,'published',100) RETURNING id`,
      [schoolB, classD, subjectB, ids["teacher-b"]]
    )).id as string;

    await test("F7: question fixtures seed one foreign + two local questions", async () => {
      questionA1 = (await one(
        `INSERT INTO assignment_questions (assignment_id, question_text, points) VALUES ($1,'Q A1',5) RETURNING id`, [assignA]
      )).id as string;
      questionBD1 = (await one(
        `INSERT INTO assignment_questions (assignment_id, question_text, points) VALUES ($1,'Q BD1',5) RETURNING id`, [assignBD]
      )).id as string;
      questionBD2 = (await one(
        `INSERT INTO assignment_questions (assignment_id, question_text, points) VALUES ($1,'Q BD2',5) RETURNING id`, [assignBD]
      )).id as string;
      assert(questionA1 && questionBD1 && questionBD2, "questions must exist");
    });

    await test("F7: a School B teacher cannot delete a School A question through their own assignment", async () => {
      const r = await call("assignments/[id]/questions", {
        token: tokens["teacher-b"], method: "DELETE", params: { id: assignBD }, query: { questionId: questionA1 },
      });
      assertEq(r.status, 404, `cross-school question id must 404, got ${r.status}`);
      const still = await one(`SELECT id FROM assignment_questions WHERE id = $1`, [questionA1]);
      assert(still, "the foreign question row must still exist");
    });

    await test("F7: the same teacher still deletes questions of their OWN assignment", async () => {
      const r = await call("assignments/[id]/questions", {
        token: tokens["teacher-b"], method: "DELETE", params: { id: assignBD }, query: { questionId: questionBD1 },
      });
      assertEq(r.status, 200, `legitimate delete must succeed, got ${r.status}: ${r.text}`);
      const gone = await one(`SELECT id FROM assignment_questions WHERE id = $1`, [questionBD1]);
      assert(!gone, "the question must be deleted");
      const untouched = await one(`SELECT id FROM assignment_questions WHERE id = $1`, [questionBD2]);
      assert(untouched, "the sibling question must remain");
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
