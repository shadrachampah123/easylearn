/**
 * Phase 2A Tenant Foundation Tests — static structure & phase-boundary guards
 *
 * Verifies (without a database):
 *   1. The Drizzle schema declares `schools` + `school_users` correctly.
 *   2. Slug uniqueness and membership uniqueness are declared.
 *   3. The 0013 migration exists, is registered with the runner, and is additive.
 *   4. Phase boundary: NO tenant columns on legacy tables, NO tenant-aware
 *      filtering, NO auth/JWT changes, NO middleware — those belong to later phases.
 *
 * For live-database constraint tests see tests/tenant-db.test.js (npm run test:db).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function readFile(filePath) {
  return fs.readFileSync(path.join(__dirname, '..', filePath), 'utf8');
}

function listFiles(dir, ext) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${error.message}`);
    failed++;
  }
}

console.log('🏫 Running Phase 2A Tenant Foundation Tests\n');

/* ── 1. Drizzle schema: schools ── */

test('Schema: schools table declared with Phase 2A fields', () => {
  const schema = readFile('src/db/schema.ts');
  assert(schema.includes('pgTable("schools"'), 'schools table must be declared');
  for (const column of ['id:', 'name:', 'shortName:', 'slug:', 'status:', 'createdAt:', 'updatedAt:']) {
    const block = schema.slice(schema.indexOf('pgTable("schools"'), schema.indexOf('pgTable("school_users"'));
    assert(block.includes(column), `schools must declare ${column}`);
  }
});

test('Schema: school slug is uniquely constrained', () => {
  const schema = readFile('src/db/schema.ts');
  assert(schema.includes('unique("schools_slug_unique")'), 'slug must have a unique constraint');
});

test('Schema: school lifecycle status constrained to plan §4.4 values', () => {
  const schema = readFile('src/db/schema.ts');
  const block = schema.slice(schema.indexOf('pgTable("schools"'), schema.indexOf('pgTable("school_users"'));
  for (const status of ['provisioned', 'active', 'suspended', 'archived']) {
    assert(block.includes(`'${status}'`), `schools_status_check must allow '${status}'`);
  }
  assert(block.includes('schools_status_check'), 'status CHECK must be named schools_status_check');
});

test('Schema: slug is URL-safe (DNS-label format check)', () => {
  const schema = readFile('src/db/schema.ts');
  assert(schema.includes('schools_slug_format_check'), 'slug format CHECK must exist');
});

/* ── 2. Drizzle schema: school_users ── */

test('Schema: school_users declared with membership fields', () => {
  const schema = readFile('src/db/schema.ts');
  assert(schema.includes('pgTable("school_users"'), 'school_users table must be declared');
  const block = schema.slice(schema.indexOf('pgTable("school_users"'), schema.indexOf('schoolUsersRelations'));
  for (const column of ['schoolId:', 'userId:', 'role:', 'status:', 'createdAt:', 'updatedAt:']) {
    assert(block.includes(column), `school_users must declare ${column}`);
  }
});

test('Schema: school_users references schools and users', () => {
  const schema = readFile('src/db/schema.ts');
  const block = schema.slice(schema.indexOf('pgTable("school_users"'), schema.indexOf('schoolUsersRelations'));
  assert(block.includes('.references(() => schools.id'), 'school_id must reference schools.id');
  assert(block.includes('.references(() => users.id'), 'user_id must reference users.id');
});

test('Schema: school_users role reuses existing user_role enum', () => {
  const schema = readFile('src/db/schema.ts');
  const block = schema.slice(schema.indexOf('pgTable("school_users"'), schema.indexOf('schoolUsersRelations'));
  assert(block.includes('userRoleEnum("role")'), 'membership role must reuse the existing user_role enum');
});

test('Schema: same user cannot be added to the same school twice', () => {
  const schema = readFile('src/db/schema.ts');
  assert(
    schema.includes('unique("school_users_school_user_unique").on(table.schoolId, table.userId)'),
    '(school_id, user_id) must be uniquely constrained'
  );
});

test('Schema: multi-school membership supported (no single-school guard)', () => {
  const schema = readFile('src/db/schema.ts');
  assert(
    !schema.includes('school_users_one_school_per_user'),
    'the single-school guard index must NOT exist: users may belong to multiple schools'
  );
  assert(
    schema.includes('unique("school_users_school_user_unique").on(table.schoolId, table.userId)'),
    '(school_id, user_id) uniqueness must remain'
  );
});

test('Schema: relations declared for school ↔ school_users ↔ user', () => {
  const schema = readFile('src/db/schema.ts');
  assert(schema.includes('schoolsRelations'), 'schoolsRelations must be declared');
  assert(schema.includes('schoolUsersRelations'), 'schoolUsersRelations must be declared');
  assert(schema.includes('usersRelations'), 'usersRelations must be declared');
  assert(schema.includes('relations(schools,'), 'schools relation');
  assert(schema.includes('relations(schoolUsers,'), 'schoolUsers relation');
  assert(schema.includes('relations(users,'), 'users relation');
});

/* ── 3. Migration file & runner ── */

const ROOT_MIGRATION = '0013_multi_school_foundation.sql';
const GUARD_DROP_MIGRATION = '0014_drop_single_school_guard.sql';

test('Migration: 0013 exists in root and drizzle/ (project convention)', () => {
  assert(fs.existsSync(path.join(__dirname, '..', ROOT_MIGRATION)), 'root migration file missing');
  assert(
    fs.existsSync(path.join(__dirname, '..', 'drizzle', ROOT_MIGRATION)),
    'drizzle/ copy missing (0011/0012 convention)'
  );
  assert(
    readFile(ROOT_MIGRATION) === readFile(path.join('drizzle', ROOT_MIGRATION)),
    'root and drizzle copies must be identical'
  );
});

test('Migration: creates schools + school_users additively', () => {
  const sql = readFile(ROOT_MIGRATION);
  assert(sql.includes('CREATE TABLE IF NOT EXISTS "schools"'), 'schools DDL missing');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS "school_users"'), 'school_users DDL missing');
  assert(sql.includes('"slug" varchar(63) NOT NULL'), 'slug column missing');
});

test('Migration: slug uniqueness, membership uniqueness and FKs present', () => {
  const sql = readFile(ROOT_MIGRATION);
  assert(sql.includes('CONSTRAINT "schools_slug_unique" UNIQUE("slug")'), 'slug unique constraint missing');
  assert(
    sql.includes('CONSTRAINT "school_users_school_user_unique" UNIQUE("school_id", "user_id")'),
    '(school_id, user_id) unique constraint missing'
  );
  assert(
    sql.includes('"school_users_school_id_schools_id_fk"') &&
      sql.includes('REFERENCES "public"."schools"("id")'),
    'FK school_users.school_id → schools missing'
  );
  assert(
    sql.includes('"school_users_user_id_users_id_fk"') &&
      sql.includes('REFERENCES "public"."users"("id")'),
    'FK school_users.user_id → users missing'
  );
  assert(
    sql.includes('"school_users_one_school_per_user"') && sql.includes("WHERE"),
    '0013 historically creates the guard index (dropped by 0014)'
  );
});

test('Migration: 0014 exists in root and drizzle/, drops the single-school guard', () => {
  assert(fs.existsSync(path.join(__dirname, '..', GUARD_DROP_MIGRATION)), 'root 0014 missing');
  assert(
    fs.existsSync(path.join(__dirname, '..', 'drizzle', GUARD_DROP_MIGRATION)),
    'drizzle/ 0014 copy missing'
  );
  assert(
    readFile(GUARD_DROP_MIGRATION) === readFile(path.join('drizzle', GUARD_DROP_MIGRATION)),
    'root and drizzle 0014 copies must be identical'
  );
  const sql = readFile(GUARD_DROP_MIGRATION);
  assert(
    sql.includes('DROP INDEX IF EXISTS "school_users_one_school_per_user"'),
    '0014 must drop the single-school guard index'
  );
  // Check executable statements only (strip '--' comments) — comments may quote 0013.
  const statements = sql
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
    )
    .join('\n');
  assert(
    /CREATE INDEX IF NOT EXISTS "school_users_one_school_per_user"/.test(statements) &&
      !/CREATE UNIQUE INDEX IF NOT EXISTS "school_users_one_school_per_user"/.test(statements),
    '0014 must recreate the name as a NON-UNIQUE placeholder so 0013 re-runs stay no-ops'
  );
  assert(
    !/CREATE TABLE|ALTER TABLE|UPDATE |DELETE FROM|INSERT INTO/i.test(statements),
    '0014 must only manage the index — no other DDL/DML'
  );
  assert(sql.includes('--> statement-breakpoint'), 'must use the project statement separator');
});

test('Migration: idempotent (IF NOT EXISTS / guarded DO blocks)', () => {
  const sql = readFile(ROOT_MIGRATION);
  assert((sql.match(/IF NOT EXISTS/g) || []).length >= 5, 'expected IF NOT EXISTS guards');
  assert(sql.includes('WHEN duplicate_object THEN null'), 'expected guarded DO blocks');
  assert(sql.includes('--> statement-breakpoint'), 'must use the project statement separator');
});

test('Runner: run-migration.js registers 0013 and 0014 in order', () => {
  const runner = readFile('run-migration.js');
  assert(
    runner.includes('"0013_multi_school_foundation.sql"') &&
      runner.includes('"0014_drop_single_school_guard.sql"'),
    'run-migration.js files array must include the new migrations (its drizzle/ scan result is never iterated)'
  );
  assert(
    runner.indexOf('"0013_multi_school_foundation.sql"') < runner.indexOf('"0014_drop_single_school_guard.sql"'),
    '0014 must run after 0013'
  );
  assert(
    runner.includes("'schools','school_users'"),
    'runner verification query should list the new tables'
  );
});

/* ── 4. Phase boundary (Phase 2A does ONLY the foundation) ── */

test('Boundary: no school_id column added to any legacy table', () => {
  const sql = readFile(ROOT_MIGRATION);
  // ALTER TABLE may only target the NEW school_users table (adding its FKs).
  const alters = [...sql.matchAll(/ALTER TABLE\s+"?(\w+)"?/gi)].map((m) => m[1]);
  assert(alters.length > 0, 'expected FK ALTERs for school_users');
  for (const target of alters) {
    assert.strictEqual(target, 'school_users', `0013 must not ALTER existing table "${target}"`);
  }
  // school_id may only appear inside the new school_users DDL block
  const schoolUsersBlock = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "school_users"'));
  const beforeBlock = sql.slice(0, sql.indexOf('CREATE TABLE IF NOT EXISTS "school_users"'));
  assert(beforeBlock.includes('"schools"'), 'schools table must be created first');
  assert(!beforeBlock.includes('school_id'), 'no school_id outside the membership table');
  assert(schoolUsersBlock.includes('"school_id"'), 'membership table owns school_id');
});

test('Boundary: no legacy table in schema.ts gained a tenant column', () => {
  const schema = readFile('src/db/schema.ts');
  // Split into per-table blocks and require schoolId/school_id only in the two new tables.
  const blocks = schema.split(/export const \w+ = pgTable\(/);
  const names = schema.match(/export const \w+ = pgTable\("(\w+)"/g) || [];
  names.forEach((name, index) => {
    const tableName = name.match(/pgTable\("(\w+)"/)[1];
    const block = blocks[index + 1] || '';
    if (['schools', 'school_users'].includes(tableName)) return;
    assert(
      !/\bschool_id\b|\bschoolId\b/.test(block),
      `legacy table ${tableName} must not gain a school_id column in Phase 2A`
    );
  });
});

test('Boundary: no API route uses the new tenant tables yet', () => {
  const routeFiles = listFiles(path.join(__dirname, '..', 'src', 'app', 'api'), '.ts');
  for (const file of routeFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert(
      !/schoolUsers|from "@\/db\/schema"[^)]*\bschools\b/.test(content) &&
        !/\bimport\s*{[^}]*\bschools\b[^}]*}\s*from\s*"@\/db\/schema"/.test(content),
      `${path.relative(process.cwd(), file)} must not use tenant tables in Phase 2A`
    );
  }
});

test('Boundary: authentication/JWT unchanged (no schoolId in tokens)', () => {
  const auth = readFile('src/lib/auth.ts');
  assert(!auth.includes('schoolId'), 'auth must not carry school context in Phase 2A');
  assert(!auth.includes('membershipId'), 'auth must not carry membership context in Phase 2A');
});

test('Boundary: no tenant filtering added to authorization helpers', () => {
  const authorization = readFile('src/lib/authorization.ts');
  assert(!authorization.includes('schoolId'), 'authorization helpers stay tenant-free in Phase 2A');
  assert(!authorization.includes('schoolId'), 'no school-scoped predicates yet');
});

test('Boundary: no middleware/hostname tenant resolution', () => {
  const middlewarePath = path.join(__dirname, '..', 'src', 'middleware.ts');
  assert(!fs.existsSync(middlewarePath), 'src/middleware.ts must not exist yet (Phase 2E)');
});

test('Docs: README documents the 0013 migration', () => {
  const readme = readFile('README.md');
  assert(readme.includes('0013_multi_school_foundation.sql'), 'README migration table should list 0013');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
