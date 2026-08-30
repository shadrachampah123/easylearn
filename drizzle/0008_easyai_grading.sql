-- 0008: EasyAI — automated grading for assignments
-- Teachers enable EasyAI on an assignment and set the total maximum marks the AI
-- may allocate (ai_max_marks). Submissions store who graded them (graded_by) and
-- the full EasyAI evaluation report (ai_report).

--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "ai_grading_enabled" boolean NOT NULL DEFAULT false;

--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "ai_max_marks" integer;

--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "graded_by" varchar(20);

--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "ai_report" jsonb;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submissions_graded_by_idx" ON "submissions" USING btree ("graded_by");
