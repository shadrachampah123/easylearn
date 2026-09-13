# Phase 2E — Dashboard & reporting cross-school hardening

**Status:** implemented on this branch (source + tests only). Includes the second audit pass
(F5–F8) recorded below, which changed the F6 decision and fixed one F7-adjacent anchoring gap.  
**Does not:** run against production, merge, or deploy.

Companion to `PHASE2E_MIGRATION_0017.md`. Migration 0017 made `school_id` NOT NULL on all
school-owned tables; this record closes the four confirmed latent query-level findings from the
read-only Phase 2E audit that followed it.

## Findings fixed

| ID | Area | Files | Fix |
| --- | --- | --- | --- |
| F1 | Subject counts | `src/app/api/dashboard/admin/route.ts`, `src/app/api/dashboard/stats/route.ts` | Count subjects with a direct `school_id = ctx.schoolId` predicate instead of counting every row. The stale "subjects cannot be attributed" comment is removed. |
| F2 | Parent announcements | `src/app/api/dashboard/parent/route.ts` | `recentAnnouncements` now filters `announcements.school_id = ctx.schoolId` (direct predicate, same pattern as the authenticated branch of `/api/announcements`). Ordering (`createdAt DESC`) and limit (3) are unchanged. |
| F3 | Teacher aggregates | `src/app/api/dashboard/teacher/route.ts`, `src/app/api/reports/route.ts` | Class selection (assigned + homeroom) and every downstream aggregate add `school_id = ctx.schoolId`, so a teacher with memberships in several schools no longer widens the dashboard across tenants via `teacherId` alone. |
| F4 | Multi-school learner activity | `src/app/api/learner-reports/route.ts`, `src/app/api/learner/stats/route.ts`, `src/app/api/dashboard/learner/route.ts`, `src/app/api/dashboard/parent/route.ts` | Submission, quiz-attempt, attendance, class/roster and assignment rows are filtered with direct `school_id = ctx.schoolId` predicates, so a learner with active memberships in several schools cannot fold another school's activity into their (or their parent's) reports and dashboards. |

## Explicit non-changes (scope guards)

- **F5 — Gamification stays platform-global by design.** `achievements`, `learner_achievements`
  and `learner_points` intentionally carry no `school_id` (see the multi-school architecture
  plan). Leaderboards and achievement progress remain global across schools; this PR does **not**
  add a school dimension to them. The F4 predicates on activity rows (submissions, quiz attempts,
  attendance) do not touch gamification.
- **F6 — Dashboard overrides.** `dashboard_card_overrides` was already school-scoped in Phase 2C
  (direct `school_id` + caller-school filtering). No change in this PR.
  *(Superseded by the second audit pass below — the creator-membership predicate was removed in
  favour of a direct `school_id` scope on every override path.)*
- **F7 — Legacy fallbacks.** Pre-0016 membership/attribution fallbacks are left in place. They are
  unreachable after migration 0017 (`school_id` is NOT NULL) and are deliberately not removed here;
  they will be removed in a later, dedicated cleanup if a test demonstrates they remain reachable.
  *(Confirmed by the second audit pass below; one non-fallback anchoring gap found and fixed.)*

## Test coverage

- `tests/tenant-dashboard-isolation-db.test.ts` (new) — live-DB regression harness with a
  multi-school dual learner and dual teacher, asserting F1–F4 cannot aggregate across schools and
  that single-school behaviour is unchanged.
- `tests/tenant-authorization-db.test.ts` (updated) — fixtures now seed `school_id` explicitly
  (required by 0017), and the "fail closed" case is updated to the post-0017 semantics: a class is
  attributed by its own `school_id`, so a dual-membership learner no longer makes it belong to
  neither school.

## Validation

```bash
npm run test:tenant-auth      # authorization + catalog + assignments/submissions + isolation
npm run test:db               # full DB suite incl. migration 0017
npm run test:all              # full suite
npm run typecheck && npm run build
```

## Second audit pass — F5–F8 (read-only hardening audit, post PR #24)

Performed against the current code after PR #24 merged and production was redeployed
(schema: 0016 + 0017 applied). One documented decision changed (F6); everything else was
verified safe as designed.

### F5 — Gamification scope: confirmed platform-global and safe. No change.

`achievements`, `learner_points` and `learner_achievements` deliberately carry no `school_id`
— consistent with the schema, with 0016/0017 (which exclude them), and with the multi-school
architecture plan. Every write path is anchored behind a tenant-validated action: points on
submit/attempt are self-awarded after `sqlAssignmentInSchool`/`isQuizInSchool` checks; grading
awards only after `sqlSubmissionInSchool`; the achievement auto-award in `GET /api/learner/stats`
requires `isUserInSchool(ctx.schoolId, learnerId)` **plus** the Phase 1 `canAccessLearner`
relationship before it can write for that learner; `/api/seed` (which populates the achievement
catalog) is disabled in production. Every read is self-scoped or gated to a learner inside the
caller's school. The accepted consequence of the global design: a learner enrolled in two schools
carries the same point total/level into both dashboards (and `learner_points.reason` strings name
assignments from either school), but no school gains visibility into learners it is not a member
of. No isolation vulnerability found; no code changed.

### F6 — Dashboard overrides: creator-membership scoping was insufficient → direct `school_id`

`dashboard_card_overrides` has carried a NOT NULL `school_id` since 0016/0017 (POST attributes
every row), yet all CRUD and dashboard-read paths still scoped rows by "creator is an ACTIVE
member of the caller's school" (`sqlUserInSchool(schoolId, createdBy)`) — the pre-0016 anchor
rationale. That predicate is unsound for multi-school members: an override created in School A by
an admin who also belongs to School B appeared in School B's override list, was applied on School
B's teacher/learner/parent dashboards, and was PUT/DELETE-able from School B's admin UI. Rows
whose creator account was deleted (`created_by` NULL via `ON DELETE SET NULL`) were orphaned —
invisible and unmanageable in *every* school despite having an owning school.

Fix (predicate swap only; no schema, no API-shape change):

- `readOverridesForDashboard` — direct `eq(dashboardCardOverrides.schoolId, …)` whenever a
  verified school context is supplied; **fail closed** (no override applied) without one.
- `GET /api/dashboard/overrides` — lists `school_id = ctx.schoolId` only.
- `GET/PUT/DELETE /api/dashboard/overrides/[id]` — every record predicate anchors
  `school_id = ctx.schoolId`; another school's row 404s (never a 403 oracle).

Regression: seven F6 cases in `tests/tenant-dashboard-isolation-db.test.ts`, verified red when the
direct predicate is removed. The `sqlDashboardOverrideDirectInSchool` helper in `src/lib/tenant.ts`
remains available for future raw-SQL callers.

### F7 — Pre-0016 legacy fallbacks: unreachable on the current schema → kept, plus one anchor fix

Every mutation-capable legacy fallback is a `catch` arm gated by `isSchemaOutOfDate(error)`
after a tenant-scoped primary statement: 17 `legacyInsert`/`legacyInsertMany` call sites
(academic-years, announcements, assignments, attendance, classes, departments, enrollments,
messages ×2, parent-learners, quizzes, resources, subjects, submissions, teacher-classes,
terms, timetable), the unscoped `isCurrent` resets (academic-years, terms), the unscoped
cascade catches (classes|subjects|departments `[id]` DELETE) and `getDirectSchoolId`'s
relational fallback in `src/lib/tenant.ts`. On the production schema every one of those
tables HAS `school_id` (0016) and it is NOT NULL (0017), so the gate cannot fire there, and a
schema-old fallback insert would additionally be rejected by the database (a not-null
violation is not "schema out of date" → rethrown → 500; fail closed). They remain reachable
only on un-migrated databases, where they reproduce exactly the pre-0016 authorship-based
attribution the read paths still understand. Removal stays deferred to the dedicated cleanup
PR, as this document already stipulated — deleting them now would break un-migrated
dev/staging DBs for no security gain.

One related gap surfaced and was fixed as the only code change under F7:
`DELETE /api/assignments/[id]/questions` validated the parent assignment (school + owner) but
deleted the question by its raw client-supplied `questionId` without requiring it to belong to
that assignment, so a staff member owning any single in-school assignment could delete another
school's question row given its uuid. Fixed by anchoring to the parent — 404 on mismatch plus
`assignment_id` in the DELETE predicate — mirroring the check the sibling corrections POST
already enforces. Covered by three F7 cases in the regression suite.

### F8 — `memberships[0]` context selection: not an isolation vulnerability (roadmap note)

`resolveAuthContext` resolves `school: memberships[0]` — the caller's EARLIEST ACTIVE
membership (deterministic `created_at, id` order), re-read from `school_users` per request.
Audit checks: no route reads a school from body/query/header anywhere (`schoolId` grep: zero
callers); token `schoolIdHint`/`membershipIdHint` claims are validated nowhere for
authorization; `resolveSchoolMembership`'s optional `schoolId` can only narrow against the
caller's own set; `selectSchoolForContext` (the host-resolution cross-check) is not yet wired
into any route. The selection therefore cannot place a user in a school they do not belong to
— the multi-school consequence is acting in the *wrong one of their own* schools
(misattribution), which school switching / host resolution will solve as a correctness
feature. No security-driven change was required or made. The F6 fix independently shrinks the
blast radius of that misattribution for dashboard overrides.
