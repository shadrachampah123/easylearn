/**
 * Phase 2E (Step 1) — Tenant write attribution: LIVE DATABASE, REAL ROUTE HANDLERS.
 *
 * Phase 2D made tenant READS safe; Phase 2E Step 1 stops the NULL school_id bleed on the
 * WRITE side. This suite proves, against a real PostgreSQL with the full migration chain
 * (0000…0017) and two real schools, that every school-scoped write path attributes the
 * row to the CALLER's verified school:
 *
 *   a. local upload          → uploaded_files.school_id  = caller school
 *   b. presigned upload      → uploaded_files.school_id  = caller school
 *   c. activity log (create) → activity_logs.school_id   = caller school
 *   d. assignment submission → notifications.school_id   = caller school
 *   e. quiz attempt          → notifications.school_id   = caller school
 *   f. submission grading    → notifications.school_id   = caller school
 *   f2. dashboard override   → dashboard_card_overrides.school_id = caller school
 *       (regression: the Step 2 audit found POST /api/dashboard/overrides was the
 *       last live NULL-school write path; also proves a forged body schoolId is
 *       ignored and that School B's write stays in School B)
 *   g. constraint error (duplicate academic year) does NOT trigger a NULL-school
 *      fallback insert, and a pre-0016 (column missing) database still gets the narrow
 *      legacy fallback
 *   h. two-school sweep: after all handler writes, NO school-owned table contains a
 *      single NULL school_id row
 *
 * Database providers (same approach as tests/tenant-authorization-db.test.ts):
 *   - TEST_DATABASE_URL → any PostgreSQL
 *   - embedded-postgres → throwaway server (`npm i --no-save embedded-postgres`)
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

const DB_NAME = `easylearn_2e_test_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = "phase-2e-integration-test-secret-0123456789";
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

/** Every school-owned table that migration 0016 gives a school_id column. */
const SCHOOL_OWNED_TABLES = [
  "academic_years",
  "terms",
  "departments",
  "classes",
  "subjects",
  "teacher_classes",
  "learner_classes",
  "parent_learners",
  "assignments",
  "submissions",
  "uploaded_files",
  "resources",
  "quizzes",
  "quiz_attempts",
  "announcements",
  "notifications",
  "attendance",
  "timetable_entries",
  "messages",
  "activity_logs",
  "dashboard_card_overrides",
  "gallery_items",
  "news",
  "faqs",
  "downloads",
];

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
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run `npm run test:write-attribution`.");
      return;
    }
    const port = 55629 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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
       import — the pool is created at import time. Fake object-storage credentials are
       set too so the presign route exercises its real (local-crypto) signing path
       without any network call. */
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.UPLOAD_DIR = UPLOAD_DIR;
    process.env.OBJECT_STORAGE_BUCKET = "easylearn-2e-test-bucket";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIA2ETESTFAKEFAKEFAKEFA";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "2etestfakefakefakefakefakefakefakefakefake";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
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
    const scalar = async (sql: string, values: unknown[] = []): Promise<number> =>
      Number((await q(sql, values))[0].count ?? 0);

    const migrationRun = runMigrations();
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    /* ── Fixture: two schools, every school-owned row carries an explicit school_id ── */

    const passwordHash: string = await bcrypt.hash("Phase2e-Test-Password!", 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Write School A', 'WSA', 'write-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Write School B', 'WSB', 'write-b') RETURNING id`
    )).id as string;

    type Fixture = { key: string; role: string; schoolId: string };
    const fixtures: Fixture[] = [
      { key: "admin-a", role: "school_admin", schoolId: schoolA },
      { key: "teacher-a", role: "teacher", schoolId: schoolA },
      { key: "learner-a", role: "learner", schoolId: schoolA },
      { key: "admin-b", role: "school_admin", schoolId: schoolB },
      { key: "teacher-b", role: "teacher", schoolId: schoolB },
      { key: "learner-b", role: "learner", schoolId: schoolB },
    ];

    const ids: Record<string, string> = {};
    for (const fixture of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, 'Phase2E', $5, true) RETURNING id`,
        [
          `${fixture.key}-${DB_NAME}@example.test`,
          `${fixture.key}-${DB_NAME.slice(-8)}`,
          passwordHash,
          fixture.role,
          fixture.key,
        ]
      );
      ids[fixture.key] = row.id;
      await q(
        `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
        [fixture.schoolId, row.id, fixture.role]
      );
    }

    const subjectA = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Maths', 'MTH-A') RETURNING id`,
      [schoolA]
    )).id as string;
    const classA = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id) VALUES ($1, 'Class A', 'primary', $2) RETURNING id`,
      [schoolA, ids["teacher-a"]]
    )).id as string;
    await q(
      `INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1, $2, $3, $4)`,
      [schoolA, ids["teacher-a"], classA, subjectA]
    );
    await q(
      `INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1, $2, $3)`,
      [schoolA, ids["learner-a"], classA]
    );

    // AI-graded free-text assignment (drives the submit-route notification, test d).
    const assignA = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads, ai_grading_enabled, ai_max_marks)
       VALUES ($1, 'AI Assignment A', $2, $3, $4, 'published', 100, true, true, 10) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;
    // Plain assignment (no AI, no questions — teacher grades manually, test f).
    const assignA2 = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score)
       VALUES ($1, 'Plain Assignment A', $2, $3, $4, 'published', 100) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;

    const quizA = (await one(
      `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published, max_attempts)
       VALUES ($1, 'Quiz A', $2, $3, $4, true, 1) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;
    const quizQuestionA = (await one(
      `INSERT INTO quiz_questions (quiz_id, question_type, question_text, correct_answer, points, order_index)
       VALUES ($1, 'mcq', 'Which letter is the answer?', 'b', 1, 0) RETURNING id`,
      [quizA]
    )).id as string;

    // School B needs a class for a legitimate B-side write (test b upload target).
    const subjectB = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Science', 'SCI-B') RETURNING id`,
      [schoolB]
    )).id as string;
    const classB = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id) VALUES ($1, 'Class B', 'primary', $2) RETURNING id`,
      [schoolB, ids["teacher-b"]]
    )).id as string;

    /* ── Token + request helpers ── */

    const auth = await import("@/lib/auth");
    const tokens: Record<string, string> = {};
    for (const fixture of fixtures) {
      tokens[fixture.key] = await auth.createToken({
        userId: ids[fixture.key],
        role: fixture.role,
        email: `${fixture.key}@example.test`,
      });
    }

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
      const handlerName = method.toUpperCase();
      const handler = mod[handlerName];
      if (!handler) throw new Error(`${pathName} has no ${handlerName} handler`);

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

    const nullCount = async (table: string): Promise<number> =>
      scalar(`SELECT count(*) FROM "${table}" WHERE school_id IS NULL`);

    console.log("\n🎯 Phase 2E Step 1 — tenant write attribution (two schools)\n");

    /* ════════════════ a. local upload → uploaded_files.school_id ════════════════ */

    await test("Upload: a local multipart upload is attributed to the caller's school", async () => {
      const form = new FormData();
      form.set("purpose", "assignment");
      form.set("file", new File([Buffer.from("%PDF-1.4 phase-2e test bytes")], "a-materials.pdf", {
        type: "application/pdf",
      }));
      const result = await call("uploads", { token: tokens["teacher-a"], multipart: form });
      assertEq(result.status, 201, `expected 201, body: ${JSON.stringify(result.json)}`);
      const fileId = result.json.data?.[0]?.fileId as string;
      assert(fileId, "response must include the new fileId");
      const row = await one(
        `SELECT school_id, uploader_id, storage_backend FROM uploaded_files WHERE id = $1`,
        [fileId]
      );
      assertEq(row?.school_id, schoolA, "uploaded_files.school_id must equal the caller's school");
      assertEq(row?.uploader_id, ids["teacher-a"], "uploader must be the caller");
    });

    /* ════════════════ b. presigned upload → uploaded_files.school_id ════════════════ */

    await test("Upload: a presigned (object storage) registration is attributed to the caller's school", async () => {
      const result = await call("uploads/presign", {
        token: tokens["teacher-b"],
        body: { purpose: "assignment", name: "b-materials.pdf", mimeType: "application/pdf", size: 10 },
      });
      assertEq(result.status, 201, `expected 201, body: ${JSON.stringify(result.json)}`);
      const fileId = result.json.data?.fileId as string;
      assert(fileId, "response must include the new fileId");
      const row = await one(
        `SELECT school_id, uploader_id, storage_backend FROM uploaded_files WHERE id = $1`,
        [fileId]
      );
      assertEq(row?.school_id, schoolB, "the SCHOOL B uploader's file must be attributed to school B");
      assertEq(row?.uploader_id, ids["teacher-b"], "uploader must be the caller");
      assertEq(row?.storage_backend, "object", "presign flow must use the object backend");
    });

    /* ════════════════ c. activity log → activity_logs.school_id ════════════════ */

    await test("Activity: creating an academic year logs an activity row with the caller's school", async () => {
      const result = await call("academic-years", {
        token: tokens["admin-a"],
        body: { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-01" },
      });
      assertEq(result.status, 201, `expected 201, body: ${JSON.stringify(result.json)}`);
      const row = await one(
        `SELECT school_id, user_id FROM activity_logs
         WHERE user_id = $1 AND action = 'create' AND entity_type = 'academic_year'
         ORDER BY created_at DESC LIMIT 1`,
        [ids["admin-a"]]
      );
      assert(row, "the create action must produce an activity row");
      assertEq(row?.school_id, schoolA, "activity_logs.school_id must equal the caller's school");
      // The row itself is attributed too.
      const yearId = result.json.data?.id as string;
      const year = await one(`SELECT school_id FROM academic_years WHERE id = $1`, [yearId]);
      assertEq(year?.school_id, schoolA, "the created academic year must carry the caller's school");
    });

    /* ════════════════ d. assignment submission → notifications.school_id ════════════════ */

    await test("Notification: an AI-graded assignment submission notifies inside the caller's school", async () => {
      const result = await call("assignments/[id]/submit", {
        token: tokens["learner-a"],
        params: { id: assignA },
        body: { content: "The mitochondria is the powerhouse of the cell. It produces ATP." },
      });
      assertEq(result.status, 200, `expected 200, body: ${JSON.stringify(result.json)}`);
      const notif = await one(
        `SELECT school_id, user_id FROM notifications
         WHERE user_id = $1 AND title = 'Assignment Graded by EasyAI'
         ORDER BY created_at DESC LIMIT 1`,
        [ids["learner-a"]]
      );
      assert(notif, "the EasyAI grading must create a notification");
      assertEq(notif?.school_id, schoolA, "notifications.school_id must equal the caller's school");
      // The submission row itself is attributed too.
      const sub = await one(
        `SELECT school_id, learner_id FROM submissions WHERE assignment_id = $1 AND learner_id = $2`,
        [assignA, ids["learner-a"]]
      );
      assert(sub, "the submission row must exist");
      assertEq(sub?.school_id, schoolA, "submissions.school_id must equal the learner's school");
    });

    /* ════════════════ e. quiz attempt → notifications.school_id ════════════════ */

    await test("Notification: a completed quiz attempt notifies inside the caller's school", async () => {
      const start = await call("quizzes/[id]/attempt", {
        token: tokens["learner-a"],
        params: { id: quizA },
        method: "POST",
      });
      assertEq(start.status, 201, `expected 201, body: ${JSON.stringify(start.json)}`);
      const attemptId = start.json.data?.attempt?.id as string;
      assert(attemptId, "attempt must be created");

      const finish = await call("quizzes/[id]/attempt", {
        token: tokens["learner-a"],
        params: { id: quizA },
        method: "PUT",
        body: { attemptId, answers: { [quizQuestionA]: "b" } },
      });
      assertEq(finish.status, 200, `expected 200, body: ${JSON.stringify(finish.json)}`);
      const notif = await one(
        `SELECT school_id, user_id FROM notifications
         WHERE user_id = $1 AND title = 'Quiz Completed'
         ORDER BY created_at DESC LIMIT 1`,
        [ids["learner-a"]]
      );
      assert(notif, "the completed quiz must create a notification");
      assertEq(notif?.school_id, schoolA, "notifications.school_id must equal the caller's school");
      // The attempt row itself is attributed too.
      const attempt = await one(`SELECT school_id FROM quiz_attempts WHERE id = $1`, [attemptId]);
      assertEq(attempt?.school_id, schoolA, "quiz_attempts.school_id must equal the learner's school");
    });

    /* ════════════════ f. submission grading → notifications.school_id ════════════════ */

    await test("Notification: grading a manual submission notifies inside the grader's school", async () => {
      // Learner submits the plain (non-AI) assignment first — no notification yet.
      const submit = await call("assignments/[id]/submit", {
        token: tokens["learner-a"],
        params: { id: assignA2 },
        body: { content: "Free-text answer for manual grading." },
      });
      assertEq(submit.status, 200, `expected 200, body: ${JSON.stringify(submit.json)}`);
      const submissionId = submit.json.data?.submission?.id as string;
      assert(submissionId, "submission must be created");
      const preCount = await scalar(
        `SELECT count(*) FROM notifications WHERE user_id = $1 AND title = 'Assignment Graded'`,
        [ids["learner-a"]]
      );

      const grade = await call("submissions/[id]/grade", {
        token: tokens["teacher-a"],
        params: { id: submissionId },
        body: { score: 90, maxScore: 100, feedback: "Good work." },
      });
      assertEq(grade.status, 200, `expected 200, body: ${JSON.stringify(grade.json)}`);
      const postCount = await scalar(
        `SELECT count(*) FROM notifications WHERE user_id = $1 AND title = 'Assignment Graded'`,
        [ids["learner-a"]]
      );
      assertEq(postCount, preCount + 1, "grading must create exactly one notification");
      const notif = await one(
        `SELECT school_id, user_id FROM notifications
         WHERE user_id = $1 AND title = 'Assignment Graded'
         ORDER BY created_at DESC LIMIT 1`,
        [ids["learner-a"]]
      );
      assertEq(notif?.school_id, schoolA, "notifications.school_id must equal the grader's school");
    });

    /* ════════════════ f2. dashboard override → dashboard_card_overrides.school_id ════════════════ */

    await test("Override: a dashboard override created by School A is attributed to School A", async () => {
      // Phase 2E Step 2 regression: POST /api/dashboard/overrides inserted without
      // schoolId — the last live NULL-school write path found by the read-only audit.
      const result = await call("dashboard/overrides", {
        token: tokens["admin-a"],
        body: {
          cardKey: "2e-regression-card-a",
          dashboardRole: "admin",
          title: "School A card",
          scopeType: "global",
        },
      });
      assertEq(result.status, 201, `expected 201, body: ${JSON.stringify(result.json)}`);
      const overrideId = result.json.data?.id as string;
      assert(overrideId, "response must include the new override id");
      const row = await one(
        `SELECT school_id, created_by FROM dashboard_card_overrides WHERE id = $1`,
        [overrideId]
      );
      assertEq(row?.school_id, schoolA, "dashboard_card_overrides.school_id must equal the caller's school");
      assertEq(row?.created_by, ids["admin-a"], "created_by must be the caller");
    });

    await test("Override: a forged schoolId is ignored and School B's write stays in School B", async () => {
      const result = await call("dashboard/overrides", {
        token: tokens["admin-b"],
        body: {
          cardKey: "2e-regression-card-b",
          dashboardRole: "admin",
          title: "School B card",
          scopeType: "global",
          schoolId: schoolA, // forged: must be ignored (attribution comes from ctx only)
          school_id: schoolA, // forged snake_case twin: must be ignored too
        },
      });
      assertEq(result.status, 201, `expected 201, body: ${JSON.stringify(result.json)}`);
      const overrideId = result.json.data?.id as string;
      assert(overrideId, "response must include the new override id");
      const row = await one(
        `SELECT school_id, created_by FROM dashboard_card_overrides WHERE id = $1`,
        [overrideId]
      );
      assertEq(row?.school_id, schoolB, "a forged schoolId must never move a row into another school");
      assertEq(row?.created_by, ids["admin-b"], "created_by must be the caller");

      // Tenant isolation preserved: School A lists only its own override.
      const listA = await call("dashboard/overrides", { token: tokens["admin-a"] });
      assertEq(listA.status, 200, "school A list must succeed");
      const keysA = ((listA.json.data ?? []) as Array<{ cardKey?: string }>).map((r) => r.cardKey);
      assert(keysA.includes("2e-regression-card-a"), "school A must see its own override");
      assert(!keysA.includes("2e-regression-card-b"), "school A must NOT see school B's override");
    });

    /* ════════════════ g. errors never trigger a NULL-school fallback ════════════════ */

    await test("Constraint: a duplicate academic year is rejected WITHOUT a NULL-school fallback row", async () => {
      // The first year was created in test (c). Create the same name again in the same
      // school — the direct insert hits the (school_id, name) unique constraint. The
      // narrowed catch must RETHROW (it is not a schema gap), so no second insert runs.
      const before = await scalar(`SELECT count(*) FROM academic_years WHERE name = '2026/2027'`);
      const result = await call("academic-years", {
        token: tokens["admin-a"],
        body: { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-01" },
      });
      assert(result.status >= 400, `duplicate must be rejected, got ${result.status}`);
      const after = await scalar(`SELECT count(*) FROM academic_years WHERE name = '2026/2027'`);
      assertEq(after, before, "no duplicate row may be created by a fallback insert");
      assertEq(
        await nullCount("academic_years"),
        0,
        "no NULL school_id row may exist after a constraint failure"
      );
    });

    await test("Legacy: a pre-0016 database (column missing) still gets the narrow fallback", async () => {
      // Simulate a database that predates migration 0016 by dropping the column.
      await q(`ALTER TABLE academic_years DROP COLUMN school_id`);
      try {
        const result = await call("academic-years", {
          token: tokens["admin-a"],
          body: { name: "2024/2025 (legacy)", startDate: "2024-09-01", endDate: "2025-07-01" },
        });
        assertEq(result.status, 201, "the legacy fallback must still work on pre-0016 databases");
      } finally {
        // Restore the column and re-attribute the rows so the final sweep (h) stays
        // meaningful. NOTE: dropping a column destroys its stored values, so EVERY
        // academic_years row is NULL again after the re-add — all rows created in
        // this test belong to school A (school B's year is created later, with the
        // column in place).
        // Restore the post-0017 shape: column present, attributed, NOT NULL.
        await q(`ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS school_id uuid`);
        await q(`UPDATE academic_years SET school_id = $1 WHERE school_id IS NULL`, [schoolA]);
        await q(`ALTER TABLE academic_years ALTER COLUMN school_id SET NOT NULL`);
      }
      assertEq(
        await nullCount("academic_years"),
        0,
        "legacy row must be re-attributed once the column is back"
      );
    });

    /* ════════════════ h. two-school sweep: zero NULL school_id rows ════════════════ */

    await test("Sweep: after all handler writes, every school-owned table has zero NULL school_id rows", async () => {
      // A second school's admin performs a write too, so the sweep covers both tenants.
      const result = await call("academic-years", {
        token: tokens["admin-b"],
        body: { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-01" },
      });
      assertEq(result.status, 201, `school B must create its own year, body: ${JSON.stringify(result.json)}`);
      const bYear = await one(`SELECT school_id FROM academic_years WHERE id = $1`, [result.json.data?.id]);
      assertEq(bYear?.school_id, schoolB, "school B's write must stay in school B");

      const bad: string[] = [];
      for (const table of SCHOOL_OWNED_TABLES) {
        const n = await nullCount(table);
        if (n > 0) bad.push(`${table}=${n}`);
      }
      assert(bad.length === 0, `tables with NULL school_id rows: ${bad.join(", ")}`);
    });

    console.log(`\n📊 Phase 2E Step 1 results: ${passed} passed, ${failed} failed\n`);
  } finally {
    // The scratch client is CONNECTED to the scratch database — it cannot drop it.
    // The app pool (imported via @/db during the suite) also holds sessions against it.
    // End both before DROP, and FORCE remaining backends so cleanup never fails the suite.
    try {
      const { pool } = await import("@/db");
      await pool.end().catch(() => {});
    } catch {
      /* pool may not have been imported if migrations failed early */
    }
    await db.end().catch(() => {});
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    } catch {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
      } catch {
        /* best effort */
      }
    }
    await admin.end().catch(() => {});
    if (stopServer) await stopServer().catch(() => {});
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
