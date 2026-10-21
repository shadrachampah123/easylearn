/**
 * F1 / F2 — Learner and parent quiz authorization: LIVE DATABASE, REAL ROUTE HANDLERS.
 *
 * This is the executable proof for two release-blocking findings:
 *
 *   F1  A learner's access to a quiz must be decided by the caller's school AND by a real
 *       enrollment in the quiz's class.
 *         - the quiz LIST already refuses a learner with no enrollments (the fail-open
 *           default was removed there), but the quiz DETAIL route and the ATTEMPT routes
 *           still carried `enrolled.length > 0 && …`, so a learner with ZERO enrollments
 *           passed the check and could read and start any published quiz in their school;
 *         - the submit route checked neither the enrollment nor the published flag, so a
 *           de-enrolled learner — or a learner whose quiz had been unpublished — could
 *           still submit, be graded and be awarded points;
 *         - the enrollment lookup was not school-scoped.
 *
 *   F2  A parent is not a learner. The answer-key redaction and the published check were
 *       applied only to `role === "learner"`, so a parent in the school received every
 *       `correctAnswer` and could read unpublished drafts.
 *
 * Every test below is a regression test: the ones marked "regression" fail against the
 * pre-fix behaviour and pass afterwards.
 *
 * Database providers (same approach as tests/tenant-authorization-db.test.ts):
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
const { createScratchDatabase, assertCleanupSucceeded } = requireFromRepo(
  "./tests/helpers/scratch-db.js"
);

const DB_NAME = `easylearn_quiz_access_${crypto.randomBytes(4).toString("hex")}`;
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
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run this suite.");
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
  const scratch = await createScratchDatabase({
    admin,
    adminUrl: adminUrl as string,
    dbName: DB_NAME,
    label: "quiz-access-db",
  });
  const db = scratch.db;

  let primaryError: any = null;
  try {
    /* The application modules must see the scratch database. Set BEFORE the first `@/db`
       import — the pool is created at import time. */
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.UPLOAD_DIR = UPLOAD_DIR;
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

    /* ── Fixture ── */

    const passwordHash: string = await bcrypt.hash("QuizAccess-Test-Password!", 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Quiz School A', 'QSA', 'quiz-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Quiz School B', 'QSB', 'quiz-b') RETURNING id`
    )).id as string;

    type Membership = { schoolId: string; role: string };
    type Fixture = { key: string; role: string; memberships: Membership[] };

    const fixtures: Fixture[] = [
      { key: "teacher-a", role: "teacher", memberships: [{ schoolId: schoolA, role: "teacher" }] },
      { key: "admin-a", role: "school_admin", memberships: [{ schoolId: schoolA, role: "school_admin" }] },
      { key: "learner-enrolled", role: "learner", memberships: [{ schoolId: schoolA, role: "learner" }] },
      // No `learner_classes` row at all — the fail-open case.
      { key: "learner-unenrolled", role: "learner", memberships: [{ schoolId: schoolA, role: "learner" }] },
      // Enrolled, but in a different class of the same school.
      { key: "learner-other-class", role: "learner", memberships: [{ schoolId: schoolA, role: "learner" }] },
      { key: "parent-a", role: "parent", memberships: [{ schoolId: schoolA, role: "parent" }] },
      { key: "teacher-b", role: "teacher", memberships: [{ schoolId: schoolB, role: "teacher" }] },
      { key: "learner-b", role: "learner", memberships: [{ schoolId: schoolB, role: "learner" }] },
    ];

    const ids: Record<string, string> = {};
    for (const fixture of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, 'Quiz', $5, true) RETURNING id`,
        [
          `${fixture.key}-${DB_NAME}@example.test`,
          `${fixture.key}-${DB_NAME.slice(-8)}`,
          passwordHash,
          fixture.role,
          fixture.key,
        ]
      );
      ids[fixture.key] = row.id;
      for (const membership of fixture.memberships) {
        await q(
          `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
          [membership.schoolId, row.id, membership.role]
        );
      }
    }

    const yearA = (await one(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2025/2026', '2025-09-01', '2026-07-01', true) RETURNING id`,
      [schoolA]
    )).id as string;
    const yearB = (await one(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2025/2026', '2025-09-01', '2026-07-01', true) RETURNING id`,
      [schoolB]
    )).id as string;

    const subjectA = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Maths', 'MTH') RETURNING id`,
      [schoolA]
    )).id as string;
    const subjectB = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Maths', 'MTH') RETURNING id`,
      [schoolB]
    )).id as string;

    const classA = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id)
       VALUES ($1, 'Class A', 'primary', $2, $3) RETURNING id`,
      [schoolA, ids["teacher-a"], yearA]
    )).id as string;
    const classA2 = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id)
       VALUES ($1, 'Class A2', 'primary', $2, $3) RETURNING id`,
      [schoolA, ids["teacher-a"], yearA]
    )).id as string;
    const classB = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id)
       VALUES ($1, 'Class B', 'primary', $2, $3) RETURNING id`,
      [schoolB, ids["teacher-b"], yearB]
    )).id as string;

    // Enrollments. `learner-unenrolled` deliberately gets none.
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
      schoolA, ids["learner-enrolled"], classA, yearA,
    ]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
      schoolA, ids["learner-other-class"], classA2, yearA,
    ]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
      schoolB, ids["learner-b"], classB, yearB,
    ]);

    const quizA = (await one(
      `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published, show_results, max_attempts)
       VALUES ($1, 'Published quiz A', $2, $3, $4, true, true, 3) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;
    const quizADraft = (await one(
      `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published, show_results, max_attempts)
       VALUES ($1, 'Draft quiz A', $2, $3, $4, false, true, 3) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;
    const quizB = (await one(
      `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published, show_results, max_attempts)
       VALUES ($1, 'Published quiz B', $2, $3, $4, true, true, 3) RETURNING id`,
      [schoolB, classB, subjectB, ids["teacher-b"]]
    )).id as string;

    const questionA = (await one(
      `INSERT INTO quiz_questions (quiz_id, question_type, question_text, correct_answer, points, order_index)
       VALUES ($1, 'mcq', 'What is 2 + 2?', '4', 1, 0) RETURNING id`,
      [quizA]
    )).id as string;
    await q(
      `INSERT INTO quiz_questions (quiz_id, question_type, question_text, correct_answer, points, order_index)
       VALUES ($1, 'mcq', 'Draft question', '42', 1, 0)`,
      [quizADraft]
    );

    /* ── Tokens + request helper ── */

    const auth = await import("@/lib/auth");

    const tokenFor = async (userId: string, role: string, schoolId: string) => {
      const membership = await one(
        `SELECT id FROM school_users WHERE school_id = $1 AND user_id = $2 AND status = 'active'`,
        [schoolId, userId]
      );
      return auth.createToken({
        userId,
        role,
        email: "quiz-access@example.test",
        schoolId,
        membershipId: membership.id,
      });
    };

    const tokens: Record<string, string> = {};
    tokens["teacher-a"] = await tokenFor(ids["teacher-a"], "teacher", schoolA);
    tokens["admin-a"] = await tokenFor(ids["admin-a"], "school_admin", schoolA);
    tokens["learner-enrolled"] = await tokenFor(ids["learner-enrolled"], "learner", schoolA);
    tokens["learner-unenrolled"] = await tokenFor(ids["learner-unenrolled"], "learner", schoolA);
    tokens["learner-other-class"] = await tokenFor(ids["learner-other-class"], "learner", schoolA);
    tokens["parent-a"] = await tokenFor(ids["parent-a"], "parent", schoolA);
    tokens["teacher-b"] = await tokenFor(ids["teacher-b"], "teacher", schoolB);
    tokens["learner-b"] = await tokenFor(ids["learner-b"], "learner", schoolB);

    type CallOptions = {
      token?: string | null;
      body?: unknown;
      params?: Record<string, string>;
      method?: string;
      headers?: Record<string, string>;
    };

    const call = async (routePath: string, options: CallOptions = {}) => {
      const substituted = routePath.replace(/\[([^\]]+)\]/g, (_match, key: string) => {
        const value = options.params?.[key];
        if (!value) throw new Error(`missing route parameter "${key}" for ${routePath}`);
        return encodeURIComponent(value);
      });
      const url = new URL(`http://localhost:3000/api/${substituted}`);

      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";

      const method = (options.method ?? (options.body !== undefined ? "POST" : "GET")).toUpperCase();
      const request = new NextRequest(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });

      const mod: any = await import(`@/app/api/${routePath}/route`);
      const handler = mod[method];
      if (!handler) throw new Error(`${routePath} has no ${method} handler`);

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

    const bodyText = (result: { json: any }) => JSON.stringify(result.json ?? "");

    /**
     * Starts (or resumes) an attempt and returns its id.
     *
     * The route answers 201 for a new attempt and 200 when it resumes an attempt that is
     * still open, so both are accepted here — the suite is about the authorization rules,
     * not about which of the two shapes the response takes.
     */
    const startAttempt = async (token: string, quizId: string): Promise<string> => {
      const result = await call("quizzes/[id]/attempt", {
        method: "POST",
        token,
        params: { id: quizId },
      });
      assert.ok(
        result.status === 201 || result.status === 200,
        `the attempt must start, got ${result.status}: ${bodyText(result)}`
      );
      const attemptId = result.json?.data?.attempt?.id as string | undefined;
      assert.ok(attemptId, `the attempt id is required: ${bodyText(result)}`);
      return attemptId;
    };

    console.log("\n🎯 F1/F2 learner and parent quiz authorization\n");

    /* ═══════════════ F1a — enrollment is required ═══════════════ */

    await test("F1a regression: a learner with NO enrollment cannot read a published quiz", async () => {
      const result = await call("quizzes/[id]", { token: tokens["learner-unenrolled"], params: { id: quizA } });
      assertEq(result.status, 403, "an unenrolled learner must not read the quiz");
      assert.ok(
        !bodyText(result).includes("What is 2 + 2?"),
        "the refused response must not contain the questions"
      );
      assert.ok(
        !bodyText(result).includes("\"4\""),
        "the refused response must not contain the answer key"
      );
    });

    await test("F1a regression: a learner with NO enrollment cannot start an attempt", async () => {
      const result = await call("quizzes/[id]/attempt", {
        method: "POST",
        token: tokens["learner-unenrolled"],
        params: { id: quizA },
      });
      assertEq(result.status, 403, "an unenrolled learner must not start an attempt");
    });

    await test("F1a regression: the quiz LIST and the quiz DETAIL agree about an unenrolled learner", async () => {
      const list = await call("quizzes", { token: tokens["learner-unenrolled"] });
      assertEq(list.status, 200, "the quiz list must answer");
      const listed = Array.isArray(list.json?.data) ? list.json.data : [];
      assertEq(listed.length, 0, "the list already refuses an unenrolled learner");

      const detail = await call("quizzes/[id]", { token: tokens["learner-unenrolled"], params: { id: quizA } });
      assertEq(detail.status, 403, "the detail route must agree with the list");
    });

    await test("F1: a learner enrolled in a different class cannot read or start the quiz", async () => {
      const read = await call("quizzes/[id]", { token: tokens["learner-other-class"], params: { id: quizA } });
      assertEq(read.status, 403, "a learner of another class must not read the quiz");

      const start = await call("quizzes/[id]/attempt", {
        method: "POST",
        token: tokens["learner-other-class"],
        params: { id: quizA },
      });
      assertEq(start.status, 403, "a learner of another class must not start an attempt");
    });

    await test("F1: an enrolled learner CAN read the published quiz and gets no answer key", async () => {
      const result = await call("quizzes/[id]", { token: tokens["learner-enrolled"], params: { id: quizA } });
      assertEq(result.status, 200, "an enrolled learner must be able to read the quiz");
      const questions = result.json?.data?.questions ?? [];
      assert.ok(Array.isArray(questions) && questions.length > 0, "the quiz must carry its questions");
      for (const question of questions) {
        assertEq(question.correctAnswer, null, "a learner must never receive the answer key");
      }
    });

    await test("F1: an enrolled learner CAN start an attempt", async () => {
      const result = await call("quizzes/[id]/attempt", {
        method: "POST",
        token: tokens["learner-enrolled"],
        params: { id: quizA },
      });
      assertEq(result.status, 201, "an enrolled learner must be able to start an attempt");
    });

    await test("F1: an enrolled learner cannot read an unpublished draft", async () => {
      const result = await call("quizzes/[id]", { token: tokens["learner-enrolled"], params: { id: quizADraft } });
      assertEq(result.status, 403, "a learner must not read a draft");
    });

    /* ═══════════════ F1b — submit is authorized too ═══════════════ */

    await test("F1b regression: a learner who was de-enrolled cannot submit", async () => {
      const attemptId = await startAttempt(tokens["learner-enrolled"], quizA);

      await q(`DELETE FROM learner_classes WHERE learner_id = $1 AND class_id = $2`, [ids["learner-enrolled"], classA]);

      const submit = await call("quizzes/[id]/attempt", {
        method: "PUT",
        token: tokens["learner-enrolled"],
        params: { id: quizA },
        body: { attemptId, answers: { [questionA]: "4" } },
      });
      assertEq(submit.status, 403, "a de-enrolled learner must not be able to submit");

      const points = await q(`SELECT count(*)::int AS n FROM learner_points WHERE learner_id = $1`, [
        ids["learner-enrolled"],
      ]);
      assertEq(points[0].n, 0, "a refused submit must not award points");

      // Restore the enrollment for the remaining tests.
      await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
        schoolA, ids["learner-enrolled"], classA, yearA,
      ]);
    });

    await test("F1b regression: a learner cannot submit after the quiz was unpublished", async () => {
      const attemptId = await startAttempt(tokens["learner-enrolled"], quizA);

      await q(`UPDATE quizzes SET is_published = false WHERE id = $1`, [quizA]);

      const submit = await call("quizzes/[id]/attempt", {
        method: "PUT",
        token: tokens["learner-enrolled"],
        params: { id: quizA },
        body: { attemptId, answers: { [questionA]: "4" } },
      });
      assertEq(submit.status, 403, "an unpublished quiz must not accept submissions");

      const points = await q(`SELECT count(*)::int AS n FROM learner_points WHERE learner_id = $1`, [
        ids["learner-enrolled"],
      ]);
      assertEq(points[0].n, 0, "a refused submit must not award points");

      await q(`UPDATE quizzes SET is_published = true WHERE id = $1`, [quizA]);
    });

    await test("F1b: an enrolled learner CAN submit a published quiz", async () => {
      const attemptId = await startAttempt(tokens["learner-enrolled"], quizA);

      const submit = await call("quizzes/[id]/attempt", {
        method: "PUT",
        token: tokens["learner-enrolled"],
        params: { id: quizA },
        body: { attemptId, answers: { [questionA]: "4" } },
      });
      assertEq(submit.status, 200, "an enrolled learner must be able to submit");

      const points = await q(`SELECT count(*)::int AS n FROM learner_points WHERE learner_id = $1`, [
        ids["learner-enrolled"],
      ]);
      assert.ok(points[0].n > 0, "a legitimate submit awards points");
      await q(`DELETE FROM learner_points WHERE learner_id = $1`, [ids["learner-enrolled"]]);
    });

    await test("F1b regression: the mid-game answer check refuses an unenrolled learner", async () => {
      // An open attempt that the learner cannot legitimately start any more.
      const attempt = await one(
        `INSERT INTO quiz_attempts (school_id, quiz_id, learner_id, answers, started_at)
         VALUES ($1, $2, $3, '{}'::jsonb, now()) RETURNING id`,
        [schoolA, quizA, ids["learner-unenrolled"]]
      );
      const attemptId = attempt.id as string;

      const result = await call("quizzes/[id]/check", {
        method: "POST",
        token: tokens["learner-unenrolled"],
        params: { id: quizA },
        body: { attemptId, questionId: questionA, answer: "4" },
      });
      assertEq(result.status, 403, "an unenrolled learner must not grade an answer");
      assert.ok(!bodyText(result).includes("correctAnswer\":\"4"), "the refusal must not leak the key");
    });

    /* ═══════════════ F2 — parents ═══════════════ */

    await test("F2 regression: a parent must not receive the answer key", async () => {
      const result = await call("quizzes/[id]", { token: tokens["parent-a"], params: { id: quizA } });
      assertEq(result.status, 200, "a parent may read a published quiz");
      const questions = result.json?.data?.questions ?? [];
      assert.ok(Array.isArray(questions) && questions.length > 0, "the quiz must carry its questions");
      for (const question of questions) {
        assertEq(question.correctAnswer, null, "a parent must never receive the answer key");
      }
      assert.ok(!bodyText(result).includes("\"4\""), "the response must not contain the answer key");
    });

    await test("F2 regression: a parent must not read an unpublished draft", async () => {
      const result = await call("quizzes/[id]", { token: tokens["parent-a"], params: { id: quizADraft } });
      assertEq(result.status, 403, "a parent must not read an unpublished draft");
      assert.ok(!bodyText(result).includes("Draft question"), "the refusal must not leak the draft");
    });

    await test("F2: the owning teacher still sees the answer key and their own draft", async () => {
      const published = await call("quizzes/[id]", { token: tokens["teacher-a"], params: { id: quizA } });
      assertEq(published.status, 200, "the owning teacher must read their quiz");
      const questions = published.json?.data?.questions ?? [];
      assert.ok(questions.length > 0, "the quiz must carry its questions");
      assertEq(questions[0].correctAnswer, "4", "a teacher needs the answer key");

      const draft = await call("quizzes/[id]", { token: tokens["teacher-a"], params: { id: quizADraft } });
      assertEq(draft.status, 200, "the owning teacher must be able to preview their draft");
    });

    await test("F2: a teacher who does not own the quiz cannot read it", async () => {
      const result = await call("quizzes/[id]", { token: tokens["teacher-b"], params: { id: quizA } });
      assertEq(result.status, 404, "another school's quiz must not exist for a teacher");
    });

    await test("F2: a school administrator may read a published quiz and a draft", async () => {
      const published = await call("quizzes/[id]", { token: tokens["admin-a"], params: { id: quizA } });
      assertEq(published.status, 200, "an administrator may read a published quiz");
      const draft = await call("quizzes/[id]", { token: tokens["admin-a"], params: { id: quizADraft } });
      assertEq(draft.status, 200, "an administrator may read a draft");
    });

    /* ═══════════════ Tenant boundary ═══════════════ */

    await test("Tenant: a learner of another school cannot read or start this school's quiz", async () => {
      const read = await call("quizzes/[id]", { token: tokens["learner-b"], params: { id: quizA } });
      assertEq(read.status, 404, "another school's quiz must not exist");

      const start = await call("quizzes/[id]/attempt", {
        method: "POST",
        token: tokens["learner-b"],
        params: { id: quizA },
      });
      assertEq(start.status, 404, "another school's quiz must not exist");

      const parent = await call("quizzes/[id]", { token: tokens["parent-a"], params: { id: quizB } });
      assertEq(parent.status, 404, "another school's quiz must not exist for a parent");
    });

    console.log(`\n📊 quiz access: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
  } catch (error) {
    primaryError = error;
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      const { pool } = await import("@/db");
      await pool.end();
    } catch {
      /* ignore */
    }
    const cleanup = await scratch.dispose();
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    assertCleanupSucceeded(cleanup, primaryError);
  }

  /* Exit explicitly: the embedded-postgres shutdown hook must not turn a red suite green. */
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
