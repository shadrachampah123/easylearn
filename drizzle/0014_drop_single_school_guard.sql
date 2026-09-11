-- 0014: Phase 2A fix — support multi-school membership
-- The architecture (docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md §6) requires
-- `users` to remain the GLOBAL identity store and `school_users` to support a
-- user belonging to MULTIPLE schools, so the single-school restriction created
-- by migration 0013 is removed here as a safe follow-up (0013 is committed
-- history and is not rewritten).
--
-- Still enforced: UNIQUE (school_id, user_id) — `school_users_school_user_unique`,
-- so the same user can never be duplicated within the same school.
-- No replacement single-school RESTRICTION is introduced.
--
-- WHY A PLACEHOLDER INDEX?
-- run-migration.js re-runs the whole chain on every deploy, and 0013 contains
-- `CREATE UNIQUE INDEX IF NOT EXISTS "school_users_one_school_per_user"`.
-- Simply dropping the index would make every later full re-run try to
-- resurrect it (and fail once any user holds two school memberships). To keep
-- the chain idempotent WITHOUT touching 0013, this migration replaces the
-- UNIQUE index with a NON-UNIQUE index of the SAME name:
--   * `IF NOT EXISTS` in 0013 then always finds the name and becomes a no-op;
--   * membership in multiple schools remains fully allowed;
--   * user_id lookups keep a supporting index (redundant with
--     school_users_user_idx, which Phase 2B may consolidate).
-- The index name is therefore historical — it enforces nothing.
--
-- Idempotent: safe to re-run; no table, column or row is modified.

--> statement-breakpoint
DROP INDEX IF EXISTS "school_users_one_school_per_user";

--> statement-breakpoint
-- Non-unique placeholder (same name as 0013's index) — see rationale above.
CREATE INDEX IF NOT EXISTS "school_users_one_school_per_user" ON "school_users" USING btree ("user_id");
