/**
 * Phase 2B — User Membership & Authentication Context: static structure & phase-boundary guards.
 *
 * Verifies (without a database):
 *   1. Migration 0015 exists (root + drizzle/), is registered with the runner, and is
 *      idempotent, additive and non-destructive.
 *   2. The CBISM backfill rule is exactly what the audit documents: role-based, preserves
 *      roles, mirrors is_active, excludes the platform `super_admin` role.
 *   3. `src/lib/tenant.ts` is the single membership gate and never trusts client input.
 *   4. JWT school claims are hints, and the token change is backward compatible.
 *   5. Phase boundary: no tenant columns on legacy tables, no route-level membership
 *      queries, no middleware, no Phase 2C tenant filtering.
 *
 * Executable coverage (real PostgreSQL + real route handlers) lives in
 * tests/membership-auth-db.test.ts (`npm run test:membership`).
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

/** Migration text with `--` comment lines removed (so comments cannot satisfy an assertion). */
function executableSql(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
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

console.log('🎓 Running Phase 2B Membership & Authentication Tests\n');

const MIGRATION = '0015_cbism_school_and_membership_backfill.sql';
const migrationSql = readFile(MIGRATION);
const migrationStatements = executableSql(migrationSql);
const tenant = readFile('src/lib/tenant.ts');
const auth = readFile('src/lib/auth.ts');
const loginRoute = readFile('src/app/api/auth/login/route.ts');
const meRoute = readFile('src/app/api/auth/me/route.ts');

/* ── 1. Migration file & runner registration ── */

test('Migration: 0015 exists in root and drizzle/ (project convention) and the copies match', () => {
  assert(fs.existsSync(path.join(__dirname, '..', MIGRATION)), 'root migration file missing');
  assert(fs.existsSync(path.join(__dirname, '..', 'drizzle', MIGRATION)), 'drizzle/ copy missing');
  assert.strictEqual(readFile(MIGRATION), readFile(path.join('drizzle', MIGRATION)), 'copies must be identical');
});

test('Runner: run-migration.js registers 0015 after 0014', () => {
  const runner = readFile('run-migration.js');
  assert(runner.includes(`"${MIGRATION}"`), 'run-migration.js files array must include 0015');
  assert(
    runner.indexOf('"0014_drop_single_school_guard.sql"') < runner.indexOf(`"${MIGRATION}"`),
    '0015 must run after 0014'
  );
  assert(runner.includes("cbism_schools"), 'runner should verify the CBISM school/membership counts');
});

test('Migration: every statement chunk is real SQL (the separator must not appear in comments)', () => {
  const chunks = migrationSql.split('--> statement-breakpoint');
  assert(chunks.length >= 3, 'expected the school insert, the backfill and the report block');
  for (const chunk of chunks) {
    const statements = executableSql(chunk).trim();
    if (!statements) continue; // comment-only leading chunk
    assert(
      /^(INSERT INTO|DO \$\$|CREATE|ALTER|SELECT|UPDATE|DELETE)/i.test(statements),
      `a statement chunk does not start with SQL — a separator probably leaked into a comment:\n${statements.slice(0, 120)}`
    );
  }
});

/* ── 2. CBISM school creation ── */

test('Migration: creates exactly one canonical CBISM school, idempotently', () => {
  assert(migrationStatements.includes(`INSERT INTO "schools"`), 'schools insert missing');
  assert(/'cbism'/.test(migrationStatements), "slug must be 'cbism'");
  assert(
    /ON CONFLICT \("slug"\) DO NOTHING/i.test(migrationStatements),
    'the insert must be keyed on the unique slug and do nothing on conflict (no duplicates)'
  );
  assert(!/ON CONFLICT[^\n]*DO UPDATE/i.test(migrationStatements), 'must never rewrite an existing school row');
  assert(migrationStatements.includes("'active'"), 'the CBISM school is created active');
});

/* ── 3. Membership backfill rule ── */

test('Migration: backfills school_users from users, preserving the role', () => {
  assert(migrationStatements.includes(`INSERT INTO "school_users"`), 'school_users insert missing');
  assert(/u\."role"/.test(migrationStatements), 'the membership role must be copied from users.role');
  assert(
    !/VALUES[^;]*'(school_admin|head_teacher|teacher|parent|learner)'/i.test(migrationStatements),
    'no hard-coded role may be assigned during the backfill'
  );
  assert(
    /FROM "users"/.test(migrationStatements) && /WHERE "slug" = 'cbism'/.test(migrationStatements),
    'the backfill must join the CBISM school resolved by slug'
  );
});

test("Migration: excludes super_admin (platform role) from memberships", () => {
  assert(
    /WHERE\s+u\."role"\s*<>\s*'super_admin'/.test(migrationStatements),
    "the backfill must exclude role = 'super_admin'"
  );
  assert(
    !/INSERT INTO "school_users"[\s\S]*'super_admin'[\s\S]*VALUES/i.test(migrationStatements),
    'super_admin must never be inserted as a membership role'
  );
});

test('Migration: membership status mirrors users.is_active (no deactivation, no activation)', () => {
  assert(
    /CASE WHEN u\."is_active" THEN 'active' ELSE 'disabled' END/.test(migrationStatements),
    'status must be derived from users.is_active'
  );
});

test('Migration: idempotent — conflicts are skipped, existing memberships are never rewritten', () => {
  assert(
    /ON CONFLICT \("school_id", "user_id"\) DO NOTHING/i.test(migrationStatements),
    'the backfill must skip existing (school_id, user_id) rows'
  );
  assert(
    !/ON CONFLICT[^\n]*DO UPDATE/i.test(migrationStatements),
    'a re-run must not overwrite an administrator-edited membership'
  );
});

test('Migration: additive and non-destructive (no UPDATE/DELETE/DROP/TRUNCATE/ALTER)', () => {
  assert(!/\bUPDATE\b/i.test(migrationStatements), 'no UPDATE');
  assert(!/\bDELETE\b/i.test(migrationStatements), 'no DELETE');
  assert(!/\bDROP\b/i.test(migrationStatements), 'no DROP');
  assert(!/\bTRUNCATE\b/i.test(migrationStatements), 'no TRUNCATE');
  assert(!/\bALTER\b/i.test(migrationStatements), 'no ALTER — no legacy table or column is touched');
  assert(!/password_hash/i.test(migrationStatements), 'passwords are never touched');
  assert(
    !/\b(attendance|assignments|submissions|announcements|grades|login_attempts)\b/i.test(migrationStatements),
    'no academic or telemetry table is referenced'
  );
});

test('Migration: no school_id column is added to any legacy table', () => {
  const alters = [...migrationStatements.matchAll(/ALTER TABLE\s+"?(\w+)"?/gi)].map((m) => m[1]);
  assert.strictEqual(alters.length, 0, 'ALTER TABLE list must be empty');
  const insertTargets = [...migrationStatements.matchAll(/INSERT INTO\s+"?(\w+)"?/gi)].map((m) => m[1]);
  for (const target of insertTargets) {
    assert(
      ['schools', 'school_users'].includes(target),
      `0015 may only write to schools/school_users (found "${target}")`
    );
  }
});

/* ── 4. Centralized membership module ── */

test('Tenant module: src/lib/tenant.ts provides the membership primitives', () => {
  for (const symbol of [
    'export async function listSchoolMemberships',
    'export async function listActiveSchoolMemberships',
    'export async function resolveSchoolMembership',
    'export async function requireActiveSchoolMembership',
    'export async function getEffectiveSchoolRole',
    'export async function resolveAuthContext',
    'export async function requireSchoolContext',
    'export function selectSchoolForContext',
    'export async function resolveLoginSchoolContext',
    'export class AuthContextError',
    'export const PLATFORM_ROLE',
    'export function isPlatformRole',
    'export function toSchoolRole',
  ]) {
    assert(tenant.includes(symbol), `tenant.ts must export ${symbol}`);
  }
});

test('Tenant module: super_admin is a platform role, never a school role', () => {
  assert(tenant.includes(`export const PLATFORM_ROLE = "super_admin"`), 'platform role constant');
  const toSchoolRoleBody = tenant.slice(
    tenant.indexOf('export function toSchoolRole'),
    tenant.indexOf('function isMembershipStatus')
  );
  assert(toSchoolRoleBody.includes('SCHOOL_ROLES'), 'toSchoolRole must allow-list school roles only');
  assert(
    !SCHOOL_ROLES_INCLUDES_SUPER_ADMIN(tenant),
    'super_admin must not be listed as a school role'
  );
  assert(
    !/if\s*\(\s*role\s*===\s*["']super_admin["']\s*\)\s*return\s+(true|membership)/.test(tenant),
    'no super_admin shortcut may grant school context'
  );
});

function SCHOOL_ROLES_INCLUDES_SUPER_ADMIN(source) {
  const block = source.slice(source.indexOf('export const SCHOOL_ROLES'), source.indexOf('export type SchoolRole'));
  return block.includes('super_admin');
}

test('Tenant module: only active memberships grant context', () => {
  assert(tenant.includes('ACTIVE_MEMBERSHIP_STATUS'), 'active status constant');
  const listBody = tenant.slice(
    tenant.indexOf('export async function listSchoolMemberships'),
    tenant.indexOf('/** Only `status = ')
  );
  assert(
    listBody.includes('eq(schoolUsers.status, ACTIVE_MEMBERSHIP_STATUS)'),
    'the default membership query must filter status = active'
  );
});

test('Tenant module: membership queries are always scoped to the authenticated user', () => {
  const listBody = tenant.slice(
    tenant.indexOf('export async function listSchoolMemberships'),
    tenant.indexOf('/** Only `status = ')
  );
  assert(
    /const conditions = \[eq\(schoolUsers\.userId, userId\)\]/.test(listBody),
    'the WHERE clause must always start from user_id = $1 (no unscoped school_users read)'
  );
  assert(
    listBody.includes('.where(and(...conditions))'),
    'the query must actually apply those conditions'
  );
  assert(
    !/\.where\(\s*eq\(schoolUsers\.schoolId/.test(listBody),
    'membership must never be looked up by school alone'
  );
});

test('Tenant module: narrowing by schoolId can only reduce the caller\'s own memberships', () => {
  const resolveBody = tenant.slice(
    tenant.indexOf('export async function resolveSchoolMembership'),
    tenant.indexOf('/** Like `resolveSchoolMembership`')
  );
  assert(resolveBody.includes('listActiveSchoolMemberships(userId)'), 'starts from the user\'s own memberships');
  assert(resolveBody.includes('memberships.find('), 'narrows by matching an existing membership');
  assert(resolveBody.includes('?? null'), 'an unmatched school id resolves to null');
  assert(resolveBody.includes('isUuid(options.schoolId)'), 'malformed school ids are rejected');
});

test('Tenant module: never reads a school from the request body, query or headers', () => {
  assert(!tenant.includes('searchParams'), 'no query-parameter reads');
  assert(!/request\.json\(/.test(tenant), 'no body reads');
  assert(!/headers\.get\((["'])(x-school|school)/i.test(tenant), 'no school header reads');
  assert(!/req(uest)?\.(body|query)/.test(tenant), 'no body/query access');
  const resolveContextBody = tenant.slice(
    tenant.indexOf('export async function resolveAuthContext'),
    tenant.indexOf('/**\n * `resolveAuthContext` + a required')
  );
  assert(
    resolveContextBody.includes('getTokenFromRequest(request)') &&
      !/request\.(headers|json|url)/.test(resolveContextBody),
    'resolveAuthContext may only read the token from the request'
  );
});

test('Tenant module: degrades instead of crashing on an un-migrated database', () => {
  assert(tenant.includes('isMissingRelation(error)'), 'missing tenant tables must be classified');
  const listBody = tenant.slice(
    tenant.indexOf('export async function listSchoolMemberships'),
    tenant.indexOf('/** Only `status = ')
  );
  assert(listBody.includes('return []'), 'missing tables degrade to "no memberships"');
  const loginBody = tenant.slice(tenant.indexOf('export async function resolveLoginSchoolContext'));
  assert(loginBody.includes('catch (error)'), 'login-time resolution must never throw');
});

test('Tenant module: password hashes never leave the module', () => {
  assert(tenant.includes('delete (user as Record<string, unknown>).passwordHash'), 'explicit passwordHash strip');
});

/* ── 5. JWT / session ── */

test('JWT: token schema version 2 is additive and legacy tokens still verify', () => {
  assert(auth.includes('export const TOKEN_SCHEMA_VERSION = 2'), 'version constant');
  assert(auth.includes('export const LEGACY_TOKEN_SCHEMA_VERSION = 1'), 'legacy version constant');
  assert(auth.includes('LEGACY_TOKEN_SCHEMA_VERSION'), 'a missing ver claim must fall back to 1');
  assert(
    !/ver\s*!==\s*TOKEN_SCHEMA_VERSION/.test(auth),
    'authorization must not be gated on the token version (would log everybody out)'
  );
  assert(auth.includes('setExpirationTime(TOKEN_EXPIRY)'), 'expiry unchanged');
  assert(auth.includes('alg: "HS256"'), 'signing algorithm unchanged');
  assert(!/\bsid\b/.test(auth), 'no half-implemented session-id claim (deferred with the revocation work)');
});

test('JWT: school claims are surfaced as untrusted hints, not authorization inputs', () => {
  assert(auth.includes('schoolIdHint'), 'schoolId must be exposed as a hint');
  assert(auth.includes('membershipIdHint'), 'membershipId must be exposed as a hint');
  assert(!/return\s*{[^}]*\bschoolId:/.test(auth), 'verifyToken must not return a bare schoolId');
  assert(/UNTRUSTED HINTS/.test(auth), 'the untrusted nature must be documented at the type site');
  assert(auth.includes('uuidClaim'), 'claims must be shape-validated');
});

test('JWT: createToken only accepts server-supplied school context', () => {
  const createBody = auth.slice(auth.indexOf('export async function createToken'), auth.indexOf('export async function verifyToken'));
  assert(createBody.includes('schoolId?: string'), 'optional school claim');
  assert(createBody.includes('membershipId?: string'), 'optional membership claim');
  assert(createBody.includes('never from client input'), 'the server-only rule is documented');
});

/* ── 6. Auth flows ── */

test('Login: school context is resolved server-side from memberships', () => {
  assert(loginRoute.includes('resolveLoginSchoolContext'), 'login uses the central resolver');
  assert(loginRoute.includes('schoolId: school?.schoolId'), 'token school claim comes from the membership');
  assert(loginRoute.includes('membershipId: school?.membershipId'), 'token membership claim comes from the membership');
});

test('Login: the request body is still only email/username/password', () => {
  const destructure = loginRoute.match(/const\s*{\s*([^}]+)\s*}\s*=\s*body as Record<string, unknown>/);
  assert(destructure, 'login must destructure a known, fixed set of body fields');
  assert.strictEqual(
    destructure[1].replace(/\s+/g, ' ').trim(),
    'email, username, password',
    'no client-supplied school/role field may be read'
  );
  assert(!/body\.(schoolId|school_id|school|role|membershipId)/.test(loginRoute), 'no direct body school reads');
});

test('Login: Phase 1 protections are intact (rate limit, password check, deactivation)', () => {
  for (const marker of [
    'checkLoginRateLimit',
    'recordFailedLoginAttempt',
    'clearFailedLoginAttempts',
    'verifyPassword(password, user.passwordHash)',
    'Account is deactivated',
    'httpOnly: true',
  ]) {
    assert(loginRoute.includes(marker), `login must keep ${marker}`);
  }
});

test('Login: missing membership does not lock a user out', () => {
  assert(loginRoute.includes('resolveLoginSchoolContext'), 'resolution is delegated');
  assert(!/if\s*\(\s*!school\s*\)[\s\S]{0,80}return\s+errorResponse/.test(loginRoute), 'no hard membership gate at login');
  const tenantLogin = tenant.slice(tenant.indexOf('export async function resolveLoginSchoolContext'));
  assert(tenantLogin.includes('school: null'), 'degrades to no school context');
});

test('Session: /api/auth/me returns DB-derived context and keeps the user shape', () => {
  assert(meRoute.includes('resolveAuthContext'), 'me uses the central resolver');
  assert(meRoute.includes('user: context.user'), 'the existing user object is preserved');
  assert(meRoute.includes('unauthorizedResponse()'), 'unauthenticated requests still get a generic 401');
  assert(!meRoute.includes('getUserFromToken'), 'the ad-hoc token read is replaced by the central helper');
});

/* ── 7. Phase boundary (2B does NOT implement 2C) ── */

test('Boundary: no legacy table in schema.ts gained a tenant column', () => {
  const schema = readFile('src/db/schema.ts');
  const blocks = schema.split(/export const \w+ = pgTable\(/);
  const names = schema.match(/export const \w+ = pgTable\("(\w+)"/g) || [];
  names.forEach((name, index) => {
    const tableName = name.match(/pgTable\("(\w+)"/)[1];
    if (['schools', 'school_users'].includes(tableName)) return;
    assert(
      !/\bschool_id\b|\bschoolId\b/.test(blocks[index + 1] || ''),
      `legacy table ${tableName} must not gain a school_id column in Phase 2B`
    );
  });
});

test('Boundary: no API route queries the tenant tables directly', () => {
  for (const file of listFiles(path.join(__dirname, '..', 'src', 'app', 'api'), '.ts')) {
    const content = fs.readFileSync(file, 'utf8');
    assert(
      !/\bschoolUsers\b/.test(content),
      `${path.relative(process.cwd(), file)} must not touch school_users directly — use src/lib/tenant.ts`
    );
  }
});

test('Boundary: Phase 2C migrated the protected routes onto the central tenant module', () => {
  // Phase 2B wired only login + me. Phase 2C migrates the school-owned routes onto the same
  // audited gate — every route listed here must go through src/lib/tenant.ts rather than
  // running its own token/role preamble.
  const apiRoot = path.join(__dirname, '..', 'src', 'app', 'api');
  const mustUseTenant = [
    'users/route.ts',
    'users/[id]/route.ts',
    'enrollments/route.ts',
    'grades/route.ts',
    'attendance/route.ts',
    'announcements/route.ts',
    'notifications/route.ts',
    'files/[id]/route.ts',
    'uploads/route.ts',
    'uploads/[id]/route.ts',
    'uploads/presign/route.ts',
    'submissions/route.ts',
    'submissions/[id]/route.ts',
    'submissions/[id]/grade/route.ts',
    'learner/stats/route.ts',
    'learner-reports/route.ts',
    'reports/route.ts',
    'messages/route.ts',
    'activity-logs/route.ts',
    'classes/route.ts',
    'classes/[id]/route.ts',
    'dashboard/admin/route.ts',
    'dashboard/stats/route.ts',
    'dashboard/teacher/route.ts',
    'dashboard/parent/route.ts',
    'dashboard/learner/route.ts',
  ];

  for (const relative of mustUseTenant) {
    const file = path.join(apiRoot, relative);
    assert(fs.existsSync(file), `${relative} is missing`);
    assert(
      /@\/lib\/tenant/.test(fs.readFileSync(file, 'utf8')),
      `${relative} must authorize through src/lib/tenant.ts (Phase 2C)`
    );
  }

  // And nothing outside the tenant module may query the membership tables directly.
  for (const file of listFiles(apiRoot, '.ts')) {
    assert(
      !/\bschoolUsers\b/.test(fs.readFileSync(file, 'utf8')),
      `${path.relative(process.cwd(), file)} must not touch school_users directly`
    );
  }
});

test('Boundary: Phase 1 authorization helpers stay tenant-free (Phase 2C adds schoolId)', () => {
  const authorization = readFile('src/lib/authorization.ts');
  assert(!authorization.includes('schoolId'), 'no school-scoped predicates yet');
  assert(!authorization.includes('@/lib/tenant'), 'authorization.ts does not depend on tenant.ts yet');
});

test('Boundary: no middleware / hostname tenant resolution (Phase 2E)', () => {
  assert(!fs.existsSync(path.join(__dirname, '..', 'src', 'middleware.ts')), 'src/middleware.ts must not exist yet');
  assert(!tenant.includes('x-forwarded-host'), 'no host-based tenant resolution yet');
});

test('Boundary: no school switching, branding, billing or RLS in this phase', () => {
  assert(!fs.existsSync(path.join(__dirname, '..', 'src', 'app', 'api', 'auth', 'select-school')), 'no school switcher route');
  assert(!fs.existsSync(path.join(__dirname, '..', 'src', 'app', 'api', 'platform')), 'no platform routes yet');
  assert(!/schoolBranding|school_branding/.test(readFile('src/db/schema.ts')), 'no branding table');
  assert(!/ROW LEVEL SECURITY/i.test(migrationSql), 'no RLS');
});

/* ── 8. Docs & scripts ── */

test('Docs: README documents the 0015 migration', () => {
  const readme = readFile('README.md');
  assert(readme.includes(MIGRATION), 'README migration table should list 0015');
});

test('Docs: the Phase 2B audit/decision record exists', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'docs', 'PHASE2B_MEMBERSHIP_AUTH.md')), 'audit doc missing');
  const doc = readFile('docs/PHASE2B_MEMBERSHIP_AUTH.md');
  for (const marker of ['super_admin', 'school_users', 'cbism', 'ON CONFLICT']) {
    assert(doc.includes(marker), `the audit doc must document ${marker}`);
  }
});

test('Scripts: package.json runs the new suites', () => {
  const pkg = JSON.parse(readFile('package.json'));
  assert(pkg.scripts['test:membership'], 'a test:membership script must exist');
  assert(pkg.scripts['test:membership'].includes('membership-auth-db.test.ts'), 'it must run the real-DB suite');
  assert(pkg.scripts.test.includes('membership-foundation.test.js'), 'npm test must run the static suite');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
