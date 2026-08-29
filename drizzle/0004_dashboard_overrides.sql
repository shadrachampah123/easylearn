-- 0004: Dashboard card overrides system
-- Allows admins to manually override displayed metric/card values while keeping live data as default

--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."dashboard_role" AS ENUM('admin', 'teacher', 'learner', 'parent', 'global');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."card_scope_type" AS ENUM('global', 'role', 'class', 'learner', 'parent', 'teacher', 'user');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dashboard_card_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_key" varchar(150) NOT NULL,
	"dashboard_role" "dashboard_role" DEFAULT 'global' NOT NULL,
	"title" varchar(255),
	"label" varchar(255),
	"value" text,
	"subtitle" varchar(255),
	"description" text,
	"trend" varchar(100),
	"is_visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"override_payload" jsonb,
	"scope_type" "card_scope_type" DEFAULT 'global' NOT NULL,
	"scope_id" uuid,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dashboard_card_overrides" ADD CONSTRAINT "dashboard_card_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_card_overrides_key_role_idx" ON "dashboard_card_overrides" USING btree ("card_key", "dashboard_role");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_card_overrides_scope_idx" ON "dashboard_card_overrides" USING btree ("scope_type", "scope_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_card_overrides_enabled_idx" ON "dashboard_card_overrides" USING btree ("is_enabled", "is_visible");
