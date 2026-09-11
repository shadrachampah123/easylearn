-- Phase 1 Security: Prevent duplicate attendance records for same learner/class/date
-- First, remove any existing duplicates, keeping the most recent record

-- Create a temporary table to identify duplicates to delete
-- Keep the latest record per (learner_id, class_id, date)
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
-- Add unique constraint to prevent future duplicates
ALTER TABLE "attendance" 
ADD CONSTRAINT "attendance_learner_class_date_unique" 
UNIQUE ("learner_id", "class_id", "date");

--> statement-breakpoint
-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS "attendance_class_date_idx" ON "attendance" ("class_id", "date");
CREATE INDEX IF NOT EXISTS "attendance_learner_date_idx" ON "attendance" ("learner_id", "date");
