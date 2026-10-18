# Production tenancy checkpoint — read-only operator procedure

**Purpose:** establish the actual production application/build and PostgreSQL tenancy state before any further Phase 2 schema work. This is an inspection plan only; it does not authorize a migration, data repair, deployment, or production write.

**Status (2026-10-18):** Not executed in production. SQL syntax was exercised against a migrated disposable PostgreSQL 18 database; no production database connection or credentials were used. The successful GitHub Production deployment record is not evidence that migrations 0013–0017 ran or that a custom-domain alias serves that build.

## Safety and evidence rules

1. An authorized operator selects the intended Vercel project, production alias, and read-only database role. Confirm the target out-of-band before running SQL. Do not paste connection strings, credentials, customer records, or personal data into tickets/chat.
2. Record UTC time, project/alias, deployment ID and commit SHA from the provider's read-only deployment UI/API. Preserve sanitized output only. Deployment identity and DB state are separate evidence.
3. Connect with a role that cannot write. Run the SQL below in a fresh session. It starts a read-only transaction and does not call the application migration runner.
4. Do not “fix” missing schema, constraints, nulls, or cross-school relationships from this session. Any anomaly is a stop condition; preserve the evidence and request a separately reviewed, backup-rehearsed remediation plan.
5. If any relation/column is missing, stop that query batch and record the missing object. Do not infer that an older database is safe because later queries failed.

## Read-only PostgreSQL inspection

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';

-- Capture target identity without exposing connection details.
SELECT current_database() AS database_name,
       current_user AS inspection_role,
       current_setting('server_version') AS postgres_version,
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

-- Direct ownership inconsistencies in core relationships. Zero rows is expected.
-- This checks relational attribution; it does not replace the complete FK audit.
SELECT 'terms.academic_year' AS relationship, count(*) AS mismatch_count
FROM public.terms t JOIN public.academic_years y ON y.id = t.academic_year_id
WHERE t.school_id <> y.school_id
UNION ALL
SELECT 'classes.academic_year', count(*)
FROM public.classes c JOIN public.academic_years y ON y.id = c.academic_year_id
WHERE c.school_id <> y.school_id
UNION ALL
SELECT 'subjects.department', count(*)
FROM public.subjects s JOIN public.departments d ON d.id = s.department_id
WHERE s.school_id <> d.school_id
UNION ALL
SELECT 'teacher_classes.class', count(*)
FROM public.teacher_classes tc JOIN public.classes c ON c.id = tc.class_id
WHERE tc.school_id <> c.school_id
UNION ALL
SELECT 'teacher_classes.subject', count(*)
FROM public.teacher_classes tc JOIN public.subjects s ON s.id = tc.subject_id
WHERE tc.school_id <> s.school_id
UNION ALL
SELECT 'learner_classes.class', count(*)
FROM public.learner_classes lc JOIN public.classes c ON c.id = lc.class_id
WHERE lc.school_id <> c.school_id
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
UNION ALL
SELECT 'assignments.class', count(*)
FROM public.assignments a JOIN public.classes c ON c.id = a.class_id
WHERE a.school_id <> c.school_id
UNION ALL
SELECT 'assignments.subject', count(*)
FROM public.assignments a JOIN public.subjects s ON s.id = a.subject_id
WHERE a.school_id <> s.school_id
UNION ALL
SELECT 'assignments.term', count(*)
FROM public.assignments a JOIN public.terms t ON t.id = a.term_id
WHERE a.school_id <> t.school_id
UNION ALL
SELECT 'submissions.assignment', count(*)
FROM public.submissions s JOIN public.assignments a ON a.id = s.assignment_id
WHERE s.school_id <> a.school_id
ORDER BY relationship;

ROLLBACK;
```

The `ROLLBACK` ends the read-only transaction without changing data. Large production tables can make count checks expensive; the operator should obtain DBA approval for the query window and stop on timeout rather than raising limits or switching to a write-capable role.

## Evidence interpretation and stop conditions

- The expected relation list must be present. `school_id` must be `NOT NULL` on all 24 tables in the 0017 list; `school_users.school_id` is also required. `activity_logs.school_id` may remain nullable for platform events.
- Each required null count and every core relationship mismatch above must be zero. Any nonzero value is an investigation/remediation item, not permission to stamp or move rows.
- The 0016 school FKs must exist and be validated. The 24 0017 unique targets must be valid, ready, and unique. Capture the count and exact definitions; do not infer application of migrations from a successful deployment.
- The custom `run-migration.js` runner has no applied-migration ledger. Do not treat a Drizzle journal row, runner log absence, or deployment status as proof of execution. Catalog and data evidence are required.
- A successful read-only catalog check is still not proof of cross-school API behavior. Separately record non-mutating, role-approved smoke checks for one-school and dual-membership test accounts in each school. Do not seed or alter production data for those checks.

## Required operator report (sanitized)

Return only: UTC timestamp; project/alias; deployment ID and commit SHA; database/version identity (no hostname or credentials); the 25-row column/nullability result; required NULL counts; activity-log NULL count; school and membership counts; validated school-FK count; valid 0017 target-index count; mismatch counts; read-only application smoke-test outcomes; query failures/timeouts. Redact personal data and all connection/configuration secrets.

**If production DB access is unavailable:** report that the production DB gate remains unverified and provide this procedure to the authorized operator. Do not attempt a production connection, request a credential, run `run-migration.js`, or infer database state from deployment records.
