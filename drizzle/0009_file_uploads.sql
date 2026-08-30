-- 0009: Local file uploads for assignments and submissions
-- Teachers upload documents, PDFs, audio, images and videos from their local
-- devices when creating assignments. Learners can only upload files with their
-- submission when the teacher explicitly enables file uploads for that
-- assignment (assignments.allow_file_uploads, default false).
-- Every uploaded file is registered in uploaded_files; the file bytes live on
-- disk under the upload storage directory (UPLOAD_DIR or ./storage/uploads).

--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "allow_file_uploads" boolean NOT NULL DEFAULT false;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uploaded_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "uploader_id" uuid NOT NULL,
  "purpose" varchar(30) NOT NULL,
  "assignment_id" uuid,
  "original_name" varchar(255) NOT NULL,
  "stored_name" varchar(255) NOT NULL,
  "mime_type" varchar(150),
  "category" varchar(20) NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_uploader_id_users_id_fk"
    FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_assignment_id_assignments_id_fk"
    FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uploaded_files_stored_name_unique" ON "uploaded_files" USING btree ("stored_name");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploaded_files_uploader_purpose_idx" ON "uploaded_files" USING btree ("uploader_id", "purpose");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploaded_files_assignment_idx" ON "uploaded_files" USING btree ("assignment_id");
