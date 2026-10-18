/**
 * Assignment-question authorization: live PostgreSQL tests against the real App Router handlers.
 *
 * The fixture intentionally includes multiple staff roles, an enrolled learner, an unenrolled
 * learner, a linked parent, an unlinked parent, and a second school. It verifies that the
 * assignment lookup itself is the authorization boundary and that learner/parent DTOs never
 * contain answer keys or explanations.
 */

import assert from "assert";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { NextRequest } from "next/server";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");
const DB_NAME = `easylearn_assignment_auth_${crypto.randomBytes(4).toString("hex")}`;
const PASSWORD = "Assignment-Auth-Test-Password!";
const JWT_SECRET = "assignment-auth-test-secret-0123456789";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed += 1;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${(error as Error).message}`);
      failed += 1;
    });
}

function assertStatus(result: { status: number; text: string }, expected: number, message: string) {
  assert.equal(result.status, expected, `${message}: ${result.text}`);
}

function assertNoAnswerKey(value: unknown, message: string) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes("correctAnswer"), `${message} must not contain correctAnswer`);
  assert(!serialized.includes("explanation"), `${message} must not contain explanation`);
}

async function main() {
  const { Client } = requireFromRepo("pg");
  const bcrypt = requireFromRepo("bcryptjs");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    let EmbeddedPostgres: any;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      return;
    }
    const port = 58529 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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

    const migration = runMigrationChain({
      databaseUrl: scratchUrl,
      env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" },
    });
    if (migration.status !== 0) {
      throw new Error(`migration failed:\n${((migration.stdout || "") + (migration.stderr || "")).slice(-6000)}`);
    }

    const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];
    const passwordHash = await bcrypt.hash(PASSWORD, 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Assignment School A','ASA','assignment-school-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Assignment School B','ASB','assignment-school-b') RETURNING id`
    )).id as string;

    const fixtureRoles = [
      ["teacher-a", "teacher", schoolA],
      ["teacher-other", "teacher", schoolA],
      ["admin-a", "school_admin", schoolA],
      ["head-a", "head_teacher", schoolA],
      ["learner-a", "learner", schoolA],
      ["learner-unenrolled", "learner", schoolA],
      ["parent-linked", "parent", schoolA],
      ["parent-unlinked", "parent", schoolA],
      ["teacher-b", "teacher", schoolB],
      ["learner-b", "learner", schoolB],
    ] as const;
    const ids: Record<string, string> = {};

    for (const [key, role, schoolId] of fixtureRoles) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1,$2,$3,$4,'Assignment', $5, true) RETURNING id`,
        [`${key}-${DB_NAME}@example.test`, `${key}-${DB_NAME.slice(-8)}`, passwordHash, role, key]
      );
      ids[key] = row.id as string;
      await q(
        `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active')`,
        [schoolId, row.id, role]
      );
    }

    const yearA = (await one(
      `INSERT INTO academic_years (school_id,name,start_date,end_date,is_current) VALUES ($1,'2026/27 A','2026-09-01','2027-07-01',true) RETURNING id`,
      [schoolA]
    )).id as string;
    const yearB = (await one(
      `INSERT INTO academic_years (school_id,name,start_date,end_date,is_current) VALUES ($1,'2026/27 B','2026-09-01','2027-07-01',true) RETURNING id`,
      [schoolB]
    )).id as string;
    const subjectA = (await one(
      `INSERT INTO subjects (school_id,name,code) VALUES ($1,'Mathematics A','AUTH-A') RETURNING id`,
      [schoolA]
    )).id as string;
    const subjectB = (await one(
      `INSERT INTO subjects (school_id,name,code) VALUES ($1,'Mathematics B','AUTH-B') RETURNING id`,
      [schoolB]
    )).id as string;
    const classA = (await one(
      `INSERT INTO classes (school_id,name,level,class_teacher_id,academic_year_id) VALUES ($1,'Class A','primary',$2,$3) RETURNING id`,
      [schoolA, ids["teacher-a"], yearA]
    )).id as string;
    const classB = (await one(
      `INSERT INTO classes (school_id,name,level,class_teacher_id,academic_year_id) VALUES ($1,'Class B','primary',$2,$3) RETURNING id`,
      [schoolB, ids["teacher-b"], yearB]
    )).id as string;

    await q(
      `INSERT INTO learner_classes (school_id,learner_id,class_id,academic_year_id) VALUES ($1,$2,$3,$4)`,
      [schoolA, ids["learner-a"], classA, yearA]
    );
    await q(
      `INSERT INTO parent_learners (school_id,parent_id,learner_id,relationship) VALUES ($1,$2,$3,'guardian')`,
      [schoolA, ids["parent-linked"], ids["learner-a"]]
    );

    const assignment = async (schoolId: string, title: string, classId: string, teacherId: string, subjectId: string, status: string) =>
      (await one(
        `INSERT INTO assignments (school_id,title,description,instructions,class_id,subject_id,teacher_id,status,max_score)
         VALUES ($1,$2,'description','instructions',$3,$4,$5,$6,100) RETURNING id`,
        [schoolId, title, classId, subjectId, teacherId, status]
      )).id as string;

    const ownPublished = await assignment(schoolA, "Own published", classA, ids["teacher-a"], subjectA, "published");
    const ownDraft = await assignment(schoolA, "Own draft", classA, ids["teacher-a"], subjectA, "draft");
    const otherPublished = await assignment(schoolA, "Other teacher published", classA, ids["teacher-other"], subjectA, "published");
    const foreignPublished = await assignment(schoolB, "Foreign published", classB, ids["teacher-b"], subjectB, "published");
    const submitAssignment = await assignment(schoolA, "Submit published", classA, ids["teacher-a"], subjectA, "published");

    const question = (await one(
      `INSERT INTO assignment_questions (assignment_id,question_type,question_text,options,correct_answer,points,order_index,explanation)
       VALUES ($1,'mcq','What is two plus two?','["3","4"]','4',5,0,'The sum is four.') RETURNING id`,
      [ownPublished]
    )).id as string;
    const submitQuestion = (await one(
      `INSERT INTO assignment_questions (assignment_id,question_type,question_text,correct_answer,points,order_index,explanation)
       VALUES ($1,'short_answer','Name a primary color','red',5,0,'Red is a primary color.') RETURNING id`,
      [submitAssignment]
    )).id as string;
    const submission = (await one(
      `INSERT INTO submissions (school_id,assignment_id,learner_id,status,score,max_score,percentage,submitted_at,graded_at)
       VALUES ($1,$2,$3,'graded',5,5,100,now(),now()) RETURNING id`,
      [schoolA, ownPublished, ids["learner-a"]]
    )).id as string;
    await q(
      `INSERT INTO assignment_answers (submission_id,question_id,learner_id,answer,is_correct,points_awarded,points_possible)
       VALUES ($1,$2,$3,'4',true,5,5)`,
      [submission, question, ids["learner-a"]]
    );

    const auth = await import("@/lib/auth");
    const tokens: Record<string, string> = {};
    for (const [key, role, schoolId] of fixtureRoles) {
      tokens[key] = await auth.createToken({
        userId: ids[key],
        role,
        email: `${key}@example.test`,
        schoolId,
      });
    }

    const route = async (pathName: string) => import(`@/app/api/${pathName}/route`);
    type CallOptions = {
      token: string;
      query?: Record<string, string>;
      method?: string;
      body?: unknown;
      params?: Record<string, string>;
    };
    const call = async (pathName: string, options: CallOptions) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
      const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const request = new NextRequest(url, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const mod: any = await route(pathName);
      const method = (options.method ?? (options.body === undefined ? "GET" : "POST")).toUpperCase();
      const response = options.params
        ? await mod[method](request, { params: Promise.resolve(options.params) })
        : await mod[method](request);
      let json: any = null;
      try { json = await response.clone().json(); } catch { /* non-JSON */ }
      return { status: response.status, json, text: JSON.stringify(json ?? "") };
    };

    console.log("\n🧩 Assignment-question authorization — live database tests\n");

    await test("teacher ownership is enforced in the assignment lookup", async () => {
      const own = await call("assignments/[id]/questions", { token: tokens["teacher-a"], params: { id: ownPublished } });
      assertStatus(own, 200, "owner question read");
      assert(own.json.data[0].correctAnswer === "4", "owner receives the answer key");
      assert(own.json.data[0].explanation === "The sum is four.", "owner receives explanation");

      const foreignTeacher = await call("assignments/[id]/questions", { token: tokens["teacher-other"], params: { id: ownPublished } });
      assertStatus(foreignTeacher, 404, "non-owner teacher cannot read another teacher's questions");
    });

    await test("school administrators and head teachers receive approved oversight access", async () => {
      for (const role of ["admin-a", "head-a"]) {
        const result = await call("assignments/[id]/questions", { token: tokens[role], params: { id: ownPublished } });
        assertStatus(result, 200, `${role} oversight read`);
        assert(result.json.data[0].correctAnswer === "4", `${role} receives staff key after oversight authorization`);
      }
    });

    await test("learners receive only published enrolled question content", async () => {
      const own = await call("assignments/[id]/questions", { token: tokens["learner-a"], params: { id: ownPublished } });
      assertStatus(own, 200, "enrolled learner read");
      assertNoAnswerKey(own.json, "learner questions");

      const draft = await call("assignments/[id]/questions", { token: tokens["learner-a"], params: { id: ownDraft } });
      assertStatus(draft, 404, "draft is hidden from learners");

      const unenrolled = await call("assignments/[id]/questions", { token: tokens["learner-unenrolled"], params: { id: ownPublished } });
      assertStatus(unenrolled, 404, "unenrolled learner is denied");

      const foreign = await call("assignments/[id]/questions", { token: tokens["learner-a"], params: { id: foreignPublished } });
      assertStatus(foreign, 404, "foreign school assignment is denied");
    });

    await test("parents require an explicit verified linked learner and never receive keys", async () => {
      const linked = await call("assignments/[id]/questions", {
        token: tokens["parent-linked"],
        params: { id: ownPublished },
        query: { learnerId: ids["learner-a"] },
      });
      assertStatus(linked, 200, "linked parent read");
      assertNoAnswerKey(linked.json, "parent questions");

      const missingTarget = await call("assignments/[id]/questions", {
        token: tokens["parent-linked"],
        params: { id: ownPublished },
      });
      assertStatus(missingTarget, 404, "parent cannot use an implicit child target");

      const unlinkedTarget = await call("assignments/[id]/questions", {
        token: tokens["parent-linked"],
        params: { id: ownPublished },
        query: { learnerId: ids["learner-unenrolled"] },
      });
      assertStatus(unlinkedTarget, 404, "parent cannot choose an unlinked learner");

      const unlinkedParent = await call("assignments/[id]/questions", {
        token: tokens["parent-unlinked"],
        params: { id: ownPublished },
        query: { learnerId: ids["learner-a"] },
      });
      assertStatus(unlinkedParent, 404, "unlinked parent is denied");
    });

    await test("detail and result DTOs keep answer keys staff-only", async () => {
      const learnerDetail = await call("assignments/[id]", { token: tokens["learner-a"], params: { id: ownPublished } });
      assertStatus(learnerDetail, 200, "learner detail");
      assertNoAnswerKey(learnerDetail.json, "learner assignment detail");

      const parentDetail = await call("assignments/[id]", {
        token: tokens["parent-linked"],
        params: { id: ownPublished },
        query: { learnerId: ids["learner-a"] },
      });
      assertStatus(parentDetail, 200, "parent detail");
      assertNoAnswerKey(parentDetail.json, "parent assignment detail");

      const learnerResults = await call("assignments/[id]/results", { token: tokens["learner-a"], params: { id: ownPublished } });
      assertStatus(learnerResults, 200, "learner results");
      assertNoAnswerKey(learnerResults.json, "learner results");

      const parentResults = await call("assignments/[id]/results", {
        token: tokens["parent-linked"],
        params: { id: ownPublished },
        query: { learnerId: ids["learner-a"] },
      });
      assertStatus(parentResults, 200, "parent results");
      assertNoAnswerKey(parentResults.json, "parent results");

      const staffResults = await call("assignments/[id]/results", {
        token: tokens["teacher-a"],
        params: { id: ownPublished },
        query: { learnerId: ids["learner-a"] },
      });
      assertStatus(staffResults, 200, "staff results");
      assert(staffResults.json.data.questions[0].correctAnswer === "4", "staff result retains answer key");
    });

    await test("assignment list authorization is query-level and parent list stays allowlisted", async () => {
      const learnerList = await call("assignments", { token: tokens["learner-a"] });
      assertStatus(learnerList, 200, "learner assignment list");
      assert(learnerList.json.data.some((row: any) => row.id === ownPublished), "published enrolled assignment is listed");
      assert(!learnerList.json.data.some((row: any) => row.id === ownDraft), "draft is not listed");
      assertNoAnswerKey(learnerList.json, "learner assignment list");

      const parentList = await call("assignments", { token: tokens["parent-linked"] });
      assertStatus(parentList, 200, "parent assignment list");
      assert(parentList.json.data.some((row: any) => row.id === ownPublished), "linked child's assignment is listed");
      assertNoAnswerKey(parentList.json, "parent assignment list");
    });

    await test("submission response does not disclose stored answer keys", async () => {
      const result = await call("assignments/[id]/submit", {
        token: tokens["learner-a"],
        params: { id: submitAssignment },
        body: { answers: { [submitQuestion]: "red" } },
      });
      assertStatus(result, 200, "learner submission");
      assertNoAnswerKey(result.json, "submission response");
    });
  } finally {
    await db.end().catch(() => undefined);
    await (await import("@/db")).pool.end().catch(() => undefined);
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DB_NAME]
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("❌ FATAL:", error);
  process.exitCode = 1;
});
