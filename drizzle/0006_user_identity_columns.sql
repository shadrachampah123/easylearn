-- 0006: User identity columns that exist in src/db/schema.ts but were never in a migration
-- (username login + forced password change shipped in code only, so databases created from
--  the SQL files above 404'd with `column users.username does not exist`).
-- Idempotent: safe to run on databases that already have the columns.

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" varchar(100);

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_unique_idx" ON "users" ("username") WHERE "username" IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_role_active_idx" ON "users" USING btree ("role", "is_active");
