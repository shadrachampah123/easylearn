# Production tenancy checkpoint — read-only operator procedure

**Purpose:** establish the actual production application/build and PostgreSQL tenancy state before any further Phase 2 schema work. This is an inspection plan only; it does not authorize a migration, data repair, deployment, or production write.

**Status (2026-10-18):** Not executed in production. SQL syntax was exercised against a migrated disposable PostgreSQL 18 database; no production database connection or credentials were used. Migration 0018 and migration-runner/history hardening are repository-only changes on an unmerged PR branch; they have not been deployed or run against production. The current 0018 SQL uses PostgreSQL 15+ selective column-list `ON DELETE SET NULL`; capture `server_version` in this read-only checkpoint and stop before any application if the deployed server is older or the version is uncertain. The successful GitHub Production deployment record is not evidence that migrations 0013–0017 ran or that a custom-domain alias serves that build.

## Safety and evidence rules

1. An authorized operator selects the intended Vercel project, production alias, and read-only database role. Confirm the target out-of-band before running SQL. Do not paste connection strings, credentials, customer records, or personal data into tickets/chat.
2. Record UTC time, project/alias, deployment ID and commit SHA from the provider's read-only deployment UI/API. Preserve sanitized output only. Deployment identity and DB state are separate evidence.
3. Connect with a database role that lacks write privileges. Run each SQL block in a fresh session; each block starts a repeatable-read, read-only transaction and rolls it back. The procedure does not call the application migration runner. The SQL blocks contain only catalog/data `SELECT`s plus transaction-local settings and `ROLLBACK`; no migration ledger is created or baselined.
4. Do not “fix” missing schema, constraints, nulls, or cross-school relationships from this session. Any anomaly is a stop condition; preserve the evidence and request a separately reviewed, backup-rehearsed remediation plan.
5. If any relation/column is missing, stop that query batch and record the missing object. Do not infer that an older database is safe because later queries failed.

## Read-only PostgreSQL inspection

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';

-- Capture target identity without exposing connection details.
SELECT current_database() AS database_name,
       current_user AS inspection_role,
       current_setting('server_version') AS postgres_version,
       current_setting('server_version_num') AS postgres_version_num,
       current_setting('transaction_read_only') AS read_only;

-- 0016/0017 direct-school columns. Required A-class tables from migration 0017.
WITH expected(table_name) AS (
  VALUES ('academic_years'), ('terms'), ('departments'), ('classes'), ('subjects'),
         ('teacher_classes'), ('learner_classes'), ('parent_learners'), ('assignments'),
         ('submissions'), ('uploaded_files'), ('resources'), ('quizzes'), ('quiz_attempts'),
         ('announcements'), ('notifications'), ('attendance'), ('timetable_entries'),
         ('messages'), ('dashboard_card_overrides'), ('gallery_items'), ('news'),
         ('faqs'), ('downloads'), ('school_users')
)
SELECT e.table_name,
       (c.table_name IS NOT NULL) AS has_school_id,
       c.is_nullable,
       c.data_type
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = e.table_name
 AND c.column_name = 'school_id'
ORDER BY e.table_name;

-- Required tables (the 24-table 0017 set) must have zero NULL attribution.
SELECT 'academic_years' AS table_name, count(*) AS null_school_id FROM public.academic_years WHERE school_id IS NULL
UNION ALL SELECT 'terms', count(*) FROM public.terms WHERE school_id IS NULL
UNION ALL SELECT 'departments', count(*) FROM public.departments WHERE school_id IS NULL
UNION ALL SELECT 'classes', count(*) FROM public.classes WHERE school_id IS NULL
UNION ALL SELECT 'subjects', count(*) FROM public.subjects WHERE school_id IS NULL
UNION ALL SELECT 'teacher_classes', count(*) FROM public.teacher_classes WHERE school_id IS NULL
UNION ALL SELECT 'learner_classes', count(*) FROM public.learner_classes WHERE school_id IS NULL
UNION ALL SELECT 'parent_learners', count(*) FROM public.parent_learners WHERE school_id IS NULL
UNION ALL SELECT 'assignments', count(*) FROM public.assignments WHERE school_id IS NULL
UNION ALL SELECT 'submissions', count(*) FROM public.submissions WHERE school_id IS NULL
UNION ALL SELECT 'uploaded_files', count(*) FROM public.uploaded_files WHERE school_id IS NULL
UNION ALL SELECT 'resources', count(*) FROM public.resources WHERE school_id IS NULL
UNION ALL SELECT 'quizzes', count(*) FROM public.quizzes WHERE school_id IS NULL
UNION ALL SELECT 'quiz_attempts', count(*) FROM public.quiz_attempts WHERE school_id IS NULL
UNION ALL SELECT 'announcements', count(*) FROM public.announcements WHERE school_id IS NULL
UNION ALL SELECT 'notifications', count(*) FROM public.notifications WHERE school_id IS NULL
UNION ALL SELECT 'attendance', count(*) FROM public.attendance WHERE school_id IS NULL
UNION ALL SELECT 'timetable_entries', count(*) FROM public.timetable_entries WHERE school_id IS NULL
UNION ALL SELECT 'messages', count(*) FROM public.messages WHERE school_id IS NULL
UNION ALL SELECT 'dashboard_card_overrides', count(*) FROM public.dashboard_card_overrides WHERE school_id IS NULL
UNION ALL SELECT 'gallery_items', count(*) FROM public.gallery_items WHERE school_id IS NULL
UNION ALL SELECT 'news', count(*) FROM public.news WHERE school_id IS NULL
UNION ALL SELECT 'faqs', count(*) FROM public.faqs WHERE school_id IS NULL
UNION ALL SELECT 'downloads', count(*) FROM public.downloads WHERE school_id IS NULL
ORDER BY table_name;

-- activity_logs is intentionally different: NULL means a platform-level event.
SELECT count(*) AS activity_log_null_school_id_allowed FROM public.activity_logs WHERE school_id IS NULL;

-- Count schools and active memberships only; do not export school/user names or emails.
SELECT count(*) AS school_count FROM public.schools;
SELECT status, count(*) AS membership_count
FROM public.school_users
GROUP BY status
ORDER BY status;

-- 0016 FKs to schools must exist and be validated. Preserve exact constraint names/states.
SELECT c.conrelid::regclass AS source_table,
       c.conname,
       c.convalidated,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND c.contype = 'f'
  AND c.confrelid = 'public.schools'::regclass
ORDER BY c.conrelid::regclass::text, c.conname;

-- The hardened runner's ledger is only a recorded migration history, not proof of live
-- schema/data state. It may be absent on an existing database and must not be created or
-- baselined during this read-only checkpoint.
SELECT to_regclass('public.easylearn_schema_migrations') IS NOT NULL AS migration_history_table_present;

-- If the ledger is present, inspect its content in a separate read-only statement after
-- confirming the relation exists; compare names/checksums with the reviewed migration files.
-- Do not infer a production baseline from an absent ledger or populate it from this session.

-- Approximate size/row-count context for 0018's directly affected tables. These catalog
-- estimates are not exact counts; the relationship mismatch checks below are exact scans.
WITH expected(table_name) AS (
  VALUES ('academic_years'), ('terms'), ('departments'), ('classes'), ('subjects'),
         ('teacher_classes'), ('learner_classes'), ('assignments'), ('submissions'),
         ('uploaded_files'), ('resources'), ('quizzes'), ('quiz_attempts'),
         ('announcements'), ('attendance'), ('timetable_entries')
)
SELECT e.table_name,
       GREATEST(c.reltuples, 0)::bigint AS estimated_rows,
       pg_total_relation_size(c.oid) AS total_relation_bytes
FROM expected e
LEFT JOIN pg_class c ON c.oid = to_regclass(format('public.%I', e.table_name))
ORDER BY e.table_name;

-- 0018 expected validated composite foreign keys (26). This remains pending until reviewed,
-- deployed, and independently confirmed in production.
WITH expected(table_name, constraint_name) AS (
  VALUES
    ('terms','terms_school_academic_year_fk'), ('classes','classes_school_academic_year_fk'),
    ('subjects','subjects_school_department_fk'), ('teacher_classes','teacher_classes_school_class_fk'),
    ('teacher_classes','teacher_classes_school_subject_fk'), ('teacher_classes','teacher_classes_school_academic_year_fk'),
    ('learner_classes','learner_classes_school_class_fk'), ('learner_classes','learner_classes_school_academic_year_fk'),
    ('assignments','assignments_school_class_fk'), ('assignments','assignments_school_subject_fk'),
    ('assignments','assignments_school_term_fk'), ('submissions','submissions_school_assignment_fk'),
    ('uploaded_files','uploaded_files_school_assignment_fk'), ('resources','resources_school_class_fk'),
    ('resources','resources_school_subject_fk'), ('resources','resources_school_term_fk'),
    ('quizzes','quizzes_school_class_fk'), ('quizzes','quizzes_school_subject_fk'),
    ('quizzes','quizzes_school_term_fk'), ('quiz_attempts','quiz_attempts_school_quiz_fk'),
    ('announcements','announcements_school_class_fk'), ('attendance','attendance_school_class_fk'),
    ('timetable_entries','timetable_entries_school_class_fk'),
    ('timetable_entries','timetable_entries_school_subject_fk'),
    ('timetable_entries','timetable_entries_school_term_fk'),
    ('timetable_entries','timetable_entries_school_academic_year_fk')
)
SELECT e.table_name, e.constraint_name, c.convalidated,
       pg_get_constraintdef(c.oid) AS definition
FROM expected e
LEFT JOIN pg_constraint c
  ON c.conname = e.constraint_name
 AND c.conrelid = to_regclass(format('public.%I', e.table_name))
ORDER BY e.table_name, e.constraint_name;

-- 0017 UNIQUE (school_id, id) targets must be valid and unique (24 expected).
SELECT tablename, indexname, indexdef,
       i.indisvalid AS is_valid,
       i.indisready AS is_ready,
       i.indisunique AS is_unique
FROM pg_indexes p
JOIN pg_class x ON x.relname = p.indexname AND x.relnamespace = 'public'::regnamespace
JOIN pg_index i ON i.indexrelid = x.oid
WHERE p.schemaname = 'public'
  AND p.indexname IN (
    'academic_years_school_id_id_unique', 'terms_school_id_id_unique',
    'departments_school_id_id_unique', 'classes_school_id_id_unique',
    'subjects_school_id_id_unique', 'teacher_classes_school_id_id_unique',
    'learner_classes_school_id_id_unique', 'parent_learners_school_id_id_unique',
    'assignments_school_id_id_unique', 'submissions_school_id_id_unique',
    'uploaded_files_school_id_id_unique', 'resources_school_id_id_unique',
    'quizzes_school_id_id_unique', 'quiz_attempts_school_id_id_unique',
    'announcements_school_id_id_unique', 'notifications_school_id_id_unique',
    'attendance_school_id_id_unique', 'timetable_entries_school_id_id_unique',
    'messages_school_id_id_unique', 'dashboard_card_overrides_school_id_id_unique',
    'gallery_items_school_id_id_unique', 'news_school_id_id_unique',
    'faqs_school_id_id_unique', 'downloads_school_id_id_unique'
  )
ORDER BY tablename, indexname;

-- 0018 composite-FK relationships. Zero mismatch/orphan counts are expected.
-- NULL optional references are intentionally excluded.
SELECT 'terms.academic_year' AS relationship, count(*) AS mismatch_count
FROM public.terms c LEFT JOIN public.academic_years p ON p.id = c.academic_year_id
WHERE c.academic_year_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'classes.academic_year' AS relationship, count(*) AS mismatch_count
FROM public.classes c LEFT JOIN public.academic_years p ON p.id = c.academic_year_id
WHERE c.academic_year_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'subjects.department' AS relationship, count(*) AS mismatch_count
FROM public.subjects c LEFT JOIN public.departments p ON p.id = c.department_id
WHERE c.department_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'teacher_classes.class' AS relationship, count(*) AS mismatch_count
FROM public.teacher_classes c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'teacher_classes.subject' AS relationship, count(*) AS mismatch_count
FROM public.teacher_classes c LEFT JOIN public.subjects p ON p.id = c.subject_id
WHERE c.subject_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'teacher_classes.academic_year' AS relationship, count(*) AS mismatch_count
FROM public.teacher_classes c LEFT JOIN public.academic_years p ON p.id = c.academic_year_id
WHERE c.academic_year_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'learner_classes.class' AS relationship, count(*) AS mismatch_count
FROM public.learner_classes c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'learner_classes.academic_year' AS relationship, count(*) AS mismatch_count
FROM public.learner_classes c LEFT JOIN public.academic_years p ON p.id = c.academic_year_id
WHERE c.academic_year_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'assignments.class' AS relationship, count(*) AS mismatch_count
FROM public.assignments c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'assignments.subject' AS relationship, count(*) AS mismatch_count
FROM public.assignments c LEFT JOIN public.subjects p ON p.id = c.subject_id
WHERE c.subject_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'assignments.term' AS relationship, count(*) AS mismatch_count
FROM public.assignments c LEFT JOIN public.terms p ON p.id = c.term_id
WHERE c.term_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'submissions.assignment' AS relationship, count(*) AS mismatch_count
FROM public.submissions c LEFT JOIN public.assignments p ON p.id = c.assignment_id
WHERE c.assignment_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'uploaded_files.assignment' AS relationship, count(*) AS mismatch_count
FROM public.uploaded_files c LEFT JOIN public.assignments p ON p.id = c.assignment_id
WHERE c.assignment_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'resources.class' AS relationship, count(*) AS mismatch_count
FROM public.resources c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'resources.subject' AS relationship, count(*) AS mismatch_count
FROM public.resources c LEFT JOIN public.subjects p ON p.id = c.subject_id
WHERE c.subject_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'resources.term' AS relationship, count(*) AS mismatch_count
FROM public.resources c LEFT JOIN public.terms p ON p.id = c.term_id
WHERE c.term_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'quizzes.class' AS relationship, count(*) AS mismatch_count
FROM public.quizzes c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'quizzes.subject' AS relationship, count(*) AS mismatch_count
FROM public.quizzes c LEFT JOIN public.subjects p ON p.id = c.subject_id
WHERE c.subject_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'quizzes.term' AS relationship, count(*) AS mismatch_count
FROM public.quizzes c LEFT JOIN public.terms p ON p.id = c.term_id
WHERE c.term_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'quiz_attempts.quiz' AS relationship, count(*) AS mismatch_count
FROM public.quiz_attempts c LEFT JOIN public.quizzes p ON p.id = c.quiz_id
WHERE c.quiz_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'announcements.class' AS relationship, count(*) AS mismatch_count
FROM public.announcements c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'attendance.class' AS relationship, count(*) AS mismatch_count
FROM public.attendance c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'timetable_entries.class' AS relationship, count(*) AS mismatch_count
FROM public.timetable_entries c LEFT JOIN public.classes p ON p.id = c.class_id
WHERE c.class_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'timetable_entries.subject' AS relationship, count(*) AS mismatch_count
FROM public.timetable_entries c LEFT JOIN public.subjects p ON p.id = c.subject_id
WHERE c.subject_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'timetable_entries.term' AS relationship, count(*) AS mismatch_count
FROM public.timetable_entries c LEFT JOIN public.terms p ON p.id = c.term_id
WHERE c.term_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'timetable_entries.academic_year' AS relationship, count(*) AS mismatch_count
FROM public.timetable_entries c LEFT JOIN public.academic_years p ON p.id = c.academic_year_id
WHERE c.academic_year_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)
UNION ALL
SELECT 'parent_learners.parent_membership', count(*)
FROM public.parent_learners pl
WHERE NOT EXISTS (
  SELECT 1 FROM public.school_users su
  WHERE su.user_id = pl.parent_id AND su.school_id = pl.school_id AND su.status = 'active'
)
UNION ALL
SELECT 'parent_learners.learner_membership', count(*)
FROM public.parent_learners pl
WHERE NOT EXISTS (
  SELECT 1 FROM public.school_users su
  WHERE su.user_id = pl.learner_id AND su.school_id = pl.school_id AND su.status = 'active'
)
ORDER BY relationship;
ROLLBACK;
```

The `ROLLBACK` ends each read-only transaction without changing data. Repeatable read makes the result set internally consistent, but the long-lived snapshot can delay vacuum cleanup. Exact mismatch/NULL counts may scan large tables and impose I/O load; obtain DBA approval for the query window and stop on timeout rather than raising limits or switching to a write-capable role.

## Conditional migration-history query (only when ledger presence is true)

Run only after the preceding `migration_history_table_present` result is `true`. This is a separate read-only session/query; it does not create, baseline, or modify the ledger.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';

SELECT filename, checksum, applied_at
FROM public.easylearn_schema_migrations
ORDER BY filename;

ROLLBACK;
```

If the ledger is absent, do not run this block. Record “history ledger unavailable; applied migration sequence/checksums unverified” and continue only with the read-only catalog/data evidence. The operator must not infer the applied prefix from the repository's Drizzle journal or create a replacement ledger.

## Evidence interpretation and stop conditions

- The expected relation list must be present. `school_id` must be `NOT NULL` on all 24 tables in the 0017 list; `school_users.school_id` is also required. `activity_logs.school_id` may remain nullable for platform events.
- Each required null count and every core relationship mismatch above must be zero. Any nonzero value is an investigation/remediation item, not permission to stamp or move rows.
- The 0016 school FKs must exist and be validated. The 24 0017 unique targets must be valid, ready, and unique. The 26 expected 0018 composite constraints are future work until their migration is independently reviewed, safely applied under separate authorization, and then appear validated. Capture counts and exact definitions; do not infer application of migrations from a successful deployment.
- The repository's prior runner had no applied-migration ledger. The new runner adds a checksum ledger, transactions, and advisory locking on an unmerged branch; production state is still unknown. Do not treat an absent ledger, a Drizzle journal row, runner-log absence, or deployment status as proof of execution. Catalog and data evidence are required. The explicit `--baseline` command only records an operator assertion; it does not verify database state and must not be used as a substitute for this verification.
- The SQL batch reports whether `public.easylearn_schema_migrations` exists. **Only if that result is true**, open a fresh read-only transaction and run the conditional history query below. If false, report the ledger as unavailable; do not run the query, invoke `run-migration.js`, or baseline the database. Compare returned checksums with the immutable migration files from the deployment/code revision claimed to have applied them—not just the current working branch. Report gaps, unknown filenames, or mismatches as unresolved; a ledger is a record, not proof, and must be corroborated against catalog/data state.
- This procedure deliberately excludes live application smoke tests. Login, GET routes, and dashboards can write rate-limit, session, last-login, or audit records even when the requested operation appears read-only. Any behavior test needs separate authorization and a demonstrated non-mutating method; prefer staging/test fixtures. Do not treat that as part of this read-only checkpoint.

## Required operator report (sanitized)

Return only: UTC timestamp; intended Vercel project/production alias; deployment ID and commit SHA; database/version identity including `server_version` and `server_version_num` (no hostname or credentials); 25-row column/nullability result; required NULL counts; activity-log NULL count; school and membership counts; table-size estimates; ledger presence and, only if present, sanitized filename/checksum/applied-at rows; validated school-FK count; valid 0017 target-index count; 0018 composite-constraint definitions/state; mismatch counts; query failures/timeouts. Do not include application smoke-test results in this read-only report. Redact personal data and all connection/configuration secrets.

**If production DB access is unavailable:** report that the production DB gate remains unverified and provide this procedure to the authorized operator. Do not attempt a production connection, request a credential, run `run-migration.js`, or infer database state from deployment records.
