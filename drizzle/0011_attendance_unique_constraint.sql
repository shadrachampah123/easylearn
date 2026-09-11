-- Phase 1 Security: Prevent duplicate attendance records for same learner/class/date
-- SAFER MIGRATION STRATEGY: Preserve duplicate data before deletion for audit

-- Step 1: Create backup table to preserve any duplicates that will be removed
-- This ensures no legitimate attendance information is lost - all duplicates are archived
CREATE TABLE IF NOT EXISTS "attendance_duplicates_backup" (
  "id" uuid PRIMARY KEY,
  "learner_id" uuid NOT NULL,
  "class_id" uuid NOT NULL,
  "date" date NOT NULL,
  "is_present" boolean NOT NULL,
  "note" text,
  "marked_by_id" uuid,
  "created_at" timestamp NOT NULL,
  "deleted_at" timestamp DEFAULT now() NOT NULL,
  "deletion_reason" text DEFAULT 'duplicate_cleanup_0011_migration'
);

--> statement-breakpoint
-- Step 2: Backup duplicates that would be deleted (keep latest per learner/class/date)
-- We identify duplicates using ROW_NUMBER() partitioned by (learner_id, class_id, date)
-- Ordered by created_at DESC, so we keep the most recent record (latest created_at)
-- This is safer than arbitrary deletion - we keep the latest as it's likely the most up-to-date correction
INSERT INTO "attendance_duplicates_backup" 
  ("id", "learner_id", "class_id", "date", "is_present", "note", "marked_by_id", "created_at")
SELECT 
  a."id", a."learner_id", a."class_id", a."date", a."is_present", a."note", a."marked_by_id", a."created_at"
FROM "attendance" a
INNER JOIN (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY learner_id, class_id, date 
    ORDER BY created_at DESC, id DESC
  ) as rn
  FROM "attendance"
) dup ON a.id = dup.id
WHERE dup.rn > 1
ON CONFLICT (id) DO NOTHING;

--> statement-breakpoint
-- Step 3: Verify backup count matches duplicates to be deleted (for audit, not enforced)
-- This is a safety check - we log duplicates found
DO $$
DECLARE
  duplicate_count INTEGER;
  backup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY learner_id, class_id, date 
      ORDER BY created_at DESC, id DESC
    ) as rn
    FROM "attendance"
  ) dup
  WHERE dup.rn > 1;

  SELECT COUNT(*) INTO backup_count FROM "attendance_duplicates_backup";

  RAISE NOTICE 'Attendance duplicates found: %, backed up: %', duplicate_count, backup_count;
  
  -- If duplicates exist, they are now backed up, so safe to proceed
  -- If no duplicates, this is a no-op and safe
END $$;

--> statement-breakpoint
-- Step 4: Remove duplicates, keeping the most recent record per (learner_id, class_id, date)
-- Retention logic: ORDER BY created_at DESC, id DESC keeps latest created record
-- This ensures if a teacher corrected attendance, the latest correction is retained
DELETE FROM "attendance" a
USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY learner_id, class_id, date 
    ORDER BY created_at DESC, id DESC
  ) as rn
  FROM "attendance"
) dup
WHERE a.id = dup.id AND dup.rn > 1;

--> statement-breakpoint
-- Step 5: Add unique constraint to prevent future duplicates
-- This will fail if duplicates still exist (safety), but we just removed them
-- Using IF NOT EXISTS pattern via DO block for idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'attendance_learner_class_date_unique'
  ) THEN
    ALTER TABLE "attendance" 
    ADD CONSTRAINT "attendance_learner_class_date_unique" 
    UNIQUE ("learner_id", "class_id", "date");
  END IF;
END $$;

--> statement-breakpoint
-- Step 6: Add indexes for faster lookups (idempotent)
CREATE INDEX IF NOT EXISTS "attendance_class_date_idx" ON "attendance" ("class_id", "date");
CREATE INDEX IF NOT EXISTS "attendance_learner_date_idx" ON "attendance" ("learner_id", "date");
CREATE INDEX IF NOT EXISTS "attendance_duplicates_backup_date_idx" ON "attendance_duplicates_backup" ("date");
