# PHASE 2 — MULTI-SCHOOL / MULTI-TENANT ARCHITECTURE PLAN

**Repository:** `shadrachampah123/easylearn`
**Branch audited:** `main` @ `eaed78cf373c55a64a406c2bdfdcb789f55548f3` (Phase 1 security hardening merged via PR #16)
**Audit date:** 2026-09-11
**Status:** ARCHITECTURE AUDIT ONLY — no application code, schema, migrations, or data were modified.

---

## 1. EXECUTIVE SUMMARY

EasyLearn is today a **single-school LMS wearing a multi-role costume**. The role enum
already contains `super_admin` and `school_admin`, but there is **no school entity anywhere
in the data model**. Every table lives in one implicit tenant: "CBISM" (City Best
International School Montessori), whose name, address, motto, anthem, colours and contact
details are hard-coded into JSX, the PWA manifest, the seed route and the layout metadata.

Phase 1 hardened *vertical* authorization (role checks, IDOR fixes, rate limiting,
attendance uniqueness). Phase 2 must introduce the *horizontal* axis: **tenant
isolation**. Nothing in the current schema or route layer can stop School A's admin from
reading School B's learners once a second school exists, because "School A" and
"School B" do not exist as concepts.

**Recommended architecture in one paragraph:**

- Add a `schools` table (the tenant root) and a **`school_users` membership table**; keep
  `users` as a global identity store (one password/identity, school-scoped memberships).
  This supports one-school-today and multi-school-tomorrow without a future user-table
  rewrite.
- Denormalize `school_id` onto the tables that are listed, filtered, aggregated, or
  constraint-checked directly (≈25 tables, classification **A**); derive tenancy through
  the parent for pure detail rows (≈6 tables, classification **B**); keep platform tables
  (**C**) out of any school; redesign only `users` (**D**).
- Resolve the tenant from the **subdomain** (`{slug}.easylearn.com`) with a
  membership-validated session claim — never from client-supplied input. Path-based
  tenancy is rejected; custom domains are a later add-on via a `school_domains` table.
- Centralize every gate in one new module (`src/lib/tenant.ts`) exposing
  `requireAuth()`, `requireSchoolContext()`, `requireSchoolRole()`,
  `requireSchoolAdmin()`, `requireSuperAdmin()`, `requireSameSchool()`,
  `canAccessSchoolResource()`, composed with the existing Phase-1 relationship helpers in
  `src/lib/authorization.ts`.
- Run **application-level tenant checks everywhere first** (Phase 2C); add **PostgreSQL
  RLS as defense-in-depth** in a later sub-phase once the connection/session pattern on
  Neon's pooler is proven, because RLS with `SET LOCAL` requires transaction-scoped
  plumbing the current codebase does not have.
- Migrate CBISM additively: create the CBISM row, backfill `school_id` (all rows → CBISM),
  verify zero orphans/leaks, then enforce `NOT NULL` + composite FKs. Every step is
  additive and reversible; nothing destructive.

The plan below is deliberately exhaustive; sections map 1:1 to the audit brief.

---

## 2. CURRENT ARCHITECTURE FINDINGS (VERIFIED, NOT ASSUMED)

### 2.1 Stack

| Layer | Technology (verified from `package.json` / code) |
| --- | --- |
| Framework | Next.js **16.2.6** (App Router, `src/app`), React 19.2.6, deployed to **Vercel** (Node runtime per route) |
| Database | **PostgreSQL on Neon** (`DATABASE_URL`, pooler hostname in `.env.example`), accessed via `pg` Pool (`max: 2` in production) + **Drizzle ORM 0.45.2** (`src/db/index.ts`, `src/db/schema.ts`) |
| Auth | **jose** HS256 JWT (24 h), **bcryptjs** (cost 12), token in `Authorization: Bearer` **and** httpOnly cookie `el_token`; client also persists token to **localStorage** |
| Validation | `zod` is a dependency but **not used anywhere in `src/`** (hand-rolled parsing) |
| UI | Tailwind 4, lucide-react, framer-motion; PWA via `public/manifest.json` + `public/sw.js` + `PWAInstall` |
| Tests | `tests/security.test.js` (28 static source-assertion tests) + `tests/real-authorization.test.ts` (15 pure-function tests of `authorization.ts`). No DB-backed integration tests. |
| Repo root migrations | `0001…0012*.sql` (duplicates of `drizzle/`) applied by **`run-migration.js`** (idempotent, per-statement, **no applied-migrations ledger, no down-migrations**) plus `drizzle/0000_wet_legion.sql` (base) |

### 2.2 Database schema inventory — table count correction

The brief says **33 tables**. The verified count is **35 tables** (all declared in
`src/db/schema.ts`; base migration `0000_wet_legion.sql` creates 27, and 8 more arrive via
migrations `0001`, `0003`, `0004`, `0009`, `0011`, `0012`). All 35 are classified in §5.

1. `users` — identity; `role` enum `user_role` = `super_admin | school_admin | head_teacher | teacher | parent | learner`
2. `academic_years` (has `is_current` — currently global!)
3. `terms` (→ academic_years)
4. `departments` (⚠ `head_id` has **no FK constraint**)
5. `classes` (⚠ `class_teacher_id` has **no FK constraint**; `academic_year_id` FK ok)
6. `subjects` (→ departments)
7. `teacher_classes` (teacher × class × subject × year)
8. `learner_classes` (learner × class × year)
9. `parent_learners` (parent × learner, free-text `relationship`)
10. `assignments` (class, subject, teacher, term; status draft/published/closed; EasyAI fields; `allow_file_uploads`)
11. `submissions` (assignment × learner; score/percentage/feedback; `graded_by`, `ai_report`)
12. `uploaded_files` (registry; `storage_backend` = `local | object`; bytes on disk under `UPLOAD_DIR` or object storage)
13. `assignment_questions`
14. `assignment_answers`
15. `assignment_corrections`
16. `resources` (study materials; external `file_url` or uploaded; `is_approved` gate)
17. `quizzes` (class, subject, teacher, term; `is_published`, `max_attempts`)
18. `quiz_questions` (`image_url` since 0007)
19. `quiz_attempts`
20. `announcements` (author, optional class, `is_public`)
21. `notifications` (per user)
22. `attendance` (unique `(learner_id, class_id, date)` since 0011)
23. `login_attempts` (brute-force ledger, 0012)
24. `attendance_duplicates_backup` (0011 archive of deduplicated rows)
25. `timetable_entries` (0003; class/subject/teacher/term/year, day + times)
26. `messages` (sender × receiver)
27. `activity_logs` (audit feed; enriched 0005 with `entity_type/entity_id/description`)
28. `dashboard_card_overrides` (0004; `dashboard_role` + `scope_type`/`scope_id`)
29. `achievements` (global badge catalog)
30. `learner_achievements`
31. `learner_points`
32. `gallery_items` (public website gallery)
33. `news` (news/events)
34. `faqs`
35. `downloads`

**12 Postgres enums**: `user_role`, `gender`, `level`, `term_name`, `assignment_status`,
`submission_status`, `notification_type`, `resource_type`, `quiz_question_type`,
`timetable_day`, `dashboard_role`, `card_scope_type`.

### 2.3 Relationships / FK integrity notes

- Strong FKs exist for most relations, **except**: `departments.head_id`,
  `classes.class_teacher_id`, `dashboard_card_overrides.scope_id`,
  `attendance_duplicates_backup.*` (deliberate), `activity_logs.entity_id` (polymorphic).
- `ON DELETE` is mostly `no action` (app deletes children manually, e.g. `users/[id]`
  DELETE removes `parent_learners`/`learner_classes` first — but **not** submissions,
  attendance, messages, notifications, uploaded_files, quiz_attempts: deleting a learner
  with history will fail or orphan rows depending on table).
- **Indexes are sparse**: partial-unique on `users.email` / `users.username`,
  `users(role, is_active)`, attendance unique + 2 idx, `login_attempts` 3 idx,
  `activity_logs` 3 idx, `timetable_entries` 2 idx, `dashboard_card_overrides` 3 idx,
  `uploaded_files` unique + 2 idx + backend idx, `submissions(graded_by)`. **Most FK
  columns have no index at all** (e.g. `submissions.assignment_id`,
  `learner_classes.class_id`, `messages.sender_id/receiver_id`,
  `notifications.user_id`).

### 2.4 Authentication / JWT structure (verified)

- `createToken()` signs `{ userId, email?, username?, role }`, HS256, 24 h, **no `jti`,
  no session table, no `schoolId`, no token version** (`src/lib/auth.ts`).
- `getTokenFromRequest()` prefers `Authorization: Bearer`, falls back to httpOnly cookie
  `el_token` (set at login: `httpOnly`, `secure` in prod, `SameSite=Lax`, 24 h).
- Login page stores the same token in **localStorage** and the client sends it as Bearer
  (all dashboard pages attach `Authorization` headers manually).
- **No `middleware.ts`** — every one of the ~40 route files performs its own
  `getTokenFromRequest` + `verifyToken` + role `if`.
- **Most routes authorize off the JWT `role` claim without re-reading the user row**
  (only `/api/auth/me` uses `getUserFromToken`). Consequences today: deactivating a user
  does not kill active sessions (except `/api/auth/me`), and role changes take up to 24 h
  to apply. For multi-tenancy this is decisive: **tenant context cannot live only in the
  token**; it must be re-derived server-side per request.
- `/api/auth/register` is hard-disabled (403). Login rate-limited via `login_attempts`
  (fails open if the table is missing — logged, not thrown).
- `/api/auth/change-password` re-verifies current password, derives `userId` from token
  (rejects cross-user), clears `must_change_password`.
- `create-admin.ts` seeds `admin@cbism.edu` / `admin123` as `school_admin`.
  `/api/seed` is 404 in production, `super_admin`-gated in dev, seeds CBISM demo data.

### 2.5 Role definitions & how they are actually used

| Role | Intended | Reality in code |
| --- | --- | --- |
| `super_admin` | Platform owner | Treated as **CBISM super-admin**: can create/delete any user, sees all dashboards. No platform/school split. |
| `school_admin` | School administrator | `ADMIN_ROLES` with `super_admin` everywhere; effectively "the admin" today. |
| `head_teacher` | Senior teacher | Included in `ADMIN_EXTENDED_ROLES` for most reads and attendance/timetable admin. |
| `teacher` | Teacher | Scoped to own assignments/classes via `authorization.ts` helpers (Phase 1). |
| `parent` | Guardian | Scoped to `parent_learners` links (Phase 1). |
| `learner` | Student | Self-scope only. |

Helpers: `isAdminRole`, `isAdminExtendedRole`, `isTeacherRole`, `canAccessLearner`,
`canTeacherAccessClass`, `getTeacherAccessibleLearnerIds`,
`getAllowedLearnerIdsForEnrollment` — all correct *within* one school and reusable for
Phase 2, but **none is tenant-aware** because tenancy doesn't exist yet.

### 2.6 API routes (all under `src/app/api`, ~40 files)

`auth/{login,logout,me,register,change-password}`, `users` + `users/[id]`,
`academic-years`, `terms`, `departments` + `[id]`, `classes` + `[id]`, `subjects` + `[id]`,
`teacher-classes` + `[id]`, `parent-learners` + `[id]`, `enrollments`, `assignments` +
`[id]{,/questions,/corrections,/results,/submit}`, `submissions` + `[id]{,/grade}`,
`quizzes` + `[id]{,/attempt,/check}`, `resources`, `announcements`, `notifications`,
`messages`, `attendance`, `timetable` + `[id]`, `grades`, `reports`, `learner-reports`,
`learner/stats`, `dashboard/{admin,teacher,parent,learner,stats,overrides[/id]}`,
`uploads{,/presign,[id]}`, `files/[id]`, `activity-logs`, `images/search`, `health`, `seed`.

Per-route authorization quality varies: Phase-1 routes (attendance, enrollments, grades,
learner stats, notifications, submissions, quizzes attempt) use relationship helpers;
older routes (users, classes, subjects, departments, terms, academic-years,
teacher-classes, announcements, resources, activity-logs, dashboards, reports) are
**role-gated but globally scoped** — they will leak across tenants the day two schools
exist. Detailed route-by-route matrix in §12.

### 2.7 File / object storage (verified)

- **Local backend**: multipart `POST /api/uploads` → disk under `UPLOAD_DIR`
  (default `<cwd>/storage/uploads`), filename-uuid, **flat, no school dimension**.
  Ephemeral on Vercel (documented in `.env.example`).
- **Object backend**: `POST /api/uploads/presign` → hand-rolled SigV4 presigned PUT
  (`src/lib/object-storage.ts`, S3/R2/MinIO), key = `uploads/{purpose}/{uuid}.ext`,
  **no school dimension**. `GET /api/files/[id]` streams local bytes or 307-redirects to
  a presigned GET; HTTP Range supported.
- Access control (`src/lib/attachment-auth.ts` + `files/[id]`): ownership +
  purpose + assignment checks; **`purpose=assignment` files are readable by ANY
  authenticated user** — a built-in cross-tenant leak under multi-school.
- `resources.file_url`, `gallery_items.image_url`, `news.image_url`,
  `downloads.file_url` hold arbitrary external URLs today.

### 2.8 Reports, dashboards, background/server utilities

- Reports: `/api/reports` (staff aggregates — admin variant is **global** count queries),
  `/api/learner-reports`, `/api/learner/stats`, `/api/grades`.
- Dashboards: `admin` (9 global `count(*)` queries + attendance-by-level),
  `teacher`/`parent` (accept `teacherId`/`parentId` query params from staff tokens),
  `learner` (relationship-checked), `stats` (global counts), `overrides`
  (card override CRUD with `scope_type`/`scope_id`).
- Background/server utilities: **none** (no cron, no queue). Cleanup happens inline
  (`rate-limit.ts` deletes >1 h login attempts on every failed login). Optional
  runtime **self-healing DDL** exists: `src/lib/schema-resilience.ts` can CREATE missing
  optional tables/columns at request time when `AUTO_SCHEMA_REPAIR` is on — a pattern
  that must be fenced off from tenant-critical schema later.

### 2.9 School-related hard-coded data (CBISM inventory)

| Location | Hard-coded content |
| --- | --- |
| `src/app/layout.tsx` | Title "EasyLearn (EL) \| City Best International School Montessori", description, `themeColor #2563eb`, tile color, PWA/apple meta |
| `public/manifest.json` | `name: "EasyLearn - CBISM"`, description, `theme_color #2563eb`, icons |
| `public/sw.js` | PWA shell caching (brand-adjacent) |
| `src/components/website/Navbar.tsx` / `Footer.tsx` | "CBISM" wordmark, address "123 Education Avenue, Accra, Ghana", `info@cbism.edu`, copyright line |
| `src/app/page.tsx` | Hero, school name, About-CBISM section, testimonial, CTA, Google-Maps embed "CBISM Location" |
| `src/app/about/page.tsx` | History + **school anthem lyrics** |
| `src/app/contact/page.tsx`, `admissions/page.tsx` | CBISM contact/admissions copy |
| `src/app/faq/page.tsx` | Hard-coded `faqData` array (the `faqs` **table exists but this page doesn't use it**) |
| `src/app/news/page.tsx`, `gallery/page.tsx`, `downloads/page.tsx` | Hard-coded content; **no API routes exist** for `news`/`gallery_items`/`downloads`/`faqs` (tables are seed-only today) |
| `src/app/dashboard/admin/reports/page.tsx` | CBISM heading |
| `src/app/api/seed/route.ts` | CBISM demo users (`@cbism.edu`, `admin123`/`teacher123`/…), academic year 2024/2025, departments, classes |
| `create-admin.ts` | `admin@cbism.edu` |
| `README.md` | CBISM branding |

### 2.10 Deployment configuration

- **Vercel** (serverless functions, `runtime = "nodejs"`, `dynamic = "force-dynamic"` on
  auth routes); env: `DATABASE_URL` (Neon), `JWT_SECRET`, optional `UPLOAD_DIR`,
  `OBJECT_STORAGE_*`, `UNSPLASH_ACCESS_KEY`, `AUTO_SCHEMA_REPAIR`.
- `next.config.ts`: strict-ish security headers, permissive CSP
  (`unsafe-eval`/`unsafe-inline`, `img-src https: http:`), `X-Frame-Options: DENY`,
  HSTS in production, `no-store` on `/api/*`.
- Neon connection: single Pool per lambda (`max 2`), pooler-compatible SSL settings.

---

## 3. RECOMMENDED TENANT MODEL

```
Platform (EasyLearn)
└── Super Admin (platform role, no school membership required)
    ├── Schools (tenants)                      ← strict security boundary
    │   ├── School Admin(s)    (school_users: role=school_admin)
    │   ├── Head Teacher(s)    (school_users: role=head_teacher)
    │   ├── Teacher(s)         (school_users: role=teacher)
    │   ├── Parent(s)          (school_users: role=parent)
    │   └── Learners           (school_users: role=learner)
    └── Platform data: plans, platform config, platform audit, support sessions
```

**Boundary definition.** A school is the *only* tenancy unit. Every school-owned row
must be attributable to exactly one `school_id`, either directly (classification A) or
through a chain of school-scoped parents that is enforced by composite foreign keys
(classification B). A session executes in exactly one school context
(`schoolId` + `membershipId`), except `super_admin` sessions, which are platform-scoped
and can only enter school data through the explicit, audited support model (§7).

**Non-negotiable invariants:**

1. School A can never read or write any School B row listed in the brief (users, learners,
   parents, teachers, classes, subjects, grades, assignments, submissions, quizzes,
   attendance, announcements, messages, notifications, resources, files, reports,
   academic records).
2. Tenant context comes from the **server-validated session membership**, never from a
   client parameter, subdomain alone, or unverified JWT claim.
3. `super_admin` is not implicitly "admin of every school" for data purposes; support
   access is explicit, time-boxed, reasoned, and audited (§7).
4. Every school-scoped relationship (enrollment, teaching assignment, parent link,
   attendance, assignment→class, file→resource) is structurally prevented from crossing
   schools by composite FKs (§13), not merely by route code.

---

## 4. SCHOOLS TABLE DESIGN (PROPOSED — NOT IMPLEMENTED)

```sql
-- PROPOSAL ONLY — do not run.
CREATE TABLE schools (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                varchar(150) NOT NULL,               -- "City Best International School Montessori"
  short_name          varchar(30)  NOT NULL,               -- "CBISM"
  slug                varchar(63)  NOT NULL,               -- "cbism" → cbism.easylearn.com
  status              varchar(20)  NOT NULL DEFAULT 'active',
                      -- provisioned | active | suspended | archived (lifecycle §4.4)
  plan                varchar(30)  NOT NULL DEFAULT 'free',-- free | standard | premium (summary only, §4.6)
  timezone            varchar(64)  NOT NULL DEFAULT 'Africa/Accra',
  contact_email       varchar(255),
  contact_phone       varchar(20),
  website             varchar(255),
  address_line1       varchar(255),
  address_line2       varchar(255),
  city                varchar(100),
  region              varchar(100),
  country             varchar(100) NOT NULL DEFAULT 'Ghana',
  postal_code         varchar(20),
  map_embed_url       text,                                -- Google-Maps embed (homepage)
  latitude            numeric(9,6),
  longitude           numeric(9,6),
  logo_file_id        uuid,                                -- → uploaded_files (or branding table; §15)
  storage_used_bytes  bigint       NOT NULL DEFAULT 0,     -- maintained counter (§16)
  storage_quota_bytes bigint       NOT NULL DEFAULT 5368709120, -- 5 GiB default
  settings            jsonb        NOT NULL DEFAULT '{}',  -- school prefs (weekend days, grade scale, …)
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX schools_slug_key   ON schools (slug);        -- tenant routing key
CREATE UNIQUE INDEX schools_name_key   ON schools (lower(name)); -- duplicate-school guard
CREATE INDEX        schools_status_idx ON schools (status);
```

### 4.1 Mandatory vs optional fields

- **Mandatory:** `name`, `short_name`, `slug`, `status`, `timezone`, `country`,
  `created_at`, `updated_at`. (`contact_email` strongly recommended at creation.)
- **Optional:** everything else — `plan` defaults to `free`; address/map/website/logo
  filled from branding onboarding; quotas defaulted server-side.

### 4.2 Data types & rationale

- `slug` ≤ 63 chars (DNS-label safe for subdomains); lowercase,
  `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, reserved list (`www`, `api`, `app`, `admin`,
  `mail`, `support`, …).
- `status`/`plan` as `varchar` + CHECK (or pg enums later) to keep Phase-2 migrations
  cheap; `timestamptz` for all new tables (existing schema uses `timestamp` — leave it).
- `storage_used_bytes` as `bigint` counter (integer overflows at 2 GiB).
- `settings` JSONB for low-cardinality preferences that would otherwise bloat columns.

### 4.3 Uniqueness & indexes

`slug` unique (routing), `lower(name)` unique (ops hygiene), `status` indexed (platform
listing). Nothing else is needed at this scale.

### 4.4 Lifecycle / status values

| Status | Meaning | Effects |
| --- | --- | --- |
| `provisioned` | Created, onboarding incomplete | Visible to super admin only; no logins |
| `active` | Operating | Normal |
| `suspended` | Billing/administrative hold | Sessions rejected at gate; data intact; optionally read-only |
| `archived` | Retired | No logins; excluded from lists; data retained for export/audit |

Transitions: `provisioned → active ⇄ suspended → archived` (archived is terminal; no
hard deletes of schools in v1).

### 4.5 Branding: separate table (recommended), not columns-on-schools, not pure JSONB

A 1:1 **`school_branding`** table (full design in §15) keeps `schools` lean, lets
branding evolve (PWA/report-card fields) without touching the tenant root, and still
gives typed, validatable columns. JSONB-only branding is rejected for typed colors/logo
references (validation, defaults, partial updates); a small JSONB block inside
`school_branding` is used for genuinely free-form pieces (social links, report-card
extras).

### 4.6 Subscription information: separate from `schools` (recommended)

Keep `schools.plan` as a **display/entitlement summary**, but put billing truth in a
future `school_subscriptions` table (`school_id`, plan, period, seats, status, provider
refs). Rationale: billing changes on its own cadence, may integrate a provider later,
and must never require touching the security-critical tenant table. **Out of scope for
Phase 2** — only `plan` + `storage_quota_bytes` are proposed now.

---

## 5. TABLE-BY-TABLE TENANT CLASSIFICATION (ALL 35 TABLES)

Classification legend: **A** = directly school-scoped (gets `school_id`) ·
**B** = school-scoped through a parent · **C** = platform-level · **D** = needs redesign.

Principles used: (1) tables that are *listed, filtered by non-parent keys, aggregated, or
constraint endpoints* get a direct `school_id`; (2) pure detail rows always reached via
their parent stay lean (B) and inherit tenancy through composite-FK chains; (3) we do
**not** blindly add `school_id` everywhere.

| Existing Table | Classification | Proposed School Boundary | Reason | Direct school_id? | Important FK / Index (future) |
| --- | --- | --- | --- | --- | --- |
| `users` | **D** | Global identity; school scope via new `school_users` membership | One account must survive future multi-school; roles become per-membership; platform `super_admin` needs no membership | No (stays global) | `school_users(school_id, user_id)` UNIQUE; `school_users(user_id)` idx |
| `academic_years` | **A** | `academic_years.school_id` | `is_current` is inherently per-school; year ranges differ per school | Yes | UNIQUE `(school_id, name)`; idx `(school_id, is_current)` |
| `terms` | **A** (B possible via academic year) | Denormalized `school_id` + composite FK to academic_years | Enables cross-tenant-proof FKs and cheap term lookups; derivation alone can't constrain `terms.academic_year_id` | Yes | FK `(school_id, academic_year_id)` → `academic_years(school_id, id)`; UNIQUE `(school_id, academic_year_id, name)` |
| `departments` | **A** | `departments.school_id` | School org structure; also fixes missing `head_id` FK | Yes | FK `(school_id, head_id)` → `school_users(school_id, user_id)`; UNIQUE `(school_id, name)` |
| `classes` | **A** | `classes.school_id` | Root academic container; routed on directly everywhere | Yes | FK `(school_id, class_teacher_id)` → `school_users`; FK `(school_id, academic_year_id)` → `academic_years`; UNIQUE `(school_id, id)` (FK target); idx `(school_id, academic_year_id)` |
| `subjects` | **A** | `subjects.school_id` | School curriculum | Yes | FK `(school_id, department_id)` → `departments(school_id, id)`; UNIQUE `(school_id, lower(name))` |
| `teacher_classes` | **A** | Denormalized `school_id` | Relationship rows need same-school guarantees for teacher, class AND subject; hot filter path | Yes | Composite FKs `(school_id, teacher_id)`→`school_users`, `(school_id, class_id)`→`classes`, `(school_id, subject_id)`→`subjects`; UNIQUE `(class_id, subject_id, teacher_id, academic_year_id)` |
| `learner_classes` | **A** | Denormalized `school_id` | Enrollments are THE cross-tenant risk; queried by learner and by class | Yes | FKs `(school_id, learner_id)`→`school_users`, `(school_id, class_id)`→`classes`; idx `(learner_id)`, `(class_id)` |
| `parent_learners` | **A** | Denormalized `school_id` | Parent↔learner link must be same-school; Phase-1 helper `isParentLinkedToLearner` gains a school predicate | Yes | FKs `(school_id, parent_id)`, `(school_id, learner_id)` → `school_users`; UNIQUE `(parent_id, learner_id)` (logically already enforced in route) |
| `assignments` | **A** (derivable via class) | Denormalized `school_id` | Listed/aggregated by teacher, class, status; constraint endpoint for questions/files | Yes | FKs `(school_id, class_id)`, `(school_id, subject_id)`, `(school_id, teacher_id)`→`school_users`, `(school_id, term_id)`; idx `(school_id, class_id, status)`, `(teacher_id)` |
| `submissions` | **A** (derivable via assignment) | Denormalized `school_id` | Queried by `learner_id` directly (grades route) — crosses the parent boundary; high-volume | Yes | FK `(school_id, assignment_id)`, `(school_id, learner_id)`→`school_users`; idx `(learner_id)`, `(assignment_id)` |
| `uploaded_files` | **A** | `school_id` of uploader's active school (+ existing optional `assignment_id`) | Files are the classic leak vector (public-ish reads today); quota accounting per school; storage key prefix derives from it | Yes | FK `(school_id, uploader_id)`→`school_users`; idx `(school_id, created_at)`; keep `stored_name` unique |
| `assignment_questions` | **B** | Through `assignments` (composite FK chain) | Never queried outside assignment context; keeps detail rows lean | No (optional denorm later) | Existing FK `assignment_id` — school reachable via assignment |
| `assignment_answers` | **B** | Through `submissions` → assignment | Only read with submissions | No | Existing FKs `submission_id`, `question_id`, `learner_id` |
| `assignment_corrections` | **B** | Through `assignments` | Only read with assignment | No | Existing FKs `assignment_id`, `question_id`, `posted_by` |
| `resources` | **A** | Denormalized `school_id` | Listing filters by class/subject/teacher/approved; `file_url` may be external; approval is per school | Yes | FKs `(school_id, class_id)`, `(school_id, subject_id)`, `(school_id, teacher_id)`→`school_users`, `(school_id, term_id)`; idx `(school_id, is_approved)` |
| `quizzes` | **A** | Denormalized `school_id` | Root assessment container; teacher/class/learner filters | Yes | FKs `(school_id, class_id)`, `(school_id, subject_id)`, `(school_id, teacher_id)`; idx `(school_id, class_id, is_published)` |
| `quiz_questions` | **B** | Through `quizzes` | Detail row | No | Existing FK `quiz_id` |
| `quiz_attempts` | **A** (derivable via quiz) | Denormalized `school_id` | Queried by `learner_id` directly (grades/stats) and aggregated in reports | Yes | FK `(school_id, quiz_id)`, `(school_id, learner_id)`; idx `(learner_id)`, `(quiz_id)` |
| `announcements` | **A** | Denormalized `school_id` (+ optional class) | `is_public` must mean "public *of this school's website*", never platform-global | Yes | FK `(school_id, author_id)`→`school_users`; FK `(school_id, class_id)` nullable; idx `(school_id, is_pinned, created_at)` |
| `notifications` | **A** (derivable via user) | Denormalized `school_id` | Per-user reads are by `user_id`, but notification *creation* is a fan-out inside one school; cheap to denormalize at insert; enables school-scoped ops queries | Yes | FK `(school_id, user_id)`→`school_users`; idx `(user_id, is_read)` (new — none today) |
| `attendance` | **A** (derivable via class) | Denormalized `school_id` | Highest-volume table; per-class date queries; must be composite-FK-guarded (learner/class same school) | Yes | FKs `(school_id, learner_id)`, `(school_id, class_id)`, `(school_id, marked_by_id)`; keep UNIQUE `(learner_id, class_id, date)`; idx `(class_id, date)` (exists) |
| `timetable_entries` | **A** (derivable via class) | Denormalized `school_id` | Queried by class and by teacher; grid rendering per school timezone | Yes | FKs `(school_id, class_id)`, `(school_id, subject_id)`, `(school_id, teacher_id)`, `(school_id, term_id)`, `(school_id, academic_year_id)`; keep existing `(class_id, day_of_week, start_time)` |
| `messages` | **A** | Denormalized `school_id` | Sender and receiver must share a school; receiver validation needs the school predicate | Yes | FKs `(school_id, sender_id)`, `(school_id, receiver_id)`→`school_users`; idx `(sender_id, created_at)`, `(receiver_id, created_at)` |
| `activity_logs` | **A** (hybrid) | `school_id` **nullable**: NULL = platform event | School audit feed vs platform audit; feed queries gain school predicate; support sessions log under both school + platform | Yes (nullable) | FK `(school_id)`→schools; existing user/entity indexes; idx `(school_id, created_at DESC)` |
| `dashboard_card_overrides` | **A** | Denormalized `school_id`; `scope_type=global` becomes "school-global" (platform overrides live in a future platform table) | Overrides are per-school dashboard customization; `scope_id` must be validated same-school | Yes | FK `(school_id, created_by)`→`school_users`; idx `(school_id, card_key, dashboard_role)`; scope refs validated app-level (polymorphic) |
| `achievements` | **C** | Platform catalog; future: nullable `school_id` for school-custom badges | Badges/points are pedagogy-neutral; sharing one catalog across schools is desirable; school-custom badges are a later nullable extension | Not in v1 | Keep `name` unique; later `(coalesce(school_id,'0000…'), name)` unique |
| `learner_achievements` | **B** | Through learner (→ `school_users`); achievement catalog is platform-level | Only read by learnerId; no cross-school pair risk once catalog is platform-level | No | Existing FKs `learner_id`, `achievement_id`; idx `(learner_id)` |
| `learner_points` | **B** | Through learner | Only aggregated by learnerId | No | Existing FK `learner_id`; idx `(learner_id)` |
| `gallery_items` | **A** | `school_id` | School website gallery; `is_public` = public within that school's site | Yes | FK `(school_id)`; idx `(school_id, created_at)` |
| `news` | **A** | `school_id` | School news/events (school-scoped `is_published`) | Yes | FK `(school_id, author_id)`; idx `(school_id, is_event, event_date)` |
| `faqs` | **A** | `school_id` | Per-school FAQ (page is currently hard-coded; table becomes real later) | Yes | FK `(school_id)`; idx `(school_id, order_index)` |
| `downloads` | **A** | `school_id` | Per-school download center | Yes | FK `(school_id)`; idx `(school_id, category)` |
| `login_attempts` | **C** | Platform security telemetry (pre-auth: no school known) | Brute-force ledger keyed by identifier/IP; optionally record attempted school slug later | No | Keep identifier/created indexes (exist) |
| `attendance_duplicates_backup` | **C** | Platform operational archive (0011 artifact) | Historical forensic copy; optional nullable `school_id` for convenience reporting only | No (optional nullable) | Keep date idx (exists) |

**Summary: A = 25 · B = 6 · C = 2 (+ `achievements` platform catalog = 3 platform-level) · D = 1 (`users`).**

---

## 6. USER / MEMBERSHIP ARCHITECTURE

### 6.1 The question: `users.school_id` vs `school_users` vs other

| Option | Verdict | Why |
| --- | --- | --- |
| `users.school_id` column | ❌ Rejected as end-state | Hard max of one school forever; a future shared teacher/parent forces duplicate accounts (two passwords, two identities); platform `super_admin` has no natural school. Easy to migrate *to*, brutal to migrate *away from* later. |
| Separate **`school_users` membership table** | ✅ **Recommended** | Users stay a global identity (one email/username/password, one `id` referenced by every existing FK). Membership is `(school_id, user_id, role, status)` — exactly the school-specific data. One user → one school initially (enforced by a partial unique index); multi-school later by relaxing one index with **zero schema rewrite**. |
| JWT-carried school only | ❌ | Tokens are 24 h and irrevocable today; tenant changes (school suspension, role change, removal) must apply immediately — membership must be re-derived from DB per request. |

### 6.2 Proposed shape (PROPOSAL ONLY)

```sql
CREATE TABLE school_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        user_role NOT NULL,          -- never 'super_admin' in this table
  status      varchar(20) NOT NULL DEFAULT 'active',  -- active | invited | disabled
  is_primary  boolean NOT NULL DEFAULT true,
  permissions jsonb,                       -- optional fine-grained grants later
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Single-school era guard (see decision note below — REMOVED by 0014):
CREATE UNIQUE INDEX school_users_one_school_per_user
  ON school_users (user_id) WHERE status <> 'disabled';
CREATE UNIQUE INDEX school_users_school_user_key ON school_users (school_id, user_id);
CREATE INDEX school_users_school_role_idx ON school_users (school_id, role, status);
CREATE INDEX school_users_user_idx ON school_users (user_id);
```

> **Decision update (Phase 2A, follow-up migration `0014_drop_single_school_guard.sql`):**
> the plan originally proposed the `school_users_one_school_per_user` partial unique
> index as a single-school-era guard. Since `users` is the global identity store and
> `school_users` must support a user belonging to **multiple schools**, that index was
> dropped in the same phase. Multi-school membership is supported from day one; the
> `UNIQUE (school_id, user_id)` constraint still prevents duplicate membership within
> one school. No replacement single-school restriction exists.

### 6.3 How this satisfies every requirement

- **Multi-school-capable membership:** a user can belong to School A and School B
  simultaneously (one membership row per school); duplicates within one school are
  structurally impossible via `UNIQUE (school_id, user_id)`.
- **School-specific roles:** role lives on the membership — the same person can be a
  `teacher` in School A and `school_admin` in School B.
- **Platform `super_admin`:** stays on `users.role` (or, better, a dedicated
  `platform_admins` flag/table in the 2B implementation) and must NOT exist in
  `school_users`; see §7.
- **Every existing FK keeps working:** `submissions.learner_id`, `attendance.learner_id`,
  `messages.sender_id`… still reference `users.id`. Composite FKs added in §13 reference
  `school_users(school_id, user_id)` to make cross-school rows unrepresentable.

### 6.4 The `role` column on `users` during transition

`users.role` remains as the platform-role home (`super_admin` only) and a denormalized
cache of the single membership role. Compatibility rule for Phase 2: for any
non-`super_admin` user, **effective role = membership role**; deprecate `users.role` for
school decisions in Phase 2C; drop nothing.

---

## 7. SUPER ADMIN ARCHITECTURE (PLATFORM VS SCHOOL)

**Problem today:** `super_admin` behaves as "CBISM's strongest admin" — it appears inside
`ADMIN_ROLES`-style checks in school screens (users CRUD, seed, dashboards). Under
multi-school, that conflates *platform operator* with *school administrator* and makes
the super account a walking tenant-bypass.

**Target model:**

1. **`super_admin` is a platform role only.** It grants: create/activate/suspend schools;
   create/reset **school administrator** accounts; view platform-wide metrics (per-school
   counts, storage vs quota, growth); manage `plan`/`storage_quota_bytes`; manage platform
   configuration (reserved slugs, default quota, maintenance banner); view platform audit;
   enter **support mode** on a school. It does **not** appear in `school_users`, and
   school dashboards do not light up for it without support mode.
2. **School administration is a membership role** (`school_admin` in `school_users`), plus
   `head_teacher` as extended-read, unchanged from Phase 1 semantics but school-scoped.
3. **Break-glass / support model** (design; not implemented now):

```sql
CREATE TABLE support_access_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id      uuid NOT NULL REFERENCES users(id),   -- the super admin
  school_id          uuid NOT NULL REFERENCES schools(id), -- school being accessed
  reason             text NOT NULL,                        -- ticket/ref + free text (required)
  requested_role     user_role NOT NULL DEFAULT 'school_admin', -- capped elevation
  status             varchar(20) NOT NULL DEFAULT 'active',     -- active | expired | revoked
  started_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,                 -- hard cap (e.g. +2 h, max 8 h)
  ended_at           timestamptz,
  created_ip         inet,
  approved_by        uuid REFERENCES users(id)             -- optional second-person approval later
);
```

   Mechanics: support mode is **opened explicitly** (`POST /api/platform/support-sessions`
   with mandatory `reason` and `schoolId`), yields a **short-lived, separately-scoped
   token** (15–60 min, claim `support.sessionId`, distinct from the admin's normal
   session), auto-expires, is revocable, and **every request under it writes an audit
   row** (actor, school, action, target, before/after, reason, session id) into both the
   school's and the platform's audit trail. Tenant helpers accept support context *only*
   when a live `support_access_sessions` row exists — there is **no code path** where
   `role === 'super_admin'` alone widens a school query. Support sessions cannot silently
   reset passwords, delete schools, or disable audit logging.
4. **Anti-escalation:** school_admins can never create/modify `super_admin` (already true
   in `/api/users` POST `validRoles`), cannot create memberships outside their school, and
   platform endpoints (`/api/platform/*`) require the platform-role check, never
   `ADMIN_ROLES`.

---

## 8. TENANT RESOLUTION (HOW A REQUEST KNOWS ITS SCHOOL)

| Option | Assessment |
| --- | --- |
| **A. `{slug}.easylearn.com`** | ✅ **Primary recommendation.** Clean cookie separation per school (host-only cookies), no route pollution, no client state, Vercel wildcard-domain friendly (`*.easylearn.com` → one deployment), middleware reads the host. Marketing root stays on `easylearn.com`. |
| **B. `easylearn.com/{slug}` path** | ❌ Rejected as primary. Path tenancy leaks into every link/redirect/SEO surface, makes the boundary a string convention instead of an origin, and a single cookie jar must be manually partitioned per school. |
| **C. Custom domains (`portal.cbism.edu.gh`)** | 🔜 **Later phase.** Fits the same model via `school_domains(school_id, domain, is_primary, verified_at)` + per-request host lookup; needs a domain-verification flow and Vercel domains API. Do **not** build in the first cut. |
| **D. Membership-determines-school** | ✅ **Required complement, never sufficient alone.** At login the server picks the user's active membership and binds it into the session; a school picker/switcher re-issues the session. Membership is the **authorization** source of truth; the host is the **routing** convenience. |

**Recommended initial implementation — one main domain + school subdomains:**

1. `easylearn.com` — platform marketing + login entry (`/login` handles: no membership →
   slug/email flow; one membership → auto-attach; several → picker).
2. `{slug}.easylearn.com` — the school portal (public website **and** dashboards, same
   deployment; new `src/middleware.ts` parses `host`, resolves slug → `schoolId`, and
   forwards it via a request header for that request only).
3. **Login flow:** the login form carries the resolved school context (subdomain or
   explicit slug field); the server verifies the user **has an active membership in that
   school** before issuing a session containing `schoolId`; a user authenticating on the
   root domain without context gets the picker (their memberships only).
4. **API requests:** browser calls are same-origin, so the subdomain arrives with every
   request; the server **cross-checks** host-resolved school vs the session's `schoolId`
   and rejects mismatches (403) — defeating forged params and cookie mixing.
5. **Invitations/links** carry the school subdomain (or `?school=slug` on the root that
   307s to the subdomain) — never a bare token on the wrong host.
6. **Development:** `*.localhost:3000` works with one helper (slug = subdomain part);
   `lvh.me` / `nip.io` also usable.
7. **Vercel:** one deployment + wildcard domain `*.easylearn.com`; custom domains later
   on the same deployment. Resolution is per-request from headers
   (`x-forwarded-host` with fallbacks) — no global mutable state, serverless-safe.

Failure mode is **fail closed**: unknown slug → branded "school not found"; known slug,
suspended school → maintenance page; session school ≠ host school → 403 + audit row.

---

## 9. JWT / SESSION TENANCY

### 9.1 Current token (verified)

`{ userId, email?, username?, role }`, HS256, 24 h, no `jti`/version/session id; stored in
localStorage **and** httpOnly cookie; most routes trust the `role` claim without a DB
re-check (§2.4).

### 9.2 Recommended future token/session claims

```jsonc
{
  "sub": "<userId>",            // global user id (existing userId claim, kept or renamed)
  "sid": "<sessionId>",         // new: enables revocation lists without a full session store
  "schoolId": "<uuid>",         // the ONE school this session is bound to (null only for platform sessions)
  "membershipId": "<uuid>",     // school_users.id the session was issued from
  "role": "teacher",            // EFFECTIVE role = membership role at issue time
  "ver": 2,                     // token schema version for staged rollout
  "support": { "sessionId": "…" } // ONLY on break-glass tokens (§7)
}
```

Rules:

- **The server never trusts a client-supplied `schoolId`.** Not from body, query, custom
  header (other than the resolved host), or even the token's own claim without
  validation. On every request the authorization layer re-derives the membership:
  `school_users WHERE user_id = sub AND id = membershipId AND status = 'active'`
  (short-TTL in-process cache of 30–60 s, invalidated immediately on suspend / role
  change / removal). Stale or missing membership ⇒ 401; session school ≠ host-resolved
  school ⇒ 403 + audit row.
- `role` in the token is a hint; the DB membership is the truth (this also fixes today's
  24-h-stale-role problem).
- Keep 24 h expiry initially; `sid` enables logout-everywhere / suspend-school-kills-
  sessions / support-session expiry via a small revocation table checked on sensitive
  routes.

### 9.3 httpOnly-cookie-only migration (Phase-1 leftover), without breaking the app

Current pain: ~50 client pages read `localStorage.el_token` and attach `Authorization`
headers manually. Safe sequence:

1. Server already accepts the cookie everywhere — keep `Bearer` accepted throughout the
   transition (no breaking change on day one).
2. Introduce one client fetch wrapper (`src/lib/client/api.ts`) using
   `credentials: 'same-origin'` and **no** token header; migrate pages to it
   incrementally (mechanical, page by page).
3. **CSRF hardening for cookie auth** (required before dropping Bearer):
   `SameSite=Lax` is already set (blocks cross-site POSTs); add a **double-submit
   token** (non-httpOnly `el_csrf` cookie + `x-csrf-token` header, compared centrally on
   every mutating route); validate `Origin`/`Referer` against the tenant host on
   mutations; consider `SameSite=Strict` for dashboard cookies later.
4. Stop writing localStorage (login + wrapper), ship a cleanup release
   (`localStorage.removeItem('el_token')` on boot), then remove Bearer support in a later
   release.
5. Cookie scoping: **host-only cookies** (do not set `Domain`) so
   `cbism.easylearn.com` and `other.easylearn.com` never share tokens — the subdomain
   model makes cookie isolation free.

---

## 10. CENTRAL TENANT AUTHORIZATION (THE NEW GATE)

New module **`src/lib/tenant.ts`** (name indicative), designed to *wrap*, not replace,
`src/lib/authorization.ts`:

```ts
// Sketch — shapes only, not implementation.
type AuthContext = {
  userId: string;
  schoolId: string | null;      // null only for platform sessions
  membershipId: string | null;
  role: Role;                   // effective role (membership role, or super_admin)
  supportSessionId?: string;    // present only in break-glass mode
};

requireAuth(req): Promise<AuthContext>;            // 401 unless valid session
requireSchoolContext(req): Promise<AuthContext & { schoolId: string }>;
  // requireAuth + host→school resolution + membership re-validation + host/session match
requireSchoolRole(ctx, ...roles): AuthContext;     // 403 helper
requireSchoolAdmin(ctx): AuthContext;              // school_admin (+ head_teacher where the route table says)
requireSuperAdmin(ctx): AuthContext;               // platform role ONLY
requireSameSchool(ctx, resourceSchoolId): void;    // throws 404 (not 403 — avoid existence leaks)
canAccessSchoolResource(ctx, resource): Promise<boolean>;
  // requireSameSchool + existing Phase-1 relationship rules (teacher-class, parent-link)
```

How the existing `src/lib/authorization.ts` fits:

- `isAdminRole` / `isTeacherRole` etc. keep working as **school-internal** predicates,
  evaluated only *after* `requireSchoolContext`.
- `canAccessLearner`, `canTeacherAccessClass`, `getTeacherAccessibleLearnerIds`,
  `getParentLinkedLearnerIds` gain a `schoolId` parameter and a school predicate in their
  queries (e.g. `teacher_classes WHERE teacher_id = $1 AND school_id = $2`).
- Every route replaces its copy-pasted `getTokenFromRequest` + `verifyToken` + role-`if`
  preamble with one call (`const ctx = await requireSchoolContext(req)`). ~40 duplicated
  preambles collapse into one audited choke point — the single highest-leverage change
  of Phase 2.
- `/api/platform/*` routes use `requireSuperAdmin`; support-mode requests surface
  `ctx.supportSessionId`, which the audit helper records automatically.
- `src/middleware.ts` does **routing only** (host → school attach), never authorization —
  decisions stay in the route layer where the database is reachable (middleware runs on
  the edge).

---

## 11. DATABASE-LEVEL ISOLATION: RLS RECOMMENDATION (NEON)

**Recommendation: both, staged. Application-level tenant checks are mandatory and come
first (Phase 2C). PostgreSQL RLS is defense-in-depth added in a later sub-phase
(2D/2E) once the connection/session pattern is proven — not skipped, but not first.**

Why not app-only forever: one forgotten `WHERE` clause is the entire class of Phase-2
bugs; a DB backstop converts a leak into an empty result. Why not RLS-first: RLS changes
every query's connection semantics, and the current stack fights it:

- **Connection/session handling is the crux on Neon.** The app uses a `pg` Pool
  (`max: 2` per lambda) + Drizzle, optionally through Neon's **pooler** (PgBouncer,
  transaction mode). `SET LOCAL app.school_id = '…'` only survives inside a single
  transaction, so every query would need a `db.transaction()` wrapper that first runs
  `set_config('app.school_id', $1, true)` — plumbing that does not exist yet and touches
  every call site. With session-mode pooling, a plain `SET` risks bleeding tenant context
  **between requests sharing a pooled connection** — the worst possible failure mode if
  gotten wrong.
- **Policies:** per A-table
  `USING (school_id = current_setting('app.school_id', true)::uuid)` plus `WITH CHECK`,
  `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`; the app must connect with a
  dedicated **non-superuser, non-BYPASSRLS** role distinct from the migration role.
  Today `run-migration.js` and `AUTO_SCHEMA_REPAIR` apply DDL with the same credentials
  the app queries with — that role split must exist before RLS means anything.
- **Drizzle compatibility:** good — policies are invisible to the query builder; the cost
  is the transaction wrapper and making `schema-resilience` self-healing DDL RLS-aware
  (run as migration role or disable).
- **Super Admin support access under RLS:** policies can embed the support gate, e.g.
  `OR EXISTS (SELECT 1 FROM support_access_sessions s WHERE s.id =
  current_setting('app.support_session_id', true)::uuid AND s.status = 'active'
  AND s.expires_at > now() AND s.school_id = <table>.school_id)` — the DB itself then
  enforces that bypass is tied to a live, time-boxed, audited support session. Platform
  analytics run under a separate reporting role, isolated from request traffic.
- **Serverless/Vercel risks:** lambda reuse + pooling make any session-level `SET`
  dangerous (context leak across requests); transaction-scoped only, or not at all.
- **Migration complexity:** ~25 policies + composite-FK groundwork + CI guard ("every
  table in schema.ts ships an ENABLE RLS statement").

Decision matrix: 1–10 schools ⇒ app-level checks are adequate; ≥10 schools or compliance
pressure ⇒ add RLS. The §5 classification (direct `school_id` on all A tables) is exactly
what the policies need, so nothing done now is wasted.

---

## 12. CROSS-TENANT DATA LEAK ANALYSIS (ROUTE BY ROUTE)

Risk = leak severity once >1 school exists, assuming today's code unchanged.

| Route | Current authorization (verified) | Current data lookup | Future tenant requirement | Direct `school_id` filter? | Risk |
| --- | --- | --- | --- | --- | --- |
| `GET /api/users` | role ≥ head_teacher | **All users, global** | Membership-school filter via `school_users` | Yes (join) | **CRITICAL** |
| `POST /api/users` | school_admin+ (`super_admin` excluded from validRoles) | inserts global user | Create user + membership in ctx school only | Yes | **CRITICAL** |
| `GET/PUT/DELETE/PATCH /api/users/[id]` | role checks (DELETE: super only) | `WHERE id = $1` — the canonical case that must become `WHERE id = $1 AND school_id = ctx` | Resource must belong to ctx school (via membership) | Yes | **CRITICAL** |
| `GET /api/grades` | `canAccessLearner` (Phase 1) | submissions + quiz_attempts by learnerId | learner same-school inside `canAccessLearner` | via learner membership + A tables | HIGH |
| `GET/POST /api/attendance` | Phase-1 role + relationship matrix | class/learner filters; **admin branch = all rows** | admin branch school-scoped; POST class must be ctx school | Yes (A) | **CRITICAL** (admin path) |
| `GET/POST/PUT /api/enrollments` | Phase-1 relationship checks; POST school_admin+ | by class/learner; **POST never validates learner role or same-school pair** | schoolId derived from class; composite FKs make cross-school inserts impossible | Yes (A) | **CRITICAL** |
| `GET/POST /api/assignments` | teacher→own; learner (class filter only if param given) | **learner can list all published assignments globally** | learner branch joins own enrollments within school | Yes (A) | HIGH |
| `GET /api/assignments/[id]` | teacher-own / staff / learner (+submission status) | `WHERE id = $1` | `AND school_id = ctx` | Yes | HIGH |
| `POST /api/assignments/[id]/submit` | learner + published + enrollment check **with legacy fallback** (check skipped if learner has no enrollment rows at all) | assignment `WHERE id` | remove fallback after enrollment integrity; assignment school = ctx | Yes | HIGH |
| `GET /api/assignments/[id]/questions` | staff-owner / learner | by assignment | school via assignment (B) | via parent | MED |
| `GET/POST /api/assignments/[id]/corrections` | staff-owner; learner reads | by assignment | same | via parent | MED |
| `GET /api/assignments/[id]/results` | teacher-own / staff / learner / parent | by assignment + learners | all rows same school | via parent | MED |
| `GET/POST /api/submissions` | learner self / teacher-own / staff | **staff branch = all submissions globally** | staff branch school filter | Yes (A) | **CRITICAL** |
| `GET /api/submissions/[id]` + `/grade` | teacher-own / staff / learner | `WHERE id = $1` | `AND school_id = ctx` | Yes | HIGH |
| `GET/POST /api/quizzes` | teacher-own; learner published + enrolled classes (**fallback: all published quizzes when learner has no enrollments**) | as described | school filter + remove fallback (Phase-1 leftover) | Yes (A) | HIGH |
| `GET/PUT/DELETE /api/quizzes/[id]` | teacher-own / staff / learner | `WHERE id = $1` | `AND school_id = ctx` | Yes | HIGH |
| `POST /api/quizzes/[id]/attempt`, `/check` | learner + published + enrollment (**same fallback**) | quiz `WHERE id` | ctx school; remove fallback | Yes | HIGH |
| `GET/POST /api/resources` | teacher-own; learner/parent approved-only | **approved resources = any school's** | school filter on every branch | Yes (A) | HIGH |
| `GET /api/files/[id]`, `DELETE /api/uploads/[id]` | ownership / assignment-teacher / admins; **purpose=assignment: ANY authenticated user** | `WHERE id = $1` | `AND school_id = ctx`; tighten purpose=assignment to school members | Yes | **CRITICAL** |
| `POST /api/uploads`, `/presign` | role/purpose/assignment rules (Phase 1) | uploader-scoped insert | storage key prefix + row school = ctx | Yes | HIGH |
| `GET/POST /api/announcements` | unauth `?public=true`; authed = **ALL announcements globally** (no school/class filter) | ordered list | school filter on every branch; `is_public` scoped to the school site | Yes | **CRITICAL** |
| `GET/PUT /api/notifications` | self-owned only (Phase 1) | `user_id = ctx` | recipient same school (denormalized school_id on insert) | Yes | MED |
| `GET/POST /api/messages` | self conversations; **receiver existence not school-checked** | by sender/receiver pairs | receiver must be same school | Yes (A) | HIGH |
| `GET/POST /api/timetable`, `[id]` | role-filtered; teacher own classes; admin all | by class/teacher | admin branch school filter; entry class = ctx | Yes (A) | HIGH |
| `GET /api/reports` | staff; teacher self-scoped | **admin aggregates are global `count(*)`** | school filter on every aggregate | Yes | HIGH |
| `GET /api/learner-reports` | staff via `getAccessibleLearnerIds` (**admin branch = all learners globally**) | per learner | school filter in admin branch | Yes | HIGH |
| `GET /api/learner/stats` | `canAccessLearner` (Phase 1) | per learner | school via learner membership | via learner | MED |
| `GET /api/dashboard/stats`, `/admin` | school_admin+ | **global counts** | school filter everywhere | Yes | HIGH |
| `GET /api/dashboard/teacher`, `/parent` | role + **`teacherId`/`parentId` query param trusted from staff tokens** | by param | param user must be same school | via membership | MED |
| `GET /api/dashboard/learner` | self / parent-link / staff-any | per learner | staff branches school-scoped | via learner | MED |
| `GET/POST /api/dashboard/overrides`, `[id]` | school_admin+ | **global override rows**; `scope_id` unchecked | school filter; validate `scope_id` same school | Yes | MED |
| `GET /api/activity-logs` | school_admin+ | **all logs globally** | `school_id = ctx` (platform logs only via super admin) | Yes (nullable col) | HIGH |
| `academic-years`, `terms`, `subjects`, `departments`, `classes`, `teacher-classes`, `parent-learners` (list+create) | role-gated | **global catalog create/list — any admin writes rows shared by every school** | create with ctx school; list ctx school; cross-school refs rejected by composite FKs | Yes (A) | **CRITICAL** |
| `[id]` routes: `classes`, `subjects`, `departments`, `teacher-classes`, `parent-learners`, `timetable`, `dashboard/overrides`, `uploads` | role-gated | `WHERE id = $1` | `AND school_id = ctx` | Yes | HIGH |
| `POST /api/seed` | 404 in prod; super in dev | seeds CBISM demo | must seed with explicit schoolId; stay disabled in prod | n/a | LOW |
| `GET /api/images/search` | staff | external API proxy | unchanged (no stored data) | n/a | NONE |
| `GET /api/health` | public | schema probes only | add schools probe (never data) | n/a | NONE |

**Every current `WHERE id = …` lookup that must become
`WHERE id = … AND school_id = <ctx>` (or an equivalent membership join):**
`users/[id]` (GET/PUT/DELETE/PATCH), `classes/[id]`, `subjects/[id]`, `departments/[id]`,
`teacher-classes/[id]`, `parent-learners/[id]`, `timetable/[id]`,
`dashboard/overrides/[id]`, `uploads/[id]`, `files/[id]`, `assignments/[id]` and its
subresources, `submissions/[id]` + `grade`, `quizzes/[id]` + `attempt`/`check` — plus
every admin-branch list/aggregation marked CRITICAL/HIGH above.

---

## 13. FOREIGN KEY / CONSTRAINT DESIGN (MAKING CROSS-TENANT ROWS UNREPRESENTABLE)

Core pattern: **every A-class table gets `school_id uuid NOT NULL`, a UNIQUE
`(school_id, id)` index (making it a valid FK target), and all references to other
school-scoped tables become composite FKs `(school_id, other_pk)`.** References to users
go through `school_users(school_id, user_id)` (UNIQUE there) so "user belongs to this
school" is enforced by the database, not by route code.

```sql
-- FK targets (repeat on every A-class table):
ALTER TABLE classes ADD UNIQUE (school_id, id);

-- Enrollments: learner of School A cannot be enrolled into a class of School B:
ALTER TABLE learner_classes ADD COLUMN school_id uuid;  -- backfill first, then:
ALTER TABLE learner_classes
  ADD CONSTRAINT lc_school_fk  FOREIGN KEY (school_id) REFERENCES schools(id),
  ADD CONSTRAINT lc_learner_fk FOREIGN KEY (school_id, learner_id)
    REFERENCES school_users(school_id, user_id),
  ADD CONSTRAINT lc_class_fk   FOREIGN KEY (school_id, class_id)
    REFERENCES classes(school_id, id),
  ADD CONSTRAINT lc_year_fk    FOREIGN KEY (school_id, academic_year_id)
    REFERENCES academic_years(school_id, id);

-- Teacher A assigned to class B: same pattern over teacher_classes (teacher, class, subject).
-- Parent A linked to learner B: both FKs → school_users(school_id, user_id).
-- Assignment A referencing class B: assignments composites over (school_id, class_id/subject_id/term_id);
--                                   teacher FK → school_users.
-- Attendance crossing schools: attendance (school_id, learner_id), (school_id, class_id),
--                              (school_id, marked_by_id) — the unique (learner, class, date)
--                              stays, now intra-school by construction.
-- Notification in the wrong school: notifications (school_id, user_id) → school_users.
-- File referencing another school's resource: uploaded_files (school_id, uploader_id),
--                              (school_id, assignment_id) → assignments.
-- Messages: BOTH sender and receiver FK → school_users(school_id, user_id) ⇒ same-school DMs only.
-- Overrides: dashboard_card_overrides (school_id, created_by); polymorphic scope_id validated app-level.
```

B-class tables need no extra FKs (their parent chain is already guarded), keeping the
migration surface small. On live tables use two-step constraints —
`ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT` — so validation takes only a
short lock; any pre-existing violating row makes validation **fail loudly before
enforcement**, which is exactly the production-safety behavior wanted (§20).

---

## 14. CBISM MIGRATION PLAN (STRATEGY ONLY — NOTHING EXECUTED)

Current state: **every existing row belongs to CBISM** (single implicit tenant). Target:
CBISM becomes the `schools` row with `slug='cbism'`. The migration is **additive and
reversible** at every step until final `NOT NULL` enforcement.

**Safe sequence:**

1. **Create school** — idempotent insert of the CBISM row (`status='active'`, Ghana
   defaults, default quota) + its `school_branding` row populated from the hard-coded
   inventory (§2.9). Keyed on `slug`.
2. **Identify CBISM users** — today that is *all* users; verify with counts by role and a
   manual review list; freeze user creation during the window.
3. **Associate users** — one `school_users` row per user (`role = users.role`,
   `status='active'`); **`super_admin` accounts excluded** (platform). Check:
   `count(users) − super_admins = count(school_users)`.
4. **Associate academic years** — `UPDATE academic_years SET school_id = :cbism`.
5. **Associate terms / departments / subjects / classes** — same single-table updates;
   fix the `departments.head_id` / `classes.class_teacher_id` FK gaps opportunistically.
6. **Associate relationships** — `teacher_classes`, `learner_classes`, `parent_learners`
   (school_id derivable from either side; both sides are CBISM).
7. **Associate the long tail** — assignments, submissions, quiz_attempts, resources,
   uploaded_files, attendance, timetable_entries, announcements, notifications, messages,
   dashboard_card_overrides, gallery/news/faqs/downloads, activity_logs (nullable rules
   below). B-class rows (assignment_questions/answers/corrections, quiz_questions,
   learner_achievements, learner_points) need nothing.
8. **Validate all dependent records** — scripted checks: every A-row has `school_id`;
   zero NULLs outside allowed columns; zero cross-school pairs (dry-run the §13 composite
   FKs via `NOT VALID` + validation queries); per-table row counts unchanged.
9. **Enforce tenant constraints** — `SET NOT NULL` on A-table `school_id`; add composite
   FKs (`NOT VALID` → `VALIDATE`); add indexes (`CONCURRENTLY` where possible).
   `activity_logs.school_id` **stays nullable forever** (platform events); historical rows
   are CBISM-stamped by convention (documented).
10. **Verify zero orphan / cross-school records** — run the Phase-2G isolation suite
    (§18) against a staging snapshot / read replica before flipping the app on.

**Records that cannot safely be auto-assigned (manual decisions):**

- `login_attempts` — platform telemetry, no school concept (leave untouched).
- `attendance_duplicates_backup` — forensic archive; optional nullable stamp only.
- `achievements` — becomes the platform catalog; no stamping.
- `activity_logs` — nullable school; pre-migration rows CBISM-stamped by convention.
- `uploaded_files` rows whose bytes are already gone (ephemeral Vercel disk) — rows can be
  stamped, but list them for an ops cleanup (row exists, object missing).
- Public-website content (`gallery_items`, `news`, `faqs`, `downloads`) — **decision
  point:** CBISM-owned (recommended while the public pages are CBISM-branded) vs
  platform-owned marketing content.
- Seeded demo accounts (`admin@cbism.edu`, `teacher@cbism.edu`, … from `/api/seed` and
  `create-admin.ts`) — review before stamping; likely deactivate rather than migrate.

**Rollback:** through step 7 everything is additive (nullable columns, new tables) —
rollback = drop added columns/tables. After step 9, rollback = drop constraints/columns
(no data loss, but a planned window). Hence enforcement happens only after validation
passes on a replayed staging snapshot.

---

## 15. SCHOOL BRANDING ARCHITECTURE (DESIGN ONLY)

Recommended: **separate 1:1 `school_branding` table** — typed columns for everything
validated, JSONB only for genuinely open-ended sets:

```sql
CREATE TABLE school_branding (
  school_id        uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  display_name     varchar(150) NOT NULL,
  short_name       varchar(30)  NOT NULL,
  motto            varchar(255),
  logo_file_id     uuid REFERENCES uploaded_files(id),  -- school-uploaded logo
  logo_url         text,                                -- external URL (transition)
  favicon_url      text,
  primary_color    char(7) NOT NULL DEFAULT '#2563eb',
  secondary_color  char(7) NOT NULL DEFAULT '#1e40af',
  accent_color     char(7),
  contact_email    varchar(255),
  contact_phone    varchar(20),
  website          varchar(255),
  address_line1    varchar(255),
  address_line2    varchar(255),
  city             varchar(100),
  region           varchar(100),
  country          varchar(100),
  postal_code      varchar(20),
  map_embed_url    text,
  social_links     jsonb NOT NULL DEFAULT '[]',  -- [{platform, url}]
  report_card      jsonb NOT NULL DEFAULT '{}',  -- header text, signature lines, footer
  pwa              jsonb NOT NULL DEFAULT '{}',  -- theme colors, icon refs
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

Why not the alternatives: **columns on `schools`** bloats the security-critical tenant
root and couples branding churn to tenant migrations; **pure JSONB** loses
type/validation on the fields that matter (colors, logo references) and makes defaults
painful. A hybrid (typed core + JSONB blocks for `social_links`/`report_card`/`pwa`)
gives validation where it counts and flexibility where the shape is open.

Surfacing plan (later implementation, not now): `generateMetadata` per resolved school
(title, description, theme-color, icons); dynamic `/manifest.webmanifest` route;
school-aware `sw.js` cache name; Navbar/Footer/Home/About/Contact/Admissions/Faq switch
from hard-coded CBISM JSX to the branding record (platform fallback on the root domain);
report-card rendering reads the `report_card` block. Phase-2H work item.

---

## 16. FILE STORAGE TENANCY (DESIGN ONLY)

Current: flat local disk or flat object keys (`uploads/{purpose}/{uuid}`), one implicit
tenant; `purpose=assignment` readable by *any* authenticated user (a leak).

**Target key structure (identical shape on both backends):**

```
schools/{schoolId}/assignments/{yyyy}/{uuid}.{ext}
schools/{schoolId}/submissions/{yyyy}/{uuid}.{ext}
schools/{schoolId}/branding/{uuid}.{ext}
schools/{schoolId}/gallery/{yyyy}/{uuid}.{ext}
platform/{...}                                  # EasyLearn's own assets
```

Design decisions:

- **Private bucket only.** Every read flows through `GET /api/files/[id]`, which checks
  (a) row `school_id == ctx.schoolId` (super admin only via an active support session),
  (b) the existing Phase-1 relationship rules, and (c) tightens `purpose=assignment`
  from "any authenticated user" to "member of the file's school" — then serves bytes or
  307s to a short-lived presigned URL (mechanics unchanged).
- **Presigned uploads:** `POST /api/uploads/presign` builds the key server-side with
  `ctx.schoolId`; the client can never influence the prefix. Keep type/size gates.
- **Quotas:** enforce at presign/upload time —
  `storage_used_bytes + size <= storage_quota_bytes`; maintain the counter transactionally
  with the `uploaded_files` insert (and on delete). Per-school usage reporting = one row
  read.
- **Metadata/ownership:** `uploaded_files.school_id` is the authorization source of
  truth; the key prefix is defense-in-depth and ops ergonomics (per-school lifecycle,
  export = rows + `schools/{id}/**` prefix copy).
- **Deletion / orphans:** soft-delete rows; a scheduled sweeper (Vercel Cron) reconciles
  bucket listings vs `uploaded_files` per school, quarantines orphans before deleting,
  and alerts when `storage_used_bytes` drifts from `SUM(size_bytes)`.
- **Backup:** object-store versioning/replication per bucket policy; the DB registry is
  the index.
- **Local-disk backend** keeps working with the same prefix under `UPLOAD_DIR`
  (non-durable on Vercel — object storage stays the production recommendation).
- **No storage migration in Phase 2**: new keys for new uploads only; rows carry
  `storage_backend`, so mixed eras coexist until an optional later backfill.

---

## 17. AUDIT LOGGING ARCHITECTURE (DESIGN ONLY)

Keep `activity_logs` as the in-app UX feed; add a dedicated append-only **`audit_logs`**
— conflating feeds with security audit has already forced sanitization compromises in
the `activity-logs` route.

```sql
CREATE TABLE audit_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid REFERENCES schools(id),   -- NULL = platform event
  actor_user_id      uuid REFERENCES users(id),
  actor_role         varchar(30),
  support_session_id uuid REFERENCES support_access_sessions(id),  -- break-glass attribution
  action             varchar(100) NOT NULL,         -- 'login', 'login.failed', 'grade.change', …
  entity_type        varchar(100),
  entity_id          uuid,
  target_user_id     uuid REFERENCES users(id),
  before             jsonb,
  after              jsonb,                         -- diffs for mutations
  reason             text,                          -- required for support + destructive actions
  ip_address         inet,
  user_agent         text,
  request_id         text,
  session_id         uuid,                          -- sid claim
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_school_time_idx ON audit_logs (school_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx       ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx      ON audit_logs (entity_type, entity_id);
-- Append-only: REVOKE UPDATE, DELETE ON audit_logs FROM <app_role>;
```

**Events to record:** login success / failed login (identifier + school + IP); password
changes (self, admin reset); user creation / deactivation / deletion; membership and role
changes; grade changes (submission scores, quiz scoring); attendance changes (incl. bulk
mark); result publishing; school configuration & branding changes; school
create/suspend/plan/quota changes; file uploads and downloads of submission files; quota
threshold events; **every support-session open/close and every action taken under it**.

**Fields** (as above): actor, school, action, entity/target, timestamp, IP, user-agent,
before/after diffs, reason, request id, session id. Never store passwords; keep
`before/after` minimal (redact unnecessary PII); retention ≥ 1 year for platform rows,
contract-driven for school rows. Written via one `recordAudit(ctx, event)` helper called
alongside (not instead of) `logActivity`.

---

## 18. MULTI-TENANT TEST STRATEGY (MANDATORY FOR PHASE 2)

Test pyramid (extending today's `npm test`):

1. **Static guards** (extend `tests/security.test.js` style): every API route file must
   reference `requireSchoolContext`/`requireSuperAdmin` (no raw `verifyToken` preambles);
   every schema table with `schoolId` appears in a migration with a NOT NULL/composite-FK
   statement; no route file reads a cross-tenant raw param (`schoolId` from body/query is
   forbidden outside `/api/platform/*`).
2. **Pure-function units** (extend `tests/real-authorization.test.ts`): school-boundary
   logic with two-school fixtures — `requireSameSchool`, school-scoped
   `canAccessLearner`, membership resolution.
3. **Integration isolation suite (new, the core of Phase 2G)** — runs against a
   disposable database (Neon branch or local Postgres) seeded with **School A and
   School B**, each with admin/head/teacher/parent/learner + classes + assignments +
   attendance + files; drives real HTTP calls (route handlers or a booted dev server).

Mandatory scenarios:

**School isolation (all must PASS as "denied/empty"):**

- School A learner cannot read School B user (`GET /api/users/[id]`)
- School A teacher cannot access School B learners (grades, attendance, enrollments)
- School A parent cannot access School B children (attendance, grades, reports)
- School A admin cannot list/read School B records (users, classes, subjects, logs)
- School A cannot modify School B attendance (`POST /api/attendance`)
- School A cannot read School B grades (`/api/grades`, `/api/learner-reports`)
- School A cannot access School B files (`GET /api/files/[id]` — incl. purpose=assignment)
- School A cannot read School B announcements (`/api/announcements`)
- School A cannot read School B reports/dashboards (`/api/reports`, `/api/dashboard/*`)

**Cross-tenant relationships (all must FAIL to insert):**

- learner A → class B (`POST /api/enrollments`, and direct DB insert must violate FK)
- teacher A → class B (`POST /api/teacher-classes`, same)
- parent A → learner B (`POST /api/parent-learners`, same)
- assignment A → class B (create/patch assignment, DB constraint)
- attendance A → learner/class B (`POST /api/attendance`, DB constraint)

**Super Admin:**

- Platform endpoints respond only to `super_admin`
- Support access requires explicit session creation (reason + time limit); expires; is
  audited (audit rows exist for every support-mode request)
- School admin cannot escalate: cannot create super_admin, cannot create cross-school
  memberships, cannot reach `/api/platform/*`

**Auth/session:** token without `schoolId` rejected after cutover; forged `schoolId`
param ignored; host/session mismatch → 403; suspended school → 403; CSRF: mutation
without `x-csrf-token` → 403 once cookie-only ships.

---

## 19. PERFORMANCE / SCALABILITY

| Scale | Assessment | What is required |
| --- | --- | --- |
| 1 school (today) | Fine; global queries and missing FK indexes are invisible | Nothing beyond Phase-2 correctness work |
| 10 schools | App-level tenant filters suffice; every list query now carries `school_id` | The §5 indexes; fix the obvious N+1s (assignments GET does one submission query **per assignment**; dashboard/admin fires ~12 parallel counts — fine at this scale) |
| 100 schools | Query shapes matter; Postgres still one database | Composite indexes `(school_id, …)` everywhere; Neon autoscaling + pooler; tenant-scoped prepared statements; cache public marketing pages (they are currently static JSX — keep static, brand via subdomain-safe defaults); avoid cross-school aggregates in request paths |
| 1,000 schools | Same architecture, operational discipline | Partition-by-tenant *only if* a table gets hot (attendance is the candidate; `(school_id, date)` range partitions); RLS baseline done; per-school storage quotas enforced; analytics move to read replica / scheduled jobs (Vercel Cron), not request paths |

Current risks to fix opportunistically (not prematurely):

- **Missing FK indexes** (most FK columns unindexed) — add the `(school_id, …)` composites
  in the same migrations; no separate index pass needed.
- **Connection pool**: `max: 2` per lambda is correct for serverless + Neon pooler;
  do not raise it; rely on Neon autoscale. No PgBouncer of our own.
- **N+1s**: `GET /api/assignments` learner branch (per-assignment submission lookup →
  single `IN` query), `getAccessibleLearnerIds` (sequential queries → `Promise.all`).
- **Caching**: no Redis/queue justified yet. `Cache-Control: no-store` on API is correct;
  public website pages can go ISR/static with per-school defaults once branding lands.
- **Serverless behavior**: cold starts unchanged; middleware host-parse is O(1); school
  resolution should be cached per-lambda with a short TTL (slug → schoolId rarely changes).
- **Background jobs**: none today; when quotas/orphan-sweeps arrive, use **Vercel Cron +
  a single idempotent handler** — no queue infrastructure.
- **Object storage**: presigned direct uploads already bypass function limits; CDN in
  front of the bucket for public branding/gallery assets at ≥100 schools.

---

## 20. PRODUCTION SAFETY (FOR THE EVENTUAL IMPLEMENTATION)

The implementation must preserve all CBISM data, avoid destructive resets, use proper
migrations, and let CBISM keep operating throughout. Danger list for the live Neon
database:

1. **`ALTER TABLE … ADD COLUMN school_id uuid NOT NULL`** without a default on a
   populated table — safe in PG11+ only *with* `DEFAULT`; the safe pattern is
   `ADD COLUMN school_id uuid` (nullable) → backfill → `SET NOT NULL`.
2. **Backfill `UPDATE`s on big tables** (attendance, submissions, notifications) take row
   locks — batch them or run in the low-traffic window; they are single-statement per
   table here (small data), but plan for growth.
3. **Adding FK constraints with immediate validation** locks and scans the table — always
   `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT` separately.
4. **Creating indexes** on populated tables — use `CREATE INDEX CONCURRENTLY` (cannot run
   inside a transaction; `run-migration.js` executes statement-by-statement, which fits).
5. **`run-migration.js` has no ledger** — it re-runs everything idempotently. Phase 2A
   should add a `schema_migrations` ledger (or adopt drizzle journal strictly) so
   "applied" is knowable — critical once migrations become non-idempotent (data
   backfills).
6. **`AUTO_SCHEMA_REPAIR` runtime DDL** must never create tenant-critical objects; the
   self-heal list must be frozen (or disabled) once tenant schema ships.
7. **RLS enablement before app changes** would instantly break every query (empty
   results) — RLS only after the transaction-scoped context wrapper exists.
8. **Never** drop/rename existing columns; never truncate; no `drizzle-kit push`
   against production without review (it can emit destructive diffs).
9. **Dual-running**: nullable `school_id` + app feature flag lets CBISM continue on the
   old code path while tenant checks roll out; enforcement is a config flip after the
   isolation suite passes on a production snapshot.
10. **Rollback**: every step through §14 step 7 is reversible (drop added columns/tables);
    after §14 step 9 reversal drops constraints only — no data loss either way.

---

## 21. PHASE 2 IMPLEMENTATION SEQUENCE (RECOMMENDED ORDER)

| Sub-phase | Scope | Exit criteria |
| --- | --- | --- |
| **2A — Tenant schema foundation** | `schools`, `school_branding`, `support_access_sessions`, `audit_logs` tables (all additive); `schema_migrations` ledger; migration-runner hardening | Migrations apply idempotently on prod copy; health endpoint reports tenant tables |
| **2B — User membership & auth** | `school_users`; login issues `schoolId`+`membershipId`+`sid` claims; membership re-validation helper; token `ver:2`; localStorage deprecation starts (fetch wrapper + CSRF double-submit) | Two users in two schools can exist; every request resolves a validated `AuthContext` |
| **2C — Tenant authorization** | `src/lib/tenant.ts` gates; all ~40 routes migrated to `requireSchoolContext`/`requireSuperAdmin`; §5 `school_id` columns added (nullable) and populated on write; lists/reads filtered | Static guard tests pass; manually verifiable A-vs-B isolation on all CRITICAL routes |
| **2D — Database constraints** | Backfills; `NOT NULL`; composite FKs (`NOT VALID`→`VALIDATE`); new indexes | Validation queries report zero orphans/cross-school rows; constraint violations impossible at DB level |
| **2E — Tenant resolution** | `{slug}.easylearn.com` wildcard + middleware host parsing; login/picker flows; host/session cross-check; (optional here) RLS enablement with transaction-scoped context | School A on cbism host cannot act as School B even with crafted requests; custom-domain table designed but not live |
| **2F — CBISM migration** | §14 sequence executed against production (snapshot-rehearsed first) | CBISM runs as a first-class school; all data stamped; zero functional regressions |
| **2G — Cross-tenant testing & hardening** | §18 suite in CI; audit-log events wired; support-mode flow; storage prefix for new uploads | Full isolation suite green; break-glass audited; docs updated |

Rationale for the order: schema before membership (2A→2B), membership before enforcement
(2B→2C), enforcement before constraints (2C→2D) so the app never writes rows the DB would
reject, resolution after core isolation works (2E can ship while everyone is still on the
root domain), and the data migration only once the machinery is proven (2F), with tests
and audit last-but-continuous (2G).

---

## 22. RISKS AND TRADE-OFFS

| Risk / trade-off | Mitigation |
| --- | --- |
| Denormalized `school_id` on 25 tables can drift from parents | Composite FKs make drift impossible for pairs; app writes derive schoolId server-side from one source |
| Two migration systems (root files + drizzle/) | 2A consolidates on the numbered files + ledger; `run-migration.js` stays the executor |
| Route-by-route retrofit is ~40 files | Central `tenant.ts` makes each edit mechanical; static guard tests prevent regressions |
| Subdomain rollout needs DNS/wildcard + Vercel config outside the repo | 2E is a config milestone; membership fallback keeps the app working on the root domain meanwhile |
| httpOnly-only migration touches ~50 client pages | Wrapper-first incremental approach; Bearer stays valid until cutover complete |
| RLS on Neon pooler is genuinely hard | Deferred, optional, and only with transaction-scoped context; app-level checks alone already meet the isolation goal |
| `super_admin` convenience lost (currently sees everything) | Support-mode flow preserves legitimate access with audit; UX cost accepted for security |
| Performance of per-school filtering at scale | Indexes land with the columns (§5); no separate retro-fit pass needed |
| Hard-coded CBISM public pages vs multi-school | Out of scope for core tenancy; 2H branding phase addresses it; subdomains render current pages until then |

---

## 23. EXACT FILES / MODULES LIKELY TO CHANGE (FUTURE IMPLEMENTATION)

**New (core):** `src/lib/tenant.ts` (authorization gates) · `src/lib/client/api.ts`
(cookie fetch wrapper) · `src/middleware.ts` (host → school) · `src/db/schema.ts`
additions (`schools`, `schoolUsers`, `schoolBranding`, `supportAccessSessions`,
`auditLogs`, optional `platformConfig`) · `src/app/api/platform/*` (schools CRUD,
support-sessions, metrics) · `/manifest.webmanifest` dynamic route.

**Modified (server):** `src/lib/auth.ts` (claims, `ver`, sid) ·
`src/lib/authorization.ts` (schoolId params + school predicates) · `src/lib/uploads.ts`,
`src/lib/upload-auth.ts`, `src/lib/attachment-auth.ts`, `src/lib/object-storage.ts`
(school key prefix, quota, tightened file reads) · `src/lib/activity.ts` (+ new
`recordAudit`) · `src/lib/dashboard-overrides.ts` (school scoping) · `src/lib/env.ts`
(+ `ROOT_DOMAIN`, `WILDCARD_PARENT`) · `src/lib/api-helpers.ts` (404-vs-403 helper,
CSRF check) · `src/db/index.ts` (optional tx-context helper for RLS later).

**Modified (routes — all ~40 files):** every `src/app/api/**/route.ts` per §12; plus new
`auth/select-school` (membership switch) and platform routes.

**Modified (client):** `src/app/login/page.tsx` (school context + picker) ·
`DashboardShell`/nav components (school name, switcher) · all dashboard pages'
data-fetch → wrapper · website pages at 2H (branding).

**Modified (ops/tests/docs):** `run-migration.js` (+ledger) · `drizzle.config.ts`
unchanged · `.env.example` (+ tenant vars) · `next.config.ts` (unchanged or CSP tweak for
bucket host) · `tests/` (new isolation suite + extended static guards) · `README.md` /
`SECURITY_PHASE1.md` successor doc.

---

## 24. RECOMMENDED FUTURE MIGRATION FILES (PROPOSALS ONLY — DO NOT RUN)

| File (suggested) | Contents |
| --- | --- |
| `drizzle/0013_schools.sql` | `schools` table + indexes (§4) |
| `drizzle/0014_school_branding.sql` | `school_branding` 1:1 table (§15) |
| `drizzle/0015_school_users.sql` | `school_users` + unique/indexes (§6) |
| `drizzle/0016_audit_and_support.sql` | `audit_logs`, `support_access_sessions` (§7, §17) |
| `drizzle/0017_school_id_columns.sql` | nullable `school_id` on all 25 A-tables + `UNIQUE (school_id, id)` targets |
| `drizzle/0018_cbism_backfill.sql` | insert CBISM school; `school_users` from users (excl. super_admin); per-table `UPDATE … SET school_id` |
| `drizzle/0019_tenant_constraints.sql` | `NOT NULL` + composite FKs (`NOT VALID` → `VALIDATE`) on relationship tables (§13) |
| `drizzle/0020_tenant_indexes.sql` | `(school_id, …)` composite indexes (`CONCURRENTLY` where run out-of-tx) |
| `drizzle/0021_platform_auth_cleanup.sql` | (optional) `platform_admins` table / `users.role` deprecation notes; seed-data deactivation |
| `drizzle/0022_rls_enable.sql` | (later, optional) roles + policies + `app.school_id` gating per §11 |

Each file idempotent where possible; backfill files must be **explicitly non-idempotent
but ledger-tracked** (they mutate data) — hence the 2A ledger requirement.

---

## 25. DEFINITION OF DONE — PHASE 2

1. `schools` exists; CBISM is a real school record; all legacy data is stamped and
   verifiably CBISM-owned; zero orphan/cross-school rows (validated by scripted checks).
2. A user belongs to a school through `school_users`; sessions carry
   `schoolId`/`membershipId`/`sid` and are re-validated server-side every request; a
   client-supplied `schoolId` is always ignored.
3. Every API route authorizes through the central tenant module; no route performs its
   own ad-hoc tenant logic; platform routes require the platform role.
4. Automated isolation suite proves School A cannot read/write any School B resource
   across all categories in §18, in CI, on every PR.
5. Cross-tenant relationships are impossible at the database level (composite FKs), not
   only at the API level.
6. Super admin is platform-only; school access happens exclusively through audited,
   time-boxed support sessions; school admins cannot escalate.
7. Tenant resolution works on `{slug}.easylearn.com` (dev: `*.localhost`), fails closed,
   and the root domain remains functional for platform/login.
8. Cookie-only auth path (with CSRF) is implemented behind the incremental migration;
   localStorage token write is removed.
9. New uploads use `schools/{schoolId}/…` keys; downloads enforce school-boundary checks;
   quotas are enforced and visible.
10. Audit events in §17 are recorded for the listed actions, including all support-mode
    activity; `audit_logs` is append-only.
11. No destructive migration was used at any point; every step rehearsed on a production
    snapshot; rollback path documented; CBISM experienced no downtime beyond the plan.
12. Documentation updated (this plan's successor: implementation notes + operator runbook
    for creating school #2).

---

*End of Phase 2 architecture plan. No code, schema, data, branches, or PRs were touched —
this document is the only artifact. Implementation awaits your review and instructions.*
