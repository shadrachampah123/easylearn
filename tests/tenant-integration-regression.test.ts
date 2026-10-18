/**
 * PR #30 ⨯ PR #31 integration regression suite.
 *
 * These are the invariants that only exist in the COMBINED implementation, i.e. the ones
 * that neither PR could prove on its own and that a future refactor of either half could
 * silently break:
 *
 *   1. A pre-v3 (legacy) multi-school token must never silently adopt a school.
 *      PR #30 introduced the v3 "explicit selection" token; PR #31 accepted any
 *      `schoolIdHint`. The merged code keeps PR #30's stricter gate, so an old token that
 *      still carries a school hint resolves to "no school" instead of a tenant.
 *   2. A v3 token issued by the validated school-selection route resolves exactly the
 *      selected school, and stops resolving it the moment the membership is revoked.
 *   3. The school LIFECYCLE and the ASSIGNMENT role rules compose: a teacher whose own
 *      school is suspended cannot read that school's assignments any more.
 *   4. The direct `assignments.school_id` is authoritative, so a teacher who holds TWO
 *      active memberships keeps access to the assignment they own in the selected school
 *      (the purely relational ownership set would deny it).
 *   5. The role rules are layered ON TOP of the school scope: a teacher cannot read
 *      another teacher's assignment, and no one can read a cross-school assignment.
 *
 * Database providers (same approach as tests/tenant-db.test.js):
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

const DB_NAME = `easylearn_integration_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = "integration-regression-test-secret-0123456789";
const UPLOAD_DIR = path.join(os.tmpdir(), `${DB_NAME}-uploads`);

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

  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run the suite.");
      return;
    }
    const port = 59529 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`),
      user: "easylearn",
      password: "easylearn",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    adminUrl = `postgres://easylearn:easylearn@localhost:${port}/postgres`;
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
       import — the pool is created at import time. */
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.EASY_LEARN_TEST_DATABASE = "true";
    process.env.UPLOAD_DIR = UPLOAD_DIR;
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const q = async (sql: string, values: unknown[] = []): Promise<any[]> =>
      (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

    const migrationRun = spawnSync(process.execPath, ["run-migration.js"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: scratchUrl, JWT_SECRET },
      encoding: "utf8",
    });
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    /* ── Fixture ── */

    const passwordHash: string = await bcrypt.hash("Integration-Test-Password!", 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Integration A', 'IA', 'integration-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Integration B', 'IB', 'integration-b') RETURNING id`
    )).id as string;

    type User = { id: string; membershipId: string };

    const createUser = async (
      label: string,
      role: string,
      memberships: { schoolId: string; role: string }[]
    ): Promise<{ id: string; memberships: Record<string, string> }> => {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
        [
          `${label}-${DB_NAME.slice(-8)}@example.test`,
          `${label}-${DB_NAME.slice(-8)}`,
          passwordHash,
          role,
          label,
          "Test",
        ]
      );
      const membershipIds: Record<string, string> = {};
      for (const membership of memberships) {
        const inserted = await one(
          `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active') RETURNING id`,
          [membership.schoolId, row.id, membership.role]
        );
        membershipIds[membership.schoolId] = inserted.id as string;
      }
      return { id: row.id as string, memberships: membershipIds };
    };

    const teacher = await createUser("dual-teacher", "teacher", [
      { schoolId: schoolA, role: "teacher" },
      { schoolId: schoolB, role: "teacher" },
    ]);
    const otherTeacher = await createUser("other-teacher", "teacher", [
      { schoolId: schoolA, role: "teacher" },
    ]);
    const learner = await createUser("learner", "learner", [
      { schoolId: schoolA, role: "learner" },
    ]);

    const yearA = (await one(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current)
       VALUES ($1,'2026/27','2026-01-01','2026-12-31',true) RETURNING id`,
      [schoolA]
    )).id as string;
    const subjectA = (await one(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1,'Integration Subject','INT-SUB') RETURNING id`,
      [schoolA]
    )).id as string;
    const classA = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id)
       VALUES ($1,'Integration Class','junior_high',$2,$3) RETURNING id`,
      [schoolA, teacher.id, yearA]
    )).id as string;
    await q(
      `INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`,
      [schoolA, learner.id, classA, yearA]
    );

    const teacherAssignment = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status)
       VALUES ($1,'Integration Teacher Assignment',$2,$3,$4,'published') RETURNING id`,
      [schoolA, classA, subjectA, teacher.id]
    )).id as string;
    const otherTeacherAssignment = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status)
       VALUES ($1,'Integration Other Teacher Assignment',$2,$3,$4,'published') RETURNING id`,
      [schoolA, classA, subjectA, otherTeacher.id]
    )).id as string;

    const { auth, tenant } = {
      auth: await import("@/lib/auth"),
      tenant: await import("@/lib/tenant"),
    };

    const route = async (pathName: string) => import(`@/app/api/${pathName}/route`);

    type CallOptions = {
      token?: string | null;
      method?: string;
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
    };

    const call = async (pathName: string, options: CallOptions = {}) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const headers: Record<string, string> = {};
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";

      const method = (options.method ?? (options.body !== undefined ? "POST" : "GET")).toUpperCase();
      const request = new NextRequest(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });

      const mod: any = await route(pathName);
      const handler = mod[method];
      if (!handler) throw new Error(`${pathName} has no ${method} handler`);
      const response = options.params
        ? await handler(request, { params: Promise.resolve(options.params) })
        : await handler(request);

      let json: any = null;
      try {
        json = await response.clone().json();
      } catch {
        json = null;
      }
      return { status: response.status, json, bodyText: JSON.stringify(json ?? {}) };
    };

    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const requestWith = (token: string) =>
      new NextRequest("http://localhost:3000/api/notifications", { headers: bearer(token) });

    /* ── 1. A legacy (pre-v3) multi-school token never adopts a school ── */

    await test("A legacy (pre-v3) multi-school token never silently adopts a school", async () => {
      // A token minted before the v3 selection schema existed still carries a school hint
      // (the old login picked the first membership). The merged code must not treat that
      // hint as an explicit selection.
      const legacyToken = await new Promise<string>((resolve, reject) => {
        import("jose")
          .then(async ({ SignJWT }) => {
            resolve(
              await new SignJWT({
                userId: teacher.id,
                role: "teacher",
                ver: 2,
                schoolId: schoolA,
                membershipId: teacher.memberships[schoolA],
              })
                .setProtectedHeader({ alg: "HS256", typ: "JWT" })
                .setIssuedAt()
                .setExpirationTime("24h")
                .sign(new TextEncoder().encode(JWT_SECRET))
            );
          })
          .catch(reject);
      });

      const context = await tenant.resolveAuthContext(requestWith(legacyToken) as never);
      assertEq(context.school, null, "a legacy multi-school token resolves to no school");
      assertEq(context.memberships.length, 2, "both active memberships are still loaded");

      const guarded = await tenant.guardSchoolContext(requestWith(legacyToken) as never);
      assertEq(guarded.ok, false, "an unselected legacy session cannot reach school data");
      if (!guarded.ok) {
        assertEq(guarded.response.status, 403, "the refusal is a 403");
        const denied: any = await guarded.response.json();
        assert(
          /select one of your schools/i.test(denied.error),
          `the refusal asks for an explicit selection (got "${denied.error}")`
        );
      }
    });

    /* ── 2. A v3 selected token resolves exactly the selected school ── */

    await test("A v3 selected token resolves exactly the selected school", async () => {
      const selectedToken = await auth.createToken({
        userId: teacher.id,
        role: "teacher",
        email: "dual-teacher@example.test",
        schoolId: schoolB,
        membershipId: teacher.memberships[schoolB],
      });
      const claims = await auth.verifyToken(selectedToken);
      assertEq(claims!.ver, 3, "the selection schema version is 3");
      assertEq(claims!.schoolIdHint, schoolB, "the school hint is the selected school");

      const context = await tenant.resolveAuthContext(requestWith(selectedToken) as never);
      assertEq(context.school?.schoolId, schoolB, "the selected school is resolved from the database");
      assertEq(context.school?.role, "teacher", "the role comes from the membership row");
    });

    await test("A v3 selected token loses its school the moment the membership is revoked", async () => {
      const selectedToken = await auth.createToken({
        userId: teacher.id,
        role: "teacher",
        email: "dual-teacher@example.test",
        schoolId: schoolB,
        membershipId: teacher.memberships[schoolB],
      });
      await q(`UPDATE school_users SET status = 'disabled' WHERE id = $1`, [teacher.memberships[schoolB]]);
      try {
        const context = await tenant.resolveAuthContext(requestWith(selectedToken) as never);
        assertEq(context.school, null, "a revoked membership resolves to no school");
      } finally {
        await q(`UPDATE school_users SET status = 'active' WHERE id = $1`, [teacher.memberships[schoolB]]);
      }
    });

    /* ── 3. School lifecycle and assignment authorization compose ── */

    await test("A suspended school revokes assignment access for its own teacher", async () => {
      const selectedToken = await auth.createToken({
        userId: teacher.id,
        role: "teacher",
        email: "dual-teacher@example.test",
        schoolId: schoolA,
        membershipId: teacher.memberships[schoolA],
      });

      const before = await call("assignments/[id]", {
        token: selectedToken,
        params: { id: teacherAssignment },
      });
      assertEq(before.status, 200, "the teacher reads their own assignment while the school is active");

      await q(`UPDATE schools SET status = 'suspended' WHERE id = $1`, [schoolA]);
      try {
        const after = await call("assignments/[id]", {
          token: selectedToken,
          params: { id: teacherAssignment },
        });
        // The lifecycle check runs in the AUTH layer: a suspended school no longer grants
        // a school context at all, so the request is refused before the assignment is
        // even looked up (403, not 404). Either way the refusal is complete.
        assertEq(after.status, 403, "a suspended school grants no assignment access");
        assert(
          !after.bodyText.includes("Integration Teacher Assignment"),
          "no assignment content leaks from a suspended school"
        );
      } finally {
        await q(`UPDATE schools SET status = 'active' WHERE id = $1`, [schoolA]);
      }
    });

    /* ── 4. The direct school_id is authoritative for a dual-membership teacher ── */

    await test("A dual-membership teacher keeps access to the assignment they own", async () => {
      const selectedToken = await auth.createToken({
        userId: teacher.id,
        role: "teacher",
        email: "dual-teacher@example.test",
        schoolId: schoolA,
        membershipId: teacher.memberships[schoolA],
      });
      const response = await call("assignments/[id]", {
        token: selectedToken,
        params: { id: teacherAssignment },
      });
      assertEq(response.status, 200, "the teacher reads their own assignment in the selected school");
      assert(
        response.bodyText.includes("Integration Teacher Assignment"),
        "the teacher's own assignment is returned"
      );
    });

    /* ── 5. The role rules are layered on top of the school scope ── */

    await test("A teacher cannot read another teacher's assignment in the same school", async () => {
      const selectedToken = await auth.createToken({
        userId: teacher.id,
        role: "teacher",
        email: "dual-teacher@example.test",
        schoolId: schoolA,
        membershipId: teacher.memberships[schoolA],
      });
      const response = await call("assignments/[id]", {
        token: selectedToken,
        params: { id: otherTeacherAssignment },
      });
      assertEq(response.status, 404, "a teacher cannot read a colleague's assignment");
      assert(
        !response.bodyText.includes("Integration Other Teacher Assignment"),
        "no colleague assignment content leaks"
      );
    });

    await test("A learner cannot read a draft assignment and never receives the answer key", async () => {
      const draftId = (await one(
        `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status)
         VALUES ($1,'Integration Draft Assignment',$2,$3,$4,'draft') RETURNING id`,
        [schoolA, classA, subjectA, teacher.id]
      )).id as string;
      await q(
        `INSERT INTO assignment_questions (assignment_id, question_type, question_text, correct_answer, explanation)
         VALUES ($1,'short_answer','Integration Question','SECRET-ANSWER','SECRET-EXPLANATION')`,
        [draftId]
      );
      await q(
        `INSERT INTO assignment_questions (assignment_id, question_type, question_text, correct_answer, explanation)
         VALUES ($1,'short_answer','Integration Published Question','SECRET-ANSWER','SECRET-EXPLANATION')`,
        [teacherAssignment]
      );

      const learnerToken = await auth.createToken({
        userId: learner.id,
        role: "learner",
        email: "learner@example.test",
        schoolId: schoolA,
        membershipId: learner.memberships[schoolA],
      });

      const draft = await call("assignments/[id]", {
        token: learnerToken,
        params: { id: draftId },
      });
      assertEq(draft.status, 404, "a learner cannot read a draft assignment");

      const published = await call("assignments/[id]", {
        token: learnerToken,
        params: { id: teacherAssignment },
      });
      assertEq(published.status, 200, "a learner can read a published, enrolled assignment");
      assert(!published.bodyText.includes("SECRET-ANSWER"), "the answer key never reaches a learner");
      assert(!published.bodyText.includes("SECRET-EXPLANATION"), "the explanation never reaches a learner");
    });
  } finally {
    await db.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} integration regression tests passed`);
}

main().catch((error: unknown) => {
  console.error("Integration regression suite failed to run:", error);
  process.exitCode = 1;
});
