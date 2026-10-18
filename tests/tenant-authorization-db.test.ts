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
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");

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

    const runMigrations = () => runMigrationChain({ databaseUrl: scratchUrl, env: { JWT_SECRET } });

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

    const subjectA = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Maths', 'MTH') RETURNING id`, [schoolA])).id as string;
    const subjectB = (await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Maths', 'MTH') RETURNING id`, [schoolB])).id as string;

    const classA = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id)
       VALUES ($1, 'Class A', 'primary', $2, $3) RETURNING id`,
      [schoolA, ids["teacher-a"], yearA]
    )).id as string;
    const classB = (await one(
      `INSERT INTO classes (school_id, name, level, class_teacher_id, academic_year_id)
       VALUES ($1, 'Class B', 'primary', $2, $3) RETURNING id`,
      [schoolB, ids["teacher-b"], yearB]
    )).id as string;

    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4,$5)`, [
      schoolA, ids["teacher-a"], classA, subjectA, yearA,
    ]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id, academic_year_id) VALUES ($1,$2,$3,$4,$5)`, [
      schoolB, ids["teacher-b"], classB, subjectB, yearB,
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
    // A cross-school link, to prove the parent branch intersects with the school's members.
    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id, relationship) VALUES ($1,$2,$3,'guardian')`, [
      schoolB, ids["parent-a"], ids["learner-b"],
    ]);
    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id, relationship) VALUES ($1,$2,$3,'guardian')`, [
      schoolB, ids["parent-b"], ids["learner-b"],
    ]);

    const assignA = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads)
       VALUES ($1, 'Assignment A', $2, $3, $4, 'published', 100, true) RETURNING id`,
      [schoolA, classA, subjectA, ids["teacher-a"]]
    )).id as string;
    const assignB = (await one(
      `INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads)
       VALUES ($1, 'Assignment B', $2, $3, $4, 'published', 100, true) RETURNING id`,
      [schoolB, classB, subjectB, ids["teacher-b"]]
    )).id as string;

    const subA = (await one(
      `INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at)
       VALUES ($1, $2, $3, 'graded', 80, 100, 80, now()) RETURNING id`,
      [schoolA, assignA, ids["learner-a"]]
    )).id as string;
    const subB = (await one(
      `INSERT INTO submissions (school_id, assignment_id, learner_id, status, score, max_score, percentage, graded_at)
       VALUES ($1, $2, $3, 'graded', 90, 100, 90, now()) RETURNING id`,
      [schoolB, assignB, ids["learner-b"]]
    )).id as string;

    await q(`INSERT INTO attendance (school_id, learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,$3,CURRENT_DATE,true,$4)`, [
      schoolA, ids["learner-a"], classA, ids["teacher-a"],
    ]);
    await q(`INSERT INTO attendance (school_id, learner_id, class_id, date, is_present, marked_by_id) VALUES ($1,$2,$3,CURRENT_DATE,false,$4)`, [
      schoolB, ids["learner-b"], classB, ids["teacher-b"],
    ]);

    const announcePrivateA = (await one(
      `INSERT INTO announcements (school_id, title, content, author_id, is_public, is_pinned) VALUES ($1, 'Private A', 'secret a', $2, false, false) RETURNING id`,
      [schoolA, ids["teacher-a"]]
    )).id as string;
    const announcePrivateB = (await one(
      `INSERT INTO announcements (school_id, title, content, author_id, is_public, is_pinned) VALUES ($1, 'Private B', 'secret b', $2, false, false) RETURNING id`,
      [schoolB, ids["teacher-b"]]
    )).id as string;
    const announcePublic = (await one(
      `INSERT INTO announcements (school_id, title, content, author_id, is_public, is_pinned) VALUES ($1, 'Public A', 'public a', $2, true, false) RETURNING id`,
      [schoolA, ids["teacher-a"]]
    )).id as string;

    const notifA = (await one(
      `INSERT INTO notifications (school_id, user_id, type, title, message, is_read) VALUES ($1, $2, 'system', 'N-A', 'for a', false) RETURNING id`,
      [schoolA, ids["learner-a"]]
    )).id as string;
    const notifB = (await one(
      `INSERT INTO notifications (school_id, user_id, type, title, message, is_read) VALUES ($1, $2, 'system', 'N-B', 'for b', false) RETURNING id`,
      [schoolB, ids["learner-b"]]
    )).id as string;

    const fileA = (await one(
      `INSERT INTO uploaded_files (school_id, uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, $2, 'assignment', $3, 'a.pdf', 'stored-a.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [schoolA, ids["teacher-a"], assignA]
    )).id as string;
    const fileB = (await one(
      `INSERT INTO uploaded_files (school_id, uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, $2, 'assignment', $3, 'b.pdf', 'stored-b.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [schoolB, ids["teacher-b"], assignB]
    )).id as string;
    const submissionFileB = (await one(
      `INSERT INTO uploaded_files (school_id, uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, $2, 'submission', $3, 'work-b.pdf', 'stored-work-b.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [schoolB, ids["learner-b"], assignB]
    )).id as string;
    // The uploader is a platform account with no membership → ownership cannot be resolved.
    const orphanFile = (await one(
      `INSERT INTO uploaded_files (school_id, uploader_id, purpose, original_name, stored_name, mime_type, category, size_bytes)
       VALUES ($1, $2, 'assignment', 'orphan.pdf', 'stored-orphan.pdf', 'application/pdf', 'document', 5) RETURNING id`,
      [schoolA, ids["platform"]]
    )).id as string;

    // Real bytes for the files a legitimately-authorized caller should be able to download.
    for (const storedName of ["stored-a.pdf", "stored-b.pdf", "stored-work-b.pdf", "stored-orphan.pdf"]) {
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), "%PDF-1.4 phase 2c test file");
    }

    await q(`INSERT INTO activity_logs (school_id, user_id, action, entity_type, description) VALUES ($1, $2, 'create', 'class', 'A event')`, [
      schoolA, ids["teacher-a"],
    ]);
    await q(`INSERT INTO activity_logs (school_id, user_id, action, entity_type, description) VALUES ($1, $2, 'create', 'class', 'B event')`, [
      schoolB, ids["teacher-b"],
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

    // Real shared identities: each holds an active membership in both tenants. These
    // records expose cases where membership-derived visibility was incorrectly used in
    // place of the owning row's school_id.
    const createDualMember = async (label: string, role: string) => {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, 'Shared', $5, true) RETURNING id`,
        [`${label}-${DB_NAME}@example.test`, `${label}-${DB_NAME.slice(-8)}`, passwordHash, role, label]
      );
      await q(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [schoolA, row.id, role]);
      await q(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active')`, [schoolB, row.id, role]);
      const membership = await one(
        `SELECT id FROM school_users WHERE school_id = $1 AND user_id = $2 AND status = 'active'`,
        [schoolA, row.id]
      );
      const token = await auth.createToken({
        userId: row.id, role, email: `${label}@example.test`,
        schoolId: schoolA, membershipId: membership.id,
      });
      const unselectedToken = await auth.createToken({ userId: row.id, role, email: `${label}@example.test` });
      return { id: row.id as string, token, unselectedToken };
    };
    const dualTeacher = await createDualMember("dual-teacher", "teacher");
    const dualPeer = await createDualMember("dual-peer", "teacher");
    const dualParent = await createDualMember("dual-parent", "parent");
    const dualLearner = await createDualMember("dual-learner", "learner");

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
        body: { learnerId: ids["learner-a2"], classId: classB, academicYearId: yearA },
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

    await test("Notifications: dual-member views and updates only the current school's rows", async () => {
      const own = (await one(`INSERT INTO notifications (school_id, user_id, type, title, message, is_read) VALUES ($1,$2,'system','DUAL-A','A notification',false) RETURNING id`, [schoolA, dualTeacher.id])).id as string;
      const foreign = (await one(`INSERT INTO notifications (school_id, user_id, type, title, message, is_read) VALUES ($1,$2,'system','DUAL-B','B notification',false) RETURNING id`, [schoolB, dualTeacher.id])).id as string;
      try {
        const list = await call("notifications", { token: dualTeacher.token });
        assertEq(list.status, 200, "dual member notification list");
        assert(bodyText(list).includes(own), "School A notification remains visible");
        assert(!bodyText(list).includes(foreign), "School B notification is not exposed");
        await call("notifications", { token: dualTeacher.token, method: "PUT", body: { notificationIds: [foreign] } });
        let state = await one(`SELECT is_read FROM notifications WHERE id=$1`, [foreign]);
        assertEq(state.is_read, false, "single-item update cannot mark School B read");
        await call("notifications", { token: dualTeacher.token, method: "PUT", body: { markAll: true } });
        state = await one(`SELECT is_read FROM notifications WHERE id=$1`, [foreign]);
        const ownState = await one(`SELECT is_read FROM notifications WHERE id=$1`, [own]);
        assertEq(state.is_read, false, "bulk update cannot mark School B read");
        assertEq(ownState.is_read, true, "bulk update still marks School A notification read");
      } finally {
        await q(`DELETE FROM notifications WHERE id IN ($1,$2)`, [own, foreign]);
      }
    });

    await test("Messages: dual participant sees and marks read only the current school's conversation", async () => {
      const a = (await one(`INSERT INTO messages (school_id,sender_id,receiver_id,content,is_read) VALUES ($1,$2,$3,'A-only-content',false) RETURNING id`, [schoolA, dualPeer.id, dualTeacher.id])).id as string;
      const b = (await one(`INSERT INTO messages (school_id,sender_id,receiver_id,content,is_read) VALUES ($1,$2,$3,'B-secret-content',false) RETURNING id`, [schoolB, dualPeer.id, dualTeacher.id])).id as string;
      try {
        const result = await call("messages", { token: dualTeacher.token, query: { userId: dualPeer.id } });
        assertEq(result.status, 200, "same-school participant can view conversation");
        assert(bodyText(result).includes("A-only-content"), "School A message remains accessible");
        assert(!bodyText(result).includes("B-secret-content"), "School B message is not exposed");
        const aState = await one(`SELECT is_read FROM messages WHERE id=$1`, [a]);
        const bState = await one(`SELECT is_read FROM messages WHERE id=$1`, [b]);
        assertEq(aState.is_read, true, "School A incoming message is marked read");
        assertEq(bState.is_read, false, "School B incoming message remains unread");
        const list = await call("messages", { token: dualTeacher.token });
        assert(!bodyText(list).includes("B-secret-content"), "conversation list also excludes School B content");
      } finally {
        await q(`DELETE FROM messages WHERE id IN ($1,$2)`, [a, b]);
      }
    });

    await test("Parent links: owner school_id protects id reads, updates, collection reads and deletes", async () => {
      const link = (await one(`INSERT INTO parent_learners (school_id,parent_id,learner_id,relationship) VALUES ($1,$2,$3,'guardian') RETURNING id`, [schoolB, dualParent.id, dualLearner.id])).id as string;
      try {
        const collection = await call("parent-learners", { token: tokens["admin-a"] });
        assert(!bodyText(collection).includes(link), "School A collection omits School B link despite dual memberships");
        const foreignRead = await call("parent-learners/[id]", { token: tokens["admin-a"], params: { id: link } });
        assertEq(foreignRead.status, 404, "foreign link id read is hidden");
        const foreignUpdate = await call("parent-learners/[id]", { token: tokens["admin-a"], method: "PUT", params: { id: link }, body: { relationship: "mother" } });
        assertEq(foreignUpdate.status, 404, "foreign link id update is hidden");
        const collectionDelete = await call("parent-learners", { token: tokens["admin-a"], method: "DELETE", query: { parentId: dualParent.id, learnerId: dualLearner.id } });
        assertEq(collectionDelete.status, 404, "collection delete requires link ownership, not just shared membership");
        const state = await one(`SELECT relationship FROM parent_learners WHERE id=$1`, [link]);
        assertEq(state.relationship, "guardian", "foreign relationship remains unchanged");
        assertEq((await call("parent-learners/[id]", { token: tokens["admin-b"], params: { id: link } })).status, 200, "School B retains legitimate link read");
        assertEq((await call("parent-learners/[id]", { token: tokens["admin-b"], method: "PUT", params: { id: link }, body: { relationship: "mother" } })).status, 200, "School B retains legitimate update");
        const mixedIdentityLink = await one(
          `SELECT id FROM parent_learners WHERE school_id = $1 AND parent_id = $2 AND learner_id = $3`,
          [schoolB, ids["parent-a"], ids["learner-b"]]
        );
        const schoolBCollection = await call("parent-learners", { token: tokens["admin-b"] });
        assert(!bodyText(schoolBCollection).includes(mixedIdentityLink.id), "link row cannot expose an identity that is not a School B member");
        assertEq((await call("parent-learners", { token: tokens["admin-b"], method: "DELETE", query: { parentId: dualParent.id, learnerId: dualLearner.id } })).status, 200, "School B retains legitimate collection delete");
        assertEq((await one(`SELECT id FROM parent_learners WHERE id=$1`, [link])), undefined, "School B deletion removes only its owned link");
      } finally {
        await q(`DELETE FROM parent_learners WHERE id=$1`, [link]);
      }
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

    await test("Assignments: composite tenant FKs reject cross-school child rows", async () => {
      await assert.rejects(
        () => db.query(
          `INSERT INTO submissions (school_id, assignment_id, learner_id, status, content)
           VALUES ($1, $2, $3, 'submitted', 'CROSS-SCHOOL-ASSIGNMENT-CHILD-SECRET')`,
          [schoolB, assignA, ids["learner-b"]]
        ),
        (error: any) => error.code === "23503",
        "a submission cannot point to another school's assignment"
      );
      await assert.rejects(
        () => db.query(
          `INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id)
           VALUES ($1, $2, $3, $4)`,
          [schoolB, ids["learner-b"], classA, yearB]
        ),
        (error: any) => error.code === "23503",
        "an enrollment cannot point to another school's class"
      );

      const response = await call("assignments/[id]", {
        token: tokens["teacher-a"], params: { id: assignA },
      });
      assertEq(response.status, 200, "legitimate same-school assignment remains readable");
      assert(response.json.data.submissions.some((row: any) => row.id === subA), "same-school submission remains visible");
      assert(!bodyText(response).includes(ids["learner-b"]), "foreign learner identity is not exposed");
      const list = await call("submissions", {
        token: tokens["teacher-a"], query: { assignmentId: assignA },
      });
      assertEq(list.status, 200, "same-school submission list stays available");
      assert(!bodyText(list).includes(subB), "School A's submission list excludes School B's existing submission");
      const results = await call("assignments/[id]/results", {
        token: tokens["teacher-a"], params: { id: assignA },
      });
      assertEq(results.status, 200, "same-school results remain accessible");
      assert(!bodyText(results).includes(subB), "results summary excludes School B's submission");
      const parentAttempt = await call("assignments/[id]/results", {
        token: tokens["parent-a"], params: { id: assignA }, query: { learnerId: ids["learner-b"] },
      });
      // The denial now happens inside the authorization query itself (query-level access
      // control): a parent whose learnerId is not an approved, linked learner does not
      // match the assignment row at all, so the refusal is indistinguishable from "not
      // found" and leaks less than the previous post-fetch 403. The security property
      // under test is that the request is refused and no foreign data is returned.
      assertEq(parentAttempt.status, 404, "parent cannot use a foreign learner id for results");
      assert(!bodyText(parentAttempt).includes(ids["learner-b"]), "foreign learner identity is not exposed through the results route");
      assert(!bodyText(parentAttempt).includes(subB), "foreign submission is not exposed through the results route");
    });

    await test("Corrections: assignment and question joins stay within the selected school", async () => {
      const foreignQuestionId = (await one(
        `INSERT INTO assignment_questions (assignment_id, question_type, question_text)
         VALUES ($1, 'short_answer', 'CROSS-SCHOOL-QUESTION-SECRET') RETURNING id`,
        [assignB]
      )).id as string;
      const foreignAssignmentCorrectionId = (await one(
        `INSERT INTO assignment_corrections (assignment_id, correction_text, posted_by)
         VALUES ($1, 'CROSS-SCHOOL-CORRECTION-SECRET', $2) RETURNING id`,
        [assignB, ids["teacher-b"]]
      )).id as string;
      const mismatchedQuestionCorrectionId = (await one(
        `INSERT INTO assignment_corrections (assignment_id, question_id, correction_text, posted_by)
         VALUES ($1, $2, 'LOCAL-CORRECTION-WITH-FOREIGN-QUESTION', $3) RETURNING id`,
        [assignA, foreignQuestionId, ids["teacher-a"]]
      )).id as string;
      try {
        const foreign = await call("assignments/[id]/corrections", {
          token: tokens["teacher-a"], params: { id: assignB },
        });
        assertEq(foreign.status, 404, "foreign assignment corrections are hidden");
        assert(!bodyText(foreign).includes("CROSS-SCHOOL-CORRECTION-SECRET"), "foreign correction text is not returned");
        const own = await call("assignments/[id]/corrections", {
          token: tokens["teacher-a"], params: { id: assignA },
        });
        assertEq(own.status, 200, "legitimate same-school corrections endpoint remains accessible");
        assert(!bodyText(own).includes(foreignAssignmentCorrectionId), "foreign correction id is absent");
        assert(!bodyText(own).includes("CROSS-SCHOOL-QUESTION-SECRET"), "foreign question text cannot leak through a mismatched questionId");
        assert(bodyText(own).includes("LOCAL-CORRECTION-WITH-FOREIGN-QUESTION"), "the same-school correction itself remains visible");
      } finally {
        await q(`DELETE FROM assignment_corrections WHERE id IN ($1, $2)`, [foreignAssignmentCorrectionId, mismatchedQuestionCorrectionId]);
        await q(`DELETE FROM assignment_questions WHERE id=$1`, [foreignQuestionId]);
      }
    });

    await test("Membership: a dual-school account without a validated selection is denied", async () => {
      const denied = await call("users", { token: dualTeacher.unselectedToken });
      assertEq(denied.status, 403, "an ambiguous multi-school token has no tenant context");
      assert(/select one of your schools/i.test(String(denied.json?.error)), "selection-required response is explicit");
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
      assert([403, 404].includes(result.status), "enrollment is required — no `if no enrollment found, allow` fallback");
    });

    /* ════════════════════ 10. Admin / aggregate isolation ════════════════════ */

    await test("Admin aggregates and feeds use row school_id for a dual-member actor", async () => {
      await q(`INSERT INTO resources (school_id,title,type,teacher_id) VALUES ($1,'Dual A Resource','pdf',$2),($3,'Dual B Resource','pdf',$2)`, [schoolA, dualTeacher.id, schoolB]);
      await q(`INSERT INTO announcements (school_id,title,content,author_id,is_public) VALUES ($1,'Dual A Announcement','A',$2,false),($3,'DUAL-B-ANNOUNCEMENT-SECRET','B',$2,false)`, [schoolA, dualTeacher.id, schoolB]);
      await q(`INSERT INTO activity_logs (school_id,user_id,action,entity_type,description) VALUES ($1,$2,'create','resource','DUAL A ACTIVITY'),($3,$2,'create','resource','DUAL B ACTIVITY SECRET')`, [schoolA, dualTeacher.id, schoolB]);
      try {
        const admin = await call("dashboard/admin", { token: tokens["admin-a"] });
        assertEq(admin.status, 200, "admin dashboard");
        assertEq(admin.json.data.rawStats.resources, 1, "resource count only includes School A row");
        assertEq(admin.json.data.rawStats.announcements, 3, "announcement metric only includes School A rows");
        assert(bodyText(admin).includes("DUAL A ACTIVITY"), "School A activity remains visible");
        assert(!bodyText(admin).includes("DUAL B ACTIVITY SECRET"), "School B activity not exposed in dashboard feed");
        const feed = await call("activity-logs", { token: tokens["admin-a"] });
        assert(bodyText(feed).includes("DUAL A ACTIVITY"), "School A activity feed includes own activity");
        assert(!bodyText(feed).includes("DUAL B ACTIVITY SECRET"), "activity endpoint excludes the same actor's School B event");
        const stats = await call("dashboard/stats", { token: tokens["admin-a"] });
        assertEq(stats.status, 200, "admin stats");
        assertEq(stats.json.data.teachers, 3, "all three teacher identities with School A memberships are counted");
      } finally {
        await q(`DELETE FROM resources WHERE title LIKE 'Dual % Resource'`);
        await q(`DELETE FROM announcements WHERE title LIKE 'Dual % Announcement' OR title='DUAL-B-ANNOUNCEMENT-SECRET'`);
        await q(`DELETE FROM activity_logs WHERE description LIKE 'DUAL % ACTIVITY%'`);
      }
    });

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
      assertEq(result.json.data.rawStats.teachers, 3, "only School A member teachers are counted, including shared identities");
      assertEq(result.json.data.rawStats.learners, 3, "only School A member learners are counted, including shared identities");
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

    await test("Tenant roles: directory and dashboards use per-school membership roles, not global users.role", async () => {
      const beforeAdmin = await call("dashboard/admin", { token: tokens["admin-a"] });
      const beforeStatsA = await call("dashboard/stats", { token: tokens["admin-a"] });
      const beforeStatsB = await call("dashboard/stats", { token: tokens["admin-b"] });
      const shared = (await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
         VALUES ($1,$2,$3,'teacher','Split','Role',true) RETURNING id`,
        [`split-role-${DB_NAME}@example.test`, `split-${DB_NAME.slice(-8)}`, passwordHash]
      )).id as string;
      try {
        await q(`INSERT INTO school_users (school_id,user_id,role,status) VALUES ($1,$2,'parent','active'),($3,$2,'learner','active')`, [schoolA, shared, schoolB]);
        const parentDirectory = await call("users", { token: tokens["admin-a"], query: { role: "parent" } });
        const splitParent = parentDirectory.json.data.users.find((item: any) => item.id === shared);
        assert(splitParent, "School A directory includes the identity under its parent membership role");
        assertEq(splitParent.role, "parent", "directory role is the selected school's membership role");
        const teacherDirectory = await call("users", { token: tokens["admin-a"], query: { role: "teacher" } });
        assert(!bodyText(teacherDirectory).includes(shared), "global teacher role cannot override School A's parent role");

        const afterAdmin = await call("dashboard/admin", { token: tokens["admin-a"] });
        const afterStatsA = await call("dashboard/stats", { token: tokens["admin-a"] });
        const afterStatsB = await call("dashboard/stats", { token: tokens["admin-b"] });
        assertEq(afterAdmin.json.data.rawStats.parents, beforeAdmin.json.data.rawStats.parents + 1, "admin dashboard counts School A parent membership");
        assertEq(afterStatsA.json.data.parents, beforeStatsA.json.data.parents + 1, "stats dashboard counts School A parent membership");
        assertEq(afterStatsB.json.data.learners, beforeStatsB.json.data.learners + 1, "School B counts the same identity as a learner");
      } finally {
        await q(`DELETE FROM users WHERE id=$1`, [shared]);
      }
    });

    await test("Users: school administration changes only its membership role, not shared identity", async () => {
      const globalBefore = await one(`SELECT role, first_name, is_active FROM users WHERE id=$1`, [dualTeacher.id]);
      const a = await call("users/[id]", { token: tokens["admin-a"], method: "PUT", params: { id: dualTeacher.id }, body: { role: "head_teacher" } });
      assertEq(a.status, 200, "same-school membership role update allowed");
      const memberships = await q(`SELECT school_id,role FROM school_users WHERE user_id=$1 ORDER BY school_id`, [dualTeacher.id]);
      assertEq(memberships.find((m: any) => m.school_id === schoolA)?.role, "head_teacher", "School A membership role updated");
      assertEq(memberships.find((m: any) => m.school_id === schoolB)?.role, "teacher", "School B role preserved");
      const globalAfter = await one(`SELECT role, first_name, is_active FROM users WHERE id=$1`, [dualTeacher.id]);
      assertEq(globalAfter.role, globalBefore.role, "global role is unchanged");
      assertEq(globalAfter.first_name, globalBefore.first_name, "global profile is unchanged");
      assertEq(globalAfter.is_active, globalBefore.is_active, "global active status is unchanged");
      const profile = await call("users/[id]", { token: tokens["admin-a"], method: "PUT", params: { id: dualTeacher.id }, body: { firstName: "Unauthorized" } });
      assertEq(profile.status, 403, "school admin cannot edit globally shared profile");
      const deactivate = await call("users/[id]", { token: tokens["admin-a"], method: "PUT", params: { id: dualTeacher.id }, body: { isActive: false } });
      assertEq(deactivate.status, 403, "school admin cannot deactivate shared identity");
      const foreignPassword = await call("users/[id]", { token: tokens["admin-a"], method: "PATCH", params: { id: ids["teacher-b"] }, body: { password: "NewPass123" } });
      assertEq(foreignPassword.status, 404, "school admin cannot target another school's account");
      const sharedPassword = await call("users/[id]", { token: tokens["admin-a"], method: "PATCH", params: { id: dualTeacher.id }, body: { password: "NewPass123" } });
      assertEq(sharedPassword.status, 403, "school admin cannot reset a shared identity's global password");
      const stillActive = await one(`SELECT is_active FROM users WHERE id=$1`, [dualTeacher.id]);
      assertEq(stillActive.is_active, true, "identity remains active");

      const platformProfile = await call("users/[id]", { token: tokens["platform"], method: "PUT", params: { id: ids["teacher-b"] }, body: { firstName: "Platform Managed" } });
      assertEq(platformProfile.status, 200, "platform administrator retains global profile administration");
      const platformPassword = await call("users/[id]", { token: tokens["platform"], method: "PATCH", params: { id: ids["teacher-b"] }, body: { password: "PlatformPass123" } });
      assertEq(platformPassword.status, 200, "platform administrator retains global password administration");
      const changed = await one(`SELECT password_hash, first_name FROM users WHERE id=$1`, [ids["teacher-b"]]);
      assertEq(changed.first_name, "Platform Managed", "platform profile update is persisted");
      assert(await bcrypt.compare("PlatformPass123", changed.password_hash), "platform password reset is persisted");
    });

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
        body: { learnerId: ids["learner-a2"], classId: classA, academicYearId: yearA },
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

    await test("Fail closed: direct school_id keeps a class attributable even with a dual-membership learner", async () => {
      /* Phase 2D/0017: classes carry a NOT NULL school_id, so a class is attributed by its
         OWN school_id rather than by which schools can "reach" it through memberships. A
         dual-membership learner enrolling in School A's class therefore no longer makes the
         class belong to neither school: School A keeps it (direct school_id) and School B is
         still denied. The relational "reachable from two schools → deny both" rule still
         applies to routes that attribute via membership (e.g. files), asserted below. */
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
      const dualMembershipA = await one(`SELECT id FROM school_users WHERE school_id=$1 AND user_id=$2`, [schoolA, dual]);
      const dualToken = await auth.createToken({
        userId: dual, role: "learner", email: "dual@example.test",
        schoolId: schoolA, membershipId: dualMembershipA.id,
      });
      const unselectedDualToken = await auth.createToken({ userId: dual, role: "learner", email: "dual@example.test" });
      await q(`INSERT INTO learner_classes (school_id, learner_id, class_id, academic_year_id) VALUES ($1,$2,$3,$4)`, [
        schoolA,
        dual,
        classA,
        yearA,
      ]);

      try {
        /* Direct school_id is authoritative: the class remains School A's. */
        const ownSchool = await call("attendance", { token: tokens["admin-a"], query: { classId: classA } });
        assertEq(ownSchool.status, 200, "School A still owns its class via direct school_id");
        const foreignSchool = await call("attendance", { token: tokens["admin-b"], query: { classId: classA } });
        assertEq(foreignSchool.status, 404, "School B must still be denied the class");

        /* A file that is reachable from School A (its assignment) and from School B (its
           uploader) is still unattributable under the relational file predicate. */
        const dualFile = (
          await one(
            `INSERT INTO uploaded_files (school_id, uploader_id, purpose, assignment_id, original_name, stored_name, mime_type, category, size_bytes)
             VALUES ($1, $2, 'assignment', $3, 'dual.pdf', 'stored-dual.pdf', 'application/pdf', 'document', 5) RETURNING id`,
            [schoolA, dual, assignA]
          )
        ).id as string;
        fs.writeFileSync(path.join(UPLOAD_DIR, "stored-dual.pdf"), "%PDF-1.4 dual");
        for (const token of [tokens["admin-a"], tokens["admin-b"]]) {
          const result = await call("files/[id]", { token, params: { id: dualFile } });
          assertEq(result.status, 404, "a file two schools can reach must be denied to both");
        }

        /* The dual member must choose; only the signed, selected school token carries context. */
        const noSelection = await call("attendance", { token: unselectedDualToken, query: { learnerId: dual } });
        assertEq(noSelection.status, 403, "unselected dual-member context is denied");
        const self = await call("attendance", { token: dualToken, query: { learnerId: dual } });
        assertEq(self.status, 200, "the learner may still read their own attendance");
      } finally {
        await q(`DELETE FROM learner_classes WHERE learner_id = $1 AND class_id = $2`, [dual, classA]);
        await q(`DELETE FROM uploaded_files WHERE uploader_id = $1`, [dual]);
        fs.rmSync(path.join(UPLOAD_DIR, "stored-dual.pdf"), { force: true });
      }

      /* The class resolves to School A regardless of the dual enrollment. */
      const restored = await call("attendance", { token: tokens["admin-a"], query: { classId: classA } });
      assertEq(restored.status, 200, "School A's class attribution is unchanged");
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
          subjectId: subjectA,
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
          `INSERT INTO quizzes (school_id, title, class_id, subject_id, teacher_id, is_published)
           VALUES ($1, 'Review Quiz A', $2, $3, $4, false) RETURNING id`,
          [schoolA, classA, subjectA, ids["teacher-a"]]
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
             (school_id, card_key, dashboard_role, label, is_visible, is_enabled, scope_type, created_by)
           VALUES ($1, 'phase2c_own_card', 'learner', 'OWN-SCHOOL-CARD', true, true, 'role', $2)
           RETURNING id`,
          [schoolA, ids["admin-a"]]
        )
      ).id as string;
      const foreignOverride = (
        await one(
          `INSERT INTO dashboard_card_overrides
             (school_id, card_key, dashboard_role, label, is_visible, is_enabled, scope_type, created_by)
           VALUES ($1, 'phase2c_foreign_card', 'learner', 'FOREIGN-SCHOOL-CARD', true, true, 'role', $2)
           RETURNING id`,
          [schoolB, ids["admin-b"]]
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
