-- 0002: Make email optional for users (learners/parents)
-- Drop the NOT NULL constraint on email
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- Drop the unique constraint on email (will add back as partial unique)
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_unique";

-- Add partial unique constraint: email must be unique when not null
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique_idx" ON "users" ("email") WHERE "email" IS NOT NULL;
