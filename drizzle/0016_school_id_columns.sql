-- 0016: Phase 2D — Add school_id columns to all school-owned tables
-- See docs/PHASE2C_TENANT_AUTHORIZATION.md and PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md §5
--
-- This migration adds nullable school_id columns to every A-class table (school-owned
-- catalog and content) so that tenant attribution can be done directly via
-- `WHERE school_id = $ctx.schoolId` instead of through relational membership joins.
-- The relational predicates in src/lib/tenant.ts remain as fallback until Phase 2D
-- code is fully migrated, but new code must use direct school_id.
--
-- STRATEGY:
--   1. Add column IF NOT EXISTS (nullable) to each table
--   2. Add FK to schools(id) IF NOT EXISTS
--   3. Add index on school_id
--   4. Backfill existing rows to CBISM (slug='cbism') where school_id IS NULL
--      — all pre-Phase-2D data belongs to CBISM per plan §14
--   5. No NOT NULL enforcement yet (Phase 2E will enforce after validation)
--
-- IDEMPOTENCY: Safe to re-run. All ADD COLUMN use IF NOT EXISTS, indexes use
-- IF NOT EXISTS, FKs use guarded DO blocks, backfill is WHERE school_id IS NULL.

--> statement-breakpoint
-- Academic Years
ALTER TABLE "academic_years" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "academic_years_school_idx" ON "academic_years" USING btree ("school_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "academic_years_school_name_unique" ON "academic_years" USING btree ("school_id", "name") WHERE "school_id" IS NOT NULL;

--> statement-breakpoint
-- Terms
ALTER TABLE "terms" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "terms" ADD CONSTRAINT "terms_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terms_school_idx" ON "terms" USING btree ("school_id");

--> statement-breakpoint
-- Departments
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "departments" ADD CONSTRAINT "departments_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "departments_school_idx" ON "departments" USING btree ("school_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "departments_school_name_unique" ON "departments" USING btree ("school_id", "name") WHERE "school_id" IS NOT NULL;

--> statement-breakpoint
-- Classes
ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "classes_school_idx" ON "classes" USING btree ("school_id");

--> statement-breakpoint
-- Subjects
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subjects" ADD CONSTRAINT "subjects_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_school_idx" ON "subjects" USING btree ("school_id");

--> statement-breakpoint
-- Teacher Classes
ALTER TABLE "teacher_classes" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "teacher_classes" ADD CONSTRAINT "teacher_classes_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teacher_classes_school_idx" ON "teacher_classes" USING btree ("school_id");

--> statement-breakpoint
-- Learner Classes
ALTER TABLE "learner_classes" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "learner_classes" ADD CONSTRAINT "learner_classes_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learner_classes_school_idx" ON "learner_classes" USING btree ("school_id");

--> statement-breakpoint
-- Parent Learners
ALTER TABLE "parent_learners" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "parent_learners" ADD CONSTRAINT "parent_learners_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parent_learners_school_idx" ON "parent_learners" USING btree ("school_id");

--> statement-breakpoint
-- Assignments
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "assignments" ADD CONSTRAINT "assignments_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignments_school_idx" ON "assignments" USING btree ("school_id");

--> statement-breakpoint
-- Submissions
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "submissions" ADD CONSTRAINT "submissions_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submissions_school_idx" ON "submissions" USING btree ("school_id");

--> statement-breakpoint
-- Uploaded Files
ALTER TABLE "uploaded_files" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploaded_files_school_idx" ON "uploaded_files" USING btree ("school_id");

--> statement-breakpoint
-- Resources
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "resources" ADD CONSTRAINT "resources_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_school_idx" ON "resources" USING btree ("school_id");

--> statement-breakpoint
-- Quizzes
ALTER TABLE "quizzes" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quizzes_school_idx" ON "quizzes" USING btree ("school_id");

--> statement-breakpoint
-- Quiz Attempts
ALTER TABLE "quiz_attempts" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quiz_attempts_school_idx" ON "quiz_attempts" USING btree ("school_id");

--> statement-breakpoint
-- Announcements
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "announcements" ADD CONSTRAINT "announcements_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_school_idx" ON "announcements" USING btree ("school_id");

--> statement-breakpoint
-- Notifications
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_school_idx" ON "notifications" USING btree ("school_id");

--> statement-breakpoint
-- Attendance
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "attendance" ADD CONSTRAINT "attendance_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_school_idx" ON "attendance" USING btree ("school_id");

--> statement-breakpoint
-- Timetable Entries
ALTER TABLE "timetable_entries" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timetable_entries_school_idx" ON "timetable_entries" USING btree ("school_id");

--> statement-breakpoint
-- Messages
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_school_idx" ON "messages" USING btree ("school_id");

--> statement-breakpoint
-- Activity Logs (nullable by design — platform events have no school)
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_logs_school_idx" ON "activity_logs" USING btree ("school_id");

--> statement-breakpoint
-- Dashboard Card Overrides
ALTER TABLE "dashboard_card_overrides" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dashboard_card_overrides" ADD CONSTRAINT "dashboard_card_overrides_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_card_overrides_school_idx" ON "dashboard_card_overrides" USING btree ("school_id");

--> statement-breakpoint
-- Gallery Items
ALTER TABLE "gallery_items" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gallery_items_school_idx" ON "gallery_items" USING btree ("school_id");

--> statement-breakpoint
-- News
ALTER TABLE "news" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news" ADD CONSTRAINT "news_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_school_idx" ON "news" USING btree ("school_id");

--> statement-breakpoint
-- FAQs
ALTER TABLE "faqs" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "faqs" ADD CONSTRAINT "faqs_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faqs_school_idx" ON "faqs" USING btree ("school_id");

--> statement-breakpoint
-- Downloads
ALTER TABLE "downloads" ADD COLUMN IF NOT EXISTS "school_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "downloads" ADD CONSTRAINT "downloads_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "downloads_school_idx" ON "downloads" USING btree ("school_id");

--> statement-breakpoint
-- Backfill existing rows to CBISM where school_id IS NULL
-- All pre-Phase-2D data belongs to CBISM per plan §14
DO $$
DECLARE
  v_cbism_id uuid;
BEGIN
  SELECT id INTO v_cbism_id FROM schools WHERE slug = 'cbism' LIMIT 1;
  IF v_cbism_id IS NULL THEN
    RAISE NOTICE '0016: no cbism school found, skipping backfill';
    RETURN;
  END IF;

  UPDATE academic_years SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE terms SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE departments SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE classes SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE subjects SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE teacher_classes SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE learner_classes SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE parent_learners SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE assignments SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE submissions SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE uploaded_files SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE resources SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE quizzes SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE quiz_attempts SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE announcements SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE notifications SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE attendance SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE timetable_entries SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE messages SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE activity_logs SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE dashboard_card_overrides SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE gallery_items SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE news SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE faqs SET school_id = v_cbism_id WHERE school_id IS NULL;
  UPDATE downloads SET school_id = v_cbism_id WHERE school_id IS NULL;

  RAISE NOTICE '0016: backfilled school_id to cbism % for all legacy tables', v_cbism_id;
END $$;
