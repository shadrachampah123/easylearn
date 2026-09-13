# Phase 2E — Dashboard & reporting cross-school hardening

**Status:** implemented on this branch (source + tests only).  
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
- **F7 — Legacy fallbacks.** Pre-0016 membership/attribution fallbacks are left in place. They are
  unreachable after migration 0017 (`school_id` is NOT NULL) and are deliberately not removed here;
  they will be removed in a later, dedicated cleanup if a test demonstrates they remain reachable.

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
