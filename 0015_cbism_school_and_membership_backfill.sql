-- 0015: Phase 2B — canonical CBISM school + school membership backfill
-- See docs/PHASE2B_MEMBERSHIP_AUTH.md (audit + decisions) and
-- docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md §6 (membership), §7 (super admin),
-- §14 step 1-3 (CBISM migration plan).
--
-- WHAT IT DOES
--   1. Creates the one canonical CBISM `schools` row (slug 'cbism') if it does not exist.
--   2. Gives every existing application user a `school_users` membership for that school,
--      preserving each user's role and never touching the `users` table.
--
-- WHAT IT DOES NOT DO  (Phase 2C+ work — deliberately out of scope here)
--   * no `school_id` column on any legacy table, no query rewrite, no tenant filtering
--   * no UPDATE / DELETE / DROP / TRUNCATE / ALTER anywhere in this file
--   * no password changes, no deactivations, no user deletions
--   * no academic data touched (attendance, assignments, grades, announcements, …)
--   * no `super_admin` membership rows (platform role, plan §7)
--   * no branding table, no subdomains, no RLS
--
-- IDEMPOTENCY
--   Safe to re-run any number of times (run-migration.js replays the whole chain on every
--   deploy): the school insert is keyed on the unique slug and the membership insert uses
--   ON CONFLICT DO NOTHING, so re-runs only create what is missing and never overwrite an
--   existing membership. Duplicate (school_id, user_id) rows are impossible
--   (`school_users_school_user_unique`).
--
-- ATOMICITY
--   run-migration.js executes each statement chunk separately (split on the project's
--   statement separator), with no wrapping transaction, so atomicity is per statement.
--   Every statement below is a single idempotent INSERT … SELECT — atomic on its own — and
--   a partially applied file is safe to re-run. The final DO block only reads and reports.
--   NOTE: the separator string must never appear inside these comments, or the runner would
--   split the comment into a "statement".

--> statement-breakpoint
-- 1. The canonical CBISM school.
--    Name/short name are the repository's own canonical wording (src/app/about/page.tsx:
--    "City Best International School Montessori (CBISM)").
--    ON CONFLICT ("slug") DO NOTHING:
--      * re-running never creates a second CBISM row (schools_slug_unique),
--      * an already-existing 'cbism' row is left EXACTLY as it is — a data migration must
--        not rename a tenant or flip its lifecycle status behind an operator's back.
INSERT INTO "schools" ("name", "short_name", "slug", "status")
VALUES ('City Best International School Montessori', 'CBISM', 'cbism', 'active')
ON CONFLICT ("slug") DO NOTHING;

--> statement-breakpoint
-- 2. Membership backfill for existing application users.
--
--    WHO IS AN APPLICATION USER
--      The audited `users` schema has no account-type/system-account column, so `role` is
--      the only reliable discriminator:
--        * role = 'super_admin'  -> PLATFORM role (plan §7). Excluded: it must never appear
--          in a membership row, and excluding it is what stops a platform operator from
--          silently acquiring school-wide membership privileges.
--        * every other enum value (school_admin, head_teacher, teacher, parent, learner) is
--          a school-level role held by a real application account -> gets a membership.
--
--    ROLE
--      Copied verbatim from users.role. Nothing is upgraded, downgraded or defaulted.
--
--    STATUS
--      Mirrors users.is_active ('active' / 'disabled'). users.is_active is NOT modified:
--      a deactivated account keeps an accurate, non-granting membership row instead of no
--      row at all, so the Phase 2C invariant "every user has a membership" already holds.
--      Membership resolution ignores non-active rows (src/lib/tenant.ts).
--
--    CONFLICT
--      DO NOTHING (not DO UPDATE): a membership an administrator edited after the first run
--      is preserved by later deploys. This is a backfill, not a synchroniser.
--
--    The CROSS JOIN yields zero rows if no 'cbism' school exists, so this statement is a
--    harmless no-op rather than an error in that (unexpected) case.
INSERT INTO "school_users" ("school_id", "user_id", "role", "status")
SELECT
  cbism."id",
  u."id",
  u."role",
  CASE WHEN u."is_active" THEN 'active' ELSE 'disabled' END
FROM "users" AS u
CROSS JOIN (SELECT "id" FROM "schools" WHERE "slug" = 'cbism' LIMIT 1) AS cbism
WHERE u."role" <> 'super_admin'
ON CONFLICT ("school_id", "user_id") DO NOTHING;

--> statement-breakpoint
-- 3. Report what the backfill produced (printed by run-migration.js, which listens for
--    PostgreSQL NOTICEs). Read-only: this block never writes.
DO $$
DECLARE
  v_school_id   uuid;
  v_eligible    integer;
  v_super_admins integer;
  v_memberships integer;
  v_active      integer;
  v_not_active  integer;
BEGIN
  SELECT "id" INTO v_school_id FROM "schools" WHERE "slug" = 'cbism' LIMIT 1;

  IF v_school_id IS NULL THEN
    RAISE WARNING '0015: no school with slug ''cbism'' exists - membership backfill did nothing';
    RETURN;
  END IF;

  SELECT count(*) INTO v_eligible     FROM "users" WHERE "role" <> 'super_admin';
  SELECT count(*) INTO v_super_admins FROM "users" WHERE "role" = 'super_admin';
  SELECT
    count(*),
    count(*) FILTER (WHERE "status" = 'active'),
    count(*) FILTER (WHERE "status" <> 'active')
  INTO v_memberships, v_active, v_not_active
  FROM "school_users" WHERE "school_id" = v_school_id;

  RAISE NOTICE
    '0015: cbism school % - % eligible users, % memberships (% active, % non-active), % super_admin(s) excluded',
    v_school_id, v_eligible, v_memberships, v_active, v_not_active, v_super_admins;

  IF v_memberships < v_eligible THEN
    RAISE WARNING '0015: % eligible user(s) have no CBISM membership - inspect before Phase 2C',
      v_eligible - v_memberships;
  END IF;
END $$;
