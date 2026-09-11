-- Phase 1 Security: Login rate limiting / brute-force protection
-- DB-backed mechanism that works across Vercel instances

CREATE TABLE IF NOT EXISTS "login_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identifier" varchar(255) NOT NULL,
  "ip_address" varchar(50),
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_identifier_idx" ON "login_attempts" ("identifier");
CREATE INDEX IF NOT EXISTS "login_attempts_created_at_idx" ON "login_attempts" ("created_at");
CREATE INDEX IF NOT EXISTS "login_attempts_identifier_created_at_idx" ON "login_attempts" ("identifier", "created_at");
