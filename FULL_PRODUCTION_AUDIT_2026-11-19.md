# EasyLearn — Full Production Readiness & Security Audit

**Date:** 2026-11-19 · **Repo:** `shadrachampah123/easylearn` · **Audited commit:** `4069584` (= `main` = the live Production deployment of 2026-11-17T21:20:13Z — verified via GitHub deployments API)
**Mode:** READ-ONLY. No file was modified, nothing committed/pushed/merged/deployed, no production database, environment variable, or bucket was touched, no backup operation run, no secret printed. Two new report documents (this file and the two prior investigation reports it cites) are the only workspace additions.
**Companion reports (this session):** `R2_CONFIG_AUDIT_2026-11-19.md`, `R2_UPLOAD_FAILURE_INVESTIGATION_2026-11-19.md`.

> ## Post-audit status update (same day, 2026-11-19)
>
> This report is a point-in-time record and its body is deliberately unchanged. Two findings moved after it was written; read them together with the roadmap (`docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md`, section "Production status update — 2026-11-19"):
>
> - **C-1 is CLOSED.** The owner confirmed that assignment uploads, learner submissions and downloads all work in Production after the Cloudflare R2 bucket CORS policy was corrected. Hypothesis H1 (CORS policy mismatch) was the cause; H2 (endpoint not live) is rejected. Cloudflare R2 integration is recorded as **COMPLETED**. The residual item is documentation-only: the bucket CORS policy is not version-controlled, so record its exact origins/methods/headers with the environment variables.
> - **H-1 is FIXED IN CODE and under review** in a separate PR: the throttle now fails closed, per-source (IP) volume and credential-spraying budgets were added, the five-attempt budget is scoped to (identifier, source) so one attacker can no longer lock an administrator out, `login_attempts` became a self-healing schema feature, `/api/health` reports it, and two regression suites were added (`tests/login-rate-limit-policy.test.ts`, `tests/login-rate-limit-db.test.ts`).
> - **H-R1 — a HIGH finding from the independent security review of that PR (same day, added after the review).** The first version of the fix also cleared failed-login rows by *source IP* on a successful login, so one valid low-privilege credential could repeatedly erase **another** account's accumulated failures: the reproducing probe measured 108 unthrottled guesses against an administrator account over three insider sign-in cycles from one IP. It is fixed in the same PR (identifier-scoped reset, the test that asserted the vulnerable behaviour reversed, a route-level regression test validated against the vulnerable code). The review also recorded **M-R1** (the leftmost `x-forwarded-for` entry is now a security control), **M-R2** (check-then-record race: 30 concurrent guesses from one IP were all accepted against a budget of 5), **M-R3** (email and username are separate budgets for one account: 10 guesses before any 429) and **M-R4**, a merge gate (fail-closed + unverified Production `login_attempts` + unknown `AUTO_SCHEMA_REPAIR` ⇒ possible total login outage), plus L-R1…L-R5 and I-R1…I-R5. The full register is in the roadmap section "Independent security review of PR #69 (2026-11-19) — findings register". **PR #69 is therefore NOT approved for merge**: it awaits an independent security re-review of the H-R1 fix and the M-R4 Production check.
> - **Unchanged:** C-2 / migration 0018 stays **pending** (prepared, not executed), all backup and disaster-recovery work stays **paused**, and every other finding below (H-2, M-1…M-5, L-1…L-7) remains **open**. The verdict therefore stays CONDITIONAL NO-GO, now blocked on H-2 and M-4 plus the 0018 gate.

---

## 1. Executive summary & readiness verdict

**Code-level security posture: STRONG and independently re-verified.** The Phase 1/2 security program is real in the current tree, not just in old reports: a single JWT chokepoint with a strict secret policy, fail-closed session revocation, cookie-only browser sessions, a single-point CSRF origin policy in `src/proxy.ts`, per-request CSP nonces, tenant SQL predicates on every school-scoped route, DB re-read membership roles (never token claims) for authorization, enrollment-required submission/quiz gates, class-level file access control, magic-byte upload validation, verified-TLS Postgres connections, and a gated migration runner with a production-safety preflight. Full unit/security test battery passes locally (≈350 assertions) and CI on this exact commit is green including the PostgreSQL suites.

**Operational posture: two critical items stand between Production and a clean sign-off.**
1. **A live production incident:** direct-to-R2 assignment uploads fail in the browser at the network layer ("Network error — the upload could not be completed."). The failure point is established exactly (the presigned `PUT`/preflight, `FileUploader.tsx:186`); all server-side causes are excluded by evidence; the remaining root causes are configuration-side (R2 CORS policy mismatch, or the endpoint not being live/correct in the running deployment). Discrimination needs 5 minutes of owner-side evidence (see §6/§7 and the companion investigation report).
2. **Production database drift (last owner-verified 2026-10-27):** migration ledger absent and **0 of 26** composite tenant foreign keys from gated migration 0018 present. Tenant isolation today rests on the application layer + 0017 `NOT NULL school_id` + 24/24 `UNIQUE (school_id, id)` targets — extensively tested, but the database-level defense-in-depth 0018 provides is missing, and the formal Issue #54 sign-off is recorded NO-GO until reconciliation. **New evidence this session narrows the drift:** the user's authenticated `GET /api/uploads` returned 200 on Production, which cannot happen unless the fail-closed session-revocation check passed — so `users.session_version` is now effectively present in the runtime DB (lazily repaired or applied). Ledger + 0018 status must still be re-verified read-only.

**Verdict:** **CONDITIONAL NO-GO for formal production security sign-off** (consistent with the standing Issue #54 posture), while the application is live and fundamentally sound. Sign-off flips to GO when: (a) the R2 upload incident is root-caused and fixed, (b) the production catalog is re-verified read-only and the prepared recovery plan (ledger + 0019 formalization + gated 0018) is executed under owner approval with a verified backup, and (c) the High findings below (rate-limit fail-open, monitoring gap) are remediated. None of the ~350 tests run for this audit failed against current code; previously reported fixes were verified present, not assumed.

---

## 2. Scope & method

- **Code re-verification (current tree, not historical reports):** auth/session (`src/lib/auth.ts`, `session-cookie.ts`, `api-client.ts`, `jwt-policy.ts`), CSRF (`src/proxy.ts`, `src/lib/csrf.ts`), tenancy (`src/lib/tenant.ts`, `assignment-access.ts`, `authorization.ts`, `report-access.ts`), uploads/downloads (`src/lib/object-storage.ts`, `upload-content.ts`, `object-guard.ts`, `attachment-auth.ts`, `upload-auth.ts`, `upload-mode.ts`, `upload-storage.ts`, api routes), all 60 API routes (guard sweep + targeted reads), schema (`src/db/schema.ts`, 38 tables), migrations (`drizzle/0000–0019`, `run-migration.js` gating/order), DB connectivity (`src/db/index.ts`, `postgres-tls`), health (`src/app/api/health/route.ts`), PWA (`public/sw.js`, `manifest.json`), frontend uploader/nav components.
- **Production/infra records (read-only):** GitHub deployments + check-runs API, Vercel-bot deployment metadata on PRs, Issue #54 + PR threads (#13/#14/#40/#41/#49/#55/#59/#61/#63–#68), owner-observed catalog checks recorded in `docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md` §1 and `SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md`.
- **Tests executed in this sandbox (safe, non-destructive):** see §8. Database-backed suites (`test:db`, `test:tenant-auth`, `test:mutation`, `test:integration`, `test:tenant-integrity`, `test:review-pr45`, TLS e2e) were **not run here** (no PostgreSQL in the sandbox; the embedded-postgres helper downloads binaries); their authoritative latest run is CI on this exact commit — **success**.
- **Not reachable from this sandbox (documented, not assumed):** Vercel API/dashboard (connector disconnected; `api.vercel.com` network-blocked), `*.vercel.app`, Cloudflare R2/dashboards, Neon. Statements depending on those are labelled **owner-verify** with exact read-only steps.

---

## 3. Security findings (verified against current code)

### 3.1 Controls verified WORKING (each re-checked at the cited lines, not taken from old reports)

| Control | Evidence (file:line) |
|---|---|
| JWT: single signing/verification chokepoint; HS256 pinned; secret policy (length/entropy/placeholder rejection) enforced at the chokepoint | `src/lib/auth.ts:39–47, 100–106`; `src/lib/jwt-policy.ts` (26/26 tests) |
| Session revocation: per-user `sessionVersion` claim vs DB; **fail-closed** (`SessionRevocationCheckError` → 503) when column/DB unavailable; logout & password change & admin reset all bump atomically | `src/lib/auth.ts:118–170`; `logout/route.ts:47–52`; `change-password/route.ts:88–97`; `users/[id]/route.ts:213–227` |
| Cookie-only browser sessions (`httpOnly`, `secure` in prod, `SameSite=Lax`, 24 h); Authorization headers stripped client-side; placeholder-bearer ("null") rejected | `login/route.ts:155–162`; `src/lib/api-client.ts:42–53`; `auth.ts:283–297` |
| CSRF: one chokepoint in the proxy for all `/api/*` state-changing requests; cookie-bearing requests always origin-checked; bearer carve-out only without cookie; derived-scheme distrust | `src/proxy.ts:88–100`; `src/lib/csrf.ts:545–690` (49+14 tests) |
| CSP: per-request CSPRNG nonce + `strict-dynamic`; `connect-src 'self' https:`; `upgrade-insecure-requests`; file responses get `sandbox; default-src 'none'` + `nosniff` + `CORP same-origin` from both route and config | `src/proxy.ts:17–37, 101–118`; `next.config.ts:74–95` (11/11 hydration tests) |
| RBAC: roles re-read from `school_users` **every request**; token claims explicitly "diagnostics only"; platform (`super_admin`) vs school roles separated; school-admin vs extended vs staff vs teaching role tiers | `src/lib/tenant.ts:344–465, 556–558`; `users/[id]/route.ts:86–115` |
| Tenant isolation: every school-scoped route uses SQL-level predicates (`sqlUserInSchool`, `sqlClassInSchool`, `sqlQuizInSchool`, `sqlFileInSchool`, `sqlSubmissionScope`…); cross-school rows are indistinguishable from missing (404) | guard sweep of all 60 routes (this audit) + e.g. `files/[id]/route.ts:73–81`, `messages/route.ts:56–64`, `grades/route.ts:43–53` |
| IDOR defenses: submission/quiz **enrollment required** (fail-open defaults removed); teacher-only-own-submission grading; parent access via `parent_learners` link inside SQL predicates; unknown roles fail closed (`sql\`false\``) | `assignments/[id]/submit/route.ts:70–85`; `quizzes/[id]/attempt/route.ts:57–64`; `submissions/[id]/grade/route.ts:94`; `assignment-access.ts:38–70`; `authorization.ts:145–175` |
| File security: extension allow-list; scriptable MIME refusal; **magic-byte signature validation** (local path) and read-back verification (object path); server-derived content type on download (never client `mime_type`); disposition forcing; object-guard 5xx→503 vs 404/403 semantics | `upload-content.ts:31–160`; `object-guard.ts`; `files/[id]/route.ts:126–150`; `object-storage.ts:140–200` |
| Upload authorization: role/purpose/assignment checks shared by presign & multipart; attachments re-verified against `uploaded_files` (uploader+purpose+assignment) at submission time | `upload-auth.ts:24–34`; `uploads/presign/route.ts:108–125`; `attachment-auth.ts:37–49` |
| Seed & registration: `/api/seed` is **404 in production**, super_admin-gated + empty-DB-only otherwise; public registration disabled (403) | `seed/route.ts:31–70`; `auth/register/route.ts:1–7` |
| DB connectivity: verified TLS (cert + hostname), sslmode-downgrade neutralized, insecure only under explicit test flag; pool `max: 2` in production (serverless-appropriate); local-host URLs rejected on Vercel | `src/db/index.ts:12–31`; `src/lib/postgres-tls.ts` (11/11 + e2e tests); `env.ts:37–44` |
| Migration runner: ledger, atomic gating, **0019 registered before gated 0018**, `CONFIRM_MIGRATION_0018` token + read-only preflight requirement, same TLS policy; `drizzle-kit push` proven destructive and banned by procedure | `run-migration.js:23–52, 78–90`; `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md:14`; `tests/migration-tenant-constraint-integrity.test.ts` |
| Password hashing: bcrypt cost 12 | `auth.ts:46–48` |
| Announcements public feed scoped to the designated school (CBISM) | `announcements/route.ts:30–57`; `tenant.ts:35–55` |

### 3.2 Vulnerabilities / weaknesses found (see §5 for severity register)

1. **Login rate limiting fails OPEN and ignores IP** — `src/lib/rate-limit.ts:80–88`: any DB error (e.g. `login_attempts` table missing — migration 0012 — or unreachable) returns `allowed: true` with only a console log; `recordFailedLoginAttempt` also swallows failures (`:92–105`). The limiter counts **per identifier only**: `ipAddress` is recorded but never used in any limit. Consequences: (a) silent total loss of brute-force protection on a drifted DB — and this Production has demonstrated drift; (b) unthrottled distributed guessing across many identifiers; (c) targeted account-lockout DoS — anyone can lock any user (including admins) out for 30 minutes with 5 bad attempts (`MAX_ATTEMPTS=5`, `BLOCK_MINUTES=30`, `:6–8`).
2. **Weak & inconsistent password policy** — admin-created accounts and admin resets accept **6-character** passwords (`users/route.ts:176–178`; `users/[id]/route.ts:202–204`) while self-service change requires 8 (`change-password/route.ts:28–30`); no complexity/deny-list checks anywhere. Creation response echoes the plaintext password back (`generatedPassword`, `users/route.ts:286`). Combined with (1), online guessing exposure is material.
3. **`images/search` authorizes from stale token claims without account re-check** — `src/app/api/images/search/route.ts:99–101` uses raw `verifyToken` + `payload.role`: no `isActive` re-read, no membership check, so a **deactivated or demoted** user keeps staff-only access for up to the 24 h token life. Only route in the app still doing claim-based authorization (all others use `guardSchoolContext`); low impact (stock-image proxy) but violates the Phase 2C rule the codebase itself states (`tenant.ts:349–352`).
4. **Missing DB uniqueness constraints (race windows)** — `submissions` has no unique `(assignment_id, learner_id)`: the "already submitted" rule is an app-level SELECT (`submit/route.ts:115–128`) — two concurrent POSTs can both pass and double-insert. `parent_learners` has no unique `(school_id, parent_id, learner_id)` (`schema.ts:224–235`) → duplicate links. `quiz_attempts` has no unique `(quiz_id, learner_id)` — protected only by an advisory-lock transaction (`attempt/route.ts:66–70`), which is correct but app-layer-only. Contrast: `attendance` does have its unique constraint (`schema.ts:451–466`, 0011).
5. **No error boundaries, no instrumentation, no monitoring** — zero `error.tsx`/`global-error.tsx`/`not-found.tsx` under `src/` (verified by `find`), no `instrumentation.ts`, no APM/logging dependency in `package.json`. `/api/health` covers DB/JWT only — no storage flag. The R2 incident (§4.3) is the concrete cost: a production outage that produces **no server-side signal at all** (presign answers 201; only the browser sees the failure).
6. **Service worker caches authenticated HTML** — `public/sw.js:39–70`: network-first but `cache.put` stores **every** non-API GET (including logged-in dashboard HTML/RSC payloads) under a **fixed** cache name `easylearn-v1`, never cleared on logout or deploy. Risks: stale UI after releases; on a shared device, cached authenticated pages can be replayed offline. (API routes are correctly excluded.)
7. **Login error-message asymmetry (minor enumeration)** — `login/route.ts:81–95`: "Invalid email/username or password" (no account) vs "Invalid email or password" (wrong password) vs 403 "Account is deactivated" (account exists + state). Low.
8. **`/api/health` is unauthenticated** and exposes schema/migration-state booleans + warnings (`health/route.ts`). Previously "accepted" (Issue #54 NEW-4) with an open owner decision to restrict. Low, still open.
9. **`school_users.role` uses the global enum incl. `super_admin`; exclusion is app-layer only** — acknowledged in `schema.ts:691–696` comment; no DB CHECK constraint. Low (defense-in-depth gap).
10. **Non-hermetic `npm test`** — reproduced this session: without CI's `JWT_SECRET`/`DATABASE_URL`, `jwt-secret-policy` fails 25/26 with a misleading message; with CI env it is 26/26. Known (follow-up doc LOW-1), still unfixed. Low.

**No new IDOR, privilege-escalation, injection, or tenant-isolation vulnerability was found** in the current tree across the 60-route sweep; the historical fail-open defaults (enrollment, quiz access, parent linkage, forwarded headers, `Bearer null`, EROFS-500, revocation fail-open, PUBLIC_URL-in-prod) are all verified **fixed in current code** by direct reading, and their regression tests are in the passing battery.

---

## 4. Database, functionality, and infrastructure findings

### 4.1 Database (reviewed; NO migration applied)

- **Schema:** 38 tables (`schema.ts:110–752`). All school-owned tables carry `school_id` (NOT NULL since 0017) + FK to `schools`; `school_users` has unique `(school_id, user_id)`, status CHECK, and covering indexes (`:704–745`); `schools` has slug format/unique + status CHECK (`:668–689`). 85 FK references, 30 indexes, 10 unique constraints.
- **Missing constraints/indexes (finding 3.2-4 plus performance):** no unique on `submissions(assignment_id, learner_id)`, `parent_learners(school_id, parent_id, learner_id)`, `quiz_attempts(quiz_id, learner_id)`; `messages` and `notifications` have only `school_idx` — conversation queries (`sender/receiver`) and per-user notification reads will seq-scan at scale (`messages/route.ts:56–64`, `notifications/route.ts`); consider `(sender_id, receiver_id, created_at)` and `(user_id, is_read)`.
- **Multi-school isolation:** enforced in SQL on every route (verified sweep); `AUTO_SCHEMA_REPAIR` defaults **true** (`schema-resilience.ts:452–455`) — this is why Production stayed alive through the 0019 drift; it also means the runtime role holds DDL rights (accepted trade-off; document it).
- **Migration 0018 status & Production readiness:** registered last, gated behind explicit filename + `CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS` (`run-migration.js:78–90`); aborts atomically on any cross-school/orphan row; requires PG 15+ (Production is **18.6** per recovery-plan records ✓). Read-only preflight (`docs/PRODUCTION_PREFLIGHT_0019_0018.md`) + recovery plan (`docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md`, status **PREPARED, NOT EXECUTED**) + rehearsal test exist. Last owner-verified production state (2026-10-27): **0/26 composite FKs, ledger absent, 24/24 unique targets present, session_version absent** — the last item is now effectively resolved (authenticated Production traffic succeeds ⇒ fail-closed revocation check passes ⇒ column present at runtime). **0018 is ready to apply but must run only under the plan: owner approval → verified backup → read-only preflight re-run → `node run-migration.js 0019_session_revocation.sql` (formalize) → gated 0018 with token. Never `drizzle-kit push`** (proven to drop all 26 FKs + ledger + 17/24 unique targets).
- **Ledger absence** means "which migrations ran" is unproven in Production — the root procedural gap behind the drift (best-fit hypothesis H1 in the recovery plan: migrations were applied outside the runner).

### 4.2 Application functionality (all major modules inspected)

| Module | State (current code) |
|---|---|
| Administration & school management | 15 admin pages; users directory admin-extended-gated, create = school_admin (membership auto-added to caller's school, rollback on failure), global identity changes & delete & password reset = platform-admin-only (`users/*`, verified) |
| Assignments & submissions | Staff-only creation with class/subject in-school validation; publish workflow; learner submission requires enrollment + deadline/late rules + upload gate; duplicate submission blocked at app level (DB unique missing — 3.2-4); corrections/questions/results endpoints role-scoped; parent results via link predicate |
| Grading & examinations | Teacher-only-own-submission grading; admin-extended oversight; EasyAI grading is **deterministic and in-process — no external API/keys** (`src/lib/easyai.ts:1–19`); grade reads via `canAccessLearner` (self/parent-link/teacher-class/admin) |
| Quizzes | Audience-scoped listing; attempt/check learner-only + published + enrollment-required + advisory-lock serialization; edit/delete via `evaluateQuizMutationAccess` (owner/admin); image picker staff-gated (claim-based — 3.2-3) |
| Attendance | Staff-only marking; class-in-school first; teachers restricted to assigned classes; learner enrollment validated per record; unique (learner, class, date) enforced in DB |
| Timetables | Admin-extended-only writes; role-scoped reads (teacher/learner/parent branches); teacher-in-school validation on entries |
| Announcements & messaging | Announcement writes role-gated; public feed scoped to designated school; messages school-scoped conversations; explicit read-receipt POST (no write-on-GET); recipient-scoped updates |
| Study resources | Role-filtered reads; teacher uploads pending admin approval (`isApproved = hasSchoolAdminExtendedRole`, `resources/route.ts:122`) |
| Notifications & analytics | Recipient+school dual scoping; reports/learner-reports staff-only with `getAccessibleLearnerIds` school-intersected; teacher metrics limited to own activities |
| Parent & learner dashboards | 10/11 pages; parentId parameter honored only for in-school members; parent-child links re-verified per request |
| **Known functional bug (live):** website mobile navigation menu unreliably tappable — `src/components/website/Navbar.tsx:64–88`; fix exists as **PR #61 (OPEN, unmerged)** so Production still has it |
| **Known functional incident (live):** R2 direct uploads fail in-browser — see §4.3 |

### 4.3 Infrastructure

- **Vercel:** project `easylearn` (`prj_9q2A950CdVcmjWlsLwCmIk7ZEM60`), team `shadrachampah123s-projects`; Production alias `https://easylearn-six.vercel.app`; latest Production deployment = audited commit (2026-11-17); CI + Vercel checks green on it. **Legacy second project `easylearnn`** built the same repo until ~2026-10-26 (newest PRs list only `easylearn`) — owner should confirm it is disconnected (duplicate env/preview risk). Env-var *values/targets* remain dashboard-only knowledge (no Vercel connector here) — the companion R2 audit lists exact read-only enumeration steps.
- **Neon:** pooled connection string convention; TLS enforced in app AND migration runner; local-URL-on-Vercel rejected; pool sizing appropriate. Runtime DB is project `easylearn`, branch `production`, PG 18.6 (owner-reported). Drift items per §4.1.
- **Cloudflare R2:** integration code verified correct and live-proven server-side (6/6 harness, Oct). **Active incident:** browser presigned PUTs fail pre-HTTP (`FileUploader.tsx:186`); presign succeeds (proved by message classification + the orphan-row side effect); candidates: CORS policy mismatch on `easylearn-uploads` (origin exact-match `https://easylearn-six.vercel.app`, `PUT` method, `content-type` header, right bucket) or endpoint not live in the running deployment (Vercel bakes env at deploy time — variables assigned after 2026-11-17T21:20Z are NOT in the running function; missing endpoint silently signs `amazonaws.com` URLs). Excluded by evidence: credentials/signature/permissions/region/expiry (all produce HTTP statuses → different UI message), app CSP (`connect-src 'self' https:` + `upgrade-insecure-requests`), CSRF (PUT never touches the app), body limits (bytes bypass Vercel). Full decision tree + unauthenticated preflight probe: companion report §5.
- **Error handling & monitoring:** route-level API error handling is consistent (sanitized messages via `database-errors`/`clientSafeErrorMessage`, schema-aware 503s); but **no UI error boundaries, no instrumentation, no APM, no storage health flag** (3.2-5) — production issues are only visible in Vercel logs and user reports.
- **Performance & mobile:** presigned direct uploads bypass the 4.5 MB body limit (by design); `force-dynamic` API + `no-store` caching; pool max 2/instance; responsive Tailwind throughout (dashboard sidebar `lg:` breakpoints verified); PWA manifest + network-first SW (with the caching hygiene issue 3.2-6); website mobile nav bug live (PR #61).

---

## 5. Findings register (by severity)

| ID | Sev | Finding | Location |
|---|---|---|---|
| C-1 | **CRITICAL** | Live Production incident: direct-to-R2 uploads fail at browser network layer (CORS policy mismatch OR endpoint not live/correct in the running deployment); core feature broken for real users | `src/components/dashboard/FileUploader.tsx:163–190` (failure site :186); companion investigation report |
| C-2 | **CRITICAL** | Production DB drift: 0/26 composite tenant FKs (0018) + migration ledger absent (last owner-verified 2026-10-27; session_version now effectively present per new runtime evidence); formal sign-off NO-GO until reconciled | `docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md` §1; `run-migration.js:78–90`; Issue #54 |
| H-1 | **HIGH** | Login rate limiting fails OPEN on any DB error (silently disabled if `login_attempts` missing); IP recorded but never limited; per-identifier lockout enables targeted 30-min DoS on any account | `src/lib/rate-limit.ts:6–8, 80–88, 92–105` |
| H-2 | **HIGH** | No monitoring/observability: no error boundaries, no instrumentation, no APM/log alerting, health endpoint blind to storage — the C-1 outage produced zero server-side signal | absence of `src/**/error.tsx`, `global-error.tsx`, `not-found.tsx`, `instrumentation.ts` (verified); `src/app/api/health/route.ts` |
| M-1 | MEDIUM | Weak/inconsistent password policy: 6-char minimum for admin create & reset vs 8 for self-service; no complexity/deny-list; plaintext password echoed in create response | `users/route.ts:176–178, 286`; `users/[id]/route.ts:202–204`; `change-password/route.ts:28–30` |
| M-2 | MEDIUM | Missing DB uniqueness (race windows): `submissions(assignment_id, learner_id)`, `parent_learners(school_id, parent_id, learner_id)`, `quiz_attempts(quiz_id, learner_id)` — app-level checks only | `schema.ts:224–235, 267–295, 407–420`; `submit/route.ts:115–128` |
| M-3 | MEDIUM | R2 hardening backlog: `OBJECT_STORAGE_PUBLIC_URL`-unset-in-prod dashboard check never recorded done; bucket CORS/versioning unverified; DB backups exclude object bytes; failed uploads leave orphan `uploaded_files` rows (no cleanup on PUT failure) | `object-storage.ts:172–190`; `docs/BACKUP_RESTORE_VERIFICATION.md:135–158`; `presign/route.ts:143–165` + `FileUploader.tsx:246–252` |
| M-4 | MEDIUM | Legacy second Vercel project `easylearnn` historically deployed the same repo — unaudited duplicate env/previews unless confirmed disconnected | Vercel-bot metadata PRs #14–#59 vs #65–#68 |
| M-5 | MEDIUM | Website mobile nav unreliably tappable in Production; fix (PR #61) open/unmerged | `src/components/website/Navbar.tsx:64–88` |
| L-1 | LOW | SW caches authenticated HTML under fixed cache name; no logout/deploy invalidation → stale UI + shared-device offline replay | `public/sw.js:1–8, 39–70` |
| L-2 | LOW | `images/search` authorizes from stale token claim; deactivated/demoted users keep staff feature ≤24 h | `images/search/route.ts:99–101` |
| L-3 | LOW | Login error-message asymmetry (minor account enumeration) | `login/route.ts:81–95` |
| L-4 | LOW | Unauthenticated `/api/health` exposes schema/migration state (owner decision NEW-4 still open) | `health/route.ts` |
| L-5 | LOW | `school_users.role` can hold `super_admin` — app-layer exclusion only, no DB CHECK | `schema.ts:691–745` |
| L-6 | LOW | `npm test` non-hermetic (misleading JWT-suite failure without CI env) — reproduced | `.github/workflows/ci.yml:31–56`; this session's runs |
| L-7 | LOW | `messages`/`notifications` lack per-user/conversation indexes (seq-scan risk at scale) | `schema.ts:436–450, 525–537` |

---

## 6. Outstanding blockers preventing production release/sign-off

1. **C-1 resolution:** discriminate H1 (CORS) vs H2 (endpoint-not-live) with owner-side read-only evidence — DevTools Network tab host of the failed OPTIONS/PUT (`*.r2.cloudflarestorage.com` ⇒ CORS; `*.amazonaws.com` ⇒ endpoint not live), console error text, bucket CORS JSON, endpoint value + assignment timestamps vs the 2026-11-17T21:20Z deploy, and the unauthenticated `curl -X OPTIONS` preflight probe (companion report §5.1). Then apply the config-only fix (CORS JSON) or redeploy (env bake).
2. **C-2 reconciliation:** re-run the read-only preflight (Step A/B of `docs/PRODUCTION_PREFLIGHT_0019_0018.md`) → confirm ledger/0018/session_version state → owner approval → **verified backup** → execute the recovery plan (runner only; 0019 formalization + gated 0018 with token). Never `drizzle-kit push`.
3. **H-1/H-2 remediation** (fail-closed or alarmed rate limiting; minimal observability: health storage flag + error boundaries + log alerting).
4. **M-3 verifications:** `OBJECT_STORAGE_PUBLIC_URL` unset in prod; bucket privacy + CORS + versioning; backup coverage for object bytes.
5. **M-4:** confirm `easylearnn` Vercel project disconnected/retired.
6. Issue #54 remains the tracking vehicle; its NO-GO stands until 1–5 close.

## 7. Prioritized remediation roadmap

**P0 — now (hours):**
1. C-1: capture the 5 evidence items → apply smallest fix (CORS JSON on `easylearn-uploads`: exact origin `https://easylearn-six.vercel.app`, methods `PUT/GET/HEAD/DELETE`, headers `content-type`, expose `ETag`; or fix endpoint + redeploy). Verify: probe → real upload → download.
2. Read-only production catalog re-check (10 min, preflight doc Step A/B) to refresh the C-2 baseline with current facts.

**P0 — this week:**
3. C-2: owner approval → verified backup → run recovery plan (0019 formalize + gated 0018). Re-verify 26/26 FKs + ledger afterwards; update Issue #54 → move sign-off toward GO.
4. H-1: make rate limiting fail-**closed-or-alarmed** (on `login_attempts` errors: allow but log loudly + surface in /api/health, or briefly deny with 503), add per-IP(+identifier) composite limiting, keep identifier lockout but shorten/soften (e.g. progressive delay) to blunt DoS.

**P1 — next sprint:**
5. H-2: add `objectStorageConfigured`/`multipartDisabled` booleans to `/api/health`; add `error.tsx`/`global-error.tsx`/`not-found.tsx`; attach Vercel log alerts or lightweight uptime monitoring.
6. M-1: unify password minimum at ≥10 chars + basic deny-list; stop echoing `generatedPassword`; set `mustChangePassword` on admin-set passwords (column exists).
7. M-5: merge or supersede PR #61 (mobile nav) — small, tested, user-visible.
8. M-3: enable bucket versioning; schedule object-vs-row reconciliation for orphan cleanup; confirm PUBLIC_URL unset.

**P2 — hardening:**
9. M-2/L-7: one new gated migration (0020): unique `submissions(assignment_id, learner_id)`, unique `parent_learners(school_id, parent_id, learner_id)`, unique `quiz_attempts(quiz_id, learner_id)` (dedupe first), indexes for messages/notifications.
10. L-1: SW cache versioning per release + skip caching authenticated HTML + clear on logout. L-2: move `images/search` to `resolveAuthContext`. L-3: unify login error text. L-4: decide /api/health restriction. L-5: DB CHECK excluding `super_admin` from `school_users.role`. L-6: make `npm test` hermetic (auto-provision env or skip-guard with clear message). M-4: retire `easylearnn`.

## 8. Tests performed this session (safe, non-destructive; nothing deployed or modified)

| Check | Env | Result |
|---|---|---|
| `npm run typecheck` | sandbox | **PASS** (exit 0) |
| `npm run lint` (eslint) | sandbox | **PASS** (exit 0) |
| `npm test` (17 unit/security suites: source-security 28, TLS 11, assignment-authz 5, JWT policy 26, CSRF 49, CSRF-credentials 14, cookie-auth 31, upload-content 34, object-content-policy 15, harness-safety 13, object-live 11, real-authorization 15, tenant-foundation 23, membership-foundation 37, R2 signing 20, disk-fallback 8, upload-mode 10) | CI env (`JWT_SECRET` random, dummy unreachable `DATABASE_URL`) | **PASS — 0 failures, exit 0 (≈350 assertions)** |
| `npm test` without CI env | bare sandbox | 25/26 on JWT suite then stop — reproduced known non-hermetic failure (L-6), not a code defect |
| `npm run test:csp-hydration` | sandbox | **PASS** 11/11 |
| `npm audit --omit=dev` | registry (read-only) | **0 vulnerabilities** |
| CI on audited commit `4069584` ("Tests, PostgreSQL isolation, typecheck, build, lint") | GitHub Actions (authoritative for DB suites) | **SUCCESS**; Vercel check **SUCCESS** |
| DB-backed suites (`test:db`, `test:tenant-auth`, `test:mutation`, `test:integration`, `test:tenant-integrity`, `test:review-pr45`, TLS e2e) | not run in sandbox (no PostgreSQL; binary downloads out of allow-list) | covered by the green CI run above |
| Live HTTP/browser/R2/Vercel probes | impossible from sandbox (network allow-list; no connectors) | replaced by owner-verify steps in §6 |

**Coverage gaps identified (no test currently covers):** browser↔R2 CORS preflight end-to-end (root reason C-1 escaped every recorded verification — server-side harness has no preflight; Puppeteer suite ran local-disk mode only); rate-limit fail-open behaviour; concurrent duplicate-submission race; SW cache lifecycle; per-route production telemetry.

## 9. The single most important issue to address first

**C-1 — the live R2 upload failure.** It is breaking a core, user-facing capability in Production *today* (teachers cannot attach files to assignments; learners cannot submit work with attachments); its failure point is already pinpointed to the browser's presigned PUT; the two remaining candidate causes are both **configuration-side and fixable without code changes**; and the discriminating evidence takes ~5 minutes (DevTools Network-tab host of the failed request + the bucket CORS JSON + the endpoint's deploy timeline, or the unauthenticated OPTIONS probe). C-2 (ledger + gated 0018) is the top *sign-off* blocker and should start in parallel, but it is a controlled, planned procedure with the application layer verified intact — C-1 is an active outage.

*No secret or credential value appears in this report; none was requested, retrieved, or printed. All GitHub/Vercel-metadata queries were read-only.*
