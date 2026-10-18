-- Phase 2: enforce tenant ownership at the database boundary for references between
-- school-owned records. The existing single-column FKs only prove that an id exists;
-- these composite FKs also require the referenced record to belong to the same school.
--
-- This migration deliberately does not repair mismatched data. It reports the affected
-- relationship and aborts atomically so operators can investigate before retrying.
DO $$
DECLARE
  rel record;
  child_oid oid;
  parent_oid oid;
  child_school_att smallint;
  child_ref_att smallint;
  parent_school_att smallint;
  parent_id_att smallint;
  violation_count bigint;
  expected_delete_code "char";
  existing_constraint record;
BEGIN
  FOR rel IN
    SELECT * FROM (VALUES
      ('terms', 'academic_year_id', 'academic_years', 'terms_school_academic_year_fk', 'NO ACTION', '', 'a'),
      ('classes', 'academic_year_id', 'academic_years', 'classes_school_academic_year_fk', 'NO ACTION', '', 'a'),
      ('subjects', 'department_id', 'departments', 'subjects_school_department_fk', 'NO ACTION', '', 'a'),
      ('teacher_classes', 'class_id', 'classes', 'teacher_classes_school_class_fk', 'NO ACTION', '', 'a'),
      ('teacher_classes', 'subject_id', 'subjects', 'teacher_classes_school_subject_fk', 'NO ACTION', '', 'a'),
      ('teacher_classes', 'academic_year_id', 'academic_years', 'teacher_classes_school_academic_year_fk', 'NO ACTION', '', 'a'),
      ('learner_classes', 'class_id', 'classes', 'learner_classes_school_class_fk', 'NO ACTION', '', 'a'),
      ('learner_classes', 'academic_year_id', 'academic_years', 'learner_classes_school_academic_year_fk', 'NO ACTION', '', 'a'),
      ('assignments', 'class_id', 'classes', 'assignments_school_class_fk', 'NO ACTION', '', 'a'),
      ('assignments', 'subject_id', 'subjects', 'assignments_school_subject_fk', 'NO ACTION', '', 'a'),
      ('assignments', 'term_id', 'terms', 'assignments_school_term_fk', 'NO ACTION', '', 'a'),
      ('submissions', 'assignment_id', 'assignments', 'submissions_school_assignment_fk', 'NO ACTION', '', 'a'),
      ('uploaded_files', 'assignment_id', 'assignments', 'uploaded_files_school_assignment_fk', 'NO ACTION', '', 'a'),
      ('resources', 'class_id', 'classes', 'resources_school_class_fk', 'NO ACTION', '', 'a'),
      ('resources', 'subject_id', 'subjects', 'resources_school_subject_fk', 'NO ACTION', '', 'a'),
      ('resources', 'term_id', 'terms', 'resources_school_term_fk', 'NO ACTION', '', 'a'),
      ('quizzes', 'class_id', 'classes', 'quizzes_school_class_fk', 'NO ACTION', '', 'a'),
      ('quizzes', 'subject_id', 'subjects', 'quizzes_school_subject_fk', 'NO ACTION', '', 'a'),
      ('quizzes', 'term_id', 'terms', 'quizzes_school_term_fk', 'NO ACTION', '', 'a'),
      ('quiz_attempts', 'quiz_id', 'quizzes', 'quiz_attempts_school_quiz_fk', 'NO ACTION', '', 'a'),
      ('announcements', 'class_id', 'classes', 'announcements_school_class_fk', 'NO ACTION', '', 'a'),
      ('attendance', 'class_id', 'classes', 'attendance_school_class_fk', 'NO ACTION', '', 'a'),
      ('timetable_entries', 'class_id', 'classes', 'timetable_entries_school_class_fk', 'CASCADE', '', 'c'),
      ('timetable_entries', 'subject_id', 'subjects', 'timetable_entries_school_subject_fk', 'SET NULL', ' (subject_id)', 'n'),
      ('timetable_entries', 'term_id', 'terms', 'timetable_entries_school_term_fk', 'SET NULL', ' (term_id)', 'n'),
      ('timetable_entries', 'academic_year_id', 'academic_years', 'timetable_entries_school_academic_year_fk', 'SET NULL', ' (academic_year_id)', 'n')
    ) AS relations(child_table, child_column, parent_table, constraint_name, delete_action, delete_columns, delete_code)
  LOOP
    child_oid := to_regclass(format('public.%I', rel.child_table));
    parent_oid := to_regclass(format('public.%I', rel.parent_table));
    IF child_oid IS NULL OR parent_oid IS NULL THEN
      RAISE EXCEPTION '0018 requires public.%.% and public.% to exist', rel.child_table, rel.child_column, rel.parent_table;
    END IF;

    SELECT attnum INTO child_school_att FROM pg_attribute
     WHERE attrelid = child_oid AND attname = 'school_id' AND NOT attisdropped;
    SELECT attnum INTO child_ref_att FROM pg_attribute
     WHERE attrelid = child_oid AND attname = rel.child_column AND NOT attisdropped;
    SELECT attnum INTO parent_school_att FROM pg_attribute
     WHERE attrelid = parent_oid AND attname = 'school_id' AND NOT attisdropped;
    SELECT attnum INTO parent_id_att FROM pg_attribute
     WHERE attrelid = parent_oid AND attname = 'id' AND NOT attisdropped;
    IF child_school_att IS NULL OR child_ref_att IS NULL OR parent_school_att IS NULL OR parent_id_att IS NULL THEN
      RAISE EXCEPTION '0018 required column missing for relationship %.% -> %.id',
        rel.child_table, rel.child_column, rel.parent_table;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = parent_oid
         AND i.indisunique
         AND i.indisvalid
         AND i.indnkeyatts = 2
         AND i.indkey[0] = parent_school_att
         AND i.indkey[1] = parent_id_att
    ) THEN
      RAISE EXCEPTION '0018 requires a valid UNIQUE (school_id, id) index on public.%', rel.parent_table;
    END IF;

    EXECUTE format(
      'SELECT count(*)::bigint FROM public.%I child
        WHERE child.%I IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.%I parent
             WHERE parent.id = child.%I
               AND parent.school_id = child.school_id
          )',
      rel.child_table, rel.child_column, rel.parent_table, rel.child_column
    ) INTO violation_count;
    IF violation_count > 0 THEN
      RAISE EXCEPTION '0018 found % cross-school or orphan reference(s) in public.%.%; no changes were retained',
        violation_count, rel.child_table, rel.child_column;
    END IF;

    expected_delete_code := rel.delete_code;
    SELECT c.contype, c.confrelid, c.conkey, c.confkey, c.confdeltype,
           c.confupdtype, c.confmatchtype, c.convalidated
      INTO existing_constraint
      FROM pg_constraint c
     WHERE c.conrelid = child_oid AND c.conname = rel.constraint_name;

    IF FOUND THEN
      IF existing_constraint.contype <> 'f'
         OR existing_constraint.confrelid <> parent_oid
         OR existing_constraint.conkey <> ARRAY[child_school_att, child_ref_att]::smallint[]
         OR existing_constraint.confkey <> ARRAY[parent_school_att, parent_id_att]::smallint[]
         OR existing_constraint.confdeltype <> expected_delete_code
         OR existing_constraint.confupdtype <> 'a'
         OR existing_constraint.confmatchtype <> 's' THEN
        RAISE EXCEPTION '0018 found an incompatible constraint named % on public.%', rel.constraint_name, rel.child_table;
      END IF;
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (school_id, %I) REFERENCES public.%I (school_id, id) ON DELETE %s%s NOT VALID',
        rel.child_table, rel.constraint_name, rel.child_column, rel.parent_table,
        rel.delete_action, rel.delete_columns
      );
    END IF;

    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', rel.child_table, rel.constraint_name);
  END LOOP;

  RAISE NOTICE '0018: composite school ownership foreign keys validated';
END $$;
