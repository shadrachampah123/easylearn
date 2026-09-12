/**
 * Phase 2B — User membership + authentication context: LIVE DATABASE tests.
 *
 * Applies the project's real migration chain (0000…0015) to a throwaway PostgreSQL
 * database and then exercises the real application modules against it:
 *
 *   MEMBERSHIP
 *     1.  the CBISM school exists exactly once (and stays that way across re-runs)
 *     2.  every existing application user receives a CBISM membership
 *     3.  memberships preserve each user's role verbatim
 *     4.  the migration is idempotent (re-runs create nothing, churn nothing)
 *     5.  a duplicate (school, user) membership is impossible
 *     6.  a user can still belong to multiple schools
 *     7.  a disabled membership does not count as an active membership
 *     8.  super_admin (platform role) never becomes a school membership
 *
 *   AUTHENTICATION
 *     9.  a valid user resolves to their own active school membership
 *     10. a user without an active membership is rejected from school context
 *     11. a client-supplied arbitrary school_id cannot override server-side membership
 *     12. role escalation through school-id manipulation is impossible
 *     13. login / me / change-password / logout still work, for every role
 *     14. pre-Phase-2B tokens keep working (no lockout) and claims are not authoritative
 *
 *   MULTI-SCHOOL SAFETY
 *     15. User A → School A, User A → School B, User B → School A: resolving User A can
 *         never return User B's membership
 *
 * Database providers (first match wins), same approach as tests/tenant-db.test.js:
 *   - TEST_DATABASE_URL  → any PostgreSQL you point at (a scratch db is created and dropped)
 *   - embedded-postgres  → throwaway server on a random port (`npm i --no-save embedded-postgres`)
 *   - otherwise the suite SKIPS (exit 0) so CI without a database still passes
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

const DB_NAME = `easylearn_2b_test_${crypto.randomBytes(4).toString("hex")}`;
const TEST_PASSWORD = "Phase2b-Test-Password!";
const NEW_PASSWORD = "Phase2b-Rotated-Password!";
const JWT_SECRET = "phase-2b-integration-test-secret-0123456789";

let passed = 0;
let failed = 0;
let skipped = 0;

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
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run `npm run test:membership`.");
      skipped++;
      return;
    }
    const port = 54429 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
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
    try {
      const url = new URL(adminUrl as string);
      url.pathname = `/${DB_NAME}`;
      return url.toString();
    } catch {
      return `${(adminUrl as string).replace(/\/$/, "")}/${DB_NAME}`;
    }
  })();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const db = new Client({ connectionString: scratchUrl });

  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
    await db.connect();

    /* The application modules must see the scratch database. Set BEFORE the first
       `@/db` import (the pool is created at import time). */
    process.env.DATABASE_URL = scratchUrl;
    process.env.JWT_SECRET = JWT_SECRET;

    const runMigrations = () =>
      spawnSync(process.execPath, ["run-migration.js"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: scratchUrl, JWT_SECRET },
        encoding: "utf8",
      });

    const q = async (sql: string, values: unknown[] = []): Promise<any[]> =>
      (await db.query(sql, values)).rows;
    const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

    /* ── 1. Fresh migration chain ── */

    await test("Migration: fresh chain (0000…0015) applies cleanly", () => {
      const result = runMigrations();
      assertEq(
        result.status,
        0,
        `run-migration.js exited ${result.status}:\n${((result.stdout || "") + (result.stderr || "")).slice(-6000)}`
      );
      assert(String(result.stdout).includes("🎉 Migration complete"), "runner did not report completion");
      assert(/cbism schools=1/.test(String(result.stdout)), "runner must verify exactly one cbism school");
    });

    await test("Membership: the CBISM school exists exactly once", async () => {
      const row = await one(
        `SELECT count(*)::int AS n, min(slug) AS slug, min(name) AS name, min(status) AS status
           FROM schools WHERE slug = 'cbism'`
      );
      assertEq(row.n, 1, "cbism school count");
      assertEq(row.name, "City Best International School Montessori", "canonical CBISM name");
      assertEq(row.status, "active", "cbism status");
    });

    await test("Membership: no memberships exist before any user does", async () => {
      assertEq((await one(`SELECT count(*)::int AS n FROM school_users`)).n, 0, "school_users must be empty");
    });

    /* ── Fixture users, created BEFORE the backfill (this is the production situation) ── */

    const passwordHash: string = await bcrypt.hash(TEST_PASSWORD, 4);
    const fixtureUsers: { key: string; role: string; active: boolean; mustChange?: boolean }[] = [
      { key: "learner", role: "learner", active: true },
      { key: "teacher", role: "teacher", active: true },
      { key: "head", role: "head_teacher", active: true },
      { key: "admin", role: "school_admin", active: true },
      { key: "parent", role: "parent", active: true },
      { key: "platform", role: "super_admin", active: true },
      { key: "disabled-teacher", role: "teacher", active: false },
      { key: "must-change", role: "learner", active: true, mustChange: true },
    ];
    const userIds: Record<string, string> = {};

    for (const fixture of fixtureUsers) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active, must_change_password)
         VALUES ($1, $2, $3, $4, 'Phase2B', $5, $6, $7) RETURNING id`,
        [
          `2b-${fixture.key}-${DB_NAME}@example.test`,
          `2b-${fixture.key}-${DB_NAME.slice(-8)}`,
          passwordHash,
          fixture.role,
          fixture.key,
          fixture.active,
          Boolean(fixture.mustChange),
        ]
      );
      userIds[fixture.key] = row.id;
    }

    /* ── 2./3. Backfill on the next deploy (run-migration.js replays the whole chain) ── */

    await test("Migration: re-running the chain backfills CBISM memberships for existing users", () => {
      const result = runMigrations();
      assertEq(
        result.status,
        0,
        `second run exited ${result.status}:\n${((result.stdout || "") + (result.stderr || "")).slice(-6000)}`
      );
      assert(/0015: cbism school .+ - 7 eligible users, 7 memberships/.test(String(result.stdout)),
        "0015 must report 7 eligible users / 7 memberships");
    });

    await test("Membership: every non-super_admin user received a membership", async () => {
      const rows = await q(
        `SELECT u.email, u.role AS user_role, u.is_active, su.role AS membership_role, su.status
           FROM users u LEFT JOIN school_users su ON su.user_id = u.id
          ORDER BY u.email`
      );
      assertEq(rows.length, fixtureUsers.length, "fixture user count");
      for (const row of rows) {
        if (row.user_role === "super_admin") {
          assertEq(row.membership_role, null, `${row.email} (super_admin) must have NO membership`);
          continue;
        }
        assert(row.membership_role, `${row.email} must have a membership`);
        assertEq(row.membership_role, row.user_role, `${row.email} membership role must match users.role`);
      }
    });

    await test("Membership: role is preserved verbatim for every role type", async () => {
      for (const key of ["learner", "teacher", "head", "admin", "parent"]) {
        const row = await one(
          `SELECT su.role FROM school_users su WHERE su.user_id = $1`,
          [userIds[key]]
        );
        const expected = fixtureUsers.find((f) => f.key === key)!.role;
        assertEq(row.role, expected, `${key} membership role`);
      }
    });

    await test("Membership: a deactivated user gets a 'disabled' membership and is not modified", async () => {
      const row = await one(
        `SELECT u.is_active, su.status FROM users u JOIN school_users su ON su.user_id = u.id
          WHERE u.id = $1`,
        [userIds["disabled-teacher"]]
      );
      assertEq(row.status, "disabled", "deactivated user's membership status");
      assertEq(row.is_active, false, "users.is_active must not be changed by the migration");
    });

    await test("Membership: passwords, usernames and must_change_password are untouched", async () => {
      const row = await one(
        `SELECT password_hash, must_change_password FROM users WHERE id = $1`,
        [userIds["must-change"]]
      );
      assertEq(row.password_hash, passwordHash, "password hash must be unchanged");
      assertEq(row.must_change_password, true, "must_change_password must be unchanged");
    });

    await test("Membership: super_admin (platform role) is excluded from memberships", async () => {
      const row = await one(`SELECT count(*)::int AS n FROM school_users WHERE role = 'super_admin'`);
      assertEq(row.n, 0, "no super_admin membership rows may exist");
    });

    /* ── 4. Idempotency ── */

    const membershipIdsBefore = await q(`SELECT id FROM school_users ORDER BY id`);

    await test("Migration: a third full run exits 0 and creates nothing new", async () => {
      const result = runMigrations();
      assertEq(
        result.status,
        0,
        `third run exited ${result.status}:\n${((result.stdout || "") + (result.stderr || "")).slice(-6000)}`
      );
      const after = await q(`SELECT id FROM school_users ORDER BY id`);
      assertEq(after.length, membershipIdsBefore.length, "membership count must not grow");
      assertEq(
        after.map((r) => r.id).join(","),
        membershipIdsBefore.map((r) => r.id).join(","),
        "membership ids must be stable (no delete/re-insert churn)"
      );
      assertEq((await one(`SELECT count(*)::int AS n FROM schools WHERE slug = 'cbism'`)).n, 1, "still one CBISM school");
    });

    await test("Migration: an administrator-edited membership role survives later deploys", async () => {
      // Backfill is a backfill, not a synchroniser: ON CONFLICT DO NOTHING must not
      // overwrite a role that was changed after the first run.
      await q(`UPDATE school_users SET role = 'head_teacher' WHERE user_id = $1`, [userIds["teacher"]]);
      const result = runMigrations();
      assertEq(result.status, 0, `run exited ${result.status}`);
      const row = await one(`SELECT role FROM school_users WHERE user_id = $1`, [userIds["teacher"]]);
      assertEq(row.role, "head_teacher", "existing membership must not be overwritten by a re-run");
      await q(`UPDATE school_users SET role = 'teacher' WHERE user_id = $1`, [userIds["teacher"]]);
    });

    /* ── 5./6. Constraints ── */

    await test("Membership: a duplicate (school, user) row is impossible (23505)", async () => {
      const cbismId = (await one(`SELECT id FROM schools WHERE slug = 'cbism'`)).id;
      try {
        await db.query(
          `INSERT INTO school_users (school_id, user_id, role) VALUES ($1, $2, 'teacher')`,
          [cbismId, userIds["teacher"]]
        );
      } catch (error: any) {
        assertEq(error.code, "23505", "wrong error code for duplicate membership");
        return;
      }
      throw new Error("duplicate membership insert unexpectedly succeeded");
    });

    let schoolBId = "";

    await test("Multi-school: a user can belong to a second school", async () => {
      schoolBId = (
        await one(
          `INSERT INTO schools (name, short_name, slug) VALUES ('School B', 'SB', 'school-b') RETURNING id`
        )
      ).id;
      await q(
        `INSERT INTO school_users (school_id, user_id, role) VALUES ($1, $2, 'school_admin')`,
        [schoolBId, userIds["teacher"]]
      );
      const row = await one(`SELECT count(*)::int AS n FROM school_users WHERE user_id = $1`, [userIds["teacher"]]);
      assertEq(row.n, 2, "user must hold memberships in two schools");
    });

    await test("Multi-school: the Phase 2A single-school guard is still gone", async () => {
      const row = await one(
        `SELECT i.indisunique FROM pg_indexes x
           JOIN pg_class c ON c.relname = x.indexname
           JOIN pg_index i ON i.indexrelid = c.oid
          WHERE x.indexname = 'school_users_one_school_per_user'`
      );
      assertEq(row.indisunique, false, "the placeholder index must remain NON-unique");
    });

    /* ── 7./8./9./10. Real membership resolution (src/lib/tenant.ts) ── */

    const tenant = await import("@/lib/tenant");
    const auth = await import("@/lib/auth");
    const cbismSchoolId = (await one(`SELECT id FROM schools WHERE slug = 'cbism'`)).id;

    await test("Resolve: an active user resolves to their own CBISM membership", async () => {
      const membership = await tenant.resolveSchoolMembership(userIds["learner"]);
      assert(membership, "membership must resolve");
      assertEq(membership!.schoolId, cbismSchoolId, "resolved school");
      assertEq(membership!.userId, userIds["learner"], "resolved membership must belong to that user");
      assertEq(membership!.role, "learner", "resolved role");
      assertEq(membership!.status, "active", "resolved status");
      assertEq(membership!.schoolSlug, "cbism", "resolved slug");
    });

    await test("Resolve: role is preserved through resolution for each role type", async () => {
      const expected: Record<string, string> = {
        learner: "learner",
        teacher: "teacher",
        head: "head_teacher",
        admin: "school_admin",
        parent: "parent",
      };
      for (const [key, role] of Object.entries(expected)) {
        assertEq(await tenant.getEffectiveSchoolRole(userIds[key]), role, `${key} effective school role`);
      }
    });

    await test("Resolve: a disabled membership is NOT an active membership", async () => {
      assertEq(await tenant.resolveSchoolMembership(userIds["disabled-teacher"]), null, "must not resolve");
      assertEq(await tenant.getEffectiveSchoolRole(userIds["disabled-teacher"]), null, "no effective role");
      await assert.rejects(
        () => tenant.requireActiveSchoolMembership(userIds["disabled-teacher"]),
        (error: any) => error instanceof tenant.AuthContextError && error.status === 403,
        "requireActiveSchoolMembership must reject with 403"
      );
    });

    await test("Resolve: an 'invited' membership is NOT an active membership", async () => {
      await q(`UPDATE school_users SET status = 'invited' WHERE user_id = $1`, [userIds["parent"]]);
      assertEq(await tenant.resolveSchoolMembership(userIds["parent"]), null, "invited must not resolve");
      await q(`UPDATE school_users SET status = 'active' WHERE user_id = $1`, [userIds["parent"]]);
      assert(await tenant.resolveSchoolMembership(userIds["parent"]), "restored membership must resolve");
    });

    await test("Resolve: super_admin gets no school membership and no school-wide access", async () => {
      assertEq(tenant.isPlatformRole("super_admin"), true, "super_admin is the platform role");
      assertEq(tenant.toSchoolRole("super_admin"), null, "super_admin is not a school role");
      assertEq(tenant.toSchoolRole("school_admin"), "school_admin", "school_admin is a school role");
      assertEq(await tenant.resolveSchoolMembership(userIds["platform"]), null, "no membership");
      assertEq(await tenant.getEffectiveSchoolRole(userIds["platform"]), null, "no school role");
      await assert.rejects(
        () => tenant.requireActiveSchoolMembership(userIds["platform"]),
        (error: any) => error instanceof tenant.AuthContextError && error.status === 403
      );
    });

    await test("Resolve: a platform role written straight into school_users is still ignored", async () => {
      // Defence in depth: even if such a row existed, the helpers must not treat a platform
      // role as a school membership (and the migration never creates one).
      await q(
        `INSERT INTO school_users (school_id, user_id, role) VALUES ($1, $2, 'super_admin')`,
        [cbismSchoolId, userIds["platform"]]
      );
      assertEq(await tenant.resolveSchoolMembership(userIds["platform"]), null, "must stay unresolved");
      const withInactive = await tenant.listSchoolMemberships(userIds["platform"], { includeInactive: true });
      assertEq(withInactive.length, 0, "platform role rows must be filtered out");
      await q(`DELETE FROM school_users WHERE user_id = $1`, [userIds["platform"]]);
    });

    /* ── 11./12. Client-supplied school ids cannot widen anything ── */

    await test("Security: an arbitrary school_id cannot override server-side membership", async () => {
      // The learner is a member of CBISM only. A forged school id must resolve to nothing,
      // never to somebody else's membership in that school.
      const forged = crypto.randomUUID();
      assertEq(await tenant.resolveSchoolMembership(userIds["learner"], { schoolId: forged }), null, "unknown uuid");
      assertEq(await tenant.resolveSchoolMembership(userIds["learner"], { schoolId: schoolBId }), null, "not a member");
      assertEq(await tenant.resolveSchoolMembership(userIds["learner"], { schoolId: "cbism" }), null, "slug is not an id");
      assertEq(await tenant.resolveSchoolMembership(userIds["learner"], { schoolId: "" }), null, "empty id");
      assertEq(
        await tenant.resolveSchoolMembership(userIds["learner"], { schoolId: cbismSchoolId.toUpperCase() }),
        null,
        "case-mangled uuid must not match"
      );
      // ...while the user's own school still resolves normally.
      const own = await tenant.resolveSchoolMembership(userIds["learner"], { schoolId: cbismSchoolId });
      assert(own && own.userId === userIds["learner"], "own membership still resolves");
    });

    await test("Security: role escalation through school-id manipulation is impossible", async () => {
      // The learner stays a learner no matter which school id is offered, and cannot pick
      // up the school_admin membership that the SAME person holds in School B.
      const learner = await tenant.listActiveSchoolMemberships(userIds["learner"]);
      assertEq(learner.length, 1, "learner has exactly one membership");
      assertEq(learner[0].role, "learner", "learner role");
      const teacherInB = await tenant.resolveSchoolMembership(userIds["teacher"], { schoolId: schoolBId });
      assertEq(teacherInB?.role, "school_admin", "teacher is school_admin in School B");
      const teacherInCbism = await tenant.resolveSchoolMembership(userIds["teacher"], { schoolId: cbismSchoolId });
      assertEq(teacherInCbism?.role, "teacher", "…and only a teacher in CBISM");
      assertEq(
        await tenant.getEffectiveSchoolRole(userIds["learner"], { schoolId: schoolBId }),
        null,
        "no role in a school the learner does not belong to"
      );
    });

    /* ── 15. Multi-school safety: User A → A & B, User B → A ── */

    await test("Multi-school: resolving one user never returns another user's membership", async () => {
      // userA = 'teacher' fixture (School A/CBISM + School B), userB = 'learner' fixture (School A).
      const userA = userIds["teacher"];
      const userB = userIds["learner"];

      const aMemberships = await tenant.listActiveSchoolMemberships(userA);
      assertEq(aMemberships.length, 2, "User A has two memberships");
      for (const membership of aMemberships) {
        assertEq(membership.userId, userA, "every resolved membership must belong to User A");
      }
      const bMemberships = await tenant.listActiveSchoolMemberships(userB);
      assertEq(bMemberships.length, 1, "User B has one membership");
      assertEq(bMemberships[0].userId, userB, "User B's membership belongs to User B");

      // Narrowing by school can only pick among the caller's own rows.
      assertEq((await tenant.resolveSchoolMembership(userA, { schoolId: schoolBId }))?.userId, userA, "A in B");
      assertEq((await tenant.resolveSchoolMembership(userA, { schoolId: cbismSchoolId }))?.userId, userA, "A in A");
      assertEq(await tenant.resolveSchoolMembership(userB, { schoolId: schoolBId }), null, "B is not in School B");
      assert(
        !aMemberships.some((m) => m.membershipId === bMemberships[0].membershipId),
        "membership ids must not be shared between users"
      );
    });

    /* ── 13. Authentication flows through the REAL route handlers ── */

    const loginRoute = await import("@/app/api/auth/login/route");
    const meRoute = await import("@/app/api/auth/me/route");
    const changePasswordRoute = await import("@/app/api/auth/change-password/route");
    const logoutRoute = await import("@/app/api/auth/logout/route");

    const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      new NextRequest(`http://localhost:3000${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    let learnerToken = "";
    let learnerMembershipId = "";

    await test("Login: a learner logs in and receives the server-derived CBISM context", async () => {
      const response = await loginRoute.POST(
        postJson("/api/auth/login", {
          email: `2b-learner-${DB_NAME}@example.test`,
          password: TEST_PASSWORD,
        }) as never
      );
      assertEq(response.status, 200, "login status");
      const body: any = await response.json();
      assertEq(body.success, true, "login success");
      assertEq(body.data.user.role, "learner", "user role in response");
      assertEq(body.data.school.slug, "cbism", "resolved school slug");
      assertEq(body.data.school.role, "learner", "membership role in response");
      assertEq(body.data.school.schoolId, cbismSchoolId, "resolved school id");
      assertEq(body.data.schools.length, 1, "one membership listed");
      assert(body.data.token, "token issued");
      learnerToken = body.data.token;
      learnerMembershipId = body.data.school.membershipId;

      const claims = await auth.verifyToken(learnerToken);
      assert(claims, "token verifies");
      assertEq(claims!.ver, auth.TOKEN_SCHEMA_VERSION, "token schema version");
      assertEq(claims!.role, "learner", "role claim");
      assertEq(claims!.schoolIdHint, cbismSchoolId, "school claim (hint)");
      assertEq(claims!.membershipIdHint, learnerMembershipId, "membership claim (hint)");
    });

    await test("Login: a client-supplied schoolId/role in the body is ignored", async () => {
      const response = await loginRoute.POST(
        postJson("/api/auth/login", {
          email: `2b-learner-${DB_NAME}@example.test`,
          password: TEST_PASSWORD,
          schoolId: schoolBId,
          school_id: schoolBId,
          school: { schoolId: schoolBId },
          membershipId: crypto.randomUUID(),
          role: "super_admin",
          isAdmin: true,
        }) as never
      );
      assertEq(response.status, 200, "login status");
      const body: any = await response.json();
      assertEq(body.data.user.role, "learner", "role cannot be set by the client");
      assertEq(body.data.school.schoolId, cbismSchoolId, "school cannot be chosen by the client");
      assertEq(body.data.school.membershipId, learnerMembershipId, "membership cannot be chosen by the client");
      assertEq(body.data.schools.length, 1, "no extra memberships appear");
      const claims = await auth.verifyToken(body.data.token);
      assertEq(claims!.schoolIdHint, cbismSchoolId, "token school claim is server-derived");
      assertEq(claims!.role, "learner", "token role claim is server-derived");
    });

    await test("Login: username login still works and resolves the same context", async () => {
      const response = await loginRoute.POST(
        postJson("/api/auth/login", {
          username: `2b-teacher-${DB_NAME.slice(-8)}`,
          password: TEST_PASSWORD,
        }) as never
      );
      assertEq(response.status, 200, "username login status");
      const body: any = await response.json();
      assertEq(body.data.user.role, "teacher", "teacher role");
      assertEq(body.data.schools.length, 2, "teacher belongs to two schools");
      assertEq(body.data.school.schoolId, cbismSchoolId, "deterministic first membership is CBISM");
    });

    await test("Login: every role can authenticate (admin, head teacher, teacher, parent, learner)", async () => {
      for (const key of ["admin", "head", "teacher", "parent", "learner"]) {
        const response = await loginRoute.POST(
          postJson("/api/auth/login", {
            email: `2b-${key}-${DB_NAME}@example.test`,
            password: TEST_PASSWORD,
          }) as never
        );
        assertEq(response.status, 200, `${key} login status`);
        const body: any = await response.json();
        assert(body.data.token, `${key} token issued`);
        assertEq(body.data.school.slug, "cbism", `${key} school context`);
      }
    });

    await test("Login: super_admin logs in with no school context (platform account)", async () => {
      const response = await loginRoute.POST(
        postJson("/api/auth/login", {
          email: `2b-platform-${DB_NAME}@example.test`,
          password: TEST_PASSWORD,
        }) as never
      );
      assertEq(response.status, 200, "super_admin must NOT be locked out");
      const body: any = await response.json();
      assertEq(body.data.user.role, "super_admin", "role");
      assertEq(body.data.school, null, "no school context for a platform account");
      assertEq(body.data.schools.length, 0, "no memberships");
      const claims = await auth.verifyToken(body.data.token);
      assertEq(claims!.schoolIdHint, undefined, "no school claim");
      assertEq(claims!.membershipIdHint, undefined, "no membership claim");
    });

    await test("Login: a deactivated account is rejected and gets no token", async () => {
      const response = await loginRoute.POST(
        postJson("/api/auth/login", {
          email: `2b-disabled-teacher-${DB_NAME}@example.test`,
          password: TEST_PASSWORD,
        }) as never
      );
      assertEq(response.status, 403, "deactivated account status");
      const body: any = await response.json();
      assertEq(body.success, false, "login refused");
      assert(!body.data, "no session data");
    });

    await test("Login: a wrong password is rejected (401) and issues nothing", async () => {
      const response = await loginRoute.POST(
        postJson("/api/auth/login", {
          email: `2b-must-change-${DB_NAME}@example.test`,
          password: "definitely-the-wrong-password",
        }) as never
      );
      assertEq(response.status, 401, "wrong password status");
      const body: any = await response.json();
      assert(!body.data?.token, "no token issued");
    });

    await test("Login: rate limiting is still enforced (429 after repeated failures)", async () => {
      const email = `2b-ratelimit-${DB_NAME}@example.test`;
      await q(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES ($1, $2, 'learner', 'Phase2B', 'ratelimit')`,
        [email, passwordHash]
      );
      let lastStatus = 0;
      for (let attempt = 0; attempt < 7; attempt++) {
        const response = await loginRoute.POST(
          postJson("/api/auth/login", { email, password: "wrong-password" }) as never
        );
        lastStatus = response.status;
      }
      assertEq(lastStatus, 429, "expected the login rate limiter to engage");
    });

    await test("Session: /api/auth/me returns the DB-derived school context", async () => {
      const request = new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer(learnerToken) });
      const response = await meRoute.GET(request as never);
      assertEq(response.status, 200, "me status");
      const body: any = await response.json();
      assertEq(body.data.user.id, userIds["learner"], "user id");
      assertEq(body.data.user.role, "learner", "user role (unchanged shape)");
      assertEq(body.data.user.passwordHash, undefined, "password hash must never be returned");
      assertEq(body.data.school.schoolId, cbismSchoolId, "school context");
      assertEq(body.data.school.membershipId, learnerMembershipId, "membership id");
    });

    await test("Session: /api/auth/me rejects a missing, garbage or tampered token", async () => {
      const noToken = await meRoute.GET(new NextRequest("http://localhost:3000/api/auth/me") as never);
      assertEq(noToken.status, 401, "missing token");
      const garbage = await meRoute.GET(
        new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer("not.a.token") }) as never
      );
      assertEq(garbage.status, 401, "garbage token");
      const tampered = await meRoute.GET(
        new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer(`${learnerToken}x`) }) as never
      );
      assertEq(tampered.status, 401, "tampered token");
    });

    await test("Session: a pre-Phase-2B token (no ver/school claims) still authenticates", async () => {
      // Simulate a token minted by the previous release: same secret, no new claims.
      const { SignJWT } = await import("jose");
      const legacyToken = await new SignJWT({
        userId: userIds["learner"],
        email: `2b-learner-${DB_NAME}@example.test`,
        role: "learner",
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime("24h")
        .sign(new TextEncoder().encode(JWT_SECRET));

      const claims = await auth.verifyToken(legacyToken);
      assert(claims, "legacy token still verifies");
      assertEq(claims!.ver, auth.LEGACY_TOKEN_SCHEMA_VERSION, "missing ver reads as 1");
      assertEq(claims!.schoolIdHint, undefined, "no school hint");

      const response = await meRoute.GET(
        new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer(legacyToken) }) as never
      );
      assertEq(response.status, 200, "no lockout for existing sessions");
      const body: any = await response.json();
      assertEq(body.data.school.schoolId, cbismSchoolId, "context still resolved from the database");
    });

    await test("Session: token claims are not authoritative — the database is", async () => {
      // Mint a token, then change the membership role behind its back. The context must
      // follow the database, not the (now stale) claim.
      const before = await auth.verifyToken(learnerToken);
      assertEq(before!.role, "learner", "claim before");
      await q(`UPDATE school_users SET role = 'teacher' WHERE id = $1`, [learnerMembershipId]);

      const request = new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer(learnerToken) });
      const context = await tenant.resolveAuthContext(request as never);
      assertEq(context.tokenRole, "learner", "the stale claim is preserved for diagnostics");
      assertEq(context.school?.role, "teacher", "membership role comes from the database");

      await q(`UPDATE school_users SET role = 'learner' WHERE id = $1`, [learnerMembershipId]);
      const restored = await tenant.resolveAuthContext(
        new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer(learnerToken) }) as never
      );
      assertEq(restored.school?.role, "learner", "role restored");
    });

    await test("Context: requireSchoolContext rejects a user whose membership was disabled", async () => {
      const request = new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer(learnerToken) });
      const ok = await tenant.requireSchoolContext(request as never);
      assertEq(ok.schoolId, cbismSchoolId, "resolved school id");
      assertEq(ok.membershipId, learnerMembershipId, "resolved membership id");

      await q(`UPDATE school_users SET status = 'disabled' WHERE id = $1`, [learnerMembershipId]);
      await assert.rejects(
        () => tenant.requireSchoolContext(request as never),
        (error: any) => error instanceof tenant.AuthContextError && error.status === 403,
        "disabled membership must be rejected"
      );
      await q(`UPDATE school_users SET status = 'active' WHERE id = $1`, [learnerMembershipId]);
      const again = await tenant.requireSchoolContext(request as never);
      assertEq(again.schoolId, cbismSchoolId, "re-enabled membership resolves again");
    });

    await test("Context: selectSchoolForContext rejects a school the user is not a member of", async () => {
      const request = new NextRequest("http://localhost:3000/api/auth/me", { headers: bearer(learnerToken) });
      const context = await tenant.resolveAuthContext(request as never);
      const selected = tenant.selectSchoolForContext(context, cbismSchoolId);
      assertEq(selected.schoolId, cbismSchoolId, "own school selectable");
      assert.throws(
        () => tenant.selectSchoolForContext(context, schoolBId),
        (error: any) => error instanceof tenant.AuthContextError && error.status === 403,
        "foreign school must be rejected"
      );
      assert.throws(
        () => tenant.selectSchoolForContext(context, crypto.randomUUID()),
        (error: any) => error instanceof tenant.AuthContextError,
        "unknown school must be rejected"
      );
    });

    await test("Password: change-password works and the new password authenticates", async () => {
      const email = `2b-must-change-${DB_NAME}@example.test`;
      const login = await loginRoute.POST(
        postJson("/api/auth/login", { email, password: TEST_PASSWORD }) as never
      );
      const token = (await login.json() as any).data.token;

      const rejected = await changePasswordRoute.POST(
        postJson("/api/auth/change-password", {
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
          userId: userIds["teacher"],
        }, bearer(token)) as never
      );
      assertEq(rejected.status, 403, "cross-user password change must stay forbidden");

      const wrongCurrent = await changePasswordRoute.POST(
        postJson("/api/auth/change-password", {
          currentPassword: "not-my-password",
          newPassword: NEW_PASSWORD,
        }, bearer(token)) as never
      );
      assertEq(wrongCurrent.status, 400, "wrong current password rejected");

      const ok = await changePasswordRoute.POST(
        postJson("/api/auth/change-password", {
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
        }, bearer(token)) as never
      );
      assertEq(ok.status, 200, "password change status");
      assertEq(((await ok.json()) as any).success, true, "password changed");
      assertEq(
        (await one(`SELECT must_change_password FROM users WHERE email = $1`, [email])).must_change_password,
        false,
        "must_change_password cleared"
      );

      const relogin = await loginRoute.POST(
        postJson("/api/auth/login", { email, password: NEW_PASSWORD }) as never
      );
      assertEq(relogin.status, 200, "login with the new password");
      assertEq(
        ((await relogin.json()) as any).data.school.slug,
        "cbism",
        "school context survives a password change"
      );
    });

    await test("Password: change-password requires authentication", async () => {
      const response = await changePasswordRoute.POST(
        postJson("/api/auth/change-password", {
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
        }) as never
      );
      assertEq(response.status, 401, "unauthenticated password change");
    });

    await test("Logout: clears the session cookie", async () => {
      const response = await logoutRoute.POST();
      assertEq(response.status, 200, "logout status");
      const cookie = response.cookies.get("el_token");
      assert(cookie, "cookie header present");
      assertEq(cookie!.value, "", "cookie cleared");
      assertEq(cookie!.maxAge, 0, "cookie expired immediately");
    });

    await test("Login: the httpOnly session cookie is still set", async () => {
      const response = await loginRoute.POST(
        postJson("/api/auth/login", {
          email: `2b-learner-${DB_NAME}@example.test`,
          password: TEST_PASSWORD,
        }) as never
      );
      const cookie = response.cookies.get("el_token");
      assert(cookie, "el_token cookie set");
      assertEq(cookie!.httpOnly, true, "cookie must stay httpOnly");
      assertEq(cookie!.sameSite, "lax", "cookie SameSite unchanged");
      assertEq(cookie!.maxAge, 60 * 60 * 24, "cookie lifetime unchanged");
    });

    /* ── Phase 1 authorization helpers still behave ── */

    await test("Phase 1: role predicates are unchanged and still drive authorization", async () => {
      const { isAdminRole, isAdminExtendedRole, isTeacherRole, canAccessLearnerPure } = await import(
        "@/lib/authorization"
      );
      assertEq(isAdminRole("school_admin"), true, "school_admin is admin");
      assertEq(isAdminRole("super_admin"), true, "super_admin is admin");
      assertEq(isAdminRole("teacher"), false, "teacher is not admin");
      assertEq(isAdminExtendedRole("head_teacher"), true, "head_teacher extended");
      assertEq(isTeacherRole("head_teacher"), true, "head_teacher is a teacher role");
      const parentLinks = new Map<string, Set<string>>([["parent-1", new Set(["learner-1"])]]);
      assertEq(
        canAccessLearnerPure({ userId: "parent-1", role: "parent" }, "learner-1", parentLinks, new Map(), new Map()),
        true,
        "linked parent keeps access"
      );
      assertEq(
        canAccessLearnerPure({ userId: "parent-1", role: "parent" }, "learner-2", parentLinks, new Map(), new Map()),
        false,
        "unlinked parent still denied"
      );
    });

    /* ── Final idempotency proof ── */

    await test("Migration: the whole chain still re-runs cleanly with multi-school data present", async () => {
      const result = runMigrations();
      assertEq(
        result.status,
        0,
        `final run exited ${result.status}:\n${((result.stdout || "") + (result.stderr || "")).slice(-6000)}`
      );
      const counts = await one(
        `SELECT (SELECT count(*)::int FROM schools WHERE slug = 'cbism') AS cbism,
                (SELECT count(*)::int FROM schools) AS schools,
                (SELECT count(*)::int FROM school_users) AS memberships`
      );
      assertEq(counts.cbism, 1, "still exactly one CBISM school");
      assertEq(counts.schools, 2, "both fixture schools present");
      // Every eligible user (created before OR after the first backfill) plus the one
      // hand-made School B membership.
      const eligible = (await one(`SELECT count(*)::int AS n FROM users WHERE role <> 'super_admin'`)).n;
      assertEq(counts.memberships, eligible + 1, "one membership per eligible user, plus School B");
      assertEq(
        (await one(`SELECT count(*)::int AS n FROM school_users WHERE role = 'super_admin'`)).n,
        0,
        "no platform-role membership was ever created"
      );
    });

    await test("Boundary: no legacy table gained a school_id column", async () => {
      const rows = await q(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'school_id' ORDER BY table_name`
      );
      assertEq(rows.map((r) => r.table_name).join(","), "school_users", "school_id columns");
    });

    const { pool } = await import("@/db");
    await pool.end();
    await db.end();
  } finally {
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

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("❌ FATAL:", error);
  process.exit(1);
});
