# Phase 2C — Central Tenant Authorization

**Status:** implemented on `arena/01a09306-easylearn` (PR: _Phase 2C: Enforce central tenant authorization_).
Phases [2A](PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md) and [2B](PHASE2B_MEMBERSHIP_AUTH.md) are
merged. Phase 2D (per-table `school_id` columns, composite foreign keys, RLS) is **not** part
of this change; everything that genuinely needs it is listed under
[Deferred to Phase 2D](#deferred-to-phase-2d).

---

## 1. What this phase adds

Phase 2A created `schools` / `school_users`; Phase 2B resolved a membership during
authentication but deliberately left every route on its Phase 1 code path. Phase 2C is the
enforcement phase: every school-owned API route now goes through **one audited gate** in
[`src/lib/tenant.ts`](../src/lib/tenant.ts) and every record lookup is predicated on the
caller's school.

The gate answers, in this order — and this order is the contract:

```
authenticate (401)            →  resolve ACTIVE membership from the DATABASE (403)
                              →  verify the target record belongs to the same school (404/403)
                              →  apply the existing Phase 1 role / ownership rules
                              →  allow
```

- Authentication alone is never enough: a valid token from another school reaches no data.
- A role check never substitutes for a school check, and a school check never substitutes for
  a role check — a correct-school learner still fails an administrator-only branch.
- Fail closed: if a school-owned record cannot be attributed to the caller's school, it is
  denied. There is no "no school found → allow", "no membership → allow", "no enrollment
  found → allow" or "no `school_id` → allow" fallback anywhere on the migrated routes.
- The client contributes **nothing** to the decision. `school_id` / `schoolId` in a body or
  query string, and the `role` claim inside the JWT, are not authorization inputs. The role
  used by every gate below is `school_users.role` read from the database on that request.

### 1.1 The central API (`src/lib/tenant.ts`)

| Helper | Purpose |
| --- | --- |
| `guardSchoolContext(request, tokenOverride?)` | 401 without a valid session, 401 for a deactivated/deleted account, **403 without an active membership**; returns `{ ok, context }` or `{ ok: false, response }` |
| `guardPlatformAdmin(request)` | Explicit platform gate (`super_admin` only). **Not** a tenant bypass — used only by `DELETE /api/users/[id]` and the dev-only seed |
| `hasSchoolRole` / `hasSchoolAdminRole` / `hasSchoolAdminExtendedRole` / `hasSchoolTeachingRole` / `hasSchoolStaffRole` / `schoolRole` | Phase 1 role groups re-expressed on the membership role; `super_admin` cannot appear |
| `sqlUserInSchool`, `sqlClassInSchool`, `sqlAssignmentInSchool`, `sqlQuizInSchool`, `sqlSubmissionInSchool`, `sqlFileInSchool`, `sqlTeacherClassInSchool`, `sqlTimetableInSchool`, `sqlAnnouncementInSchool`, `sqlLearnerInSchool` | DB-level predicates embedded in `WHERE` clauses (no fetch-then-inspect) |
| `sqlOwnedBySchool` | The ownership rule: reachable from this school **and** from no other school |
| `isUserInSchool`, `getLearnerIdsInSchool`, `isClassInSchool`, `isAssignmentInSchool`, `isSubmissionInSchool`, `isFileInSchool`, `isQuizInSchool`, `isTeacherClassInSchool`, `isTimetableInSchool` | Single-record resolvers for decisions that cannot be expressed in SQL |
| `addSchoolMembership`, `updateSchoolMembershipRole`, `canHoldSchoolMembership` | The only writes to `school_users`; routes never touch the table directly (asserted by `tests/tenant-foundation.test.js`) |

### 1.2 Two ownership rules (deliberate)

Attribution cannot always be "the anchor user is a member", because some rows bridge people:

- **Identity / relationship records** — users, notifications, announcements, resources,
  activity logs, files anchored on an uploader — belong to a school when the anchor user is
  an **ACTIVE member** of it. A user who genuinely belongs to two schools is visible in both;
  that is an affiliation, not a leak.
- **School content** — classes, teacher↔class rows, assignments, quizzes, submissions,
  attendance, enrollments, timetables, files attached to an assignment — must be **uniquely
  attributable**: reachable from the caller's school *and from nowhere else*. Content
  reachable from a second school belongs to neither and is denied (tested in
  `Fail closed: content reachable from TWO schools belongs to neither`).

Until Phase 2D adds `school_id` to these tables, a class is attributed through its people
(homeroom teacher, `teacher_classes` teachers, enrolled learners). A class with **no**
members — or with members from two schools — is therefore not accessible. That is the
fail-closed rule the brief requires, and it is also the operational constraint to be aware
of: a brand-new class must have a homeroom teacher (or an assigned teacher) before it can be
listed, edited or enrolled into.

---

## 2. Route audit

59 API route handlers exist. **47 authorize through `src/lib/tenant.ts`** (2 were already
there after Phase 2B: `auth/login`, `auth/me`; 45 more were migrated in Phase 2C). The 12
routes left unchanged are listed with their reason in §3.

Legend: **CHANGED** = tenant gate + ownership enforcement; *read* / *write* = which verbs.

| Route | Status | What Phase 2C did |
| --- | --- | --- |
| `users` (GET, POST) | CHANGED | Directory scoped to the school's active members; account creation requires a school admin and writes the `school_users` row (rollback → 503 if the membership cannot be stored); `super_admin` can no longer enumerate or create school users |
| `users/[id]` (GET/PUT/PATCH/DELETE) | CHANGED | Cross-school user is 404; role changes are restricted to `ASSIGNABLE_ROLES` and re-align the membership row; password hash is never returned; `DELETE` is the explicitly platform-gated capability |
| `enrollments` (GET/POST) | CHANGED | Both the learner **and** the class must belong to the caller's school; the enrollment row alone is never trusted |
| `grades` (GET) | CHANGED | Tenant check (`isUserInSchool`) **before** `canAccessLearner`; teacher/head-teacher rules preserved |
| `attendance` (GET/POST/PUT) | CHANGED | School ownership of learner, class and records; `classId`/`learnerId` parameters validated (404); head-teacher school-wide branch preserved |
| `announcements` (GET/POST) | CHANGED | Non-public announcements are listed/mutable only when authored by a member of the caller's school; `?public=true` stays anonymous and public **by design** |
| `notifications` (GET/PUT) | CHANGED | Gate added; ownership filters (`user_id = ctx.userId`) preserved and now scoped to the caller's own ids |
| `files/[id]` (GET) | CHANGED | File ownership resolved through the parent chain (uploader membership + assignment → class → members); another school's file is 404; unattributable files are denied to everyone; `?token=` media fallback preserved; Phase 1 submission-file rules stand inside the school |
| `uploads`, `uploads/[id]`, `uploads/presign` | CHANGED | Upload authorization verifies the assignment belongs to the caller's school; DELETE additionally requires a school admin and the file's own tenant predicate |
| `submissions` (GET/POST) | CHANGED | Each Phase 1 branch (learner self / teacher own / admin-extended) AND the school predicate; submitting to another school's assignment is 404; **the fail-open "no enrollment rows at all → allow" fallback was removed** |
| `submissions/[id]`, `submissions/[id]/grade` | CHANGED | Row lookup and the grade `UPDATE` are tenant-predicated; teacher ownership via the membership role |
| `learner/stats`, `learner-reports` | CHANGED | Learner must be in the caller's school (404) before the Phase 1 access check; report access list intersected with the school's learners |
| `reports` | CHANGED | Administrator branch counts only this school (assignments, submissions, quizzes, attendance, learner count, class distribution) |
| `messages` (GET/POST) | CHANGED | Partner must be a member of the caller's school (404); receiver insert is tenant-checked |
| `assignments`, `assignments/[id]`, `.../submit`, `.../questions`, `.../corrections`, `.../results` | CHANGED | Every lookup tenant-predicated; creation requires a class of the caller's school; submission requires enrollment (fail-open fallback removed) |
| `quizzes`, `quizzes/[id]`, `.../attempt`, `.../check` | CHANGED | Quiz ownership via teacher + class; **the "learner has no enrollments → show all published quizzes" fallback was removed** |
| `resources` (GET/POST) | CHANGED | Listed only when the uploader is a school member; `classId` validated on create |
| `classes`, `classes/[id]` | CHANGED | List/create/update/delete restricted to classes attributable to the caller's school; cascade delete is tenant-predicated |
| `teacher-classes`, `teacher-classes/[id]` | CHANGED | Rows must resolve to one school; creation requires both the teacher and the class to belong to it |
| `parent-learners`, `parent-learners/[id]` | CHANGED | A link is visible/mutable only when **both** sides are members of the caller's school; cross-school legacy links grant nothing |
| `timetable`, `timetable/[id]` | CHANGED | Slots scoped by class, teacher and creator attribution |
| `activity-logs` (GET) | CHANGED | Feed restricted to actors who are members of the caller's school (platform events are not part of any school feed) |
| `dashboard/admin`, `dashboard/stats` | CHANGED | Every count/aggregate scoped to the school; the admin dashboard accepts only school admin/head-teacher |
| `dashboard/teacher`, `dashboard/parent`, `dashboard/learner` | CHANGED | `teacherId`/`parentId`/`learnerId` parameters are honoured only for members of the caller's school (404 otherwise); learner branch is tenant-first |
| `dashboard/overrides`, `dashboard/overrides/[id]` | CHANGED | Only overrides created by members of the caller's school are readable/changed |
| `auth/login`, `auth/me` | unchanged (2B) | Already resolve memberships; they are the reason the rest could be migrated |

### 2.1 Removed permissive defaults (fail-open → fail-closed)

1. `submissions/route.ts` and `assignments/[id]/submit/route.ts` — "if the learner has no
   enrollment rows at all, allow the submission" is gone; enrollment is required.
2. `quizzes/route.ts` — "if the learner has no enrollments, show all published quizzes" is
   gone; learners see only quizzes for classes they are enrolled in.
3. `users/route.ts` — the directory no longer reads `FROM users` globally; the list is
   `... AND <school membership exists>`.
4. `files/[id]` — assignment material used to be readable by *any* authenticated user; it is
   now readable only by members of the file's school.
5. `dashboard/*` — client-supplied `teacherId` / `parentId` / `learnerId` used to be trusted;
   they are now resolved against the school.

---

## 3. Routes intentionally left unchanged (with reasons)

| Route | Reason |
| --- | --- |
| `academic-years`, `terms`, `subjects`, `subjects/[id]`, `departments`, `departments/[id]` | **Phase 2D dependency.** These are global catalogs with *no* user/class anchor, so there is no relational way to tell School A's "Grade 7" from School B's: attribution is impossible in Phase 2C. Per the brief, no risky workaround was invented. Writes remain role-gated as before. Plan §5/§12 classifies them as class **A** (`school_id` + composite FKs). |
| `images/search` | Unsplash/Openverse proxy. Reads no school-owned data — the only data it touches is a third-party image API. Existing staff-role gate retained. |
| `seed` | Dev-only (404 in production), platform demo data for CBISM. Uses the explicit platform gate concept; it is not a school-data path. |
| `health` | Liveness probe; intentionally public, exposes no tenant rows. |
| `auth/register`, `auth/change-password`, `auth/logout` | Self-service identity routes. No school-owned record is read or written beyond the caller's own account; membership is irrelevant to changing your own password. |

### Deferred to Phase 2D

- `school_id` columns on the 35 legacy tables (including the six catalogs above) plus
  composite foreign keys and RLS. Verified absent by
  `tests/tenant-foundation.test.js` (`no legacy table gained a tenant column`).
- Because those columns do not exist, the following is *also* deferred: exact school
  attribution for an **empty** class/subject (see §1.2), per-school uniqueness of
  `academic_years.is_current`, and any cross-school integrity guarantee enforced by the
  database rather than by the route.
- Phase 2E items (school subdomains, school switching, `selectSchoolForContext` wiring) and
  break-glass/support access are out of scope; `selectSchoolForContext` exists and is tested
  but is not reachable from any route.

---

## 4. `super_admin` handling

`super_admin` is a **platform** role and gets no school membership (migration 0015 excludes
it; `toSchoolRole()` refuses to map it). Consequences, all deliberate:

- It cannot pass `guardSchoolContext`, so it can never read or write a school-owned record
  through the migrated routes. There is no implicit bypass and no `super_admin === true` path
  inside a tenant predicate.
- The only two routes with an explicit platform gate are `DELETE /api/users/[id]` (the global
  identity store, whose pre-Phase-2C rule was already `super_admin`-only) and the dev-only
  seed. Neither is a school-data endpoint.
- Break-glass “support mode” is a later phase and was **not** built.

---

## 5. Evidence

All of the following run against a **real PostgreSQL** database:

| Suite | What it proves |
| --- | --- |
| `tests/tenant-authorization-db.test.ts` (63 checks) | Two real schools (`tenant-a`, `tenant-b`), real memberships, real route handlers, real signed tokens. User / learner / grade / attendance / announcement / notification / file / submission / admin isolation, both directions, plus every §10 negative case (wrong ids, inactive membership, missing membership, forged role, forged `schoolId`, foreign resource) and the legitimate same-school cases that prove Phase 1 still works. |
| `tests/tenant-authorization-mutation.test.ts` (7 checks) | Removes each protection from `src/lib/tenant.ts` one at a time (membership check, ownership predicate, role check, inactive-membership filter, uniqueness rule) and requires the suite above to go red; restores the file byte-identically afterwards. |
| `tests/tenant-db.test.js`, `tests/membership-auth-db.test.ts` | Phase 2A/2B regressions on the same database. |
| `tests/security.test.js` (28), `tests/real-authorization.test.ts` (15), `tests/tenant-foundation.test.js` (23), `tests/membership-foundation.test.js` (35) | Phase 1 static + helper regressions; the two assertions that encoded pre-2C literals were updated deliberately (never deleted) and `membership-foundation` now asserts the 26-route migrated set. |

Database provider order, identical to Phases 2A/2B: `TEST_DATABASE_URL` → `embedded-postgres`
(`npm i --no-save embedded-postgres`) → the suite SKIPs with exit 0. A skip is **not** a pass.

---

## 6. Performance notes

- No membership is resolved more than once per request; the gate returns the context and
  routes reuse it.
- List endpoints use DB-level predicates (`EXISTS` / `UNION` over indexed FKs), not
  fetch-everything-then-filter.
- Single-record decisions use one resolver query; batch decisions
  (`getLearnerIdsInSchool`) use one query for the whole id set.
- No authorization result is cached, so a revoked membership or a disabled account takes
  effect on the next request.

## 7. Known residual risks

1. **Catalog tables** (`subjects`, `departments`, `academic_years`, `terms`) are still shared
   between schools until Phase 2D adds `school_id` — an administrator of one school can list
   or edit another school's catalog rows. Documented above; not workable around without the
   schema change.
2. **Empty/unattributable content** is invisible (fail closed). Operationally this means a
   class must be staffed before it can be used.
3. `activity_logs` rows written before Phase 2C by accounts that no longer have a membership
   are not part of any school's feed.
4. Row-level security is still application-level only; a direct database connection bypasses
   these rules. RLS is Phase 2D.
