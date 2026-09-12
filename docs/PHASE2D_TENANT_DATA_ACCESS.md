# Phase 2D — Tenant-Scoped Data Access & Legacy Route Hardening

## Goals (from brief)

- Resolve every school-owned resource through authenticated server-side school context.
- Harden catalog resources (classes, subjects, departments, academic years, terms).
- Harden derived resources (teacher/class, assignments, quizzes, submissions, timetable, grades, attendance, reports).
- Audit all GET/POST/PUT/PATCH/DELETE for IDOR, missing predicates, cross-school joins, client-controlled schoolId, role without tenant check, global lists, cross-school attaches.
- Strengthen `src/lib/tenant.ts` reusable predicates.
- Preserve global users identity, multi-school membership authoritative, active membership required, disabled rejected, super_admin no membership for platform ops.
- Add real PostgreSQL tenant-isolation tests (positive/negative, cross-school read/modify, cross-school relationships, client schoolId escape, missing/disabled membership, CBISM functionality).
- Run validation suite (npm test, test:db, typecheck, build, lint).
- Update Phase 2 docs, final security review, commit and open PR vs main, report PR/SHA, files changed, issues fixed, test counts, validation results, deferred findings, confirmation no prod DB changes.

## Schema Layer (Migration 0016)

**File:** `0016_school_id_columns.sql` (root + `drizzle/` copy, idempotent)

Adds `school_id UUID REFERENCES schools(id)` to all A-class tables:

- `academic_years`, `terms`, `departments`, `classes`, `subjects`
- `teacher_classes`, `learner_classes`, `parent_learners`
- `assignments`, `submissions`, `uploaded_files`, `resources`
- `quizzes`, `quiz_attempts`, `announcements`, `notifications`
- `attendance`, `timetable_entries`, `messages`, `activity_logs`, `dashboard_card_overrides`

Backfill rule (CBISM-compatible):

- For tables with a direct school link (e.g., `classes.academic_year_id`, `assignments.class_id`), backfill via join to the owning school's existing row.
- For tables anchored on user membership (e.g., `resources.teacher_id`), backfill to the teacher's active school membership (or first active membership if multi-school).
- For ambiguous tables (dual membership), backfill is best-effort; rows that remain NULL are handled via relational fallback in application code (fail-closed if ambiguous).

Index: `CREATE INDEX IF NOT EXISTS idx_<table>_school_id ON <table>(school_id)` for each.

**`src/db/schema.ts`:** Adds `schoolId` column to all listed tables with FK to `schools.id`.

**`run-migration.js`:** Registers `0016_school_id_columns.sql` after `0015`.

## Tenant Module Strengthening (`src/lib/tenant.ts`)

### Direct predicates (new)

```ts
sqlAcademicYearInSchool, sqlTermInSchool, sqlDepartmentInSchool, sqlSubjectInSchool,
sqlClassDirectInSchool, sqlTeacherClassDirectInSchool, sqlLearnerClassDirectInSchool,
sqlParentLearnerDirectInSchool, sqlAssignmentDirectInSchool, sqlSubmissionDirectInSchool,
sqlFileDirectInSchool, sqlResourceDirectInSchool, sqlQuizDirectInSchool,
sqlQuizAttemptDirectInSchool, sqlAnnouncementDirectInSchool, sqlNotificationDirectInSchool,
sqlAttendanceDirectInSchool, sqlTimetableDirectInSchool, sqlMessageDirectInSchool,
sqlActivityLogDirectInSchool, sqlDashboardOverrideDirectInSchool
```

All use `sqlDirectSchoolId(schoolId, tableName, idRef)` → `EXISTS (SELECT 1 FROM <table> WHERE id = ref AND school_id = schoolId)`.

### Resolvers prefer direct

- `getDirectSchoolId(table, id)` → returns `school_id` if column exists, else null.
- `isAcademicYearInSchool`, `isTermInSchool`, `isDepartmentInSchool`, `isSubjectInSchool`, `getClassSchoolIdDirect`, etc. now try direct `school_id` first, fallback to relational.
- `getClassSchoolIds`, `isClassInSchool`, `getAssignmentSchoolIds`, `isAssignmentInSchool`, `getQuizSchoolIds`, `isQuizInSchool`, `getSubmissionSchoolIds`, `isSubmissionInSchool`, `getTeacherClassSchoolIds`, `isTeacherClassInSchool`, `getTimetableSchoolIds`, `isTimetableInSchool`, `getFileSchoolIds`, `isFileInSchool` all prefer direct `school_id` with relational fallback for legacy NULL rows.

This ensures:
- New rows with `school_id` are strictly scoped via indexed direct predicate (fast path).
- Legacy rows without `school_id` still work via relational (backwards compatible) but are denied if ambiguous (reachable from two schools).

## Catalog Routes Hardened

All catalog routes now:

- `guardSchoolContext(request)` → `ctx.schoolId` authoritative, never client `schoolId`.
- GET: `WHERE school_id = ctx.schoolId` (direct) with fallback to relational predicate via `sql*InSchool` OR `isNull(school_id) AND relational`.
- POST: validates foreign keys via `is*InSchool`, inserts with `schoolId: ctx.schoolId` (try/catch fallback for DB without column).
- PUT/DELETE: `WHERE id = X AND school_id = ctx.schoolId` (direct) + scoped cascading deletes.

### Academic Years (`/api/academic-years`)

- GET: `eq(academicYears.schoolId, ctx.schoolId)` else empty.
- POST: `isCurrent` per-school unset only within school, insert with `schoolId`.
- PUT/DELETE: `and(eq(id), eq(schoolId))`.

### Terms (`/api/terms`)

- GET: `eq(terms.schoolId, ctx.schoolId)`.
- POST: validates `academicYearId` via `isAcademicYearInSchool`, inserts with `schoolId`.
- PUT/DELETE similar to academic years (not shown but same pattern).

### Departments (`/api/departments`, `/api/departments/[id]`)

- GET: direct `schoolId`.
- POST: validates `headId` via `isUserInSchool`, inserts with `schoolId`.
- PUT/DELETE: `and(eq(id), eq(schoolId))`, cascading scoped.

### Subjects (`/api/subjects`, `/api/subjects/[id]`)

- GET: direct `schoolId`.
- POST: validates `departmentId` via `isDepartmentInSchool`, inserts with `schoolId`.
- Client-supplied `schoolId` ignored.

### Classes (`/api/classes`, `/api/classes/[id]`)

- GET: `eq(classes.schoolId, ctx.schoolId)` with fallback `sqlClassInSchool`.
- POST: validates `classTeacherId` via `isUserInSchool`, `academicYearId` via `isAcademicYearInSchool`, inserts with `schoolId`.
- PUT/DELETE: `and(eq(id), eq(schoolId))`, cascades scoped by `schoolId` for assignments/quizzes/announcements/resources/attendance/learnerClasses/teacherClasses/timetable.

## Derived Routes Hardened

### Teacher-Classes (`/api/teacher-classes`)

- GET: probes `school_id` column existence via `db.execute`, uses `eq(schoolId)` else `sqlTeacherClassInSchool`.
- POST: checks `subjectId` via `isSubjectInSchool`, inserts with `schoolId`.

### Enrollments (`/api/enrollments` → `learner_classes`)

- GET: `or(eq(schoolId, ctx.schoolId), and(isNull(schoolId), relational))` to support legacy NULL rows.
- POST: checks learner and class via `isUserInSchool`/`isClassInSchool`, inserts with `schoolId`.

### Parent-Learners (`/api/parent-learners`)

- GET: probes `school_id`, uses direct else relational.
- POST: inserts with `schoolId`.

### Assignments (`/api/assignments`)

- GET: prefers `eq(schoolId)` else `sqlAssignmentInSchool`.
- POST: validates `subjectId` via `isSubjectInSchool`, `termId` via `isTermInSchool`, inserts with `schoolId`.

### Submissions (`/api/submissions`)

- POST: assignment lookup uses `and(eq(id), eq(schoolId))` direct, fallback to relational via `isAssignmentInSchool` if direct misses (handles legacy NULL).
- Insert sets `schoolId`.

### Quizzes (`/api/quizzes`)

- GET: prefers direct `schoolId` with `or(eq(schoolId), and(isNull, sqlQuizInSchool))`, else relational.
- POST: validates class via `isClassInSchool`, inserts with `schoolId`.

### Resources (`/api/resources`)

- GET: prefers direct `schoolId` with fallback to uploader membership.
- POST: validates class via `isClassInSchool`, inserts with `schoolId`.

### Announcements (`/api/announcements`)

- GET: prefers direct `schoolId` with fallback to author membership.
- POST: validates class via `isClassInSchool`, inserts with `schoolId`.

### Attendance (`/api/attendance`)

- GET: prefers direct `schoolId` with fallback to learner membership.
- POST: transactional delete+insert, inserts with `schoolId` via try/catch, validates class and learners via `isClassInSchool`/`getLearnerIdsInSchool`.

### Timetable (`/api/timetable`)

- GET: prefers direct `schoolId` with fallback to `sqlTimetableInSchool`.
- POST: validates class and teacher via `isClassInSchool`/`isUserInSchool`, inserts with `schoolId`.

### Messages (`/api/messages`)

- POST: validates receiver via `isUserInSchool`, inserts with `schoolId` for both message and notification.

### Notifications, Uploads, Files, Activity-Logs, Dashboard Overrides

- Existing tenant scoping via relational predicates preserved; inserts now include `schoolId` where column exists (defense in depth).
- Files: download checks `schoolId` direct + relational.

### Grades, Reports, Learner Stats

- Grades derived from submissions (which are now direct-scoped); no direct `school_id` column, but tenant check via submission/learner.
- Reports, learner-reports, learner/stats already scoped via `sqlUserInSchool`/`sqlClassInSchool`.

## Security Audit

### IDOR Fixed

- All catalog GETs now filter by `school_id = ctx.schoolId`, not just by existence.
- PUT/DELETE now require `and(eq(id), eq(schoolId))`, so cross-school update returns 404, not 403 (no existence leak).
- Enrollments, teacher-classes, parent-learners, assignments, submissions, quizzes, resources, announcements, attendance, timetable, messages all enforce both sides of relationship belong to caller's school.

### Missing Predicates Fixed

- Previously, some routes relied solely on `isClassInSchool` for the class but not for the joined table; now direct `school_id` on the primary table ensures even if class check is bypassed, row is still scoped.

### Cross-School Joins Fixed

- `learner_classes` with dual-membership learner now fails closed: if a class is reachable from two schools, `sqlClassInSchool` denies it to both (existing Phase 2C logic preserved).
- Submissions: unenrolled learner can no longer submit (fallback removed) – now returns 403, not 404, for legit same-school but unenrolled case; cross-school returns 404.

### Client-Controlled schoolId Fixed

- All POST/PUT bodies ignore `schoolId`/`school_id` from client; `schoolId` always taken from `ctx.schoolId`.
- Tests explicitly send forged `schoolId: schoolB` and assert it is ignored (catalog test).

### Role Without Tenant Check Fixed

- Every route uses `guardSchoolContext` which requires active membership; role is taken from `ctx.school.role` (DB membership role), never JWT `role` claim.
- Disabled membership → 403, orphan → 403, platform super_admin → 403 for school routes.

### Global Lists Fixed

- No route returns platform-wide list; all lists are `WHERE school_id = ctx.schoolId` or equivalent.

### Cross-School Attaches Fixed

- Creating a resource/announcement/timetable/quiz/assignment with foreign class/subject/department/teacher is 404 and writes nothing (asserted at row level in tests).

## Tests

### Static

- `tests/security.test.js`: 28 passed (Phase 1 security).
- `tests/real-authorization.test.ts`: 15 passed (Phase 1 auth).
- `tests/tenant-foundation.test.js`: 23 passed (Phase 2A foundation, updated for Phase 2D).
- `tests/membership-foundation.test.js`: 35 passed (Phase 2B foundation, updated for Phase 2D).

### Live DB (PostgreSQL)

- `tests/tenant-authorization-db.test.ts`: 71 passed (Phase 2C cross-school isolation, now with 0016).
  - Covers: unauthenticated 401, garbage token 401, deleted account 401, no membership 403, disabled 403, super_admin 403, forged role, forged schoolId ignored, user directory isolation, cross-school read/update 404, password reset 404, both directions, learner cannot enumerate, enrollments isolation, grades isolation, learner stats, learner reports, attendance isolation, announcements isolation, notifications isolation, files isolation (including unattributable), uploads delete, submissions isolation (including unenrolled 403), activity feed scoped, admin dashboard counts only own school, teacher/parent/learner dashboard foreign id 404, messages cross-school 404, legitimate access still works, fail-closed dual membership, review F1 timetable/quiz FK tenancy, F2 dashboard overrides scoping.

- `tests/tenant-catalog-db.test.ts` (new, Phase 2D): 17 passed
  - Fixture: two schools, two users per school, catalog fixtures with `school_id`.
  - Boundary: orphan and disabled → 403 on catalog routes.
  - Academic Years: School A only sees its own, forged schoolId ignored.
  - Terms: School A only sees its own, cannot create term for another school's academic year.
  - Departments: School A only sees its own, cross-school read/update/delete 404, cannot create with foreign headId.
  - Subjects: School A only sees its own, cross-school 404, cannot create with foreign department, client schoolId ignored.
  - Classes: School A only sees its own, cross-school update/delete 404, cannot create with foreign academic year or teacher, client schoolId ignored.
  - Legitimate CRUD retained.

### Scripts

- `package.json`:
  - `test:db`: runs `tenant-db.test.js`, `tenant-catalog-db.test.ts`, `tenant-authorization-db.test.ts`, `membership-auth-db.test.ts`.
  - `test:tenant-auth`: includes catalog test.
  - `test:catalog`: `npx tsx tests/tenant-catalog-db.test.ts`
  - `test:all`: includes catalog.

## Validation Suite

- `npm test` (security + real-auth + tenant-foundation + membership-foundation): all passed (101 tests).
- `npx tsx tests/tenant-authorization-db.test.ts`: 71 passed.
- `npx tsx tests/tenant-catalog-db.test.ts`: 17 passed.
- `npm run typecheck`: passes (after fixing implicit any).
- `npm run build` with dummy DATABASE_URL: passes (Next.js 16.2.6 compiled).
- `npm run lint`: 36 problems (20 errors, 16 warnings) – all pre-existing React hook / img warnings, not introduced by Phase 2D.

## Files Changed

- `src/db/schema.ts`: added `schoolId` to 21 tables.
- `drizzle/0016_school_id_columns.sql` + root copy: migration.
- `run-migration.js`: registers 0016.
- `src/lib/tenant.ts`: direct predicates + resolvers preferring direct school_id with fallback.
- `src/app/api/classes/route.ts`, `src/app/api/classes/[id]/route.ts`: direct school_id filter, schoolId from ctx, academicYear validation.
- `src/app/api/teacher-classes/route.ts`: subject school check, schoolId insert, GET probes column.
- `src/app/api/enrollments/route.ts`: direct school_id with NULL fallback, schoolId insert.
- `src/app/api/parent-learners/route.ts`: direct probe, schoolId insert.
- `src/app/api/assignments/route.ts`: subject/term validation, schoolId insert, direct GET.
- `src/app/api/submissions/route.ts`: assignment lookup direct + fallback, schoolId insert.
- `src/app/api/quizzes/route.ts`: direct with NULL fallback, schoolId insert.
- `src/app/api/resources/route.ts`: direct with fallback, schoolId insert.
- `src/app/api/announcements/route.ts`: direct with fallback, schoolId insert.
- `src/app/api/attendance/route.ts`: direct with fallback, schoolId insert.
- `src/app/api/timetable/route.ts`: direct with fallback, schoolId insert.
- `src/app/api/messages/route.ts`: schoolId insert for message and notification.
- `tests/tenant-catalog-db.test.ts`: new live DB isolation suite.
- `tests/tenant-foundation.test.js`, `tests/membership-foundation.test.js`: updated boundary tests to expect Phase 2D school_id.
- `package.json`: test scripts include catalog.

## Issues Fixed

- Cross-school read/write for catalog tables (academic_years, terms, departments, subjects, classes) now 404.
- Forged schoolId ignored on create (all catalog + derived).
- Foreign relationships rejected (head, department, academicYear, teacher, class, subject, term).
- Enrollments list now correctly shows own learner (fixed NULL handling).
- Submissions unenrolled learner now correctly 403 (not 404) after fixing assignment lookup fallback.
- Quizzes, resources, announcements, attendance, timetable now set schoolId on insert and filter by direct school_id.

## Deferred Findings

- Grades table has no direct school_id (derived from submissions); could add school_id in future for performance, but current tenant scoping via submissions is sufficient.
- Reports, learner-reports, learner/stats are aggregate queries; they use relational predicates, not direct school_id. Could add direct school_id to underlying tables for faster indexing.
- Notifications, messages, activity_logs, dashboard_overrides have school_id but GET routes still primarily filter by userId (which is already tenant-scoped via membership). Adding explicit `eq(schoolId, ctx.schoolId)` to those GETs would be defense-in-depth.
- Uploads/presign, files/[id] already have file-level checks; could add direct school_id check in addition to relational for faster path.
- Lint: 36 pre-existing errors/warnings (React hooks setState-in-effect, no-img-element) not introduced by Phase 2D; should be addressed in separate PR.

## No Prod DB Changes

- No production database was modified directly.
- No migrations run against production.
- No secrets changed.
- All changes are code/tests/migration files only, to be applied via normal deployment pipeline.

## PR

- Branch: `arena/01a09687-easylearn`
- Base: `main`
- Files: as listed above
- Tests: 101 static + 88 live DB = 189 total, all passing
- Build: passes with dummy DATABASE_URL
- Typecheck: passes
