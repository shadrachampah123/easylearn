-- 0013: Phase 2A — Multi-school tenant foundation
-- Adds the `schools` tenant root and the `school_users` membership table.
-- See docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md (§4 schools design, §6 membership design).
--
-- PURELY ADDITIVE: no existing table, column, row, index or query is modified.
-- Existing CBISM data is NOT migrated here — all existing records keep working
-- exactly as before. Backfill/membership wiring happens in Phase 2B/2F.
--
-- Conventions matched to this project's existing migrations:
--   * uuid PRIMARY KEY DEFAULT gen_random_uuid()
--   * varchar + CHECK for lifecycle values (cheap to extend, plan §4.2)
--   * timestamptz for NEW tables (plan §4.2 recommendation)
--   * idempotent: IF NOT EXISTS / guarded DO blocks, safe to re-run
--
-- Known runner limitation (documented, not rewritten here): run-migration.js
-- applies only the files listed in its explicit `files` array; the drizzle/
-- directory scan result (`allFiles`) is never iterated. This file is therefore
-- registered in that array (and shipped in both root and drizzle/, like 0011/0012).

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"short_name" varchar(30) NOT NULL,
	"slug" varchar(63) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "schools_slug_unique" UNIQUE("slug"),
	CONSTRAINT "schools_status_check" CHECK ("status" in ('provisioned', 'active', 'suspended', 'archived')),
	CONSTRAINT "schools_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schools_status_idx" ON "schools" USING btree ("status");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "school_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	-- Reuses the existing user_role enum for compatibility with the current
	-- role model. 'super_admin' exclusion is an application-layer rule (Phase 2B).
	"role" "user_role" NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "school_users_school_user_unique" UNIQUE("school_id", "user_id"),
	CONSTRAINT "school_users_membership_status_check" CHECK ("status" in ('active', 'invited', 'disabled'))
);

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "school_users" ADD CONSTRAINT "school_users_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "school_users" ADD CONSTRAINT "school_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
-- Single-school-era guard (plan §6.2): at most one non-disabled membership per
-- user across ALL schools. Replace this index when true multi-school
-- membership ships in a later phase.
CREATE UNIQUE INDEX IF NOT EXISTS "school_users_one_school_per_user" ON "school_users" USING btree ("user_id") WHERE "school_users"."status" <> 'disabled';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "school_users_school_role_idx" ON "school_users" USING btree ("school_id","role","status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "school_users_user_idx" ON "school_users" USING btree ("user_id");
