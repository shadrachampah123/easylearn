/**
 * Additional PR #45 review regressions.
 *
 * ── Provenance ──────────────────────────────────────────────────────────────────────────
 * Written by the independent reviewer of PR #45 and originally delivered out-of-band as
 * `docs/reviews/pr45/additional-tests.patch`, because a reviewer's reproductions must not
 * be authored by the person whose fix is under review. They are now permanent test files
 * so the reproductions keep running in CI instead of living in a patch nobody applies.
 *
 * One assertion was adopted rather than copied: the R3 concurrent-submission case used to
 * require that exactly one of the two responses be HTTP 200, which contradicts the
 * documented idempotent replay contract (see README, "Repeating a submission"). It now
 * asserts both statuses are 200 AND that `alreadySubmitted` distinguishes the one
 * completion from the one replay, so the security property (a single award) is still
 * proven while the transport status is allowed to be idempotent. Nothing else in this
 * file was weakened.
 *
 * These cases fill gaps in the committed suite; failed expectations are findings, not
 * expected-success vulnerability demonstrations. Requires an explicitly disposable LOCAL
 * PostgreSQL server. Never uses production data.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

const { createScratchDatabase, assertCleanupSucceeded } = require("./helpers/scratch-db.js");
const { runMigrations } = require("./helpers/migrations.js");
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  // Optional selection is only for comparing the inherited findings with the base;
  // the full PR-head review is always run without this variable.
  if (process.env.PR45_REVIEW_FILTER && !new RegExp(process.env.PR45_REVIEW_FILTER).test(name)) {
    console.log(`NOT SELECTED ${name}`); return;
  }
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${(error as Error).message}`); }
}
async function main() {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl && process.env.EASY_LEARN_TEST_DATABASE === "true", "explicit disposable DB configuration required");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname), "local disposable database only");
  const dbName = `easylearn_pr45_review_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const scratch = await createScratchDatabase({ admin, adminUrl, dbName, label: "pr45-review" });
  const url = new URL(adminUrl); url.pathname = `/${dbName}`;
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = createTestJwtSecret();
  let primaryError: unknown = null;
  try {
    const migration = runMigrations({ databaseUrl: url.toString() });
    assert.equal(migration.status, 0, `migration failure: ${migration.stderr}`);
    const auth = await import("@/lib/auth");
    const detail = await import("@/app/api/quizzes/[id]/route");
    const list = await import("@/app/api/quizzes/route");
    const attempt = await import("@/app/api/quizzes/[id]/attempt/route");
    const check = await import("@/app/api/quizzes/[id]/check/route");
    const q = async (text: string, values: unknown[] = []) => (await scratch.db.query(text, values)).rows;
    const one = async (text: string, values: unknown[] = []) => (await q(text, values))[0];
    let sequence = 0;
    async function school() {
      const n = ++sequence;
      return (await one("INSERT INTO schools (name, short_name, slug) VALUES ($1,$1,$2) RETURNING id", [`Review ${n}`, `review-${n}`])).id as string;
    }
    const schoolA = await school();
    const schoolB = await school();
    const subjectA = (await one("INSERT INTO subjects (school_id,name,code) VALUES ($1,'Review maths','RMA') RETURNING id", [schoolA])).id as string;
    const subjectB = (await one("INSERT INTO subjects (school_id,name,code) VALUES ($1,'Review maths','RMB') RETURNING id", [schoolB])).id as string;
    async function user(role: string, schoolId = schoolA) {
      const n = ++sequence;
      const id = (await one("INSERT INTO users (email,password_hash,role,first_name,last_name,is_active) VALUES ($1,'not-a-login-password',$2,'Review',$3,true) RETURNING id", [`review-${n}@example.test`, role, String(n)])).id as string;
      await q("INSERT INTO school_users (school_id,user_id,role,status) VALUES ($1,$2,$3,'active')", [schoolId,id,role]);
      return { id, token: await tokenFor(id, schoolId) };
    }
    async function tokenFor(userId: string, schoolId: string) {
      const membership = await one("SELECT id,role FROM school_users WHERE school_id=$1 AND user_id=$2 AND status='active'", [schoolId,userId]);
      assert.ok(membership);
      return auth.createToken({ userId, role: membership.role, schoolId, membershipId: membership.id });
    }
    async function quiz(teacherId: string, options: { schoolId?: string; published?: boolean; showResults?: boolean; maxAttempts?: number } = {}) {
      const schoolId = options.schoolId ?? schoolA;
      const classId = (await one("INSERT INTO classes (school_id,name,level,class_teacher_id) VALUES ($1,$2,'primary',$3) RETURNING id", [schoolId,`Review class ${++sequence}`,teacherId])).id as string;
      const id = (await one("INSERT INTO quizzes (school_id,title,class_id,subject_id,teacher_id,is_published,show_results,max_attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [schoolId,`Review quiz ${++sequence}`,classId,schoolId === schoolA ? subjectA : subjectB,teacherId,options.published ?? true,options.showResults ?? false,options.maxAttempts ?? 3])).id as string;
      const questionId = (await one("INSERT INTO quiz_questions (quiz_id,question_type,question_text,correct_answer,points,order_index) VALUES ($1,'mcq','Review question','review-secret-answer',1,0) RETURNING id", [id])).id as string;
      return { id, classId, questionId, schoolId };
    }
    async function enroll(learnerId: string, target: { classId: string; schoolId: string }) {
      await q("INSERT INTO learner_classes (school_id,learner_id,class_id) VALUES ($1,$2,$3)", [target.schoolId,learnerId,target.classId]);
    }
    type Handler = (req: NextRequest, ctx: { params: Promise<{id: string}> }) => Promise<Response>;
    async function call(handler: Handler, token: string, id: string, method = "GET", body?: unknown) {
      const request = new NextRequest(`http://review.example.test/api/quizzes/${id}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const response = await handler(request, { params: Promise.resolve({id}) });
      return { status: response.status, json: await response.json() as any };
    }
    async function start(token: string, id: string) {
      const response = await call(attempt.POST,token,id,"POST");
      assert.equal(response.status,201,JSON.stringify(response.json));
      return response.json.data.attempt.id as string;
    }
    async function effects(learnerId: string) {
      return one("SELECT (SELECT count(*)::int FROM learner_points WHERE learner_id=$1) AS points, (SELECT count(*)::int FROM notifications WHERE user_id=$1) AS notices, (SELECT count(*)::int FROM quiz_attempts WHERE learner_id=$1 AND completed_at IS NOT NULL) AS completed", [learnerId]);
    }
    const teacher = await user("teacher");

    await test("same-school non-owner teacher cannot read either published quiz or draft", async () => {
      const other = await user("teacher");
      for (const published of [true,false]) {
        const item = await quiz(teacher.id,{published});
        const response = await call(detail.GET,other.token,item.id);
        assert.equal(response.status,403);
        assert.ok(!JSON.stringify(response.json).includes("review-secret-answer"));
      }
    });
    await test("head teacher and administrator can read drafts and keys; non-owner head teacher cannot edit", async () => {
      const item = await quiz(teacher.id,{published:false});
      for (const role of ["head_teacher","school_admin"]) {
        const staff = await user(role);
        const response = await call(detail.GET,staff.token,item.id);
        assert.equal(response.status,200);
        assert.equal(response.json.data.questions[0].correctAnswer,"review-secret-answer");
        const write = await call(detail.PUT,staff.token,item.id,"PUT",{description:"Staff policy control"});
        assert.equal(write.status,role === "school_admin" ? 200 : 403);
      }
    });
    await test("parent list hides drafts and all parent grading paths deny without effects", async () => {
      const parent = await user("parent");
      const item = await quiz(teacher.id,{published:false});
      const listed = await call(list.GET,parent.token,"");
      assert.equal(listed.status,200);
      assert.ok(!listed.json.data.some((r: any)=>r.id===item.id));
      const before = await effects(parent.id);
      for (const [handler,method] of [[attempt.POST,"POST"],[attempt.PUT,"PUT"],[check.POST,"POST"]] as const) {
        const response = await call(handler,parent.token,item.id,method,{attemptId:crypto.randomUUID(),questionId:item.questionId,answers:{[item.questionId]:"review-secret-answer"},answer:"review-secret-answer"});
        assert.equal(response.status,403);
        assert.ok(!JSON.stringify(response.json).includes("review-secret-answer"));
      }
      assert.deepEqual(await effects(parent.id),before);
    });
    await test("wrong attempt owner and wrong question IDs cannot expose keys or award points", async () => {
      const learner = await user("learner");
      const other = await user("learner");
      const item = await quiz(teacher.id,{showResults:true});
      const unrelated = await quiz(teacher.id);
      await enroll(learner.id,item); await enroll(other.id,item);
      const attemptId = await start(learner.token,item.id);
      const before = await effects(other.id);
      const submission = await call(attempt.PUT,other.token,item.id,"PUT",{attemptId,answers:{[item.questionId]:"review-secret-answer"}});
      const feedback = await call(check.POST,other.token,item.id,"POST",{attemptId,questionId:item.questionId,answer:"review-secret-answer"});
      const wrongQuestion = await call(check.POST,learner.token,item.id,"POST",{attemptId,questionId:unrelated.questionId,answer:"review-secret-answer"});
      assert.equal(submission.status,404); assert.equal(feedback.status,400); assert.equal(wrongQuestion.status,404);
      for (const response of [submission,feedback,wrongQuestion]) assert.ok(!JSON.stringify(response.json).includes("review-secret-answer"));
      assert.deepEqual(await effects(other.id),before);
      assert.equal((await one("SELECT completed_at FROM quiz_attempts WHERE id=$1",[attemptId])).completed_at,null);
    });
    await test("unpublishing and de-enrollment deny check and submit without mutation or disclosure", async () => {
      const learner = await user("learner");
      const item = await quiz(teacher.id,{showResults:true});
      await enroll(learner.id,item);
      const attemptId = await start(learner.token,item.id);
      const before = await effects(learner.id);
      await q("UPDATE quizzes SET is_published=false WHERE id=$1",[item.id]);
      for (const state of ["unpublished","unenrolled"]) {
        if (state === "unenrolled") {
          await q("UPDATE quizzes SET is_published=true WHERE id=$1",[item.id]);
          await q("DELETE FROM learner_classes WHERE learner_id=$1 AND class_id=$2",[learner.id,item.classId]);
        }
        for (const [handler,method] of [[attempt.POST,"POST"],[attempt.PUT,"PUT"],[check.POST,"POST"]] as const) {
          const response = await call(handler,learner.token,item.id,method,{attemptId,questionId:item.questionId,answers:{[item.questionId]:"review-secret-answer"},answer:"review-secret-answer"});
          assert.ok(response.status >= 400 && response.status < 500,`${state}: ${response.status}`);
          assert.ok(!JSON.stringify(response.json).includes("review-secret-answer"));
        }
        assert.deepEqual(await effects(learner.id),before);
        assert.equal((await one("SELECT completed_at FROM quiz_attempts WHERE id=$1",[attemptId])).completed_at,null);
      }
    });
    await test("hidden-results feedback and successful submission withhold answer keys", async () => {
      const learner = await user("learner");
      const item = await quiz(teacher.id,{showResults:false});
      await enroll(learner.id,item);
      const attemptId = await start(learner.token,item.id);
      const feedback = await call(check.POST,learner.token,item.id,"POST",{attemptId,questionId:item.questionId,answer:"wrong"});
      assert.equal(feedback.status,200); assert.equal(feedback.json.data.correctAnswer,null);
      const response = await call(attempt.PUT,learner.token,item.id,"PUT",{attemptId,answers:{[item.questionId]:"wrong"}});
      assert.equal(response.status,200);
      assert.ok(!JSON.stringify(response.json).includes("review-secret-answer"));
      assert.equal((await effects(learner.id)).points,0);
    });
    await test("enrollment helper uses selected school; a second-school enrollment is not enough", async () => {
      const access = await import("@/lib/quiz-access");
      const learner = await user("learner");
      const secondTeacher = await user("teacher",schoolB);
      const a = await quiz(teacher.id);
      const b = await quiz(secondTeacher.id,{schoolId:schoolB});
      await q("INSERT INTO school_users (school_id,user_id,role,status) VALUES ($1,$2,'learner','active')",[schoolB,learner.id]);
      await enroll(learner.id,b);
      assert.equal(await access.isLearnerEnrolledInClass(schoolA,learner.id,a.classId),false);
      assert.equal(await access.isLearnerEnrolledInClass(schoolA,learner.id,b.classId),false);
      assert.equal(await access.isLearnerEnrolledInClass(schoolB,learner.id,b.classId),true);
      const read = await call(detail.GET,learner.token,a.id);
      assert.equal(read.status,403);
      await enroll(learner.id,a);
      assert.equal(await access.isLearnerEnrolledInClass(schoolA,learner.id,a.classId),true);
    });
    await test("multi-school enrolled learner can open the quiz listed in their selected school", async () => {
      const localTeacher = await user("teacher");
      const learner = await user("learner");
      const item = await quiz(localTeacher.id);
      await enroll(learner.id,item);
      assert.equal((await call(detail.GET,learner.token,item.id)).status,200);
      await q("INSERT INTO school_users (school_id,user_id,role,status) VALUES ($1,$2,'learner','active')",[schoolB,learner.id]);
      const listed = await call(list.GET,learner.token,"");
      assert.ok(listed.json.data.some((r: any)=>r.id===item.id));
      const read = await call(detail.GET,learner.token,item.id);
      const begun = await call(attempt.POST,learner.token,item.id,"POST");
      console.log(`  OBSERVED dual-school learner: listed=true, detail=${read.status}, start=${begun.status}`);
      assert.equal(read.status,200,"a second active membership must not invalidate valid selected-school enrollment");
      assert.equal(begun.status,201);
    });
    await test("multi-school teacher can open their own directly attributed quiz", async () => {
      const localTeacher = await user("teacher");
      const item = await quiz(localTeacher.id);
      await q("INSERT INTO school_users (school_id,user_id,role,status) VALUES ($1,$2,'teacher','active')",[schoolB,localTeacher.id]);
      const listed = await call(list.GET,localTeacher.token,"");
      assert.ok(listed.json.data.some((r: any)=>r.id===item.id));
      const response = await call(detail.GET,localTeacher.token,item.id);
      console.log(`  OBSERVED dual-school teacher: listed=true, detail=${response.status}`);
      assert.equal(response.status,200);
    });
    await test("moving a teacher membership must not move an old school A draft/key into school B", async () => {
      const movingTeacher = await user("teacher");
      const item = await quiz(movingTeacher.id,{published:false});
      const bAdmin = await user("school_admin",schoolB);
      assert.equal((await call(detail.GET,bAdmin.token,item.id)).status,404);
      await q("UPDATE school_users SET status='disabled' WHERE user_id=$1 AND school_id=$2",[movingTeacher.id,schoolA]);
      await q("INSERT INTO school_users (school_id,user_id,role,status) VALUES ($1,$2,'teacher','active')",[schoolB,movingTeacher.id]);
      const response = await call(detail.GET,bAdmin.token,item.id);
      const leaked = JSON.stringify(response.json).includes("review-secret-answer");
      assert.equal((await one("SELECT school_id FROM quizzes WHERE id=$1",[item.id])).school_id,schoolA);
      console.log(`  OBSERVED transferred teacher: B-admin detail=${response.status}, A-draft answer key exposed=${leaked}`);
      assert.equal(response.status,404,"school B must not read a quiz still attributed to school A");
      assert.equal(leaked,false);
    });
    await test("demoted quiz owner cannot edit/publish or delete as a parent", async () => {
      const formerTeacher = await user("teacher");
      const item = await quiz(formerTeacher.id,{published:false});
      await q("UPDATE school_users SET role='parent' WHERE user_id=$1 AND school_id=$2",[formerTeacher.id,schoolA]);
      const read = await call(detail.GET,formerTeacher.token,item.id);
      const edit = await call(detail.PUT,formerTeacher.token,item.id,"PUT",{isPublished:true,description:"Unauthorized mutation"});
      const changed = (await one("SELECT is_published FROM quizzes WHERE id=$1",[item.id])).is_published;
      const deleted = await call(detail.DELETE,formerTeacher.token,item.id,"DELETE");
      console.log(`  OBSERVED demoted owner: draft GET=${read.status}, PUT=${edit.status}, published=${changed}, DELETE=${deleted.status}`);
      assert.equal(read.status,403,"the read gate must see the new membership role, not token.role");
      assert.equal(edit.status,403,"historical ownership is not a current staff role");
      assert.equal(deleted.status,403);
    });
    await test("a default one-attempt quiz can resume an already-open attempt", async () => {
      const learner = await user("learner");
      const item = await quiz(teacher.id,{maxAttempts:1});
      await enroll(learner.id,item);
      const id = await start(learner.token,item.id);
      const resumed = await call(attempt.POST,learner.token,item.id,"POST");
      console.log(`  OBSERVED maxAttempts=1: first=201, resume=${resumed.status}`);
      assert.equal(resumed.status,200,"incomplete attempt is not a new attempt");
      assert.equal(resumed.json.data.attempt.id,id);
    });
    await test("blank fill-in answer cannot fail the check but earn full credit on submit", async () => {
      const learner = await user("learner");
      const item = await quiz(teacher.id,{showResults:false});
      await q("UPDATE quiz_questions SET question_type='fill_blank' WHERE id=$1",[item.questionId]);
      await enroll(learner.id,item);
      const attemptId = await start(learner.token,item.id);
      const feedback = await call(check.POST,learner.token,item.id,"POST",{attemptId,questionId:item.questionId,answer:"   "});
      const submitted = await call(attempt.PUT,learner.token,item.id,"PUT",{attemptId,answers:{[item.questionId]:"   "}});
      const state = await effects(learner.id);
      console.log(`  OBSERVED blank fill-in: check.correct=${feedback.json.data?.correct}, submit.score=${submitted.json.data?.results?.score}, pointsEarned=${submitted.json.data?.results?.pointsEarned}, points rows=${state.points}`);
      assert.equal(feedback.status,200); assert.equal(feedback.json.data.correct,false);
      assert.equal(submitted.status,200);
      assert.equal(submitted.json.data.results.score,0,"a whitespace-only answer is not correct");
      assert.equal(submitted.json.data.results.pointsEarned,0); assert.equal(state.points,0);
    });
    await test("concurrent submissions of one attempt award points and notify exactly once", async () => {
      const learner = await user("learner");
      const item = await quiz(teacher.id);
      await enroll(learner.id,item);
      const attemptId = await start(learner.token,item.id);
      // A real database lock is a deterministic scheduling barrier, not an application
      // mock: both handlers must wait until the old incomplete row has been observed.
      const locker = new Client({connectionString:url.toString()});
      await locker.connect(); await locker.query("BEGIN");
      await locker.query("SELECT id FROM quiz_attempts WHERE id=$1 FOR UPDATE",[attemptId]);
      const submissions = [0,1].map(()=>call(attempt.PUT,learner.token,item.id,"PUT",{attemptId,answers:{[item.questionId]:"review-secret-answer"}}));
      let waiting = 0;
      try {
        const deadline = Date.now()+8000;
        while (Date.now()<deadline) {
          waiting = Number((await one("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query ILIKE '%quiz_attempts%'",[dbName])).n);
          if (waiting >= 2) break;
          await delay(15);
        }
      } finally { await locker.query("COMMIT"); await locker.end(); }
      const results = await Promise.all(submissions);
      const state = await effects(learner.id);
      console.log(`  OBSERVED concurrent submit: lock waiters=${waiting}, statuses=${results.map(r=>r.status)}, alreadySubmitted=${results.map(r=>r.json.data?.alreadySubmitted)}, points rows=${state.points}, notifications=${state.notices}`);
      assert.equal(waiting,2,"both requests reached the real DB barrier");
      // A repeat submission of an already-completed attempt is an idempotent replay: both
      // requests answer 200 with the persisted grade (see README, "Repeating a submission").
      assert.deepEqual(results.map(r=>r.status),[200,200],"a completed attempt answers 200 to every submission");
      // The security property is which request COMPLETED the attempt, not its status code:
      // exactly one winner, exactly one replay.
      assert.deepEqual(
        results.map(r=>r.json.data?.alreadySubmitted).sort(),
        [false,true],
        "exactly one request completed the attempt and exactly one is a replay"
      );
      assert.equal(state.points,1); assert.equal(state.notices,1); assert.equal(state.completed,1);
    });
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { const {pool} = await import("@/db"); await pool.end(); } catch { /* primary setup failure is reported above */ }
    const cleanup = await scratch.dispose();
    await admin.end();
    assertCleanupSucceeded(cleanup,primaryError);
  }
  /* A run that executed nothing must never look like a pass. `PR45_REVIEW_FILTER` exists so
     an inherited finding can be isolated, and a filter that matches no test at all used to
     print "0 passed, 0 failed" and exit 0 — the same false green that finding R5 was about,
     one level up. `passed + failed` counts tests that actually ran, so a filter that selects
     at least one test still works, and a legitimate empty selection now fails loudly. */
  assert.ok(passed + failed > 0, "no PR #45 reviewer tests executed — check PR45_REVIEW_FILTER and the database setup");
  console.log(`PR45 additional DB review: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode=1;
}
main().catch(error=>{console.error(error); process.exitCode=1;});
