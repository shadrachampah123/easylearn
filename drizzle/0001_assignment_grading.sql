-- 0001: Add assignment auto-grading tables
-- Assignment Questions, Answers, Corrections, and update submissions

ALTER TABLE "submissions" ADD COLUMN "max_score" integer;
ALTER TABLE "submissions" ADD COLUMN "percentage" integer;

CREATE TABLE IF NOT EXISTS "assignment_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"question_type" "quiz_question_type" NOT NULL DEFAULT 'mcq',
	"question_text" text NOT NULL,
	"options" jsonb,
	"correct_answer" text,
	"points" integer DEFAULT 1,
	"order_index" integer DEFAULT 0,
	"explanation" text
);
--> statement-breakpoint
ALTER TABLE "assignment_questions" ADD CONSTRAINT "assignment_questions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;

CREATE TABLE IF NOT EXISTS "assignment_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"answer" text,
	"is_correct" boolean DEFAULT false,
	"points_awarded" integer DEFAULT 0,
	"points_possible" integer DEFAULT 0
);
--> statement-breakpoint
ALTER TABLE "assignment_answers" ADD CONSTRAINT "assignment_answers_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_answers" ADD CONSTRAINT "assignment_answers_question_id_assignment_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."assignment_questions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_answers" ADD CONSTRAINT "assignment_answers_learner_id_users_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE TABLE IF NOT EXISTS "assignment_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"question_id" uuid,
	"correction_text" text NOT NULL,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignment_corrections" ADD CONSTRAINT "assignment_corrections_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_corrections" ADD CONSTRAINT "assignment_corrections_question_id_assignment_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."assignment_questions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_corrections" ADD CONSTRAINT "assignment_corrections_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
