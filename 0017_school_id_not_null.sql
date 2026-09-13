-- 0017: Phase 2E — Enforce school_id integrity on school-owned tables
-- See docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md §5, §13, §14 steps 8–9
-- and Phase 2E Step 1 (PR #21: stop NULL school_id writes).
--
-- CONTEXT
--   Migration 0016 added nullable school_id + FK + index + CBISM backfill to every
--   A-class table. Phase 2E Step 1 stopped new NULL school_id writes. Live audit
--   confirmed the tenancy foundation is sound (26 school-scoped tables, FKs valid,
--   indexes present, one active school = CBISM, zero orphan school_id refs) with a
--   small residual of legacy NULL school_id rows that must be resolved safely.
--
-- WHAT THIS MIGRATION DOES
--   1. Deterministically backfill remaining NULL school_id values from parent /
--      relationship rows (never invents tenancy).
--   2. Only when EXACTLY one schools row exists, stamp any still-NULL A-table rows
--      to that single school (the live DB has one school: CBISM). With >1 school,
--      unresolved rows are NOT blindly assigned — the migration aborts instead of
--      guessing.
--   3. activity_logs.school_id STAYS NULLABLE forever (platform events = NULL per
--      plan §5 / §14). Historical NULL activity rows may be stamped only when the
--      actor has exactly one school membership; remaining NULL platform rows are
--      intentional and left alone.
--   4. After proving zero NULLs on required tables, SET school_id NOT NULL on every
--      A-class table except activity_logs.
--   5. Add UNIQUE (school_id, id) targets so later composite FKs can reference
--      school-scoped parents (plan §13). Existing school_id FKs and indexes are
--      preserved untouched.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * no DROP of existing FKs or indexes
--   * no composite FK enforcement yet (separate later step; UNIQUE targets only)
--   * no RLS, no subdomain/middleware work, no application behaviour change
--   * no production data modification outside this migration's own SQL
--   * no blind multi-school CBISM stamp
--
-- IDEMPOTENCY
--   Safe to re-run: backfills are WHERE school_id IS NULL, SET NOT NULL is guarded
--   by is_nullable checks, UNIQUE indexes use IF NOT EXISTS. A re-run on an already
--   enforced database is a no-op.
--
-- FAILURE MODE
--   If any required table still has NULL school_id after the deterministic backfill
--   (e.g. multi-school DB with unresolvable orphans), the migration RAISE EXCEPTION
--   and does NOT apply NOT NULL — operators must resolve those rows manually.

--> statement-breakpoint
-- ── 1. Deterministic relational backfill (parent / relationship derived) ──────
-- Only fills WHERE school_id IS NULL. Existing non-NULL values are never touched.

-- terms ← academic_years
UPDATE "terms" t
   SET "school_id" = ay."school_id"
  FROM "academic_years" ay
 WHERE t."school_id" IS NULL
   AND t."academic_year_id" = ay."id"
   AND ay."school_id" IS NOT NULL;

--> statement-breakpoint
-- subjects ← departments
UPDATE "subjects" s
   SET "school_id" = d."school_id"
  FROM "departments" d
 WHERE s."school_id" IS NULL
   AND s."department_id" = d."id"
   AND d."school_id" IS NOT NULL;

--> statement-breakpoint
-- classes ← academic_years
UPDATE "classes" c
   SET "school_id" = ay."school_id"
  FROM "academic_years" ay
 WHERE c."school_id" IS NULL
   AND c."academic_year_id" = ay."id"
   AND ay."school_id" IS NOT NULL;

--> statement-breakpoint
-- teacher_classes ← classes
UPDATE "teacher_classes" tc
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE tc."school_id" IS NULL
   AND tc."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- learner_classes ← classes
UPDATE "learner_classes" lc
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE lc."school_id" IS NULL
   AND lc."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- parent_learners ← shared membership of parent AND learner (same single school only)
UPDATE "parent_learners" pl
   SET "school_id" = shared."school_id"
  FROM (
    SELECT psu."user_id" AS parent_id,
           lsu."user_id" AS learner_id,
           psu."school_id"
      FROM "school_users" psu
      JOIN "school_users" lsu
        ON lsu."school_id" = psu."school_id"
       AND lsu."user_id" <> psu."user_id"
     WHERE psu."status" <> 'disabled'
       AND lsu."status" <> 'disabled'
  ) shared
 WHERE pl."school_id" IS NULL
   AND pl."parent_id" = shared.parent_id
   AND pl."learner_id" = shared.learner_id
   -- only when the pair shares exactly one school (no multi-school ambiguity)
   AND (
     SELECT count(DISTINCT psu2."school_id")
       FROM "school_users" psu2
       JOIN "school_users" lsu2
         ON lsu2."school_id" = psu2."school_id"
      WHERE psu2."user_id" = pl."parent_id"
        AND lsu2."user_id" = pl."learner_id"
        AND psu2."status" <> 'disabled'
        AND lsu2."status" <> 'disabled'
   ) = 1;

--> statement-breakpoint
-- assignments ← classes
UPDATE "assignments" a
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE a."school_id" IS NULL
   AND a."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- submissions ← assignments
UPDATE "submissions" s
   SET "school_id" = a."school_id"
  FROM "assignments" a
 WHERE s."school_id" IS NULL
   AND s."assignment_id" = a."id"
   AND a."school_id" IS NOT NULL;

--> statement-breakpoint
-- uploaded_files ← assignment (when attached)
UPDATE "uploaded_files" f
   SET "school_id" = a."school_id"
  FROM "assignments" a
 WHERE f."school_id" IS NULL
   AND f."assignment_id" = a."id"
   AND a."school_id" IS NOT NULL;

--> statement-breakpoint
-- uploaded_files ← uploader's sole active membership (when no assignment link)
UPDATE "uploaded_files" f
   SET "school_id" = sole."school_id"
  FROM (
    SELECT su."user_id", min(su."school_id"::text)::uuid AS school_id
      FROM "school_users" su
     WHERE su."status" <> 'disabled'
     GROUP BY su."user_id"
    HAVING count(DISTINCT su."school_id") = 1
  ) sole
 WHERE f."school_id" IS NULL
   AND f."uploader_id" = sole."user_id";

--> statement-breakpoint
-- resources ← classes (when class-linked)
UPDATE "resources" r
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE r."school_id" IS NULL
   AND r."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- resources ← teacher's sole active membership
UPDATE "resources" r
   SET "school_id" = sole."school_id"
  FROM (
    SELECT su."user_id", min(su."school_id"::text)::uuid AS school_id
      FROM "school_users" su
     WHERE su."status" <> 'disabled'
     GROUP BY su."user_id"
    HAVING count(DISTINCT su."school_id") = 1
  ) sole
 WHERE r."school_id" IS NULL
   AND r."teacher_id" = sole."user_id";

--> statement-breakpoint
-- quizzes ← classes
UPDATE "quizzes" q
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE q."school_id" IS NULL
   AND q."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- quiz_attempts ← quizzes
UPDATE "quiz_attempts" qa
   SET "school_id" = q."school_id"
  FROM "quizzes" q
 WHERE qa."school_id" IS NULL
   AND qa."quiz_id" = q."id"
   AND q."school_id" IS NOT NULL;

--> statement-breakpoint
-- announcements ← class (when class-scoped)
UPDATE "announcements" a
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE a."school_id" IS NULL
   AND a."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- announcements ← author's sole active membership
UPDATE "announcements" a
   SET "school_id" = sole."school_id"
  FROM (
    SELECT su."user_id", min(su."school_id"::text)::uuid AS school_id
      FROM "school_users" su
     WHERE su."status" <> 'disabled'
     GROUP BY su."user_id"
    HAVING count(DISTINCT su."school_id") = 1
  ) sole
 WHERE a."school_id" IS NULL
   AND a."author_id" = sole."user_id";

--> statement-breakpoint
-- notifications ← recipient's sole active membership
UPDATE "notifications" n
   SET "school_id" = sole."school_id"
  FROM (
    SELECT su."user_id", min(su."school_id"::text)::uuid AS school_id
      FROM "school_users" su
     WHERE su."status" <> 'disabled'
     GROUP BY su."user_id"
    HAVING count(DISTINCT su."school_id") = 1
  ) sole
 WHERE n."school_id" IS NULL
   AND n."user_id" = sole."user_id";

--> statement-breakpoint
-- attendance ← classes
UPDATE "attendance" att
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE att."school_id" IS NULL
   AND att."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- timetable_entries ← classes
UPDATE "timetable_entries" te
   SET "school_id" = c."school_id"
  FROM "classes" c
 WHERE te."school_id" IS NULL
   AND te."class_id" = c."id"
   AND c."school_id" IS NOT NULL;

--> statement-breakpoint
-- messages ← sender+receiver shared sole school
UPDATE "messages" m
   SET "school_id" = shared."school_id"
  FROM (
    SELECT ssu."user_id" AS sender_id,
           rsu."user_id" AS receiver_id,
           ssu."school_id"
      FROM "school_users" ssu
      JOIN "school_users" rsu
        ON rsu."school_id" = ssu."school_id"
     WHERE ssu."status" <> 'disabled'
       AND rsu."status" <> 'disabled'
  ) shared
 WHERE m."school_id" IS NULL
   AND m."sender_id" = shared.sender_id
   AND m."receiver_id" = shared.receiver_id
   AND (
     SELECT count(DISTINCT ssu2."school_id")
       FROM "school_users" ssu2
       JOIN "school_users" rsu2
         ON rsu2."school_id" = ssu2."school_id"
      WHERE ssu2."user_id" = m."sender_id"
        AND rsu2."user_id" = m."receiver_id"
        AND ssu2."status" <> 'disabled'
        AND rsu2."status" <> 'disabled'
   ) = 1;

--> statement-breakpoint
-- dashboard_card_overrides ← creator's sole active membership
UPDATE "dashboard_card_overrides" d
   SET "school_id" = sole."school_id"
  FROM (
    SELECT su."user_id", min(su."school_id"::text)::uuid AS school_id
      FROM "school_users" su
     WHERE su."status" <> 'disabled'
     GROUP BY su."user_id"
    HAVING count(DISTINCT su."school_id") = 1
  ) sole
 WHERE d."school_id" IS NULL
   AND d."created_by" = sole."user_id";

--> statement-breakpoint
-- news ← author's sole active membership
UPDATE "news" n
   SET "school_id" = sole."school_id"
  FROM (
    SELECT su."user_id", min(su."school_id"::text)::uuid AS school_id
      FROM "school_users" su
     WHERE su."status" <> 'disabled'
     GROUP BY su."user_id"
    HAVING count(DISTINCT su."school_id") = 1
  ) sole
 WHERE n."school_id" IS NULL
   AND n."author_id" = sole."user_id";

--> statement-breakpoint
-- activity_logs ← actor's sole active membership (optional stamp; NULLs may remain)
UPDATE "activity_logs" al
   SET "school_id" = sole."school_id"
  FROM (
    SELECT su."user_id", min(su."school_id"::text)::uuid AS school_id
      FROM "school_users" su
     WHERE su."status" <> 'disabled'
     GROUP BY su."user_id"
    HAVING count(DISTINCT su."school_id") = 1
  ) sole
 WHERE al."school_id" IS NULL
   AND al."user_id" = sole."user_id";

--> statement-breakpoint
-- ── 2. Single-school residual backfill (safe only when exactly one school) ────
-- Live audit: one active school (CBISM). With a single school every remaining
-- school-owned NULL row is deterministically that school. With >1 school this
-- block is a no-op and step 3 will abort if NULLs remain.
DO $$
DECLARE
  v_school_count integer;
  v_only_school  uuid;
  v_stamped      integer := 0;
BEGIN
  SELECT count(*)::int INTO v_school_count FROM "schools";
  IF v_school_count <> 1 THEN
    RAISE NOTICE
      '0017: % school row(s) present — skipping single-school residual stamp (relational backfill only)',
      v_school_count;
    RETURN;
  END IF;

  SELECT "id" INTO v_only_school FROM "schools" LIMIT 1;

  UPDATE "academic_years"            SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  UPDATE "terms"                     SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "departments"               SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "classes"                   SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "subjects"                  SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "teacher_classes"           SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "learner_classes"           SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "parent_learners"           SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "assignments"               SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "submissions"               SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "uploaded_files"            SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "resources"                 SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "quizzes"                   SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "quiz_attempts"             SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "announcements"             SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "notifications"             SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "attendance"                SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "timetable_entries"         SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "messages"                  SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "dashboard_card_overrides"  SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "gallery_items"             SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "news"                      SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "faqs"                      SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  UPDATE "downloads"                 SET "school_id" = v_only_school WHERE "school_id" IS NULL;
  -- activity_logs intentionally NOT bulk-stamped here: platform rows stay NULL.

  RAISE NOTICE
    '0017: single-school residual stamp applied to school % (academic_years first-batch rows≈%)',
    v_only_school, v_stamped;
END $$;

--> statement-breakpoint
-- ── 3. Prove required tables are NULL-free, then SET NOT NULL ─────────────────
-- Aborts loudly if any required table still has NULL school_id. activity_logs is
-- excluded (nullable by design). school_users is already NOT NULL (0013).
DO $$
DECLARE
  v_table   text;
  v_nulls   bigint;
  v_bad     text[] := ARRAY[]::text[];
  v_tables  text[] := ARRAY[
    'academic_years',
    'terms',
    'departments',
    'classes',
    'subjects',
    'teacher_classes',
    'learner_classes',
    'parent_learners',
    'assignments',
    'submissions',
    'uploaded_files',
    'resources',
    'quizzes',
    'quiz_attempts',
    'announcements',
    'notifications',
    'attendance',
    'timetable_entries',
    'messages',
    'dashboard_card_overrides',
    'gallery_items',
    'news',
    'faqs',
    'downloads'
  ];
  -- Tables that already have school_id indexes from 0016; SET NOT NULL is the
  -- integrity step. FK constraints are left in place (validated, ON DELETE set null
  -- becomes effectively restrictive once the column is NOT NULL).
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE school_id IS NULL',
      v_table
    ) INTO v_nulls;
    IF v_nulls > 0 THEN
      v_bad := array_append(v_bad, format('%s=%s', v_table, v_nulls));
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '0017: refusing NOT NULL — unresolved NULL school_id remain: %. Resolve deterministically (or ensure a single school) and re-run.',
      array_to_string(v_bad, ', ');
  END IF;

  FOREACH v_table IN ARRAY v_tables LOOP
    -- Guard: only ALTER when still nullable (idempotent re-run).
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = v_table
         AND column_name = 'school_id'
         AND is_nullable = 'YES'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN school_id SET NOT NULL',
        v_table
      );
      RAISE NOTICE '0017: SET NOT NULL on %.school_id', v_table;
    ELSE
      RAISE NOTICE '0017: %.school_id already NOT NULL — skip', v_table;
    END IF;
  END LOOP;

  RAISE NOTICE '0017: NOT NULL enforced on % A-class tables; activity_logs.school_id remains nullable',
    array_length(v_tables, 1);
END $$;

--> statement-breakpoint
-- ── 4. UNIQUE (school_id, id) FK targets (plan §13) ───────────────────────────
-- Enables later composite FKs without rewriting parents. IF NOT EXISTS → idempotent.
-- school_id is NOT NULL on these tables after step 3, so (school_id, id) is a true key.
CREATE UNIQUE INDEX IF NOT EXISTS "academic_years_school_id_id_unique"
  ON "academic_years" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "terms_school_id_id_unique"
  ON "terms" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "departments_school_id_id_unique"
  ON "departments" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "classes_school_id_id_unique"
  ON "classes" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subjects_school_id_id_unique"
  ON "subjects" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teacher_classes_school_id_id_unique"
  ON "teacher_classes" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "learner_classes_school_id_id_unique"
  ON "learner_classes" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "parent_learners_school_id_id_unique"
  ON "parent_learners" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assignments_school_id_id_unique"
  ON "assignments" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "submissions_school_id_id_unique"
  ON "submissions" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uploaded_files_school_id_id_unique"
  ON "uploaded_files" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resources_school_id_id_unique"
  ON "resources" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quizzes_school_id_id_unique"
  ON "quizzes" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quiz_attempts_school_id_id_unique"
  ON "quiz_attempts" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "announcements_school_id_id_unique"
  ON "announcements" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_school_id_id_unique"
  ON "notifications" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_school_id_id_unique"
  ON "attendance" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "timetable_entries_school_id_id_unique"
  ON "timetable_entries" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_school_id_id_unique"
  ON "messages" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_card_overrides_school_id_id_unique"
  ON "dashboard_card_overrides" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gallery_items_school_id_id_unique"
  ON "gallery_items" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_school_id_id_unique"
  ON "news" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "faqs_school_id_id_unique"
  ON "faqs" USING btree ("school_id", "id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "downloads_school_id_id_unique"
  ON "downloads" USING btree ("school_id", "id");

--> statement-breakpoint
-- ── 5. Final report (read-only) ───────────────────────────────────────────────
DO $$
DECLARE
  v_activity_nulls bigint;
  v_schools        integer;
BEGIN
  SELECT count(*) INTO v_activity_nulls FROM "activity_logs" WHERE "school_id" IS NULL;
  SELECT count(*)::int INTO v_schools FROM "schools";
  RAISE NOTICE
    '0017 complete: schools=% ; activity_logs NULL school_id (platform/legacy, allowed)=%',
    v_schools, v_activity_nulls;
END $$;
