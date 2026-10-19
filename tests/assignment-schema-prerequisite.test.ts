/**
 * Assignment authorization — SCHEMA PREREQUISITE regression suite.
 *
 * Why this suite exists
 * ---------------------
 * The audit of PR #32 proved that the "works on a pre-0016 database" claim carried by the
 * assignment authorization layer was only half true. Measured against a real pre-0016
 * database (migrations 0000–0015):
 *
 *   - The SCHOOL-SCOPE layer (`sqlSchoolRowInSchool()` → the relational attribution) never
 *     reads a content table's `school_id`. It attributes a row through `school_users.school_id`
 *     (migration 0013) and the relational ownership chain, so it works on a pre-0016 schema.
 *   - The LEARNER and PARENT role predicates read `learner_classes.school_id` and
 *     `parent_learners.school_id`, which migration 0016 adds. On a pre-0016 schema they fail
 *     CLOSED with a missing-column error.
 *   - The TEACHER and SCHOOL-ADMIN/HEAD-TEACHER role predicates need only the school scope, so
 *     they work on a pre-0016 schema.
 *   - The synchronous `assignmentAccessPredicate` references `assignments.school_id` and
 *     therefore requires migration 0016 for EVERY role.
 *
 * The supported schema versions are 0016 and later. This suite pins that contract so it can
 * never silently change in either direction:
 *
 *   1. On a SUPPORTED database (0016/0017/0018) every role is isolated, and the prerequisite
 *      columns exist.
 *   2. On a PRE-0016 database the learner and parent paths fail closed (an error, never a
 *      row) and the teacher/administrator paths stay isolated.
 *   3. The documentation states the prerequisite — so the old, false claim cannot come back.
 *
 * The two scenarios run in separate processes: the application reads `DATABASE_URL` once, at
 * import time, so the `@/db` pool is bound to a single database per process.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");
const { createScratchDatabase, assertCleanupSucceeded } = requireFromRepo(
  "./tests/helpers/scratch-db.js"
);

const RUN_ID = crypto.randomBytes(4).toString("hex");
const SUPPORTED_DB = `easylearn_prereq_supported_${RUN_ID}`;
const PRE0016_DB = `easylearn_prereq_pre0016_${RUN_ID}`;
const JWT_SECRET = createTestJwtSecret();
const SCENARIO_ENV = "EASY_LEARN_PREREQ_SCENARIO";
const PRE0016_URL_ENV = "EASY_LEARN_PREREQ_PRE0016_URL";
/** In CI a skip must fail the job: the assertions have to actually run. */
const REQUIRE_ENV = "EASY_LEARN_REQUIRE_ASSIGNMENT_PREREQ";

/** The migration files that make up a pre-0016 schema, in order. */
const PRE_0016_MIGRATIONS = [
  "0000_wet_legion.sql",
  "0001_assignment_grading.sql",
  "0002_optional_email.sql",
  "0003_timetable.sql",
  "0004_dashboard_overrides.sql",
  "0005_activity_enhancements.sql",
  "0006_user_identity_columns.sql",
  "0007_quiz_images.sql",
  "0008_easyai_grading.sql",
  "0009_file_uploads.sql",
  "0010_object_storage.sql",
  "0011_attendance_unique_constraint.sql",
  "0012_login_attempts.sql",
  "0013_multi_school_foundation.sql",
  "0014_drop_single_school_guard.sql",
  "0015_cbism_school_and_membership_backfill.sql",
];

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

function assertEq(actual: unknown, expected: unknown, message: string) {
  assert.equal(actual, expected, `${message} (got ${String(actual)}, expected ${String(expected)})`);
}

/** A UUID that is stable within one run. */
function uuid(tag: string): string {
  return crypto
    .createHash("sha256")
    .update(`${tag}:${RUN_ID}`)
    .digest("hex")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
}

/* ───────────────────────── shared fixture ───────────────────────── */

type Fixture = {
  schoolA: string;
  schoolB: string;
  teacherA: string;
  otherTeacherA: string;
  teacherB: string;
  adminA: string;
  learnerA: string;
  unenrolledLearnerA: string;
  parentA: string;
  linkedLearnerId: string;
  assignmentA: string;
  draftAssignmentA: string;
  assignmentB: string;
};

/**
 * Seed two schools with the same shape on both schema versions.
 *
 * The pre-0016 tables have no `school_id`; from 0016 on they have one (and from 0017 on it
 * is NOT NULL). `hasSchoolId` selects the matching column list, so the SAME fixture describes
 * both schemas and the two scenarios are comparable.
 */
async function seedFixture(
  q: (sql: string, values?: unknown[]) => Promise<any[]>,
  hasSchoolId: boolean
): Promise<Fixture> {
  const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0];

  const schoolA = (await one(
    `INSERT INTO schools (name, short_name, slug) VALUES ('Prereq School A','PSA','prereq-a') RETURNING id`
  )).id as string;
  const schoolB = (await one(
    `INSERT INTO schools (name, short_name, slug) VALUES ('Prereq School B','PSB','prereq-b') RETURNING id`
  )).id as string;

  const createUser = async (label: string, role: string, schoolId: string, membershipRole: string) => {
    const row = await one(
      `INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active)
       VALUES ($1,$2,'not-a-real-hash',$3,$4,'Test',true) RETURNING id`,
      [`${label}-${RUN_ID}@example.test`, `${label}-${RUN_ID}`, role, label]
    );
    await one(
      `INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active') RETURNING id`,
      [schoolId, row.id, membershipRole]
    );
    return row.id as string;
  };

  const teacherA = await createUser("prereq-teacher-a", "teacher", schoolA, "teacher");
  const otherTeacherA = await createUser("prereq-teacher-other", "teacher", schoolA, "teacher");
  const teacherB = await createUser("prereq-teacher-b", "teacher", schoolB, "teacher");
  const adminA = await createUser("prereq-admin-a", "school_admin", schoolA, "school_admin");
  const learnerA = await createUser("prereq-learner-a", "learner", schoolA, "learner");
  const unenrolledLearnerA = await createUser("prereq-learner-unenrolled", "learner", schoolA, "learner");
  const parentA = await createUser("prereq-parent-a", "parent", schoolA, "parent");

  /* The `school_id` column list, and the value list that goes with it. */
  const withSchool = (schoolId: string) => (hasSchoolId ? [schoolId] : []);
  const schoolColumn = (_table: string) => (hasSchoolId ? `, school_id` : "");
  const schoolPlaceholder = (_table: string, position: number) => (hasSchoolId ? `, $${position}` : "");

  const yearA = (await one(
    `INSERT INTO academic_years (name, start_date, end_date, is_current${schoolColumn("academic_years")})
     VALUES ('2026/27','2026-01-01','2026-12-31',true${schoolPlaceholder("academic_years", 1)})
     RETURNING id`,
    withSchool(schoolA)
  )).id as string;
  const subjectA = (await one(
    `INSERT INTO subjects (name, code${schoolColumn("subjects")})
     VALUES ('Prereq Subject A','PSA-SUB'${schoolPlaceholder("subjects", 1)}) RETURNING id`,
    withSchool(schoolA)
  )).id as string;
  const classA = (await one(
    `INSERT INTO classes (name, level, class_teacher_id, academic_year_id${schoolColumn("classes")})
     VALUES ('Prereq Class A','junior_high',$1,$2${schoolPlaceholder("classes", 3)}) RETURNING id`,
    [...[teacherA, yearA], ...withSchool(schoolA)]
  )).id as string;
  await q(
    `INSERT INTO learner_classes (learner_id, class_id, academic_year_id${schoolColumn("learner_classes")})
     VALUES ($1,$2,$3${schoolPlaceholder("learner_classes", 4)})`,
    [...[learnerA, classA, yearA], ...withSchool(schoolA)]
  );
  await q(
    `INSERT INTO parent_learners (parent_id, learner_id${schoolColumn("parent_learners")})
     VALUES ($1,$2${schoolPlaceholder("parent_learners", 3)})`,
    [...[parentA, learnerA], ...withSchool(schoolA)]
  );

  const assignmentA = (await one(
    `INSERT INTO assignments (title, class_id, subject_id, teacher_id, status${schoolColumn("assignments")})
     VALUES ('Prereq Assignment A',$1,$2,$3,'published'${schoolPlaceholder("assignments", 4)}) RETURNING id`,
    [...[classA, subjectA, teacherA], ...withSchool(schoolA)]
  )).id as string;
  const draftAssignmentA = (await one(
    `INSERT INTO assignments (title, class_id, subject_id, teacher_id, status${schoolColumn("assignments")})
     VALUES ('Prereq Draft Assignment A',$1,$2,$3,'draft'${schoolPlaceholder("assignments", 4)}) RETURNING id`,
    [...[classA, subjectA, teacherA], ...withSchool(schoolA)]
  )).id as string;

  const yearB = (await one(
    `INSERT INTO academic_years (name, start_date, end_date, is_current${schoolColumn("academic_years")})
     VALUES ('2027/28','2027-01-01','2027-12-31',true${schoolPlaceholder("academic_years", 1)})
     RETURNING id`,
    withSchool(schoolB)
  )).id as string;
  const subjectB = (await one(
    `INSERT INTO subjects (name, code${schoolColumn("subjects")})
     VALUES ('Prereq Subject B','PSB-SUB'${schoolPlaceholder("subjects", 1)}) RETURNING id`,
    withSchool(schoolB)
  )).id as string;
  /* The school-B class is homeroomed by a school-B teacher, so the relational attribution of
     school B's content is school B alone (never school A). */
  const classB = (await one(
    `INSERT INTO classes (name, level, class_teacher_id, academic_year_id${schoolColumn("classes")})
     VALUES ('Prereq Class B','junior_high',$1,$2${schoolPlaceholder("classes", 3)}) RETURNING id`,
    [...[teacherB, yearB], ...withSchool(schoolB)]
  )).id as string;
  const assignmentB = (await one(
    `INSERT INTO assignments (title, class_id, subject_id, teacher_id, status${schoolColumn("assignments")})
     VALUES ('Prereq Assignment B',$1,$2,$3,'published'${schoolPlaceholder("assignments", 4)}) RETURNING id`,
    [...[classB, subjectB, teacherB], ...withSchool(schoolB)]
  )).id as string;

  return {
    schoolA,
    schoolB,
    teacherA,
    otherTeacherA,
    teacherB,
    adminA,
    learnerA,
    unenrolledLearnerA,
    parentA,
    linkedLearnerId: learnerA,
    assignmentA,
    draftAssignmentA,
    assignmentB,
  };
}

/* ───────────────────────── the two scenarios ───────────────────────── */

/**
 * Build a context exactly like the one `resolveAuthContext()` returns: the membership role
 * comes from `school_users`, never from the token.
 */
function schoolContext(
  role: string,
  userId: string,
  schoolId: string
): any {
  const membership = {
    membershipId: uuid(`membership:${role}:${userId}`),
    schoolId,
    userId,
    role,
    status: "active",
    schoolSlug: "prereq",
    schoolName: "Prereq",
    schoolStatus: "active",
    createdAt: null,
  };
  return {
    userId,
    role,
    tokenRole: role,
    email: null,
    username: null,
    isPlatformAdmin: false,
    user: {},
    memberships: [membership],
    school: membership,
    schoolId,
    membershipId: membership.membershipId,
  };
}

/** Run the four role predicates of the assignment access layer against one assignment id. */
async function probeRoles(assignmentId: string, fixture: Fixture): Promise<Record<string, unknown>> {
  const { db } = await import("@/db");
  const { assignments } = await import("@/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const access = await import("@/lib/assignment-access");
  const tenant = await import("@/lib/tenant");

  const count = async (predicate: any): Promise<number> =>
    (await db.select({ id: assignments.id }).from(assignments)
      .where(and(eq(assignments.id, assignmentId), predicate)).limit(1)).length;

  const attempt = async (fn: () => Promise<number>) => {
    try {
      return { ok: true, rows: await fn() };
    } catch (error: any) {
      return { ok: false, error: String(error?.cause?.message || error?.message || error) };
    }
  };

  const teacherCtx = schoolContext("teacher", fixture.teacherA, fixture.schoolA);
  const adminCtx = schoolContext("school_admin", fixture.adminA, fixture.schoolA);
  const learnerCtx = schoolContext("learner", fixture.learnerA, fixture.schoolA);
  const parentCtx = schoolContext("parent", fixture.parentA, fixture.schoolA);

  return {
    scope: await attempt(async () => {
      const predicate = await tenant.sqlAssignmentScope(fixture.schoolA, assignments.id);
      return count(predicate);
    }),
    scopeForeign: await attempt(async () => {
      const predicate = await tenant.sqlAssignmentScope(fixture.schoolA, assignments.id);
      return (await db.select({ id: assignments.id }).from(assignments)
        .where(and(eq(assignments.id, fixture.assignmentB), predicate)).limit(1)).length;
    }),
    teacher: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(teacherCtx);
      return count(predicate);
    }),
    teacherForeign: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(teacherCtx);
      return (await db.select({ id: assignments.id }).from(assignments)
        .where(and(eq(assignments.id, fixture.assignmentB), predicate)).limit(1)).length;
    }),
    admin: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(adminCtx);
      return count(predicate);
    }),
    adminForeign: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(adminCtx);
      return (await db.select({ id: assignments.id }).from(assignments)
        .where(and(eq(assignments.id, fixture.assignmentB), predicate)).limit(1)).length;
    }),
    learner: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(learnerCtx);
      return count(predicate);
    }),
    learnerForeign: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(learnerCtx);
      return (await db.select({ id: assignments.id }).from(assignments)
        .where(and(eq(assignments.id, fixture.assignmentB), predicate)).limit(1)).length;
    }),
    parent: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(parentCtx, {
        learnerId: fixture.linkedLearnerId,
      });
      return count(predicate);
    }),
    parentForeign: await attempt(async () => {
      const predicate = await access.resolveAssignmentAccessPredicate(parentCtx, {
        learnerId: fixture.linkedLearnerId,
      });
      return (await db.select({ id: assignments.id }).from(assignments)
        .where(and(eq(assignments.id, fixture.assignmentB), predicate)).limit(1)).length;
    }),
    syncTeacher: await attempt(async () => {
      const predicate = access.assignmentAccessPredicate(teacherCtx);
      return count(predicate);
    }),
  };
}

type Probe = Record<string, { ok: boolean; rows?: number; error?: string }>;

/** The pre-0016 scenario: run in its own process, against its own database. */
async function runPre0016Scenario(): Promise<void> {
  const databaseUrl = process.env[PRE0016_URL_ENV];
  if (!databaseUrl) throw new Error(`${PRE0016_URL_ENV} is not set`);

  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.EASY_LEARN_TEST_DATABASE = "true";

  const { Client } = requireFromRepo("pg");
  const db = new Client({ connectionString: databaseUrl });
  db.on("error", () => undefined);
  await db.connect();
  const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;

  console.log("\n🧩 Assignment authorization — PRE-0016 schema scenario\n");

  await test("the pre-0016 schema has no school_id on assignments/learner_classes/parent_learners", async () => {
    for (const table of ["assignments", "learner_classes", "parent_learners"]) {
      const rows = await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name='school_id'`,
        [table]
      );
      assertEq(rows.length, 0, `${table}.school_id must not exist on a pre-0016 schema`);
    }
  });

  const fixture = await seedFixture(q, false);
  const probe = (await probeRoles(fixture.assignmentA, fixture)) as Probe;

  await test("the school scope is schema-aware: it resolves on a pre-0016 schema", async () => {
    assert(probe.scope.ok, `the school scope must execute on a pre-0016 schema: ${probe.scope.error}`);
    assertEq(probe.scope.rows, 1, "the school scope must match the school's own assignment");
  });

  await test("the school scope stays isolated on a pre-0016 schema", async () => {
    assert(probe.scopeForeign.ok, `the school scope must execute: ${probe.scopeForeign.error}`);
    assertEq(probe.scopeForeign.rows, 0, "a foreign-school assignment must not match the school scope");
  });

  await test("the teacher role predicate resolves on a pre-0016 schema and stays isolated", async () => {
    assert(probe.teacher.ok, `the teacher predicate must execute: ${probe.teacher.error}`);
    assertEq(probe.teacher.rows, 1, "the teacher must reach their own assignment");
    assert(probe.teacherForeign.ok, `the teacher predicate must execute: ${probe.teacherForeign.error}`);
    assertEq(probe.teacherForeign.rows, 0, "a foreign-school assignment must not be reachable");
  });

  await test("the school-administrator role predicate resolves on a pre-0016 schema and stays isolated", async () => {
    assert(probe.admin.ok, `the administrator predicate must execute: ${probe.admin.error}`);
    assertEq(probe.admin.rows, 1, "the administrator must reach the school's assignment");
    assert(probe.adminForeign.ok, `the administrator predicate must execute: ${probe.adminForeign.error}`);
    assertEq(probe.adminForeign.rows, 0, "a foreign-school assignment must not be reachable");
  });

  await test("the learner role predicate FAILS CLOSED on a pre-0016 schema (no row, no leak)", async () => {
    assert(!probe.learner.ok, "the learner predicate must not succeed without migration 0016");
    assert(
      /school_id does not exist/i.test(String(probe.learner.error)),
      `the learner predicate must fail on the missing 0016 column, got: ${probe.learner.error}`
    );
    assertEq(probe.learner.rows, undefined, "a failed learner predicate must return no rows");
  });

  await test("the parent role predicate FAILS CLOSED on a pre-0016 schema (no row, no leak)", async () => {
    assert(!probe.parent.ok, "the parent predicate must not succeed without migration 0016");
    assert(
      /school_id does not exist/i.test(String(probe.parent.error)),
      `the parent predicate must fail on the missing 0016 column, got: ${probe.parent.error}`
    );
    assertEq(probe.parent.rows, undefined, "a failed parent predicate must return no rows");
  });

  await test("the synchronous assignmentAccessPredicate requires migration 0016 for every role", async () => {
    assert(!probe.syncTeacher.ok, "the synchronous predicate must not succeed without migration 0016");
    assert(
      /school_id does not exist/i.test(String(probe.syncTeacher.error)),
      `the synchronous predicate must fail on the missing 0016 column, got: ${probe.syncTeacher.error}`
    );
  });

  await db.end().catch(() => undefined);
  await (await import("@/db")).pool.end().catch(() => undefined);
}

/** The supported scenario: 0016 and later. */
async function runSupportedScenario(databaseUrl: string): Promise<void> {
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.EASY_LEARN_TEST_DATABASE = "true";

  const { Client } = requireFromRepo("pg");
  const db = new Client({ connectionString: databaseUrl });
  db.on("error", () => undefined);
  await db.connect();
  const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;

  console.log("\n🧩 Assignment authorization — SUPPORTED schema scenario (0016+)\n");

  await test("the supported schema has the school_id columns the role predicates require", async () => {
    for (const table of ["assignments", "learner_classes", "parent_learners"]) {
      const rows = await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name='school_id'`,
        [table]
      );
      assertEq(rows.length, 1, `${table}.school_id must exist on a supported schema`);
    }
  });

  try {
  const fixture = await seedFixture(q, true);
  const probe = (await probeRoles(fixture.assignmentA, fixture)) as Probe;

  await test("every role predicate resolves on the supported schema", async () => {
    for (const role of ["scope", "teacher", "admin", "learner", "parent", "syncTeacher"]) {
      assert(probe[role].ok, `the ${role} predicate must execute on a supported schema: ${probe[role].error}`);
    }
  });

  await test("every role reaches the school's own published assignment", async () => {
    assertEq(probe.scope.rows, 1, "the school scope must match");
    assertEq(probe.teacher.rows, 1, "the teacher must reach their own assignment");
    assertEq(probe.admin.rows, 1, "the administrator must reach the school's assignment");
    assertEq(probe.learner.rows, 1, "the enrolled learner must reach the published assignment");
    assertEq(probe.parent.rows, 1, "the linked parent must reach the published assignment");
  });

  await test(
    "the synchronous and the schema-aware predicate select exactly the same rows",
    async () => {
      /* The submit route used to be the only one using the synchronous predicate. It now
         uses the schema-aware one, which is only safe because the two are equivalent on
         a supported schema — this assertion is what makes that reasoning checkable. */
      const { db: appDb } = await import("@/db");
      const { assignments } = await import("@/db/schema");
      const access = await import("@/lib/assignment-access");

      const roles: Array<{ name: string; ctx: any; options?: any }> = [
        { name: "teacher", ctx: schoolContext("teacher", fixture.teacherA, fixture.schoolA) },
        {
          name: "school_admin",
          ctx: schoolContext("school_admin", fixture.adminA, fixture.schoolA),
        },
        { name: "learner", ctx: schoolContext("learner", fixture.learnerA, fixture.schoolA) },
        {
          name: "parent",
          ctx: schoolContext("parent", fixture.parentA, fixture.schoolA),
          options: { learnerId: fixture.linkedLearnerId },
        },
      ];

      for (const role of roles) {
        const syncRows = (
          await appDb
            .select({ id: assignments.id })
            .from(assignments)
            .where(access.assignmentAccessPredicate(role.ctx, role.options))
        )
          .map((row: any) => row.id)
          .sort();
        const asyncRows = (
          await appDb
            .select({ id: assignments.id })
            .from(assignments)
            .where(await access.resolveAssignmentAccessPredicate(role.ctx, role.options))
        )
          .map((row: any) => row.id)
          .sort();
        assert.deepEqual(
          asyncRows,
          syncRows,
          `the ${role.name} role must select the same rows with both predicates`
        );
      }
    }
  );

  await test("no role reaches a foreign-school assignment", async () => {
    assertEq(probe.scopeForeign.rows, 0, "the school scope must not reach a foreign assignment");
    assertEq(probe.teacherForeign.rows, 0, "a teacher must not reach a foreign assignment");
    assertEq(probe.adminForeign.rows, 0, "an administrator must not reach a foreign assignment");
    assertEq(probe.learnerForeign.rows, 0, "a learner must not reach a foreign assignment");
    assertEq(probe.parentForeign.rows, 0, "a parent must not reach a foreign assignment");
  });

  await test("a learner does not reach a draft assignment", async () => {
    const { db: appDb } = await import("@/db");
    const { assignments } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const access = await import("@/lib/assignment-access");
    const ctx = schoolContext("learner", fixture.learnerA, fixture.schoolA);
    const predicate = await access.resolveAssignmentAccessPredicate(ctx);
    const rows = await appDb.select({ id: assignments.id }).from(assignments)
      .where(and(eq(assignments.id, fixture.draftAssignmentA), predicate)).limit(1);
    assertEq(rows.length, 0, "a draft assignment must not be reachable by a learner");
  });

  await test("an unenrolled learner does not reach a published assignment", async () => {
    const { db: appDb } = await import("@/db");
    const { assignments } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const access = await import("@/lib/assignment-access");
    const ctx = schoolContext("learner", fixture.unenrolledLearnerA, fixture.schoolA);
    const predicate = await access.resolveAssignmentAccessPredicate(ctx);
    const rows = await appDb.select({ id: assignments.id }).from(assignments)
      .where(and(eq(assignments.id, fixture.assignmentA), predicate)).limit(1);
    assertEq(rows.length, 0, "an unenrolled learner must not reach a published assignment");
  });

  } finally {
    await db.end().catch(() => undefined);
    await import("@/db").then((m) => m.pool.end()).catch(() => undefined);
  }
}

/* ───────────────────────── documentation contract ───────────────────────── */

function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

async function runDocumentationTests(): Promise<void> {
  console.log("\n🧩 Assignment authorization — documentation contract\n");

  await test("the authorization module states the migration 0016 prerequisite", async () => {
    const source = readRepoFile("src/lib/assignment-access.ts");
    assert(/SCHEMA PREREQUISITE/i.test(source), "the module must document the schema prerequisite");
    assert(
      /learner_classes\.school_id/.test(source) && /parent_learners\.school_id/.test(source),
      "the module must name the columns that make migration 0016 a prerequisite"
    );
    assert(
      /0016 and later|0016 and later/.test(source),
      "the module must name the supported schema versions"
    );
  });

  await test("the false pre-0016 claims are gone", async () => {
    const forbidden = [
      ["src/lib/assignment-access.ts", "which additionally works on a pre-0016 database"],
      [
        "src/lib/assignment-access.ts",
        "is still tenant-isolated instead of\n * failing open or failing with a missing-column error",
      ],
      [
        "src/app/api/assignments/route.ts",
        "a database that predates migration 0016 is isolated as well",
      ],
    ];
    for (const [file, phrase] of forbidden) {
      const source = readRepoFile(file).replace(/\s+/g, " ");
      assert(
        !source.includes(phrase.replace(/\s+/g, " ")),
        `${file} must not claim: ${phrase}`
      );
    }
  });

  await test("the assignment list route states the prerequisite", async () => {
    const source = readRepoFile("src/app/api/assignments/route.ts");
    assert(
      /require migration 0016|requires migration 0016/i.test(source),
      "the route must state that the learner and parent roles require migration 0016"
    );
  });

  await test("the integration resolution log states the prerequisite", async () => {
    const source = readRepoFile("docs/PR30_PR31_INTEGRATION_RESOLUTION.md");
    assert(
      /Schema prerequisite/i.test(source),
      "the resolution log must document the schema prerequisite"
    );
    assert(
      /learner_classes\.school_id/.test(source) && /parent_learners\.school_id/.test(source),
      "the resolution log must name the columns that make migration 0016 a prerequisite"
    );
  });
}

/* ───────────────────────── entry point ───────────────────────── */

async function main(): Promise<void> {
  /* ── child: the pre-0016 scenario ── */
  if (process.env[SCENARIO_ENV] === "pre0016") {
    await runPre0016Scenario();
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  /* ── parent ── */
  const { Client } = requireFromRepo("pg");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      console.log("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      console.log("   Install it with `npm i --no-save embedded-postgres` and re-run the suite.");
      if (process.env[REQUIRE_ENV] === "true") {
        console.error(
          `❌ FAIL: ${REQUIRE_ENV}=true — the assignment schema-prerequisite suite must run, not skip.`
        );
        process.exitCode = 1;
      }
      return;
    }
    const port = 60129 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `${SUPPORTED_DB}-data`),
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

  const admin = new Client({ connectionString: adminUrl });
  admin.on("error", () => undefined);
  await admin.connect();

  const urlFor = (dbName: string) => {
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    return url.toString();
  };
  const supportedUrl = urlFor(SUPPORTED_DB);
  const pre0016Url = urlFor(PRE0016_DB);

  /* `@/db` reads DATABASE_URL once, at import time. Set it before anything imports it, so
     the cleanup path below can never mask the real failure with a configuration error. */
  process.env.DATABASE_URL = supportedUrl;

  /* The scratch databases are created and removed by the shared helper, so they are
     dropped even when a setup step or an assertion fails. See tests/helpers/scratch-db.js. */
  const scratches: Array<{
    dispose: () => Promise<{ ok: boolean; error: Error | null }>;
  }> = [];
  let primaryError: any = null;

  try {
    for (const dbName of [SUPPORTED_DB, PRE0016_DB]) {
      const scratch = await createScratchDatabase({
        admin,
        adminUrl: adminUrl as string,
        dbName,
        label: "assignment-schema-prerequisite",
      });
      scratches.push(scratch);
    }

    /* The supported database: the whole chain, the way an operator applies it. */
    const migration = runMigrationChain({
      databaseUrl: supportedUrl,
      env: { JWT_SECRET, EASY_LEARN_TEST_DATABASE: "true" },
    });
    if (migration.status !== 0) {
      throw new Error(
        `run-migration.js exited ${migration.status}:\n${((migration.stdout || "") + (migration.stderr || "")).slice(-6000)}`
      );
    }

    /* The pre-0016 database: migrations 0000-0015 only. */
    const pre = new Client({ connectionString: pre0016Url });
    await pre.connect();
    for (const file of PRE_0016_MIGRATIONS) {
      const sql = fs.readFileSync(path.join(REPO_ROOT, "drizzle", file), "utf8");
      for (const statement of sql
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await pre.query(statement);
      }
    }
    await pre.end();

    /* The pre-0016 scenario runs in a child process: `@/db` binds DATABASE_URL at import. */
    const child = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(__dirname, "assignment-schema-prerequisite.test.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          [SCENARIO_ENV]: "pre0016",
          [PRE0016_URL_ENV]: pre0016Url,
          JWT_SECRET,
          EASY_LEARN_TEST_DATABASE: "true",
        },
        encoding: "utf8",
      }
    );
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0) {
      throw new Error(`the pre-0016 scenario failed (exit ${child.status})`);
    }

    await runSupportedScenario(supportedUrl);
    await runDocumentationTests();
  } catch (error) {
    /* Remember the original failure: the teardown must never replace it. */
    primaryError = error;
    throw error;
  } finally {
    await import("@/db")
      .then((mod) => mod.pool.end())
      .catch(() => undefined);
    const cleanups: Array<{ ok: boolean; error: Error | null }> = [];
    for (const scratch of scratches) {
      cleanups.push(await scratch.dispose());
    }
    await admin.end().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    assertCleanupSucceeded(cleanups, primaryError);
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("❌ FATAL:", error);
  process.exitCode = 1;
});
