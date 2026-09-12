/**
 * Phase 2C — Cross-school tenant authorization: LIVE DATABASE, REAL ROUTE HANDLERS.
 *
 * This is the executable proof that School A cannot reach School B through the API. It is
 * NOT a static-analysis test: a throwaway PostgreSQL database is created, the project's real
 * migration chain (0000…0015) is applied, two real schools with real memberships and real
 * school-owned content are inserted, and the REAL App Router handlers are invoked with real
 * signed tokens.
 *
 * Fixture (identical shape to the brief's §9):
 *
 *   School A (slug `tenant-a`)            School B (slug `tenant-b`)
 *     Admin A   → school_admin              Admin B   → school_admin
 *     Teacher A → teacher                   Teacher B → teacher
 *     Learner A → learner                   Learner B → learner
 *     Parent A  → parent                    Parent B  → parent
 *     Learner A2 (unenrolled)               Learner B2 (not the uploader)
 *   Platform account (`super_admin`, NO membership)
 *   Disabled A (membership status = `disabled`)
 *   Orphan (no membership row at all)
 *
 * Covered: user / learner / grade / attendance / announcement / notification / file / admin
 * isolation, every §10 negative case (wrong ids, inactive membership, missing membership,
 * forged role, forged school id, foreign resource) and the §9 "legitimate access" cases that
 * prove Phase 1 behaviour still works inside a school.
 *
 * `tests/tenant-authorization-mutation.test.ts` then proves this suite is not vacuous: it
 * surgically removes each protection from `src/lib/tenant.ts` and requires the checks below
 * to fail.
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

const DB_NAME = `easylearn_2c_test_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = "phase-2c-integration-test-secret-0123456789";
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
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run `npm run test:tenant-auth`.");
      return;
    }
    const port = 54629 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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
       import — the pool is created at import time. */
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

    /* ── Migrations ── */

    const migrationRun = runMigrations();
    if (migrationRun.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migrationRun.status}:\n${((migrationRun.stdout || "") + (migrationRun.stderr || "")).slice(-4000)}`
      );
    }

    /* ── Fixture ── */

    const passwordHash: string = await bcrypt.hash("Phase2c-Test-Password!", 4);

    const schoolA = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Tenant School A', 'TSA', 'tenant-a') RETURNING id`
    )).id as string;
    const schoolB = (await one(
      `INSERT INTO schools (name, short_name, slug) VALUES ('Tenant School B', 'TSB', 'tenant-b') RETURNING id`
    )).id as string;

    type Fixture = {
      key: string;
      role: string;
      schoolId?: string;
      membershipStatus?: string;
      memberships?: { schoolId: string; role: string; status?: string }[];
      active?: boolean;
    };

    const fixtures: Fixture[] = [
      { key: "admin-a", role: "school_admin", memberships: [{ schoolId: schoolA, role: "school_admin" }] },
      { key: "teacher-a", role: "teacher", memberships: [{ schoolId: schoolA, role: "teacher" }] },
      { key: "learner-a", role: "learner", memberships: [{ schoolId: schoolA, role: "learner" }] },
      { key: "learner-a2", role: "learner", memberships: [{ schoolId: schoolA, role: "learner" }] },
      { key: "parent-a", role: "parent", memberships: [{ schoolId: schoolA, role: "parent" }] },
      { key: "admin-b", role: "school_admin", memberships: [{ schoolId: schoolB, role: "school_admin" }] },
      { key: "teacher-b", role: "teacher", memberships: [{ schoolId: schoolB, role: "teacher" }] },
      { key: "learner-b", role: "learner", memberships: [{ schoolId: schoolB, role: "learner" }] },
      { key: "learner-b2", role: "learner", memberships: [{ schoolId: schoolB, role: "learner" }] },
      { key: "parent-b", role: "parent", memberships: [{ schoolId: schoolB, role: "parent" }] },
      // Platform account: `super_admin` never gets a school membership (plan §7).
      { key: "platform", role: "super_admin", memberships: [] },
      // Membership exists but is disabled → no school context may be granted.
      { key: "disabled-a", role: "teacher", memberships: [{ schoolId: schoolA, role: "teacher", status: "disabled" }] },
      // No membership row at all.
      { key: "orphan", role: "teacher", memberships: [] },
    ];

    const ids: Record<string, string> = {};
    for (const fixture of fixtures) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, 'Phase2C', $5, true) RETURNING id`,
        [
          `${fixture.key}-${DB_NAME}@example.test`,
          `${fixture.key}-${DB_NAME.slice(-8)}`,
          passwordHash,
          fixture.role,
          fixture.key,
        ]
      );
      ids[fixture.key] = row.id;
      for (const membership of fixture.memberships ?? []) {
        await q(
          `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
          [membership.schoolId, row.id, membership.role, membership.status ?? "active"]
        );
      }
    }

    const academicYear = (await one(
      `INSERT INTO academic_years (name, start_date, end_date, is_current)
       VALUES ('2025/2026', '2025-09-01', '2026-07-01', true) RETURNING id`
    )).id as string;

    const subject = (await one(`INSERT INTO subjects (name, code) VALUES ('Maths', 'MTH') RETURNING id`)).id as string;

    const classA = (await one(
      `INSERT INTO classes (name, level, class_teacher_id, academic_year_id)
       VALUES ('Class A', 'primary', $1, $2) RETURNING id`,
      [ids["teacher-a"], academicYear]
    )).id as string;
    const classB = (await one(
      `INSERT INTO classes (name, level, class_teacher_id, academic_year_id)
       VALUES ('Class B', 'primary', $1, $2) RETURNING id`,
      [ids["teacher-b"], academicYear]
    )).id as string;

    await q(`INSERT INTO teacher_classes (teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
      ids["teacher-a"], classA, subject, academicYear,
    ]);
    await q(`INSERT INTO teacher_classes (teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
      ids["teacher-b"], classB, subject, academicYear,
    ]);

    await q(`INSERT INTO learner_classes (learner_id, class_id, academic_year_id) VALUES ($1,$2,$3)`, [
      ids["learner-a"], classA, academicYear,
    ]);
    await q(`INSERT INTO learner_classes (learner_id, class_id, academic_year_id) VALUES ($1,$2,$3)`, [
      ids["learner-b"], classB, academicYear,
    ]);

    await q(`INSERT INTO parent_learners (parent_id, learner_id, relationship) VALUES ($1,$2,'guardian')`, [
      ids["parent-a"], ids["learner-a"],
    ]);
    // A cross-school link, to prove the parent branch intersects with the school's members.
    await q(`INSERT INTO parent_learners (parent_id, learner_id, relationship) VALUES ($1,$2,'guardian')`, [
      ids["parent-a"], ids["learner-b"],
    ]);
    await q(`INSERT INTO parent_learners (parent_id, learner_id, relationship) VALUES ($1,$2,'guardian')`, [
      ids["parent-b"], ids["learner-b"],
    ]);

    const assignA = (await one(
      `INSERT INTO assignments (title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads)
       VALUES ('Assignment A', $1, $2, $3, 'published', 100, true) RETURNING id`,
      [classA, subject, ids["teacher-a"]]
    )).id as string;
    const assignB = (await one(
      `INSERT INTO assignments (title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads)
       VALUES ('Assignment B', $1, $2, $3, 'published', 100, true) RETURNING id`,
      [classB, subject, ids["teacher-b"]]
    )).id as string;

    const subA = (await one(
      `INSERT INTO submissions (assignment_id, learner_id, status, score, max_score, percentage, graded_at)
       VALUES ($1, $2, 'graded', 80, 100, 80, now()) RETURNING id`,
      [assignA, ids["learner-a"]]
    )).id as string;
    const subB = (await one(
      `INSERT INTO submissions (assignment_id, learner_id, status, score, max_score, percentage, graded_at)
       VALUES ($1, $2, 'graded', 90, 100, 90, now()) RETURNING id`,
      [assignB, ids["learner-b"]]
    )).id as string;

    await q(`INSERT INTO attendance (learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,CURRENT_DATE,true,$3)`, [
      ids["learner-a"], classA, ids["teacher-a"],
    ]);
    await q(`INSERT INTO attendance (learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,CURRENT_DATE,false,$3)`, [
      ids["learner-b"], classB, ids["teacher-b"],
    ]);

    const announcePrivateA = (await one(
      `INSERT INTO announcements (title, content, author_id, is_public, is_pinned) VALUES ('Private A', 'secret a', $1, false, false) RETURNING id`,
      [ids["teacher-a"]]
    )).id as string;
    const announcePrivateB = (await one(
      `INSERT INTO announcements (title, content, author_id, is_public, is_pinned) VALUES ('Private B', 'secret b', $1, false, false) RETURNING id`,
      [ids["teacher-b"]]
    )).id as string;
    const announcePublic = (await one(
      `INSERT INTO announcements (title, content, author_id, is_public, is_pinned) VALUES ('Public A', 'public a', $1, true, false) RETURNING id`,
      [ids["teacher-a"]]
    )).id as string;

    const notifA = (await one(
      `INSERT INTO notifications (user_id, type, title, message, is_read) VALUES ($1, 'system', 'N-A', 'for a', false) RETURNING id`,
      [ids["learner-a"]]
    )).id as string;
    const notifB = (await one(
      `INSERT INTO notifications (user_id, type, title, message, is_read) VALUES ($1, 'system', 'N-B', 'for b', false) RETURNING id`,
      [ids["learner-b"]]
    )).id as string;

    const fileA = (await one(
      `INSERT INTO uploaded_files (uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, 'assignment', $2, 'a.pdf', 'stored-a.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [ids["teacher-a"], assignA]
    )).id as string;
    const fileB = (await one(
      `INSERT INTO uploaded_files (uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, 'assignment', $2, 'b.pdf', 'stored-b.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [ids["teacher-b"], assignB]
    )).id as string;
    const submissionFileB = (await one(
      `INSERT INTO uploaded_files (uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, 'submission', $2, 'work-b.pdf', 'stored-work-b.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [ids["learner-b"], assignB]
    )).id as string;
    // The uploader is a platform account with no membership → ownership cannot be resolved.
    const orphanFile = (await one(
      `INSERT INTO uploaded_files (uploader_id, purpose, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, 'assignment', 'orphan.pdf', 'stored-orphan.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [ids["platform"]]
    )).id as string;

    // Real bytes for the files a legitimately-authorized caller should be able to download.
    for (const storedName of ["stored-a.pdf", "stored-b.pdf", "stored-work-b.pdf", "stored-orphan.pdf"]) {
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), "%PDF-1.4 phase 2c test file");
    }

    await q(`INSERT INTO activity_logs (user_id, action, entity_type, description) VALUES ($1, 'create', 'class', 'A event')`, [
      ids["teacher-a"],
    ]);
    await q(`INSERT INTO activity_logs (user_id, action, entity_type, description) VALUES ($1, 'create', 'class', 'B event')`, [
      ids["teacher-b"],
    ]);
    await q(`INSERT INTO activity_logs (user_id, action, entity_type, description) VALUES ($1, 'login', null, 'orphan event')`, [
      ids["orphan"],
    ]);

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
      query?: Record<string, string>;
      body?: unknown;
      params?: Record<string, string>;
      method?: string;
      extraHeaders?: Record<string, string>;
    };

    const call = async (pathName: string, options: CallOptions = {}) => {
      const url = new URL(`http://localhost:3000/api/${pathName}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
      }

      const headers: Record<string, string> = { ...(options.extraHeaders ?? {}) };
      if (options.token !== null && options.token !== undefined) {
        headers.authorization = `Bearer ${options.token}`;
      } else if (options.token !== null && options.token === undefined) {
        // default: the caller passed nothing, meaning "no token" tests must pass token: null
      }
      if (options.body !== undefined) headers["content-type"] = "application/json";

      const request = new NextRequest(url, {
        method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });

      const mod: any = await route(pathName);
      const handlerName = (options.method ?? (options.body !== undefined ? "POST" : "GET")).toUpperCase();
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
      return { status: response.status, json, response, headers: response.headers };
    };

    const bodyText = (result: { json: any }) => JSON.stringify(result.json ?? "");

    console.log("\n🎯 Phase 2C cross-school authorization (School A vs School B)\n");

    /* ════════════════════ 1. Tenant boundary: authentication & membership ════════════════════ */

    await test("Boundary: unauthenticated requests are rejected with 401", async () => {
      for (const pathName of ["users", "notifications", "attendance", "enrollments", "announcements"]) {
        const result = await call(pathName, { token: null });
        assertEq(result.status, 401, `${pathName} must be 401 without a token`);
      }
    });

    await test("Boundary: a garbage token is rejected with 401", async () => {
      const result = await call("users", { token: "not.a.real.token" });
      assertEq(result.status, 401, "garbage token");
    });

    await test("Boundary: a token for a deleted account is rejected with 401", async () => {
      const ghost = await auth.createToken({
        userId: crypto.randomUUID(),
        role: "school_admin",
      });
      const result = await call("users", { token: ghost });
      assertEq(result.status, 401, "unknown user id");
    });

    await test("Boundary: no membership → 403 (fail closed, never platform-wide access)", async () => {
      const result = await call("users", { token: tokens["orphan"] });
      assertEq(result.status, 403, "a user without membership must not receive a school context");
    });

    await test("Boundary: a DISABLED membership grants no context (403)", async () => {
      for (const pathName of ["users", "notifications", "attendance"]) {
        const result = await call(pathName, { token: tokens["disabled-a"] });
        assertEq(result.status, 403, `${pathName} for a disabled membership`);
      }
    });

    await test("Boundary: super_admin has no school context and no implicit school access (403)", async () => {
      for (const pathName of ["users", "notifications", "attendance", "enrollments", "announcements"]) {
        const result = await call(pathName, { token: tokens["platform"] });
        assertEq(result.status, 403, `${pathName} must not open for a platform account without membership`);
      }
    });

    await test("Boundary: a forged `role: super_admin` claim in the token changes nothing", async () => {
      // Same identity, same signature key, but the claim lies about the role. The membership
      // role from the database is the only role that authorizes.
      const forged = await auth.createToken({
        userId: ids["learner-a"],
        role: "super_admin",
        email: "learner-a@example.test",
      });
      const result = await call("users", { token: forged });
      assertEq(result.status, 403, "JWT role must not grant admin access");
    });

    await test("Boundary: a client-supplied schoolId/school_id is ignored", async () => {
      // Query parameter form.
      const withQuery = await call("users", {
        token: tokens["admin-a"],
        query: { schoolId: schoolB, school_id: schoolB },
      });
      assertEq(withQuery.status, 200, "query params must not break the request");
      assert(
        !bodyText(withQuery).includes(ids["admin-b"]),
        "schoolId query parameter must never widen the result to School B"
      );

      // Body form, on a write path.
      const withBody = await call("enrollments", {
        token: tokens["admin-a"],
        body: { learnerId: ids["learner-a2"], classId: classA, schoolId: schoolB, school_id: schoolB },
      });
      assertEq(withBody.status, 201, "the legitimate same-school enrollment must still work");
      await q(`DELETE FROM learner_classes WHERE learner_id = $1 AND class_id = $2`, [ids["learner-a2"], classA]);
    });

    /* ════════════════════ 2. User isolation ════════════════════ */

    await test("Users: School A's directory never lists School B's members", async () => {
      const result = await call("users", { token: tokens["admin-a"], query: { limit: "100" } });
      assertEq(result.status, 200, "list status");
      const text = bodyText(result);
      for (const key of ["admin-b", "teacher-b", "learner-b", "parent-b"]) {
        assert(!text.includes(ids[key]), `School B's ${key} must not appear in School A's directory`);
      }
      assert(text.includes(ids["teacher-a"]), "School A's own members must still be listed");
    });

    await test("Users: School A cannot read a School B user (404, no existence leak)", async () => {
      const result = await call("users/[id]", { token: tokens["admin-a"], params: { id: ids["admin-b"] } });
      assertEq(result.status, 404, "cross-school read must be 404");
    });

    await test("Users: School A cannot modify a School B user (role change / deactivation)", async () => {
      const result = await call("users/[id]", {
        token: tokens["admin-a"],
        method: "PUT",
        params: { id: ids["learner-b"] },
        body: { role: "school_admin", isActive: false },
      });
      assertEq(result.status, 404, "cross-school update must be 404");
      const row = await one(`SELECT role, is_active FROM users WHERE id = $1`, [ids["learner-b"]]);
      assertEq(row.role, "learner", "role must be untouched");
      assertEq(row.is_active, true, "is_active must be untouched");
      const membership = await one(`SELECT role FROM school_users WHERE user_id = $1`, [ids["learner-b"]]);
      assertEq(membership.role, "learner", "membership role must be untouched");
    });

    await test("Users: School A cannot reset a School B user's password", async () => {
      const before = (await one(`SELECT password_hash FROM users WHERE id = $1`, [ids["learner-b"]])).password_hash;
      const result = await call("users/[id]", {
        token: tokens["admin-a"],
        method: "PATCH",
        params: { id: ids["learner-b"] },
        body: { password: "New-Password-123" },
      });
      assertEq(result.status, 404, "cross-school password reset must be 404");
      const after = (await one(`SELECT password_hash FROM users WHERE id = $1`, [ids["learner-b"]])).password_hash;
      assertEq(after, before, "password hash must be untouched");
    });

    await test("Users: School B cannot read or modify School A's users either (both directions)", async () => {
      const read = await call("users/[id]", { token: tokens["admin-b"], params: { id: ids["learner-a"] } });
      assertEq(read.status, 404, "B reading A");
      const update = await call("users/[id]", {
        token: tokens["admin-b"],
        method: "PUT",
        params: { id: ids["learner-a"] },
        body: { isActive: false },
      });
      assertEq(update.status, 404, "B updating A");
      const row = await one(`SELECT is_active FROM users WHERE id = $1`, [ids["learner-a"]]);
      assertEq(row.is_active, true, "School A's learner must remain active");
    });

    await test("Users: a learner cannot enumerate the directory (role check)", async () => {
      const result = await call("users", { token: tokens["learner-a"] });
      assertEq(result.status, 403, "learners are not administrators");
    });

    await test("Users: a learner cannot create users", async () => {
      const result = await call("users", {
        token: tokens["learner-a"],
        body: { firstName: "Injected", lastName: "User", role: "teacher", password: "secret123", email: "x@y.test" },
      });
      assertEq(result.status, 403, "learners cannot create accounts");
    });

    /* ════════════════════ 3. Learner / enrollment isolation ════════════════════ */

    await test("Enrollments: School A's list contains only School A enrollments", async () => {
      const result = await call("enrollments", { token: tokens["admin-a"] });
      assertEq(result.status, 200, "list status");
      const text = bodyText(result);
      assert(!text.includes(ids["learner-b"]), "School B's learner must not appear");
      assert(text.includes(ids["learner-a"]), "School A's own learner must appear");
    });

    await test("Enrollments: filtering by a School B learner returns nothing (404/empty)", async () => {
      const result = await call("enrollments", {
        token: tokens["admin-a"],
        query: { learnerId: ids["learner-b"] },
      });
      assert(
        result.status === 404 || (result.status === 200 && !bodyText(result).includes(ids["learner-b"])),
        `expected 404 or empty, got ${result.status}`
      );
    });

    await test("Enrollments: School A cannot enroll its learner into School B's class", async () => {
      const result = await call("enrollments", {
        token: tokens["admin-a"],
        body: { learnerId: ids["learner-a2"], classId: classB, academicYearId: academicYear },
      });
      assertEq(result.status, 404, "cross-school class must not be enrollable");
      const rows = await q(`SELECT 1 FROM learner_classes WHERE learner_id = $1 AND class_id = $2`, [
        ids["learner-a2"], classB,
      ]);
      assertEq(rows.length, 0, "no cross-school enrollment row may be created");
    });

    await test("Enrollments: School B cannot enroll School A's learner into its class", async () => {
      const result = await call("enrollments", {
        token: tokens["admin-b"],
        body: { learnerId: ids["learner-a2"], classId: classB },
      });
      assertEq(result.status, 404, "foreign learner must not be enrollable");
      const rows = await q(`SELECT 1 FROM learner_classes WHERE learner_id = $1 AND class_id = $2`, [
        ids["learner-a2"], classB,
      ]);
      assertEq(rows.length, 0, "no cross-school enrollment row may be created");
    });

    await test("Enrollments: a learner cannot enroll anybody (role check)", async () => {
      const result = await call("enrollments", {
        token: tokens["learner-a"],
        body: { learnerId: ids["learner-a2"], classId: classA },
      });
      assertEq(result.status, 403, "learners are not administrators");
    });

    /* ════════════════════ 4. Grade isolation ════════════════════ */

    await test("Grades: School A cannot read School B's grades", async () => {
      for (const key of ["admin-a", "teacher-a"]) {
        const result = await call("grades", { token: tokens[key], query: { learnerId: ids["learner-b"] } });
        assertEq(result.status, 404, `${key} reading School B grades`);
        assert(!bodyText(result).includes("Assignment B"), "no School B grade content may leak");
      }
    });

    await test("Grades: School A's own grade book is intact (legitimate access)", async () => {
      const result = await call("grades", { token: tokens["admin-a"], query: { learnerId: ids["learner-a"] } });
      assertEq(result.status, 200, "grades status");
      assert(bodyText(result).includes("Assignment A"), "School A's grade must be present");
      assert(!bodyText(result).includes("Assignment B"), "School B's grade must be absent");
    });

    await test("Grades: a School B teacher cannot read School A's learner", async () => {
      const result = await call("grades", { token: tokens["teacher-b"], query: { learnerId: ids["learner-a"] } });
      assertEq(result.status, 404, "cross-school teacher read");
    });

    await test("Learner stats: School A cannot read School B's learner statistics", async () => {
      const result = await call("learner/stats", { token: tokens["admin-a"], query: { learnerId: ids["learner-b"] } });
      assertEq(result.status, 404, "cross-school learner stats");
    });

    await test("Learner stats: a parent cannot read a School B learner through a legacy link", async () => {
      // parent-a has a (cross-school) parent_learners row pointing at learner-b in the
      // fixture; the link alone must never grant access.
      const result = await call("learner/stats", { token: tokens["parent-a"], query: { learnerId: ids["learner-b"] } });
      assertEq(result.status, 404, "link must not cross the tenant boundary");
    });

    await test("Learner reports: the administrator branch is scoped to School A", async () => {
      const result = await call("learner-reports", { token: tokens["admin-a"] });
      assertEq(result.status, 200, "learner reports status");
      const text = bodyText(result);
      assert(!text.includes(ids["learner-b"]), "School B's learner must not be reported");
      assert(text.includes(ids["learner-a"]), "School A's learner must be reported");
    });

    /* ════════════════════ 5. Attendance isolation ════════════════════ */

    await test("Attendance: School A's list contains only School A rows", async () => {
      const result = await call("attendance", { token: tokens["admin-a"] });
      assertEq(result.status, 200, "attendance status");
      const text = bodyText(result);
      assert(!text.includes(ids["learner-b"]), "School B's attendance must not appear");
      assert(text.includes(ids["learner-a"]), "School A's attendance must appear");
    });

    await test("Attendance: reading School B's class is 404", async () => {
      const result = await call("attendance", { token: tokens["admin-a"], query: { classId: classB } });
      assertEq(result.status, 404, "cross-school class read");
    });

    await test("Attendance: School A cannot mark attendance for School B's class", async () => {
      const result = await call("attendance", {
        token: tokens["admin-a"],
        body: {
          classId: classB,
          date: "2026-01-05",
          records: [{ learnerId: ids["learner-b"], isPresent: true }],
        },
      });
      assertEq(result.status, 404, "cross-school attendance write");
      const rows = await q(`SELECT 1 FROM attendance WHERE class_id = $1 AND date = '2026-01-05'`, [classB]);
      assertEq(rows.length, 0, "no attendance row may be written for another school's class");
    });

    await test("Attendance: a School A teacher cannot mark a School B learner", async () => {
      const result = await call("attendance", {
        token: tokens["teacher-a"],
        body: {
          classId: classA,
          date: "2026-01-06",
          records: [{ learnerId: ids["learner-b"], isPresent: true }],
        },
      });
      assertEq(result.status, 404, "foreign learner in the record set");
      const rows = await q(`SELECT 1 FROM attendance WHERE class_id = $1 AND date = '2026-01-06'`, [classA]);
      assertEq(rows.length, 0, "no attendance row may be written");
    });

    await test("Attendance: School A can still mark its own class (head-teacher behaviour preserved)", async () => {
      const result = await call("attendance", {
        token: tokens["admin-a"],
        body: {
          classId: classA,
          date: "2026-01-07",
          records: [{ learnerId: ids["learner-a"], isPresent: true }],
        },
      });
      assertEq(result.status, 201, "legitimate attendance write must succeed");
    });

    await test("Attendance: class learners (PUT) refuses another school's class", async () => {
      const result = await call("attendance", { token: tokens["teacher-a"], method: "PUT", body: { classId: classB } });
      assertEq(result.status, 404, "cross-school class roster");
    });

    /* ════════════════════ 6. Announcement isolation ════════════════════ */

    await test("Announcements: School A sees its own private notices only", async () => {
      const result = await call("announcements", { token: tokens["teacher-a"] });
      assertEq(result.status, 200, "announcements status");
      const text = bodyText(result);
      assert(text.includes(announcePrivateA), "School A's private announcement must be visible");
      assert(!text.includes(announcePrivateB), "School B's private announcement must NOT be visible");
    });

    await test("Announcements: School B cannot see School A's private notice either", async () => {
      const result = await call("announcements", { token: tokens["teacher-b"] });
      assert(!bodyText(result).includes(announcePrivateA), "School B must not see School A's notice");
    });

    await test("Announcements: can't target another school's class on create", async () => {
      const result = await call("announcements", {
        token: tokens["teacher-a"],
        body: { title: "Cross", content: "school", classId: classB },
      });
      assertEq(result.status, 404, "class targeting is tenant-checked");
    });

    await test("Announcements: the anonymous public feed still works (intentionally public)", async () => {
      const result = await call("announcements", { token: null, query: { public: "true" } });
      assertEq(result.status, 200, "public announcements need no auth");
      assert(bodyText(result).includes(announcePublic), "public announcements remain public");
    });

    /* ════════════════════ 7. Notification isolation ════════════════════ */

    await test("Notifications: School A's learner only ever sees their own stream", async () => {
      const result = await call("notifications", { token: tokens["learner-a"] });
      assertEq(result.status, 200, "notifications status");
      const text = bodyText(result);
      assert(text.includes(notifA), "own notification");
      assert(!text.includes(notifB), "School B's notification must not appear");
    });

    await test("Notifications: cannot mark another school's notification as read", async () => {
      const result = await call("notifications", {
        token: tokens["learner-a"],
        method: "PUT",
        body: { notificationIds: [notifB] },
      });
      assertEq(result.status, 200, "no existence leak — the request looks successful");
      const row = await one(`SELECT is_read FROM notifications WHERE id = $1`, [notifB]);
      assertEq(row.is_read, false, "School B's notification must remain unread");
    });

    await test("Notifications: markAll only touches the caller's own rows", async () => {
      await call("notifications", { token: tokens["learner-a"], method: "PUT", body: { markAll: true } });
      const own = await one(`SELECT is_read FROM notifications WHERE id = $1`, [notifA]);
      const foreign = await one(`SELECT is_read FROM notifications WHERE id = $1`, [notifB]);
      assertEq(own.is_read, true, "own notification marked");
      assertEq(foreign.is_read, false, "foreign notification untouched");
    });

    /* ════════════════════ 8. File isolation ════════════════════ */

    await test("Files: downloading another school's file is 404 (not 403 — no enumeration)", async () => {
      const result = await call("files/[id]", { token: tokens["teacher-a"], params: { id: fileB } });
      assertEq(result.status, 404, "cross-school file download");
    });

    await test("Files: downloading another school's SUBMISSION file is 404", async () => {
      const result = await call("files/[id]", { token: tokens["teacher-a"], params: { id: submissionFileB } });
      assertEq(result.status, 404, "cross-school submission file");
    });

    await test("Files: an unattributable file (no resolvable school) is denied", async () => {
      // A platform account has no school context at all → 403 before the file is even read.
      const platform = await call("files/[id]", { token: tokens["platform"], params: { id: orphanFile } });
      assertEq(platform.status, 403, "platform account must not receive a school context");
      // A school member must not be able to learn that somebody else's file exists → 404.
      for (const key of ["admin-a", "admin-b"]) {
        const result = await call("files/[id]", { token: tokens[key], params: { id: orphanFile } });
        assertEq(result.status, 404, `${key} must not be able to resolve an unattributable file`);
      }
    });

    await test("Files: the same-school owner can download their own file (legitimate access)", async () => {
      const result = await call("files/[id]", { token: tokens["teacher-a"], params: { id: fileA } });
      assertEq(result.status, 200, "own file download");
      assert(result.headers.get("content-type")?.includes("pdf"), "content type preserved");
    });

    await test("Files: Phase 1 per-file rules still apply inside the school", async () => {
      // learner-b2 is a member of School B but is neither the uploader nor the assignment
      // teacher of learner-b's submission file → Phase 1 denies with 403.
      const result = await call("files/[id]", { token: tokens["learner-b2"], params: { id: submissionFileB } });
      assertEq(result.status, 403, "Phase 1 submission-file rule preserved");
    });

    await test("Files: uploads/[id] DELETE cannot remove another school's file", async () => {
      const result = await call("uploads/[id]", {
        token: tokens["teacher-a"],
        method: "DELETE",
        params: { id: fileB },
      });
      assertEq(result.status, 404, "cross-school delete");
      const rows = await q(`SELECT 1 FROM uploaded_files WHERE id = $1`, [fileB]);
      assertEq(rows.length, 1, "the file row must still exist");
    });

    /* ════════════════════ 9. Submissions ════════════════════ */

    await test("Submissions: School A's supervisor branch is school-scoped", async () => {
      for (const key of ["admin-a", "teacher-a"]) {
        const result = await call("submissions", { token: tokens[key] });
        assertEq(result.status, 200, `${key} submissions`);
        const text = bodyText(result);
        assert(!text.includes(ids["learner-b"]), `${key} must not see School B's submissions`);
        assert(text.includes(ids["learner-a"]) || text.includes(subA), `${key} must see own-school submissions`);
      }
    });

    await test("Submissions: reading a School B submission is 404", async () => {
      const read = await call("submissions/[id]", { token: tokens["teacher-a"], params: { id: subB } });
      assertEq(read.status, 404, "cross-school submission read");
    });

    await test("Submissions: grading a School B submission is 404 and writes nothing", async () => {
      const result = await call("submissions/[id]/grade", {
        token: tokens["teacher-a"],
        method: "POST",
        params: { id: subB },
        body: { score: 10, maxScore: 100, feedback: "hacked" },
      });
      assertEq(result.status, 404, "cross-school grade write");
      const row = await one(`SELECT score, feedback, graded_by FROM submissions WHERE id = $1`, [subB]);
      assertEq(row.score, 90, "score untouched");
      assertEq(row.feedback, null, "feedback untouched");
    });

    await test("Submissions: a learner cannot submit to another school's assignment", async () => {
      const result = await call("submissions", {
        token: tokens["learner-a"],
        body: { assignmentId: assignB, content: "cross-school work" },
      });
      assertEq(result.status, 404, "cross-school submission write");
      const rows = await q(`SELECT 1 FROM submissions WHERE assignment_id = $1 AND learner_id = $2`, [
        assignB, ids["learner-a"],
      ]);
      assertEq(rows.length, 0, "no cross-school submission row may exist");
    });

    await test("Submissions: an unenrolled learner can no longer submit (fallback removed)", async () => {
      // learner-a2 is a member of School A but not enrolled in class A.
      const result = await call("submissions", {
        token: tokens["learner-a2"],
        body: { assignmentId: assignA, content: "not enrolled" },
      });
      assertEq(result.status, 403, "enrollment is required — no `if no enrollment found, allow` fallback");
    });

    /* ════════════════════ 10. Admin / aggregate isolation ════════════════════ */

    await test("Admin: the activity feed is scoped to the caller's school", async () => {
      const result = await call("activity-logs", { token: tokens["admin-a"] });
      assertEq(result.status, 200, "activity feed");
      const text = bodyText(result);
      assert(!text.includes("B event"), "School B's activity must not appear");
      assert(!text.includes("orphan event"), "unattributable activity must not appear");
    });

    await test("Admin: the admin dashboard counts only this school", async () => {
      const result = await call("dashboard/admin", { token: tokens["admin-a"] });
      assertEq(result.status, 200, "dashboard status");
      assertEq(result.json.data.rawStats.teachers, 1, "only School A's teacher is counted");
      assertEq(result.json.data.rawStats.learners, 2, "only School A's learners are counted");
      assert(!bodyText(result).includes("B event"), "School B's activity must not appear");
    });

    await test("Admin: staff cannot pull another school's teacher dashboard", async () => {
      const result = await call("dashboard/teacher", { token: tokens["admin-a"], query: { teacherId: ids["teacher-b"] } });
      assertEq(result.status, 404, "foreign teacherId parameter");
    });

    await test("Admin: staff cannot pull another school's parent dashboard", async () => {
      const result = await call("dashboard/parent", { token: tokens["admin-a"], query: { parentId: ids["parent-b"] } });
      assertEq(result.status, 404, "foreign parentId parameter");
    });

    await test("Admin: the learner dashboard refuses another school's learner", async () => {
      const result = await call("dashboard/learner", { token: tokens["admin-a"], query: { learnerId: ids["learner-b"] } });
      assertEq(result.status, 404, "foreign learnerId parameter");
    });

    await test("Admin: messages cannot be sent across schools", async () => {
      const result = await call("messages", {
        token: tokens["teacher-a"],
        body: { receiverId: ids["teacher-b"], content: "hello across the fence" },
      });
      assertEq(result.status, 404, "cross-school recipient");
      const rows = await q(`SELECT 1 FROM messages WHERE receiver_id = $1`, [ids["teacher-b"]]);
      assertEq(rows.length, 0, "no cross-school message may be stored");
    });

    /* ════════════════════ 11. Legitimate access (nothing broke) ════════════════════ */

    await test("Legitimate: School A's admin can read a School A user in full", async () => {
      const result = await call("users/[id]", { token: tokens["admin-a"], params: { id: ids["learner-a"] } });
      assertEq(result.status, 200, "same-school read");
      assertEq(result.json.data.id, ids["learner-a"], "correct user");
      assertEq(result.json.data.passwordHash, undefined, "no credential may leave the API");
    });

    await test("Legitimate: School A's teacher can mark their own class", async () => {
      const result = await call("attendance", {
        token: tokens["teacher-a"],
        body: { classId: classA, date: "2026-01-08", records: [{ learnerId: ids["learner-a"], isPresent: true }] },
      });
      assertEq(result.status, 201, "own class attendance");
    });

    await test("Legitimate: School A's admin can update a School A user's role", async () => {
      const result = await call("users/[id]", {
        token: tokens["admin-a"],
        method: "PUT",
        params: { id: ids["learner-a2"] },
        body: { role: "teacher" },
      });
      assertEq(result.status, 200, "same-school role change");
      const membership = await one(`SELECT role FROM school_users WHERE user_id = $1`, [ids["learner-a2"]]);
      assertEq(membership.role, "teacher", "membership role stays aligned with the identity role");
      await call("users/[id]", {
        token: tokens["admin-a"],
        method: "PUT",
        params: { id: ids["learner-a2"] },
        body: { role: "learner" },
      });
    });

    await test("Legitimate: School A's admin can enroll a School A learner into a School A class", async () => {
      const result = await call("enrollments", {
        token: tokens["admin-a"],
        body: { learnerId: ids["learner-a2"], classId: classA, academicYearId: academicYear },
      });
      assertEq(result.status, 201, "same-school enrollment");
      await q(`DELETE FROM learner_classes WHERE learner_id = $1 AND class_id = $2`, [ids["learner-a2"], classA]);
    });

    await test("Legitimate: School A's parent sees their own child's attendance", async () => {
      const result = await call("attendance", { token: tokens["parent-a"], query: { learnerId: ids["learner-a"] } });
      assertEq(result.status, 200, "parent own child");
      assert(bodyText(result).includes(ids["learner-a"]), "child's attendance present");
    });

    await test("Legitimate: assignment material is readable by school members, submission files are not", async () => {
      // Phase 2C decision: a file attached to an assignment is course material for the
      // school, so a same-school member may read it; a `purpose=submission` file keeps the
      // Phase 1 owner/teacher/admin rule (proved above by the learner-b2 → 403 case).
      const material = await call("files/[id]", { token: tokens["learner-a2"], params: { id: fileA } });
      assertEq(material.status, 200, "same-school assignment material stays readable inside the school");

      const foreignSubmission = await call("files/[id]", { token: tokens["teacher-a"], params: { id: submissionFileB } });
      assertEq(foreignSubmission.status, 404, "another school's submission file is invisible");
    });

    /* ════════════════════ 12. Fail closed when attribution is ambiguous ════════════════════ */

    await test("Fail closed: content reachable from TWO schools belongs to neither", async () => {
      /* A dual-membership learner (teacher/parent accounts can legitimately belong to more
         than one school) enrols in School A's class. The class is now reachable from School B
         as well, so `sqlClassInSchool` must deny it to BOTH schools until the cross-school
         row is gone — "reachable from my school" alone is not ownership. */
      const dual = (
        await one(
          `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
           VALUES ($1, $2, $3, 'learner', 'Dual', 'Member', true) RETURNING id`,
          [`dual-${DB_NAME}@example.test`, `dual-${DB_NAME.slice(-8)}`, passwordHash]
        )
      ).id as string;
      await q(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,'learner','active')`, [
        schoolA,
        dual,
      ]);
      await q(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,'learner','active')`, [
        schoolB,
        dual,
      ]);
      const dualToken = await auth.createToken({ userId: dual, role: "learner", email: "dual@example.test" });
      await q(`INSERT INTO learner_classes (learner_id, class_id, academic_year_id) VALUES ($1,$2,$3)`, [
        dual,
        classA,
        academicYear,
      ]);

      try {
        for (const token of [tokens["admin-a"], tokens["admin-b"]]) {
          const result = await call("attendance", { token, query: { classId: classA } });
          assertEq(result.status, 404, "a class two schools can reach must be denied to both");
        }

        /* A file that is reachable from School A (its assignment) and from School B (its
           uploader) is likewise unattributable. */
        const dualFile = (
          await one(
            `INSERT INTO uploaded_files (uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
             VALUES ($1, 'assignment', $2, 'dual.pdf', 'stored-dual.pdf', 'application/pdf', 'document', 5) RETURNING id`,
            [dual, assignA]
          )
        ).id as string;
        fs.writeFileSync(path.join(UPLOAD_DIR, "stored-dual.pdf"), "%PDF-1.4 dual");
        for (const token of [tokens["admin-a"], tokens["admin-b"]]) {
          const result = await call("files/[id]", { token, params: { id: dualFile } });
          assertEq(result.status, 404, "a file two schools can reach must be denied to both");
        }

        /* The dual member is still a legitimate member of each school individually. */
        const self = await call("attendance", { token: dualToken, query: { learnerId: dual } });
        assertEq(self.status, 200, "the learner may still read their own attendance");
      } finally {
        await q(`DELETE FROM learner_classes WHERE learner_id = $1 AND class_id = $2`, [dual, classA]);
        await q(`DELETE FROM uploaded_files WHERE uploader_id = $1`, [dual]);
        fs.rmSync(path.join(UPLOAD_DIR, "stored-dual.pdf"), { force: true });
      }

      /* Once the ambiguous row is gone the class resolves to School A alone again. */
      const restored = await call("attendance", { token: tokens["admin-a"], query: { classId: classA } });
      assertEq(restored.status, 200, "single-school attribution is restored");
    });

    /* ════════════════════ 13. Phase 2C review fixes — F1 (timetable/quiz FK tenancy)
                            and F2 (learner dashboard override scoping) ════════════════════ */

    /* These four tests are the regression lock for the pre-merge security review of PR #19.
       F1: `POST /api/timetable`, `PUT /api/timetable/[id]` and `PUT /api/quizzes/[id]`
       accepted a client-supplied class/teacher id without proving it belonged to the
       caller's school. F2: `GET /api/dashboard/learner` read card overrides without the
       school predicate. Every assertion below drives the REAL route handler against the
       REAL database, and each rejection is additionally asserted at the row level so a
       "blocked" response that still wrote data cannot pass. */

    let entryA = "";

    await test("Review F1: a timetable slot cannot reference another school's class", async () => {
      const result = await call("timetable", {
        token: tokens["admin-a"],
        body: { classId: classB, dayOfWeek: "monday", startTime: "09:00", endTime: "10:00", room: "R1" },
      });
      assertEq(result.status, 404, "School B's class must be rejected");
      assert(!bodyText(result).includes(classB), "the foreign class id must not be echoed back");

      const rows = await q(`SELECT 1 FROM timetable_entries WHERE class_id = $1`, [classB]);
      assertEq(rows.length, 0, "no timetable row may be written for another school's class");
    });

    await test("Review F1: a timetable slot cannot reference another school's teacher", async () => {
      const result = await call("timetable", {
        token: tokens["admin-a"],
        body: {
          classId: classA,
          teacherId: ids["teacher-b"],
          dayOfWeek: "monday",
          startTime: "09:00",
          endTime: "10:00",
        },
      });
      assertEq(result.status, 404, "School B's teacher must be rejected");

      const rows = await q(
        `SELECT 1 FROM timetable_entries WHERE class_id = $1 AND teacher_id = $2`,
        [classA, ids["teacher-b"]]
      );
      assertEq(rows.length, 0, "no cross-school timetable row may be written");
    });

    await test("Review F1: a membership-less account is not a valid slot teacher either", async () => {
      const result = await call("timetable", {
        token: tokens["admin-a"],
        body: {
          classId: classA,
          teacherId: ids["orphan"],
          dayOfWeek: "friday",
          startTime: "13:00",
          endTime: "14:00",
        },
      });
      assertEq(result.status, 404, "a teacher without an active membership must be rejected");
    });

    await test("Review F1: legitimate same-school timetable creation still works", async () => {
      const withTeacher = await call("timetable", {
        token: tokens["admin-a"],
        body: {
          classId: classA,
          teacherId: ids["teacher-a"],
          subjectId: subject,
          dayOfWeek: "tuesday",
          startTime: "09:00",
          endTime: "10:00",
          room: "A1",
        },
      });
      assertEq(withTeacher.status, 201, "same-school slot with a teacher");
      entryA = withTeacher.json.data.id as string;
      assertEq(withTeacher.json.data.classId, classA, "stored on the caller's own class");

      const withoutTeacher = await call("timetable", {
        token: tokens["admin-a"],
        body: { classId: classA, dayOfWeek: "wednesday", startTime: "11:00", endTime: "12:00" },
      });
      assertEq(withoutTeacher.status, 201, "a slot without a teacher stays allowed");
    });

    await test("Review F1: reassigning a slot to another school's teacher is refused", async () => {
      const result = await call("timetable/[id]", {
        token: tokens["admin-a"],
        method: "PUT",
        params: { id: entryA },
        body: { teacherId: ids["teacher-b"] },
      });
      assertEq(result.status, 404, "foreign teacher reassignment");

      const row = await one(`SELECT teacher_id, room FROM timetable_entries WHERE id = $1`, [entryA]);
      assertEq(row.teacher_id, ids["teacher-a"], "the stored teacher must be unchanged");
    });

    await test("Review F1: legitimate same-school slot updates still work", async () => {
      const result = await call("timetable/[id]", {
        token: tokens["admin-a"],
        method: "PUT",
        params: { id: entryA },
        body: { teacherId: ids["teacher-a"], room: "A2" },
      });
      assertEq(result.status, 200, "same-school reassignment must succeed");
      assertEq(result.json.data.room, "A2", "the update must be persisted");
    });

    await test("Review F1: a quiz cannot be moved to another school's class", async () => {
      const quizA = (
        await one(
          `INSERT INTO quizzes (title, class_id, subject_id, teacher_id, is_published)
           VALUES ('Review Quiz A', $1, $2, $3, false) RETURNING id`,
          [classA, subject, ids["teacher-a"]]
        )
      ).id as string;

      try {
        const foreign = await call("quizzes/[id]", {
          token: tokens["teacher-a"],
          method: "PUT",
          params: { id: quizA },
          body: { classId: classB },
        });
        assertEq(foreign.status, 404, "School B's class must be rejected");

        const row = await one(`SELECT class_id FROM quizzes WHERE id = $1`, [quizA]);
        assertEq(row.class_id, classA, "the quiz must stay on its own school's class");

        const legit = await call("quizzes/[id]", {
          token: tokens["teacher-a"],
          method: "PUT",
          params: { id: quizA },
          body: { classId: classA, title: "Review Quiz A (updated)" },
        });
        assertEq(legit.status, 200, "a same-school quiz update must still succeed");
        assertEq(legit.json.data.classId, classA, "same-school class is persisted");
      } finally {
        await q(`DELETE FROM quizzes WHERE id = $1`, [quizA]);
      }
    });

    await test("Review F2: a learner never receives another school's dashboard overrides", async () => {
      const ownOverride = (
        await one(
          `INSERT INTO dashboard_card_overrides
             (card_key, dashboard_role, label, is_visible, is_enabled, scope_type, created_by)
           VALUES ('phase2c_own_card', 'learner', 'OWN-SCHOOL-CARD', true, true, 'role', $1)
           RETURNING id`,
          [ids["admin-a"]]
        )
      ).id as string;
      const foreignOverride = (
        await one(
          `INSERT INTO dashboard_card_overrides
             (card_key, dashboard_role, label, is_visible, is_enabled, scope_type, created_by)
           VALUES ('phase2c_foreign_card', 'learner', 'FOREIGN-SCHOOL-CARD', true, true, 'role', $1)
           RETURNING id`,
          [ids["admin-b"]]
        )
      ).id as string;

      try {
        const result = await call("dashboard/learner", { token: tokens["learner-a"] });
        assertEq(result.status, 200, "learner dashboard");

        const stats = result.json.data.stats as Record<string, { label?: string }>;
        assert(stats.phase2c_own_card, "this school's override must still be applied");
        assertEq(stats.phase2c_own_card.label, "OWN-SCHOOL-CARD", "own override content");

        assert(
          !stats.phase2c_foreign_card,
          "another school's override card must not be returned at all"
        );
        assert(
          !bodyText(result).includes("FOREIGN-SCHOOL-CARD"),
          "another school's override content must never appear in the response"
        );
      } finally {
        await q(`DELETE FROM dashboard_card_overrides WHERE id IN ($1, $2)`, [
          ownOverride,
          foreignOverride,
        ]);
      }
    });

    /* ════════════════════ Summary ════════════════════ */

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

  /* Exit explicitly: the embedded-postgres shutdown hook must not turn a red suite green. */
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
