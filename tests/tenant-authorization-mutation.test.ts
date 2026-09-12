/**
 * Phase 2C — MUTATION PROOF for the central tenant gate.
 *
 * `tests/tenant-authorization-db.test.ts` asserts that School A cannot reach School B. A
 * green suite is only meaningful if it would go RED when a protection is removed. This
 * runner therefore:
 *
 *   1. Runs the authorization suite unmodified and requires it to PASS (baseline).
 *   2. For each protection of `src/lib/tenant.ts`, applies ONE surgical mutation that
 *      removes that protection, re-runs the suite, and requires it to FAIL.
 *   3. Restores the original file (also on crash/exit, via a backup copy).
 *
 * A mutation that leaves the suite green is reported as a SURVIVOR and fails this run: it
 * means either the code or the test is not doing its job.
 *
 * Mutations (brief §14):
 *   M1  membership check removed         → no-membership accounts get a school context
 *   M2  school ownership check removed   → any school's file/submission becomes readable
 *   M3  role check removed               → a learner is treated as an administrator
 *   M4  inactive-membership filter removed → a `disabled` membership grants access
 *   M5  uniqueness/fail-closed rule removed → cross-school-attributable content leaks
 *
 * Runs the suite as a child process, so it needs the same database providers as
 * `tests/tenant-authorization-db.test.ts` (TEST_DATABASE_URL → embedded-postgres → SKIP).
 * Expect roughly one suite run per mutation: this file is deliberately slow.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = path.join(__dirname, "..");
const TENANT_FILE = path.join(REPO_ROOT, "src", "lib", "tenant.ts");
const SUITE_FILE = path.join(__dirname, "tenant-authorization-db.test.ts");
const BACKUP_FILE = path.join(REPO_ROOT, ".tenant-mutation-backup.ts");

let passed = 0;
let failed = 0;

function record(name: string, ok: boolean, detail: string) {
  if (ok) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${name}\n   ${detail}`);
    failed++;
  }
}

function restoreTenantFile() {
  if (fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(BACKUP_FILE, TENANT_FILE);
    fs.rmSync(BACKUP_FILE, { force: true });
  }
}

/* Never leave the repository mutated, whatever happens. */
process.on("exit", restoreTenantFile);
process.on("SIGINT", () => {
  restoreTenantFile();
  process.exit(130);
});

function runAuthorizationSuite(): { code: number | null; output: string } {
  const result = spawnSync("npx", ["tsx", SUITE_FILE], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 900_000,
  });
  return {
    code: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

type Mutation = { id: string; name: string; find: string; replace: string };

const mutations: Mutation[] = [
  {
    id: "M1",
    name: "membership check removed (no membership → fabricated school context)",
    find: `  const context = await resolveAuthContext(request, tokenOverride);
  if (!context.school) {
    throw new AuthContextError("You do not have an active school membership", 403);
  }`,
    replace: `  const context = await resolveAuthContext(request, tokenOverride);
  if (!context.school) {
    // MUTANT M1: permissive fallback instead of failing closed.
    const { schools } = await import("@/db/schema");
    const [firstSchool] = await db.select().from(schools).limit(1);
    context.school = {
      membershipId: "00000000-0000-0000-0000-000000000000",
      schoolId: firstSchool.id,
      userId: context.userId,
      role: "school_admin",
      status: "active",
      schoolSlug: firstSchool.slug,
      schoolName: firstSchool.name,
      schoolStatus: firstSchool.status,
      createdAt: null,
    };
  }`,
  },
  {
    id: "M2",
    name: "school ownership check removed (ownership predicate always true)",
    find: `export function sqlOwnedBySchool(schoolId: string, schoolSet: SQL): SQL {
  assertSchoolId(schoolId);
  return sql\`(
    exists (select 1 from \${schoolSet} ss where ss."school_id" = \${schoolId})
    and not exists (select 1 from \${schoolSet} ss where ss."school_id" <> \${schoolId})
  )\`;
}`,
    replace: `export function sqlOwnedBySchool(schoolId: string, schoolSet: SQL): SQL {
  assertSchoolId(schoolId);
  // MUTANT M2: tenant predicate neutralised.
  return sql\`true\`;
}`,
  },
  {
    id: "M3",
    name: "role check removed (every membership role passes every role gate)",
    find: `export function hasSchoolRole(context: AuthContext, ...roles: readonly SchoolRole[]): boolean {
  const role = schoolRole(context);
  return role !== null && roles.includes(role);
}`,
    replace: `export function hasSchoolRole(context: AuthContext, ...roles: readonly SchoolRole[]): boolean {
  // MUTANT M3: any school role satisfies any role requirement.
  return true;
}`,
  },
  {
    id: "M4",
    name: "inactive-membership filter removed (disabled membership grants access)",
    find: `  const conditions = [eq(schoolUsers.userId, userId)];
  if (!options.includeInactive) conditions.push(eq(schoolUsers.status, ACTIVE_MEMBERSHIP_STATUS));`,
    replace: `  // MUTANT M4: membership status ignored.
  const conditions = [eq(schoolUsers.userId, userId)];`,
  },
  {
    id: "M5",
    name: "uniqueness rule removed (content reachable from a second school is admitted)",
    find: `  return sql\`(
    exists (select 1 from \${schoolSet} ss where ss."school_id" = \${schoolId})
    and not exists (select 1 from \${schoolSet} ss where ss."school_id" <> \${schoolId})
  )\`;`,
    replace: `  // MUTANT M5: "reachable from my school" is enough — the "from nowhere else" half is gone.
  return sql\`(exists (select 1 from \${schoolSet} ss where ss."school_id" = \${schoolId}))\`;`,
  },
];

async function main() {
  restoreTenantFile();

  const original = fs.readFileSync(TENANT_FILE, "utf8");
  fs.writeFileSync(BACKUP_FILE, original, "utf8");

  console.log("🧬 Phase 2C mutation testing — src/lib/tenant.ts\n");

  const baseline = runAuthorizationSuite();
  if (baseline.code === 0 && /📊 Results: \d+ passed, 0 failed/.test(baseline.output)) {
    record("Baseline: the cross-school suite passes unmutated", true, "");
  } else if (/⏭️\s+SKIP/.test(baseline.output)) {
    console.log("⏭️  SKIP: the authorization suite skipped (no TEST_DATABASE_URL, no embedded-postgres).");
    restoreTenantFile();
    return;
  } else {
    record(
      "Baseline: the cross-school suite passes unmutated",
      false,
      `expected a green suite, got exit ${baseline.code}\n${baseline.output.slice(-1500)}`
    );
    restoreTenantFile();
    return;
  }

  for (const mutation of mutations) {
    assert(original.includes(mutation.find), `${mutation.id}: anchor not found in src/lib/tenant.ts`);

    // A previous mutation that survived would already have failed the run; restore anyway.
    fs.writeFileSync(TENANT_FILE, original.replace(mutation.find, mutation.replace), "utf8");

    let result: { code: number | null; output: string };
    try {
      result = runAuthorizationSuite();
    } finally {
      fs.writeFileSync(TENANT_FILE, original, "utf8");
    }

    const summary = /📊 Results: \d+ passed, (\d+) failed/.exec(result.output);
    const suiteFailed = result.code !== 0 || (summary ? Number(summary[1]) > 0 : false);
    const sawFailureLine = /❌ FAIL:/.test(result.output);
    record(
      `${mutation.id}: ${mutation.name}`,
      suiteFailed && sawFailureLine,
      suiteFailed
        ? `${mutation.id} was applied but the suite still passed — mutation SURVIVED (the protection is not covered by tests)`
        : `${mutation.id} killed the suite (exit ${result.code}) but no ❌ line was found:\n${result.output.slice(-800)}`
    );
  }

  /* Prove the file is byte-identical again before declaring success. */
  restoreTenantFile();
  const restored = fs.readFileSync(TENANT_FILE, "utf8");
  record(
    "Restore: src/lib/tenant.ts is byte-identical to the committed version",
    restored === original,
    "the tenant module differs after mutation testing — inspect src/lib/tenant.ts"
  );

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  restoreTenantFile();
  console.error(error);
  process.exit(1);
});
