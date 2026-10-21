/**
 * PR #45 security remediation regression suite (live PostgreSQL + real route handlers).
 *
 * Covers the confirmed review findings against real database state without mocks:
 *   1. Multi-school & transferred-teacher quiz tenancy for drafts, published quizzes, and answer keys.
 *   2. Current staff-role and school authorization on every quiz mutation (create, edit, publish, delete).
 *   3. Atomic, idempotent attempt submission and consistent non-empty answer normalization.
 *   6. Resuming incomplete attempts under default maxAttempts=1 without duplicate attempts or rewards.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { createScratchDatabase, assertCleanupSucceeded } = requireFromRepo(
  "./tests/helpers/scratch-db.js"
);
const { runMigrations } = requireFromRepo("./tests/helpers/migrations.js");

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  if (process.env.QUIZ_REMEDIATION_FILTER && !new RegExp(process.env.QUIZ_REMEDIATION_FILTER).test(name)) {
    return;
  }
  try {
    await fn();
    passed++;
    console.log(`✅ PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${(error as Error).message}`);
  }
}

async function main() {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(
    adminUrl && process.env.EASY_LEARN_TEST_DATABASE === "true",
    "TEST_DATABASE_URL and EASY_LEARN_TEST_DATABASE=true are required"
  );
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname),
    "Refusing non-local database host"
  );

  const dbName = `easylearn_quiz_remediation_${crypto.randomBytes(5).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const scratch = await createScratchDatabase({
    admin,
    adminUrl,
    dbName,
    label: "quiz-remediation-db",
  });

  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${dbName}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  process.env.JWT_SECRET = createTestJwtSecret();

  let primaryError: unknown = null;
  try {
    const migration = runMigrations({ databaseUrl: scratchUrl.toString() });
    assert.equal(migration.status, 0, `migration failed:\n${migration.stderr}`);

    const auth = await import("@/lib/auth");
    const tenant = await import("@/lib/tenant");
    const listRoute = await import("@/app/api/quizzes/route");
    const detailRoute = await import("@/app/api/quizzes/[id]/route");
    const attemptRoute = await import("@/app/api/quizzes/[id]/attempt/route");
    const checkRoute = await import("@/app/api/quizzes/[id]/check/route");

    const q = async (text: string, values: unknown[] = []) => (await scratch.db.query(text, values)).rows;
    const one = async (text: string, values: unknown[] = []) => (await q(text, values))[0];

    let seq = 0;
    async function createSchool(tag: string) {
      const n = ++seq;
      const row = await one(
        "INSERT INTO schools (name, short_name, slug) VALUES ($1, $2, $3) RETURNING id",
        [`Remediation ${tag} ${n}`, `R${tag}${n}`, `remediation-${tag.toLowerCase()}-${n}`]
      );
      const subject = await one(
        "INSERT INTO subjects (school_id, name, code) VALUES ($1, $2, $3) RETURNING id",
        [row.id, `Subject ${tag}`, `S${tag}${n}`]
      );
      return { id: row.id as string, subjectId: subject.id as string };
    }

    const schoolA = await createSchool("A");
    const schoolB = await createSchool("B");

    async function tokenFor(userId: string, schoolId: string) {
      const membership = await one(
        "SELECT id, role FROM school_users WHERE school_id = $1 AND user_id = $2 AND status = 'active'",
        [schoolId, userId]
      );
      assert.ok(membership, `expected active membership for ${userId} in ${schoolId}`);
      return auth.createToken({
        userId,
        role: membership.role,
        schoolId,
        membershipId: membership.id,
      });
    }

    async function createUser(role: string, schoolId = schoolA.id) {
      const n = ++seq;
      const row = await one(
        "INSERT INTO users (email, password_hash, role, first_name, last_name, is_active) VALUES ($1, 'not-a-login-password', $2, 'Quiz', $3, true) RETURNING id",
        [`quiz-rem-${n}@example.test`, role, String(n)]
      );
      await q(
        "INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, $3, 'active')",
        [schoolId, row.id, role]
      );
      return { id: row.id as string, token: await tokenFor(row.id, schoolId) };
    }

    async function createQuiz(
      teacherId: string,
      opts: {
        school?: { id: string; subjectId: string };
        published?: boolean;
        showResults?: boolean;
        maxAttempts?: number;
        answerKey?: string;
        questionType?: string;
      } = {}
    ) {
      const targetSchool = opts.school ?? schoolA;
      const n = ++seq;
      const cls = await one(
        "INSERT INTO classes (school_id, name, level, class_teacher_id) VALUES ($1, $2, 'primary', $3) RETURNING id",
        [targetSchool.id, `Class ${n}`, teacherId]
      );
      const answerKey = opts.answerKey ?? `secret-key-${n}`;
      const quizRow = await one(
        `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published, show_results, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          targetSchool.id,
          `Quiz ${n}`,
          cls.id,
          targetSchool.subjectId,
          teacherId,
          opts.published ?? true,
          opts.showResults ?? false,
          opts.maxAttempts ?? 3,
        ]
      );
      const question = await one(
        `INSERT INTO quiz_questions (quiz_id, question_type, question_text, correct_answer, points, order_index)
         VALUES ($1, $2, 'Question text', $3, 1, 0) RETURNING id`,
        [quizRow.id, opts.questionType ?? "mcq", answerKey]
      );
      return {
        id: quizRow.id as string,
        classId: cls.id as string,
        questionId: question.id as string,
        schoolId: targetSchool.id,
        answerKey,
      };
    }

    async function enroll(learnerId: string, target: { schoolId: string; classId: string }) {
      await q(
        "INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1, $2, $3)",
        [target.schoolId, learnerId, target.classId]
      );
    }

    type IdHandler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    async function callId(handler: IdHandler, token: string, id: string, method = "GET", body?: unknown) {
      const req = new NextRequest(`http://quiz.example.test/api/quizzes/${id}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const res = await handler(req, { params: Promise.resolve({ id }) });
      return { status: res.status, json: (await res.json()) as any };
    }

    async function callRoot(handler: (req: NextRequest) => Promise<Response>, token: string, method = "GET", body?: unknown) {
      const req = new NextRequest("http://quiz.example.test/api/quizzes", {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const res = await handler(req);
      return { status: res.status, json: (await res.json()) as any };
    }

    await test("R1: multi-school teacher can read/manage own drafts and keys in selected school only", async () => {
      const dualTeacher = await createUser("teacher", schoolA.id);
      await q(
        "INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'teacher', 'active')",
        [schoolB.id, dualTeacher.id]
      );
      const tokenA = dualTeacher.token;
      const tokenB = await tokenFor(dualTeacher.id, schoolB.id);

      const draftA = await createQuiz(dualTeacher.id, { school: schoolA, published: false, answerKey: "key-draft-school-a" });
      const pubA = await createQuiz(dualTeacher.id, { school: schoolA, published: true, answerKey: "key-pub-school-a" });
      const draftB = await createQuiz(dualTeacher.id, { school: schoolB, published: false, answerKey: "key-draft-school-b" });

      const listedA = await callRoot(listRoute.GET, tokenA);
      assert.equal(listedA.status, 200);
      assert.ok(listedA.json.data.some((r: any) => r.id === draftA.id), "selected school A lists own draft");
      assert.ok(listedA.json.data.some((r: any) => r.id === pubA.id), "selected school A lists own published quiz");
      assert.ok(!listedA.json.data.some((r: any) => r.id === draftB.id), "selected school A excludes school B draft");

      const detailDraftA = await callId(detailRoute.GET, tokenA, draftA.id);
      assert.equal(detailDraftA.status, 200, "dual-school teacher opens own draft in selected school A");
      assert.equal(detailDraftA.json.data.questions[0].correctAnswer, "key-draft-school-a");

      const crossDetailBFromA = await callId(detailRoute.GET, tokenA, draftB.id);
      assert.equal(crossDetailBFromA.status, 404, "own draft in school B is hidden while school A is selected");
      assert.ok(!JSON.stringify(crossDetailBFromA.json).includes("key-draft-school-b"));

      const crossEditBFromA = await callId(detailRoute.PUT, tokenA, draftB.id, "PUT", { title: "Cross-tenant edit" });
      assert.equal(crossEditBFromA.status, 404);
      const crossDeleteBFromA = await callId(detailRoute.DELETE, tokenA, draftB.id, "DELETE");
      assert.equal(crossDeleteBFromA.status, 404);

      const detailDraftB = await callId(detailRoute.GET, tokenB, draftB.id);
      assert.equal(detailDraftB.status, 200, "switching to school B grants access to school B draft");
      assert.equal(detailDraftB.json.data.questions[0].correctAnswer, "key-draft-school-b");

      const crossDetailAFromB = await callId(detailRoute.GET, tokenB, draftA.id);
      assert.equal(crossDetailAFromB.status, 404);
      assert.ok(!JSON.stringify(crossDetailAFromB.json).includes("key-draft-school-a"));
    });

    await test("R1: multi-school enrolled learner retains selected-school access without cross-school leakage", async () => {
      const owner = await createUser("teacher", schoolA.id);
      const dualLearner = await createUser("learner", schoolA.id);
      const pubA = await createQuiz(owner.id, { school: schoolA, published: true, showResults: false, answerKey: "learner-hidden-key-a" });
      await enroll(dualLearner.id, pubA);

      await q(
        "INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'learner', 'active')",
        [schoolB.id, dualLearner.id]
      );
      const tokenA = dualLearner.token;
      const tokenB = await tokenFor(dualLearner.id, schoolB.id);

      const readA = await callId(detailRoute.GET, tokenA, pubA.id);
      assert.equal(readA.status, 200, "second school membership must not break valid selected-school enrollment");
      assert.equal(readA.json.data.questions[0].correctAnswer, null);

      const started = await callId(attemptRoute.POST, tokenA, pubA.id, "POST");
      assert.equal(started.status, 201);
      const attemptId = started.json.data.attempt.id as string;

      for (const [handler, method] of [
        [detailRoute.GET, "GET"],
        [attemptRoute.POST, "POST"],
        [attemptRoute.PUT, "PUT"],
        [checkRoute.POST, "POST"],
      ] as const) {
        const res = await callId(
          handler,
          tokenB,
          pubA.id,
          method,
          method === "GET"
            ? undefined
            : {
                attemptId,
                questionId: pubA.questionId,
                answer: pubA.answerKey,
                answers: { [pubA.questionId]: pubA.answerKey },
              }
        );
        assert.equal(res.status, 404, `selected school B must receive 404 on ${method}`);
        assert.ok(!JSON.stringify(res.json).includes(pubA.answerKey));
      }

      const checked = await callId(checkRoute.POST, tokenA, pubA.id, "POST", {
        attemptId,
        questionId: pubA.questionId,
        answer: pubA.answerKey,
      });
      assert.equal(checked.status, 200);
      assert.equal(checked.json.data.correct, true);
      assert.equal(checked.json.data.correctAnswer, null);
    });

    await test("R1: transferring a teacher membership never moves old-school drafts or answer keys into the new school", async () => {
      const movingTeacher = await createUser("teacher", schoolA.id);
      const draftA = await createQuiz(movingTeacher.id, {
        school: schoolA,
        published: false,
        answerKey: "transferred-school-a-secret",
      });
      const adminA = await createUser("school_admin", schoolA.id);
      const adminB = await createUser("school_admin", schoolB.id);

      await q("UPDATE school_users SET status = 'disabled' WHERE user_id = $1 AND school_id = $2", [
        movingTeacher.id,
        schoolA.id,
      ]);
      await q("INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, 'teacher', 'active')", [
        schoolB.id,
        movingTeacher.id,
      ]);
      const movedTeacherTokenB = await tokenFor(movingTeacher.id, schoolB.id);

      for (const actorToken of [adminB.token, movedTeacherTokenB]) {
        const listedB = await callRoot(listRoute.GET, actorToken);
        assert.equal(listedB.status, 200);
        assert.ok(!listedB.json.data.some((r: any) => r.id === draftA.id));

        const detailB = await callId(detailRoute.GET, actorToken, draftA.id);
        assert.equal(detailB.status, 404, "school B actor must not read a draft stored in school A");
        assert.ok(!JSON.stringify(detailB.json).includes("transferred-school-a-secret"));

        assert.equal((await callId(detailRoute.PUT, actorToken, draftA.id, "PUT", { isPublished: true })).status, 404);
        assert.equal((await callId(detailRoute.DELETE, actorToken, draftA.id, "DELETE")).status, 404);
      }

      const detailAdminA = await callId(detailRoute.GET, adminA.token, draftA.id);
      assert.equal(detailAdminA.status, 200, "school A admin retains access to school A draft");
      assert.equal(detailAdminA.json.data.questions[0].correctAnswer, "transferred-school-a-secret");

      // Legacy NULL school_id fallback must also fail closed when parent class/subject belong to school A.
      await q("ALTER TABLE quizzes ALTER COLUMN school_id DROP NOT NULL");
      try {
        await q("UPDATE quizzes SET school_id = NULL WHERE id = $1", [draftA.id]);
        const legacyDetailB = await callId(detailRoute.GET, adminB.token, draftA.id);
        assert.equal(legacyDetailB.status, 404);
        assert.ok(!JSON.stringify(legacyDetailB.json).includes("transferred-school-a-secret"));
        assert.equal(await tenant.isQuizInSchool(schoolB.id, draftA.id), false);
      } finally {
        await q("UPDATE quizzes SET school_id = $1 WHERE id = $2", [schoolA.id, draftA.id]);
        await q("ALTER TABLE quizzes ALTER COLUMN school_id SET NOT NULL");
      }
    });

    await test("R2: demoted quiz owner (parent or learner) cannot edit, publish, replace questions, or delete", async () => {
      for (const demotedRole of ["parent", "learner"] as const) {
        const formerStaff = await createUser("teacher", schoolA.id);
        const draft = await createQuiz(formerStaff.id, {
          school: schoolA,
          published: false,
          answerKey: `demoted-${demotedRole}-key`,
        });

        // Token still carries stale role="teacher", while live school_users role is changed.
        await q("UPDATE school_users SET role = $1 WHERE user_id = $2 AND school_id = $3", [
          demotedRole,
          formerStaff.id,
          schoolA.id,
        ]);

        const read = await callId(detailRoute.GET, formerStaff.token, draft.id);
        assert.equal(read.status, 403, `demoted ${demotedRole} cannot read unpublished draft`);

        const publishAttempt = await callId(detailRoute.PUT, formerStaff.token, draft.id, "PUT", {
          isPublished: true,
          title: "Tampered by demoted owner",
          questions: [{ questionType: "mcq", questionText: "Tampered?", correctAnswer: "leaked", points: 1 }],
        });
        assert.equal(publishAttempt.status, 403, `demoted ${demotedRole} owner must be refused on PUT/publish`);

        const afterPut = await one("SELECT title, is_published FROM quizzes WHERE id = $1", [draft.id]);
        assert.equal(afterPut.is_published, false, "draft must remain unpublished");
        assert.notEqual(afterPut.title, "Tampered by demoted owner");

        const deleteAttempt = await callId(detailRoute.DELETE, formerStaff.token, draft.id, "DELETE");
        assert.equal(deleteAttempt.status, 403, `demoted ${demotedRole} owner must be refused on DELETE`);
        assert.ok(await one("SELECT id FROM quizzes WHERE id = $1", [draft.id]), "quiz row must survive refused DELETE");

        const createAttempt = await callRoot(listRoute.POST, formerStaff.token, "POST", {
          title: "Unauthorized quiz",
          classId: draft.classId,
          subjectId: schoolA.subjectId,
          isPublished: false,
        });
        assert.equal(createAttempt.status, 403, `demoted ${demotedRole} cannot create quizzes`);
      }
    });

    await test("R2: quiz mutations enforce staff ownership/admin permissions and selected-school references", async () => {
      const ownerTeacher = await createUser("teacher", schoolA.id);
      const otherTeacher = await createUser("teacher", schoolA.id);
      const nonOwnerHead = await createUser("head_teacher", schoolA.id);
      const schoolAdminA = await createUser("school_admin", schoolA.id);
      const quizA = await createQuiz(ownerTeacher.id, { school: schoolA, published: false });

      for (const nonAuthorizedStaff of [otherTeacher, nonOwnerHead]) {
        assert.equal(
          (await callId(detailRoute.PUT, nonAuthorizedStaff.token, quizA.id, "PUT", { isPublished: true })).status,
          403
        );
        assert.equal((await callId(detailRoute.DELETE, nonAuthorizedStaff.token, quizA.id, "DELETE")).status, 403);
      }

      // Cross-school subjectId on POST and PUT must fail closed with 404 rather than mutating or throwing 503.
      const badCreate = await callRoot(listRoute.POST, ownerTeacher.token, "POST", {
        title: "Cross-school subject quiz",
        classId: quizA.classId,
        subjectId: schoolB.subjectId,
        isPublished: false,
      });
      assert.equal(badCreate.status, 404, "POST must reject another school's subjectId with 404");

      const badPutSubject = await callId(detailRoute.PUT, ownerTeacher.token, quizA.id, "PUT", {
        subjectId: schoolB.subjectId,
      });
      assert.equal(badPutSubject.status, 404, "PUT must reject another school's subjectId with 404");

      // Active owner can publish, and school_admin in the same school can edit and delete.
      assert.equal((await callId(detailRoute.PUT, ownerTeacher.token, quizA.id, "PUT", { isPublished: true })).status, 200);
      assert.equal((await callId(detailRoute.PUT, schoolAdminA.token, quizA.id, "PUT", { description: "Approved" })).status, 200);
      assert.equal((await callId(detailRoute.DELETE, schoolAdminA.token, quizA.id, "DELETE")).status, 200);
    });

    await test("R3: concurrent and repeated submissions are atomic and idempotent with single reward/notification", async () => {
      const owner = await createUser("teacher", schoolA.id);
      const learner = await createUser("learner", schoolA.id);
      const quizItem = await createQuiz(owner.id, {
        school: schoolA,
        published: true,
        answerKey: "photosynthesis",
      });
      await enroll(learner.id, quizItem);

      const started = await callId(attemptRoute.POST, learner.token, quizItem.id, "POST");
      assert.equal(started.status, 201);
      const attemptId = started.json.data.attempt.id as string;

      // Real PostgreSQL row lock synchronizes two concurrent in-flight PUT handlers without mocks.
      const locker = new Client({ connectionString: scratchUrl.toString() });
      await locker.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM quiz_attempts WHERE id = $1 FOR UPDATE", [attemptId]);

      const inFlight = [0, 1].map(() =>
        callId(attemptRoute.PUT, learner.token, quizItem.id, "PUT", {
          attemptId,
          answers: { [quizItem.questionId]: "  PHOTOSYNTHESIS  " },
        })
      );

      let lockWaiters = 0;
      try {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const row = await one(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query ILIKE '%quiz_attempts%'",
            [dbName]
          );
          lockWaiters = row.n as number;
          if (lockWaiters >= 2) break;
          await delay(15);
        }
      } finally {
        await locker.query("COMMIT");
        await locker.end();
      }

      const [res1, res2] = await Promise.all(inFlight);
      assert.equal(lockWaiters, 2, "both concurrent submissions reached the PostgreSQL row-lock barrier");
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      assert.equal(res1.json.data.results.score, 1);
      assert.equal(res2.json.data.results.score, 1);
      assert.equal(res1.json.data.results.pointsEarned, 100);
      assert.equal(res2.json.data.results.pointsEarned, 100);

      // Subsequent sequential retry — even with tampered wrong answers — must remain idempotent and immutable.
      const retry = await callId(attemptRoute.PUT, learner.token, quizItem.id, "PUT", {
        attemptId,
        answers: { [quizItem.questionId]: "wrong-answer" },
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.json.data.results.score, 1, "completed attempt score must remain immutable on retry");

      const counts = await one(
        `SELECT
           (SELECT count(*)::int FROM learner_points WHERE learner_id = $1) AS points_rows,
           (SELECT COALESCE(sum(points), 0)::int FROM learner_points WHERE learner_id = $1) AS total_points,
           (SELECT count(*)::int FROM notifications WHERE user_id = $1) AS notice_rows,
           (SELECT count(*)::int FROM quiz_attempts WHERE learner_id = $1 AND completed_at IS NOT NULL) AS completed_rows`,
        [learner.id]
      );
      assert.equal(counts.points_rows, 1, "must award learner_points once");
      assert.equal(counts.total_points, 100, "must award 100 XP total, never 200 XP");
      assert.equal(counts.notice_rows, 1, "must create notification once");
      assert.equal(counts.completed_rows, 1);
    });

    await test("R4: check and submit enforce identical answer normalization and reject whitespace/empty answers", async () => {
      const owner = await createUser("teacher", schoolA.id);
      const learner = await createUser("learner", schoolA.id);
      const fillQuiz = await createQuiz(owner.id, {
        school: schoolA,
        published: true,
        showResults: false,
        maxAttempts: 5,
        questionType: "fill_blank",
        answerKey: "Mitochondria",
      });
      await enroll(learner.id, fillQuiz);

      for (const blankCandidate of ["   ", "\t\n ", "", []] as unknown[]) {
        const started = await callId(attemptRoute.POST, learner.token, fillQuiz.id, "POST");
        assert.equal(started.status, 201);
        const attemptId = started.json.data.attempt.id as string;

        const checked = await callId(checkRoute.POST, learner.token, fillQuiz.id, "POST", {
          attemptId,
          questionId: fillQuiz.questionId,
          answer: blankCandidate,
        });
        assert.equal(checked.status, 200);
        assert.equal(checked.json.data.correct, false, "check must reject blank/non-scalar answer");

        const submitted = await callId(attemptRoute.PUT, learner.token, fillQuiz.id, "PUT", {
          attemptId,
          answers: { [fillQuiz.questionId]: blankCandidate },
        });
        assert.equal(submitted.status, 200);
        assert.equal(submitted.json.data.results.score, 0, "submit must reject blank/non-scalar answer");
        assert.equal(submitted.json.data.results.pointsEarned, 0);
      }

      // Retrying a 0-score completed attempt with the real answer must NOT retroactively award points.
      const [existingZeroAttempt] = await q(
        "SELECT id FROM quiz_attempts WHERE learner_id = $1 AND quiz_id = $2 ORDER BY started_at LIMIT 1",
        [learner.id, fillQuiz.id]
      );
      const lateTamper = await callId(attemptRoute.PUT, learner.token, fillQuiz.id, "PUT", {
        attemptId: existingZeroAttempt.id,
        answers: { [fillQuiz.questionId]: "Mitochondria" },
      });
      assert.equal(lateTamper.status, 200);
      assert.equal(lateTamper.json.data.results.score, 0, "retry cannot upgrade a 0-score submission");

      const pointsAfterBlank = await one(
        "SELECT count(*)::int AS n FROM learner_points WHERE learner_id = $1",
        [learner.id]
      );
      assert.equal(pointsAfterBlank.n, 0, "blank answers and post-submit tampering must award 0 points");
    });

    await test("R6: default one-attempt quizzes resume incomplete attempts cleanly without duplicate attempts or rewards", async () => {
      const owner = await createUser("teacher", schoolA.id);
      const learner = await createUser("learner", schoolA.id);
      const oneShotQuiz = await createQuiz(owner.id, {
        school: schoolA,
        published: true,
        maxAttempts: 1,
        answerKey: "accra",
      });
      await enroll(learner.id, oneShotQuiz);

      // Simultaneous first starts (Synchronized via PostgreSQL advisory lock) must never create two rows.
      const barrier = new Client({ connectionString: scratchUrl.toString() });
      await barrier.connect();
      await barrier.query("BEGIN");
      await barrier.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        oneShotQuiz.id,
        learner.id,
      ]);

      const concurrentStarts = [0, 1].map(() =>
        callId(attemptRoute.POST, learner.token, oneShotQuiz.id, "POST")
      );
      await delay(80);
      await barrier.query("COMMIT");
      await barrier.end();

      const startOutcomes = await Promise.all(concurrentStarts);
      const statuses = startOutcomes.map((o) => o.status).sort();
      assert.deepEqual(statuses, [200, 201], "concurrent starts must create one attempt (201) and resume it (200)");
      assert.equal(
        startOutcomes[0].json.data.attempt.id,
        startOutcomes[1].json.data.attempt.id,
        "concurrent starts must return the same open attempt ID"
      );
      const attemptId = startOutcomes[0].json.data.attempt.id as string;

      // List and detail keep attemptsLeft = 1 / attemptsUsed = 0 while the single attempt is still incomplete.
      const listedOpen = await callRoot(listRoute.GET, learner.token);
      const listedQuizOpen = listedOpen.json.data.find((r: any) => r.id === oneShotQuiz.id);
      assert.equal(listedQuizOpen.attemptsUsed, 0);
      assert.equal(listedQuizOpen.attemptsLeft, 1);

      const detailOpen = await callId(detailRoute.GET, learner.token, oneShotQuiz.id);
      assert.equal(detailOpen.json.data.attemptsUsed, 0);

      // Explicit subsequent resume also returns 200 with the exact same open attempt ID.
      const resumed = await callId(attemptRoute.POST, learner.token, oneShotQuiz.id, "POST");
      assert.equal(resumed.status, 200);
      assert.equal(resumed.json.data.attempt.id, attemptId);

      // Complete the single attempt -> 100 points once.
      const submitted = await callId(attemptRoute.PUT, learner.token, oneShotQuiz.id, "PUT", {
        attemptId,
        answers: { [oneShotQuiz.questionId]: "Accra" },
      });
      assert.equal(submitted.status, 200);
      assert.equal(submitted.json.data.results.pointsEarned, 100);

      // After completion, list/detail report attemptsUsed = 1 / attemptsLeft = 0 and a new start is refused with 400.
      const listedDone = await callRoot(listRoute.GET, learner.token);
      const listedQuizDone = listedDone.json.data.find((r: any) => r.id === oneShotQuiz.id);
      assert.equal(listedQuizDone.attemptsUsed, 1);
      assert.equal(listedQuizDone.attemptsLeft, 0);

      const secondAttempt = await callId(attemptRoute.POST, learner.token, oneShotQuiz.id, "POST");
      assert.equal(secondAttempt.status, 400, "completed one-attempt quiz must refuse starting a second attempt");

      const totals = await one(
        `SELECT
           (SELECT count(*)::int FROM quiz_attempts WHERE quiz_id = $1 AND learner_id = $2) AS attempts,
           (SELECT count(*)::int FROM learner_points WHERE learner_id = $2) AS point_rows`,
        [oneShotQuiz.id, learner.id]
      );
      assert.equal(totals.attempts, 1, "must never create more than one attempt row");
      assert.equal(totals.point_rows, 1, "must never award duplicate points");
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const { pool } = await import("@/db");
      await pool.end();
    } catch {
      /* pool never opened */
    }
    const cleanup = await scratch.dispose();
    await admin.end();
    assertCleanupSucceeded(cleanup, primaryError);
  }

  assert.ok(passed + failed > 0, "no quiz remediation tests executed");
  console.log(`\n📊 Quiz remediation results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
