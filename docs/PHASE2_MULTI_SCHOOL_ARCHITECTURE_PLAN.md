# EasyLearn — Canonical Nine-Phase Roadmap

**Roadmap updated:** 2026-11-19 · **Repository:** `shadrachampah123/easylearn`
**Verified `main`:** `4069584e99574a4fe2af7d4317a8bcbf13f9bf73` (PR #68 merged; live Production deployment 2026-11-17T21:20:13Z, alias `https://easylearn-six.vercel.app`).
**Latest application/security checkpoint:** full production readiness & security audit of 2026-11-19 — `FULL_PRODUCTION_AUDIT_2026-11-19.md`, with `R2_CONFIG_AUDIT_2026-11-19.md` and `R2_UPLOAD_FAILURE_INVESTIGATION_2026-11-19.md` (all committed at the repository root). Earlier checkpoints: PR #32 merged at `90ec04363cbec3222232c6f912fcad69ab038dba`; PR #33 follow-up merged at `851156cac0403f1b9e268c0c3584543852399c48`.
**Overall roadmap estimate: 46% complete.** This is a planning estimate across the nine product phases, not a test score or production-readiness certification. Phase 2 code hardening has advanced substantially, but production database state and safe migration gates remain unresolved.

This current roadmap supersedes the historical architecture audit retained below, including its proposed numbering, table counts, future migration numbers and old “remaining” lists. Status distinguishes **implemented**, **merged**, **deployed**, **production DB migrated**, and **production behavior verified** as independent gates. No production connections, migrations, deployments, secrets, or settings were accessed or changed for this roadmap update. The 2026-11-19 update below is likewise documentation-only on the Production side: no deployment, migration, backup operation, environment-variable change, or Cloudflare/Vercel setting was performed.

## Production status update — 2026-11-19

This section is the current owner-facing truth about the deployed application. It records the outcome of the full production readiness & security audit of 2026-11-19 (`FULL_PRODUCTION_AUDIT_2026-11-19.md`) against `main` at `4069584`, which **is** the live Production build (deployment 2026-11-17T21:20:13Z, alias `https://easylearn-six.vercel.app`, Vercel project `easylearn`). Supporting reports: `R2_CONFIG_AUDIT_2026-11-19.md` (read-only storage configuration audit) and `R2_UPLOAD_FAILURE_INVESTIGATION_2026-11-19.md` (upload-failure root-cause analysis).

### Closed — Cloudflare R2 object storage: COMPLETED

R2 integration is **complete and verified in Production**. The owner confirmed that all three production paths work end to end after the bucket CORS correction was applied:

| Production path | Status |
| --- | --- |
| Assignment file uploads (teacher browser → R2 presigned `PUT`) | Verified working |
| Learner submission uploads | Verified working |
| Assignment and submission downloads from R2 | Verified working |

- The former **C-1** active finding ("the browser cannot complete the presigned `PUT` to R2") is **closed and removed** from every outstanding-work list in this roadmap. Root cause: the missing Cloudflare R2 bucket CORS policy. The earlier `amazonaws.com`-endpoint hypothesis recorded in `R2_UPLOAD_FAILURE_INVESTIGATION_2026-11-19.md` was investigated and rejected; that report is retained for the record.
- No application change was required. The code-side configuration was audited read-only and is correct: `OBJECT_STORAGE_PROVIDER=cloudflare-r2`, account-ID-based endpoint construction, `forcePathStyle: true`, `public-read` ACL, and `s3:GetObject`-only presigned download URLs with `OBJECT_STORAGE_URL_EXPIRES_SECONDS=900` (`src/lib/object-storage.ts`).
- **Standing dependency:** the bucket CORS policy lives in Cloudflare, which the application and its CI cannot read or version. Record its exact allowed origins, methods and headers alongside the environment variables so a future bucket rebuild does not silently reintroduce C-1.

### Pending — migration `0018_composite_school_foreign_keys.sql`

**Status: PREPARED, NOT EXECUTED — deliberately pending.** The R2 completion does not change this gate.

- Production is confirmed drifted: **0/26** composite foreign keys present and **no `easylearn_schema_migrations` ledger** (owner-verified read-only on 2026-10-27, see `docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md`), while **24/24** migration 0017 objects are present.
- The migration itself is **ready to run**: Production PostgreSQL is 18.6 (≥ 15, so `ADD CONSTRAINT … NOT VALID` is supported), the migration is gated behind `EASY_LEARN_APPLY_COMPOSITE_TENANT_FOREIGN_KEYS=true`, and both the preflight (`docs/PRODUCTION_PREFLIGHT_0019_0018.md`) and the documented `DROP CONSTRAINT` rollback path are written.
- `drizzle-kit push` remains **banned** against Production (`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md`).
- The application already fails closed without 0018 (`users.session_version` enforcement and the SQL tenant predicates live in code), so this is parity and defence-in-depth rather than an outage risk. It stays open until the reviewed preflight and a restored-copy rehearsal have been executed.
- The related **26 missing child-side FK indexes** also remain outstanding. They have deliberately **not** been written as a migration (no such file exists in `drizzle/` as of 2026-11-19); the analysis and the low-lock approach live in `docs/PRODUCTION_MIGRATION_SAFETY_REVIEW_PR32.md` §"The 26 missing child-side indexes", and they still require their own reviewed, separately authorised gated migration.

### Paused — backup and disaster recovery

**Status: PAUSED.** No backup or disaster-recovery work is scheduled, in progress, or authorised in this cycle, and the 2026-11-19 audit performed no backup operations.

- The verification runbook `docs/BACKUP_RESTORE_VERIFICATION.md` (2026-11-04) stays **prepared and unused**. Its four gates — documented RPO/RTO, a restore rehearsal into a scratch database, object-store versioning or replication for R2, and a point-in-time-recovery test — are all still unmet.
- Storage hardening that belongs to the same workstream is paused with it rather than closed (audit finding M-3): bucket versioning, lifecycle policy, an explicit `OBJECT_STORAGE_PUBLIC_URL` check, and cleanup of orphaned `uploaded_files` rows left by historically failed uploads.
- Resumption requires an explicit owner decision. Until then treat restore capability as **unverified** and do not schedule destructive migrations or bulk data operations on the assumption that a restore is available.

### Outstanding findings from the 2026-11-19 audit (preserved)

Only C-1 was closed above. Every other audit finding remains open, with `FULL_PRODUCTION_AUDIT_2026-11-19.md` as the source of truth. File and line references below are against the audited commit `4069584`; the H-1 fix shifts the line numbers in `src/app/api/auth/login/route.ts` and `src/lib/rate-limit.ts`.

| ID | Finding | Status |
| --- | --- | --- |
| **H-1** | Login rate limiting fails **open** on any database error; the client IP is recorded but never used in a limit; the per-identifier lockout lets anyone lock any account, including administrators | **Fixed in code 2026-11-19 — PR #69, open for review** (verified locally; see "H-1 remediation" below) |
| **H-R1** | *(found by independent security review of PR #69, 2026-11-19)* The successful-login reset deleted every failure row sharing the source IP, so one valid low-privilege credential could repeatedly erase an attacker's accumulated failures against other accounts — a throttle-reset oracle, measured at 108 unthrottled guesses over three sign-in cycles | **Fixed in code 2026-11-19 — in PR #69**; the vulnerable assertion was reversed and a route-level regression test added. Awaiting independent re-review |
| **M-R1** | *(independent review of PR #69)* The client IP was the **leftmost** valid `x-forwarded-for` entry — the element the client writes — so behind any appending proxy an attacker chose its own throttle bucket and could trip the account-wide backstop with forged addresses | **Fixed in code 2026-11-19 — in PR #69**; declared trust position, five spoofed-chain assertions validated against the vulnerable code. Operator must confirm the hop count for the real edge |
| **M-R2** | *(same review)* Check-then-record race: nothing serialized `checkLoginRateLimit` and `recordFailedLoginAttempt`, so a concurrent burst all read an empty table — measured 30 concurrent requests ⇒ 30 guesses against a budget of 5 | **Fixed in code 2026-11-19 — in PR #69**; advisory-locked insert-then-decide before password verification — 25 concurrent ⇒ exactly 5 guesses |
| **M-R3** | *(same review)* One account = two budgets, because email and username were separate identifiers — 10 real guesses against a documented budget of 5, and N aliases ⇒ N × 15 distributed guesses | **Fixed in code 2026-11-19 — in PR #69**; the resolved account's alias set shares one budget, unknown accounts keep their own |
| **M-R4** | *(same review, **merge gate**)* Failing closed turns "table missing" into "nobody can sign in", and there was no runtime evidence that `login_attempts` exists in Production or that `AUTO_SCHEMA_REPAIR` is enabled there | **Substantially resolved 2026-11-19** by operator-supplied read-only evidence: table present, role `neondb_owner`, `CREATE` on `public` = true, `AUTO_SCHEMA_REPAIR` absent ⇒ enabled. **Qualification kept: runtime repair has never been exercised in Production** |
| **M-R4a** | *(found while investigating M-R4)* `/api/health` reported 200 "Login and registration services are ready" whenever repair was merely *enabled*, even with repair broken — while every login answered 503. Setting `AUTO_SCHEMA_REPAIR=false` was safer to operate than leaving it absent | **Fixed in code 2026-11-19 — in PR #69**; `repairBlocked` (repair off, no `CREATE` privilege, or a recorded repair failure) escalates to 503 for `login_attempts` and `session_revocation`, cause logged server-side |
| **H-2** | No observability: no `error.tsx`, `global-error.tsx` or `not-found.tsx`; no instrumentation or APM; `/api/health` is blind to object storage | Open — M-R4a makes a failed *schema repair* visible, but nothing collects it: no alerting exists |
| **C-2** | Production schema drift (0/26 composite FKs) and absent migration ledger; 0018 prepared but unexecuted | Pending — see above |
| **M-1** | Inconsistent password policy: 6-character minimum on admin user create/reset versus 8 on `change-password`; `generatedPassword` echoed in the API response | Open |
| **M-2** | Missing database-level uniqueness for `submissions(assignment_id, learner_id)`, `parent_learners(school_id, parent_id, learner_id)` and `quiz_attempts(quiz_id, learner_id)` — application-layer or advisory-lock only today | Open |
| **M-3** | R2 hardening backlog (versioning, lifecycle, `OBJECT_STORAGE_PUBLIC_URL` check, orphaned `uploaded_files` rows) | Paused with backup/DR |
| **M-4** | Legacy duplicate Vercel project `easylearnn` (`prj_UMJnGXOIWQzDRnCMiM5bM1kKTlBo`) still exists next to the active `easylearn` project | Open — owner must confirm it is disconnected |
| **M-5** | Mobile-navigation bug is live in Production: PR #61 (Navbar fix, head `e682503`) is open and unmerged | Open |
| **L-1** | Service worker caches authenticated HTML under the fixed `easylearn-v1` cache key (`public/sw.js`) | Open |
| **L-2** | `images/search` reuses a stale claim without re-checking `isActive` (the only route that does) | Open |
| **L-3** | Login error asymmetry (`login/route.ts:81–95`) discloses whether an account exists | Open |
| **L-4** | Unauthenticated `/api/health` exposes schema-feature state | Open |
| **L-5** | `school_users.role` enum still admits `super_admin`; exclusion is application-layer only | Open |
| **L-6** | `npm test` is not hermetic — it fails without CI's `JWT_SECRET` and `DATABASE_URL` | Open |
| **L-7** | `messages` and `notifications` lack per-user and per-conversation indexes | Open |

### H-1 remediation — PR #69 (implemented 2026-11-19, independently reviewed, H-R1 corrected)

The login-throttle fix is **implemented, verified locally, independently security-reviewed, and open for review as PR #69** (branch `arena/4416888f-easylearn`, base `main` @ `4069584`). The work itself touches no Production system: no migration, deployment, setting change, or backup operation was performed as part of it.

**Correction to a claim made in an earlier revision of this section.** Merging PR #69 into `main` *is* expected to deploy to Production. The GitHub deployments API records a Production deployment of `4069584` — the merge commit of PR #68 — at 2026-11-17T21:20:13Z for the Vercel project `easylearn`, so `main` is the production branch and this PR is **deploy-blocking, not merge-only**. That distinction is what makes finding M-R4 below a merge gate.

**What was wrong.** Three defects from the audit, plus a **fourth found while implementing the fix**, plus a **fifth introduced by the first version of this remediation and caught by independent security review**:

1. `checkLoginRateLimit` caught any database error and returned `{ allowed: true }` — every throttle failure handed out unlimited guesses.
2. The client IP was recorded but never used in a limit.
3. The only bucket was the identifier, so five failures locked an account for everybody for 30 minutes: anyone could lock an administrator out with one request.
4. *(new)* `ip_address` is `varchar(50)` and `getClientIp` returned the raw leftmost `x-forwarded-for` token. A longer header made the INSERT throw, which `recordFailedLoginAttempt` swallowed — an attacker could switch throttling off **for themselves** with a single header while every check kept succeeding.
5. *(new — **H-R1**, introduced by the first version of this remediation and caught by independent review)* `clearFailedLoginAttempts(identifier, ip)` deleted every row matching the identifier **OR** the source IP, so one successful login wiped all pending failures from that IP — including failures recorded against **other accounts**. Anyone holding one valid low-privilege credential (a malicious insider, or a credential-stuffed account) could sign in from the school's exit IP and erase the attacker's accumulated evidence, making the guess budget **repeatable instead of bounded**. The reproducing probe measured **108 unthrottled guesses** against an administrator account from a single IP across three insider sign-in cycles, with the victim's pair bucket returning to a full budget after every cycle; it also deleted the rows the account-wide aggregate backstop counts. `main` had an identifier-scoped delete, so this PR *widened* it. The vulnerable behaviour was additionally **asserted as correct** by the original test ("clearing releases the account bucket and the source bucket together"), which is why that test had to be reversed rather than merely extended.

**What it does now.**

- **Fails closed.** An unevaluable check refuses the login for 60 seconds (`reason: "unavailable"`) and logs it. This costs no real availability: a database that cannot answer the throttle query cannot answer the user lookup either.
- **Three buckets, one round trip** over a single windowed scan (`WINDOW_MINUTES = 15`, unchanged):

  | Bucket | Threshold | Cooldown | Purpose |
  | --- | --- | --- | --- |
  | (identifier, source IP) | `MAX_ATTEMPTS = 5` (unchanged) | `BLOCK_MINUTES = 30` (unchanged) | The familiar limit, now scoped to the **guesser**, so the account owner is unaffected |
  | source IP | `MAX_ATTEMPTS_PER_IP = 40` failures **or** `MAX_IDENTIFIERS_PER_IP = 10` distinct identifiers | `IP_BLOCK_MINUTES = 15` | Volume abuse and credential spraying |
  | **account** (every alias of it), any source | `MAX_ATTEMPTS_PER_IDENTIFIER = 15` | `IDENTIFIER_BLOCK_MINUTES = 15` | Distributed-guessing backstop — unreachable from one source. Counted over the account's whole alias set since M-R3, so email and username share one budget |

- **Enforcement is atomic and happens before the password is checked (M-R2).** The route now runs four steps: a cheap read-only pre-check, the account lookup, `recordFailedLoginAttempt` — which is the *enforcement* point — and only then the outcome. That call opens a transaction, takes two `pg_advisory_xact_lock` keys in a fixed order (source, then account, so concurrent attempts cannot form a wait cycle), **inserts the attempt**, re-counts the budgets *including the row it just wrote*, and commits or rolls back on the verdict. A refused attempt is rolled back, so it can never extend its own cooldown. bcrypt stays outside the transaction and the connection is released before the optional self-heal and the expired-row prune, because the Production pool allows only two connections. Measured: **25 concurrent wrong-password requests from one source now produce exactly 5 guesses and 20 refusals**; the pre-fix code produced 25 guesses (the review's own probe measured 30/30).
- **A failure that cannot be stored is no longer silent:** `recordFailedLoginAttempt` returns `{ recorded, allowed, decision, reason }`; the route answers 429 when `decision` says a budget is exhausted, 503 when the throttle could not be evaluated, and 503 when an *allowed* attempt could not be stored — so a degraded throttle can never become free guesses.
- **`clearFailedLoginAttempts(identifier | aliases, ip)` releases only the signing-in account's own recorded failures, under every alias of that account** (H-R1 fix, widened by M-R3 to the alias set so a success via email also releases the budget consumed via username). It is scoped by account and never by source: the rows that account wrote from its own IP are removed — which lowers the whole-source budget by exactly those rows — while **other accounts' failures from the same NAT survive**. The `ip` argument is kept for call-site compatibility and now only attributes the reset in the log; it can no longer widen the DELETE. The NAT case the earlier version tried to serve is still covered, because the source budget is deliberately generous (40 failures or 10 distinct identifiers per 15-minute window) and self-heals as rows age out of the window.
- **`getClientIp` now takes an explicit trust position instead of a guess (M-R1, hardened by F-3).** In order: `EASY_LEARN_CLIENT_IP_HEADER` if the operator names the platform's own header (used **exclusively** — no fallback to a header the client can also write); otherwise the entry `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS` positions from the **right** of `x-forwarded-for` (default 1, clamped to 8); otherwise `x-vercel-forwarded-for`, but only when `process.env.VERCEL === "1"` — the exact marker Vercel sets, so a client-supplied `VERCEL=true` cannot claim platform provenance. **That is the end of the chain: the `x-real-ip` fallback M-R1 still had was removed by F-3**, because `x-real-ip` is a header any client can send on a direct request, and reading it after the trusted position had already been rejected meant the *rejected* value decided the bucket. When the trusted position holds junk the result is `null`; the chain never scans left towards the value the client wrote. Validation was tightened at the same time (F-10): IPv4 octets may not be zero-padded (`010.001.001.001` is rejected, because it is a different address to a proxy that parses octal), IPv6 must be a real address rather than a colon-and-hex character set (`:::`, `a:b:c`, `1:::1` are all rejected), and both forms are canonicalised to their RFC 5952 / dotted-quad spelling before they are used as a bucket key or stored, so one address cannot occupy two buckets. The legacy `"unknown"` sentinel is still never stored. `null` is not an error: the per-source budgets simply cannot be applied, and the per-account budgets still are. All three variables are documented in `.env.example` and `docs/SECURITY_AUTHENTICATION.md` §11.
  This module cannot adopt `csrf.ts`'s stricter answer (refuse forwarded headers entirely) because a route handler has no socket address to fall back to; the CSRF convention was consulted and the difference is recorded in the source.
- **`login_attempts` is now a self-healing schema feature** (`src/lib/schema-resilience.ts`), so an un-migrated database becomes *throttled* instead of silently unprotected.
- **"Repair is enabled" is no longer mistaken for "repair worked" (M-R4a).** `/api/health` escalates to **503** when an optional feature is missing *and blocked*, where blocked means any of: `AUTO_SCHEMA_REPAIR` disabled; the runtime role lacks `CREATE` on `public`, from a read-only `has_schema_privilege(current_user, 'public', 'CREATE')` probe; or a repair attempt has already **failed**, recorded in an in-process ledger with how many DDL statements were applied and why the rest were not. Before this, only the first case escalated, so a deployment with repair enabled and repair broken answered **200 "Login and registration services are ready"** while every login — correct passwords included — answered 503, and the only signal was a `console.warn` nobody collected. A later successful repair clears the ledger, so health recovers without a restart.
- **A missing security-critical feature is unhealthy *now*, whatever the repair settings say (F-1, F-4).** M-R4a still required a *failed repair attempt* to escalate, and the second review measured the gap that leaves: dropping one column (`ALTER TABLE login_attempts DROP COLUMN ip_address`) made every login answer 503 while `/api/health` answered **200 `ok:true`** — the probe only asked whether the *relation* existed, and nothing ever attempted a repair, because no login touches `users.session_version` and the relation probe kept answering "present". So `login_attempts` and `session_revocation` are now marked **security-critical** and escalate on *missing or unverifiable* alone; optional features keep the M-R4a rule exactly as it was. The `login_attempts` probe asks about the **columns the throttle actually reads** (`identifier`, `ip_address`, `created_at`) rather than the relation, and the self-heal gained three additive `ADD COLUMN IF NOT EXISTS` statements (its ledger total is now **8**, not 5) so a drifted relation is repaired instead of only a missing one. An errored probe is reported as "could not be verified" and escalates for a security-critical feature, so `ok:true` can never sit next to a `false` flag in the same body (F-7), and the cause is recorded server-side where an operator can retrieve it. The cause is written to the server log only; the public response names the migration, because the endpoint is unauthenticated (finding L-4). An unknown capability (`null`, the probe itself failed) deliberately does **not** escalate on its own.
- **No role-specific thresholds**, deliberately: the role is unknown before the password verifies, and looking it up per unauthenticated request would create an oracle and add a query to the hottest unauthenticated path. Attributing failures to their **source** protects administrators without leaking anything.

**Verification (local mirror of `.github/workflows/ci.yml`, same environment shape: shared PostgreSQL service as `TEST_DATABASE_URL`, deliberately unreachable `DATABASE_URL`, random `JWT_SECRET`, all `EASY_LEARN_REQUIRE_*` flags set).**

| CI step | Result |
| --- | --- |
| `security:check-secret`, `npm audit --omit=dev` | pass · 0 vulnerabilities |
| `npm test` | pass — includes the **27-assertion** login-throttle policy suite |
| `test:csp-hydration`, `test:auth-security` | pass |
| `test:db` | pass — **23 suites**, **0 failures**, including the **27-assertion** login-rate-limit database suite |
| `test:tenant-auth`, `test:review-pr45`, `test:mutation`, `test:integration`, `test:tenant-integrity` | pass |
| `typecheck`, `build`, `lint` | pass · `✓ Compiled successfully` |
| `test:tls-e2e` | not run locally (needs TLS-enabled PostgreSQL 16) — CI only |

**Count correction (audit finding L-R3).** An earlier revision of this section recorded `test:db` as "22 suites" and the database suite as "19 assertions". Both were wrong or stale: `npm run test:db` chains **23 suite invocations** — 22 `npx tsx tests/*.test.ts` commands plus `node tests/tenant-db.test.js` — and the database suite now holds **20 assertions** because the H-R1 regression test was added. The figures above are the post-H-R1 re-run of the same local CI mirror. **Second round (M-R1, M-R2, M-R3, M-R4a):** both login-throttle suites grew from 20 assertions to **27**, and the whole 13-step mirror was re-run afterwards with the same result — `EXIT=0` for every step, `0 vulnerabilities`, `✓ Compiled successfully`, `📊 Results: … 0 failed` for all 18 database suites that print one.

The regression assertions that pin the requirements: *the legitimate owner on another source is NOT locked out (H-1 admin lockout)*, *an over-long x-forwarded-for can no longer switch throttling off*, *with repair disabled the throttle FAILS CLOSED*, *the correct password is still refused while the throttle is degraded*, *the administrator can still sign in from their own source afterwards* (200 + `HttpOnly` cookie), *login still works with no source header at all*, and — for H-R1 — *clearing releases the signing-in account only, never other accounts on the same source* plus the route-level *a successful login by account A cannot clear account B's failures from the same IP (H-R1)*.

Added in the second round: *M-R1: a spoofed prefix in x-forwarded-for is ignored, the trusted hop is used*, *M-R1: junk at the trusted position does not fall back towards the client*, *M-R1: the trusted hop count is configurable and clamped*, *M-R1: a declared platform header is authoritative and used exclusively*, *M-R1: x-vercel-forwarded-for is only consulted when actually running on Vercel*, *M-R2: a concurrent burst from one source yields at most MAX_ATTEMPTS real guesses*, *M-R2: a concurrent burst across many sources still respects the account backstop*, *M-R2: the record is atomic — advisory lock, insert, then a self-inclusive count*, *M-R3: email and username share one budget instead of two*, *M-R3: a successful sign-in releases every alias of that account, and nobody else's*, *M-R3: unknown accounts keep their own budget and cannot borrow a real account's*, *M-R3: budgets are keyed on the account's alias set, not on one identifier*, *M-R4a: an enabled-but-failing repair makes /api/health unhealthy, not 'ready'*, *M-R4a: a successful repair clears the failure and health recovers*, and *M-R4a: 'repair is enabled' is no longer mistaken for 'repair worked'*.

**The H-R1 tests were validated against the vulnerable code, not only against the fixed code.** Re-applying the pre-fix `OR ip_address = $2` DELETE in a scratch copy and re-running the database suite produced exactly two failures — `H-R1: 3 insider sign-ins must release at most one budget of 5 guesses, got 12` and `only the colleague's 4 rows may survive — a shared source is NOT an amnesty (H-R1)` — with the other 18 assertions still passing; the fixed code passes 20/20. The tests therefore detect the vulnerability instead of restating the implementation. The original test that asserted the vulnerable behaviour was **reversed**, and the static guard in `tests/login-rate-limit-policy.test.ts` now pins the scope of the DELETE itself — `.where(eq(loginAttempts.identifier, …))`, no reference to `loginAttempts.ipAddress` inside the clear, and no unused `or` import left in `src/lib/rate-limit.ts` — so a later refactor cannot silently reintroduce it.

**The M-R1/M-R2/M-R3/M-R4a tests were validated against the vulnerable code the same way.** Reverting exactly four files — `src/lib/rate-limit.ts`, `src/app/api/auth/login/route.ts`, `src/lib/schema-resilience.ts`, `src/app/api/health/route.ts` — to `5b8fbd1` while keeping the new suites produced:

| Suite | Against `5b8fbd1` | Against the fix |
| --- | --- | --- |
| `tests/login-rate-limit-db.test.ts` | 21 passed / **6 failed** — `concurrency must not raise the pair budget above 5: 25 guesses were allowed`; `a parallel spray must not exceed the 15-failure account backstop, got 24`; `once the shared account budget is gone, the email alias must be refused too`; `only the colleague's rows may survive, got [admin ×2, colleague ×1]`; `a failed repair must be unhealthy, got 200`; `resilience.getSchemaRepairFailure is not a function` | **27 passed / 0 failed** |
| `tests/login-rate-limit-policy.test.ts` | 18 passed / **9 failed** — all five M-R1 attribution tests, the fail-open literal count, the H-R1 DELETE scope, the M-R2 atomicity invariants and the M-R3 alias counting | **27 passed / 0 failed** |

The numbers in the failure messages are the vulnerabilities, re-measured in the regression harness rather than argued: **25 of 25** concurrent guesses against a budget of 5, **24 of 24** against a 15-failure backstop, an alias pair that never shares a budget, a username login that leaves the email alias's failures behind, and a health endpoint answering **200** while every login answers 503. Every one of the pre-existing assertions still passed against the old code, so the new tests did not weaken the old ones.

**Residual risk, recorded rather than hidden:** a botnet can still trip the account-wide backstop (15 failures from ≥3 sources ⇒ 15-minute cooldown). The application cannot distinguish that from a busy school NAT, so the mitigations are the high threshold, the short cooldown, a loud server-side log carrying the distinct-source count, and — recommended as an owner-side layer — a Cloudflare WAF rate rule on `/api/auth/login`.

**F-9 — that WAF recommendation silently changes the source attribution, and the two must be decided together.** Adding Cloudflare in front of Vercel adds a second appending proxy, so the default `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS=1` would then read the *edge's* address instead of the client's: every visitor shares a handful of Cloudflare IPs. Measured consequence at the shipped constants — five attacker guesses from that shared address exhaust the `(identifier, source)` pair budget and **lock the account owner out** for the cooldown, and 40 guesses from it block **every** user behind that edge for 15 minutes. That is the H-1 lockout shape returning through configuration rather than code. So: if a Cloudflare WAF rate rule is adopted, `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS` must be raised to `2` **or** `EASY_LEARN_CLIENT_IP_HEADER=x-vercel-forwarded-for` must be set, and the choice recorded here. Setting that header alone removes the whole class — nothing is then unattributable — and it is the single owner-side change this roadmap recommends first.

**F-8 — unattributable traffic is *less* volume-limited, not more.** When the source cannot be attributed (`null`), neither source budget can be applied, so the only limits left are per-account: measured, four accounts from one unattributable source absorbed **60** guesses before any refusal, where the same four from an attributed source are capped at **40** by `MAX_ATTEMPTS_PER_IP`. An earlier revision of the source comments claimed the opposite ("stricter, not looser") and was corrected. A **global** bucket for unattributable traffic was considered and deliberately rejected: one shared counter is exactly the denial-of-service shape H-1 removed, since an attacker who can make requests unattributable could then exhaust it and lock out every such user. The honest mitigation is to make traffic attributable (F-9 above); the residual risk stays open.

Added by the second round, and recorded rather than hidden:

- **The trust position is a configuration, not a proof.** `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS=1` is correct for a single honest proxy in front of the application and wrong for a longer chain; if the real chain is longer, the attributed address is a proxy's, which *under*-counts per attacker (many attackers share one bucket) rather than letting an attacker choose its own. Naming the platform header with `EASY_LEARN_CLIENT_IP_HEADER` removes the ambiguity entirely and is the recommended Vercel configuration. Neither variable is set in Production today, so Production currently runs on the default of one trusted hop plus the `process.env.VERCEL` fallback. **No Production setting was changed during this work.**
- **Counting the in-flight attempt makes enforcement self-inclusive**, which is what makes concurrency safe. `decide` compensates by adding the same one to every threshold, so the observable limits are unchanged (5 guesses and the 6th refused; 15 per account; 40 or 10 distinct accounts per source) — pinned by the pre-existing assertions, which still pass.
- **Advisory locks serialize attempts that share a source or an account.** That is the point, and the cost is that a burst queues instead of racing; locks are per key (never global), transaction-scoped, and never held across a bcrypt hash. The transaction is **seven statements** — `BEGIN`, `SET LOCAL lock_timeout`, the two `pg_advisory_xact_lock` calls, the `INSERT`, the windowed count and the `COMMIT`/`ROLLBACK` — so the locks are held across the last three, not "two short statements" as an earlier revision claimed.
- **A lock wait is bounded, and hitting the bound fails closed (F-5).** `pg_advisory_xact_lock` waits forever by default, which with the Production pool at two connections was measured to be an application-wide outage rather than a login problem: two wedged logins held both connections, `GET /api/health` answered **503** and a bare `pool.query('SELECT 1')` errored. The enforcement transaction now runs `SET LOCAL lock_timeout` — transaction-scoped, so it can never leak into another request's use of the same pooled connection — from `EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS` (default **2000 ms**, clamped to 250–10000, non-numeric junk falls back to the default rather than being silently ignored). `55P03` is then treated as contention, not as a broken schema: the login fails closed with 503 + `Retry-After`, the connection goes straight back to the pool, and no advisory lock is left behind. Measured with the Production pool shape: six concurrent logins against a lock held by another backend all answer 503 within the bound plus the pool's acquire timeout, `/api/health` stays **200** throughout, and the next login after the holder releases is an ordinary **401**. A burst therefore queues for at most the bound; it does not "wait rather than deadlock" indefinitely as the earlier revision claimed.
- **The repair-failure ledger is per process and in memory.** On Vercel that means each isolate learns the failure on its own first attempt, and a redeploy forgets it; the `ddlCapable` privilege probe covers the persistent case (no `CREATE` on `public`) without needing a failed attempt first. A probe that *errors* (as opposed to reporting "missing") is not recorded as a repair failure — in that state the database is unreachable and `/api/health` already fails on its connectivity check.
- **Automatic schema repair has still never been observed running in Production** (M-R4's surviving qualification). The operator evidence below shows it *can* run; only a disposable-database rehearsal shows it *does*.

### Independent security review of PR #69 (2026-11-19) — findings register

PR #69 was reviewed independently of its own implementation claims: every changed file was compared against `main`, the runtime behaviour was re-measured with probe scripts against a disposable PostgreSQL database driving the **real** `POST /api/auth/login` handler and the real `src/lib/rate-limit.ts`, and the whole CI sequence was re-run locally. The review **failed the PR** on one HIGH finding. Nothing below was accepted on the strength of a green CI status.

*Line references are against the post-H-R1-fix working tree (`5b8fbd1`) on branch `arena/4416888f-easylearn`; they described the code as the review found it. The second round of fixes (M-R1, M-R2, M-R3, M-R4a) rewrote the counting half of `src/lib/rate-limit.ts`, the login route's step order, and parts of `src/lib/schema-resilience.ts` and `src/app/api/health/route.ts`, so **every line number below is now stale** — read them as "the code the reviewer measured", and use the status column for what shipped.*

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| **H-R1** | High | The successful-login reset deleted every failure row **sharing the source IP** (`clearFailedLoginAttempts`, `src/lib/rate-limit.ts:497`), turning one valid low-privilege credential into a repeatable throttle-reset oracle: **108 unthrottled guesses** across three insider sign-in cycles from one IP, the victim's pair bucket back to a full budget after every cycle, and the rows counted by the account-wide aggregate deleted as well. `main` had an identifier-scoped delete, so the PR *widened* it — and the original test asserted the vulnerable behaviour as correct | **Fixed** — reset is identifier-scoped; the vulnerable assertion was reversed; a route-level regression test was added and validated against the vulnerable code |
| **M-R1** | Medium | `getClientIp` takes the **first** (leftmost) syntactically valid `x-forwarded-for` entry (`src/lib/rate-limit.ts:195-204`, pinned by `tests/login-rate-limit-policy.test.ts:75`). Safe on plain Vercel, which overwrites the header, but nothing in the code enforces that assumption and the strictly safer `x-vercel-forwarded-for` is not consulted. Behind any proxy that *appends*, the source becomes client-controlled: forged IPs keep the per-source buckets from ever filling, and 15 requests × 15 forged IPs trip the account-wide backstop — **reintroducing the administrator lockout DoS** that H-1 was meant to remove | **Fixed in code 2026-11-19 — in PR #69.** `getClientIp` now takes a declared trust position: `EASY_LEARN_CLIENT_IP_HEADER` (exclusive), else `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS` positions from the **right** of `x-forwarded-for` (default 1, clamped to 8), else `x-vercel-forwarded-for` only when `process.env.VERCEL === "1"`; junk at the trusted position yields `null` and the chain never scans left. **Superseded in part by F-3:** the `x-real-ip` step this row still described was removed, because it let a client-written header decide the bucket after the trusted position had been rejected. Pinned by spoofed-chain / proxy-configuration assertions that **fail against `5b8fbd1`** |
| **M-R2** | Medium | Check-then-record race: `checkLoginRateLimit` (`:390`) runs before `recordFailedLoginAttempt` (`:419`) with nothing serialising them, so a concurrent burst all passes the check. Probe: **30 concurrent wrong-password requests from one fresh IP → 30 × 401, 0 × 429, budget 5, 30 rows recorded**. Pre-existing on `main`, not introduced here, but it bounds how much "effective per-IP limiting" this design actually delivers, and it is what made H-R1's amplification repeatable | **Fixed in code 2026-11-19 — in PR #69.** The third option, and the first two together: `recordFailedLoginAttempt` is now the enforcement point, called *before* the password is verified, and inside one transaction it takes `pg_advisory_xact_lock` on the source key then the account key (fixed order, no wait cycle), **inserts** the attempt, re-counts the budgets including that row, and commits or rolls back on the verdict. Measured in the regression harness: **25 concurrent wrong passwords from one source → exactly 5 guesses, 20 refusals** (the same harness against `5b8fbd1`: **25 guesses, 0 refusals**); a 24-request spray across 24 sources → exactly the 15-failure backstop (against `5b8fbd1`: 24) |
| **M-R3** | Medium | One account = two budgets: the identifier is `normalizedEmail \|\| normalizedUsername` and both columns are looked up (`src/app/api/auth/login/route.ts:86,98,106`), so email and username are throttled separately. Probe against one `school_admin` holding both, same IP: **10 real guesses before any 429** against a documented budget of 5. The aggregate backstop is likewise per-identifier, so an account reachable by N aliases tolerates N × 15 distributed guesses per window | **Fixed in code 2026-11-19 — in PR #69.** The route resolves the account first and passes the whole alias set (`supplied identifier`, `user.email`, `user.username`) to both the recorder and the clearer; the counting query matches `identifier = ANY($1::text[])`. Unknown accounts keep a budget of their own, so enumeration is still counted. Not bucketed on `user.id` — the recorded identifier stays the supplied string, which keeps the spraying budget (distinct supplied identities per source) meaningful and avoids a schema change. Measured: 15 guesses across both aliases then 429 through either alias, including against the **correct** password (against `5b8fbd1`: the email alias was never refused) |
| **M-R4** | Medium (**merge gate**) | Failing closed converts "`login_attempts` missing" into "nobody can sign in" whenever `AUTO_SCHEMA_REPAIR=false` — a documented, supported setting (`README.md:165`). Production has **no migration ledger** (finding C-2), so there is no runtime evidence that the table exists there, and the previous fail-open code would have hidden its absence behind a `console.error` nobody reads (H-2). Whether Production sets `AUTO_SCHEMA_REPAIR=false` is an open question in this repository's own records (`SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md:55`, `docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md:56`, `docs/PRODUCTION_PREFLIGHT_0019_0018.md:110`). Since `main` is the production branch, this is a **merge** gate, not only a deploy gate | **Substantially resolved 2026-11-19 by operator-supplied read-only evidence; one qualification survives.** An authorized operator ran the check against the Production runtime database (this sandbox has no path to it, and none was created): `public.login_attempts` **exists**; the effective role is **`neondb_owner`**; `has_schema_privilege(current_user, 'public', 'CREATE')` is **true** and `USAGE` is **true**; `AUTO_SCHEMA_REPAIR` is **absent** from the Vercel Production environment, which the code's only parser treats as **enabled**. So the merge-gate scenario — table missing *and* repair off, i.e. nobody can sign in — is not the Production state, and the runtime role can create the table and all four indexes if it ever disappears. **Qualification, kept deliberately: actual runtime repair has never been exercised in Production.** The table's presence means the repair path has never had to run there; the evidence proves capability, not behaviour. The repair path is instead rehearsed against disposable databases by `tests/login-rate-limit-db.test.ts` (drop → self-heal → all four indexes → recording works again), and finding **M-R4a** below makes a repair that fails observable rather than silent. No production connection, setting change, migration, or `drizzle-kit push` was performed during this work |
| **M-R4a** | Medium | *(found while investigating M-R4, 2026-11-19)* `/api/health` could not see a **failed** repair. Its escalation branch required `!item.repairEnabled`, so with repair enabled but unable to deliver — no `CREATE` privilege, a DDL error, a half-applied statement list — the endpoint answered **200 `ok:true` "Login and registration services are ready"** while every login, correct passwords included, answered **503**. The only signal was a `console.warn`/`console.error` that nothing collects (H-2). Perverse incentive: explicitly setting `AUTO_SCHEMA_REPAIR=false` was *safer to operate* than leaving it absent | **Fixed in code 2026-11-19 — in PR #69.** `OptionalSchemaStatus` gained `ddlCapable` (read-only `has_schema_privilege` probe, cached, `null` when the probe itself fails and then deliberately non-escalating), `repairFailed` (an in-process ledger written by `ensureSchemaFeature` with `appliedStatements`/`totalStatements`/`reason`, cleared on success) and `repairBlocked`; both the `login_attempts` and the `session_revocation` escalation branches now gate on `repairBlocked`. The cause goes to the server log; the public response stays a fixed string naming `node run-migration.js` (finding L-4). Regression: with DDL blocked and repair **enabled**, `/api/health` answers **503** — against `5b8fbd1` the same test measured **200** |
| **L-R1** | Low | The documented 30-minute cooldown is not delivered: `decide` (`:289`) only blocks while `blockedUntil > now`, but every count is windowed at `WINDOW_MINUTES = 15` (`:55`), so `BLOCK_MINUTES = 30` (`:57`) — and both other cooldowns — can never outlive the window. Probe: 5 failures 14 minutes ago ⇒ blocked; **16 minutes ago ⇒ allowed**. Real budgets: 5 per 15 min per (account, IP), 40 per 15 min per IP, 15 per 15 min per account ⇒ **1,440 guesses/day/account** | Open — either correct the constants and the documentation, or evaluate the cooldown against rows outside the counting window |
| **L-R2** | Low | `MAX_IDENTIFIERS_PER_IP = 10` (`:70`) can lock a whole school for 15 minutes: a mass password reset, or a start-of-term morning with more than ten distinct staff mistyping behind one NAT, blocks every login from that IP — including correct passwords. Not attacker-inducible from outside the NAT, but realistic for this product's deployment shape | Open — consider a higher cap, a progressive cooldown, or exempting sources with a recent success |
| **L-R3** | Low | This roadmap recorded `test:db` as "22 suites" and the database suite as "19 assertions"; the actual chain is **23 suite invocations** and the suite now holds 20 | **Corrected above** |
| **L-R4** | Low | The earlier revision of this section recorded only the favourable residual risk (botnet/aggregate) and claimed per-source limiting was effective and that an attacker could no longer lock an administrator out, without recording H-R1, M-R2, M-R3 or L-R1 | **Corrected by this register** |
| **L-R5** | Low | `login_attempts_ip_created_at_idx` never exists on a normally migrated database: it ships only in the self-heal DDL (`src/lib/schema-resilience.ts:373`), which does not run when the table already exists. `EXPLAIN` on the count query with 500 rows shows `Seq Scan on login_attempts`. Negligible while the 60-minute prune holds; note that the recorded follow-up **overstates** the benefit, since the planner ignored the existing indexes too — an `OR` predicate wants BitmapOr | Open — measure before adding a reviewed, gated migration |
| **I-R1** | Info | Full source IPs are logged (`decide` warnings and the new reset log in `src/lib/rate-limit.ts`). Consistent with storing `ip_address`, but relevant once H-2 ships log shipping | Accepted |
| **I-R2** | Info | Scope: 13 files, +2037/−124, of which only 5 are code; three 186–195-line audit reports ride along in a security-fix PR | Accepted |
| **I-R3** | Info | `remainingAttempts` ignores the credential-spraying budget, so a source at 9 distinct identifiers reports 5 remaining for a fresh identifier. Not client-visible | Accepted |
| **I-R4** | Info | Deactivated-account attempts are now recorded (`src/app/api/auth/login/route.ts:119-124`), which changes an existing response sequence: a deactivated user receives 429 after five tries instead of a persistent 403. Correct for the source budget, but untested | Open — add a test |
| **I-R5** | Info | `docs/PRODUCTION_MIGRATION_SAFETY_REVIEW_PR32.md:972` enumerates the runtime-DDL surface and no longer lists `login_attempts`. Compliant with the "never create tenant-critical objects at runtime" rule — this table is not tenant-critical | Open — refresh that inventory |

**Tests the review found missing** — status after the second round:

| Missing test | Finding | Status |
| --- | --- | --- |
| Concurrency: N parallel wrong-password requests must not exceed the budget | M-R2 | **Added** — 25 parallel from one source must yield exactly 5 guesses, and a 24-request parallel spray exactly the 15-failure backstop; both validated against `5b8fbd1` |
| Alias budget: email and username for one account must share a budget | M-R3 | **Added** — 15 shared guesses then 429 through either alias, alias-wide clearing on success, and unknown accounts keeping their own budget |
| Spoofed `x-forwarded-for` chain: pin which entry is trusted and state the platform assumption | M-R1 | **Added** — five assertions covering a forged prefix, junk at the trusted position, the hop count, a declared platform header and the Vercel-only fallback. The assertion that used to pin the weaker leftmost choice was **reversed**, exactly as the H-R1 assertion was |
| Effective cooldown: a blocked pair must still be blocked at window + 1 minute, or the constant corrected | L-R1 | **Still missing** — the finding is open; writing the test first would pin behaviour nobody has decided on |
| NAT blast radius: more than ten distinct legitimate identifiers failing from one source | L-R2 | **Still missing** — open |
| Deactivated-account recording | I-R4 | **Still missing** — open, and now cheaper to write: the provisional row is inserted before the deactivated branch returns 403, so the assertion is one `count(*)` |

**Risks that cannot be closed from the repository:** ~~the Production presence of `login_attempts` and the Production value of `AUTO_SCHEMA_REPAIR`~~ — **answered 2026-11-19 by operator-supplied read-only evidence** (table present, role `neondb_owner`, `CREATE` on `public` granted, `AUTO_SCHEMA_REPAIR` absent ⇒ enabled); what remains is that **runtime repair has never been exercised in Production**, which no repository-side check can close. Still open: the absence of observability, so an exploited throttle bypass would raise no alert (H-2 open — M-R4a only makes a *failed repair* visible, and only to whoever reads `/api/health` or the logs); the real edge behaviour in front of Production, which decides whether one trusted hop is the right number (M-R1's configuration is a decision the operator must confirm, not something the code can verify); `test:tls-e2e`, runnable in CI only; and bcrypt cost 12, which remains the only real brake on the 1,440-guesses-per-day aggregate.

**Follow-ups created by this work:** ~~M-R1 (source-IP trust model), M-R2 (check-then-record race), M-R3 (email/username double budget)~~ — **fixed in code 2026-11-19, in PR #69**; ~~M-R4 (**merge gate** — verify `login_attempts` exists in Production and record the `AUTO_SCHEMA_REPAIR` setting)~~ — **answered by operator evidence, with the "runtime repair never exercised" qualification kept**; **new:** the operator decision on `EASY_LEARN_CLIENT_IP_HEADER` / `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS` for the real Production edge (nothing is set today, so the default of one trusted hop applies), and M-R4a's ledger is per-process — a durable signal needs H-2. Still open: L-R1 (the 30-minute cooldown is unreachable), L-R2 (NAT blast radius of `MAX_IDENTIFIERS_PER_IP`), L-R5 (the `(ip_address, created_at)` index exists only in the self-heal DDL — measure first, then add it in a reviewed, gated migration), I-R4 (deactivated-account recording is untested) and I-R5 (the runtime-DDL inventory in `docs/PRODUCTION_MIGRATION_SAFETY_REVIEW_PR32.md` is stale). Also: re-verify throttling live after deployment, and decide on the Cloudflare WAF rate rule. L-3 (login error asymmetry) was **not** fixed here, and this work takes care not to widen it.

Controls re-verified as working at `4069584` are listed in §3.1 of the audit report: the JWT chokepoint (HS256 pinned, strict secret policy), fail-closed session revocation, cookie-only sessions, the single CSRF chokepoint in `src/proxy.ts`, nonce CSP plus the file-response sandbox CSP, database-re-read membership roles, SQL tenant predicates on all 60 API routes, enrollment-gated submit/attempt, teacher-own-submission grading, parent-link predicates, magic-byte upload validation, server-derived download content type, seed 404 and registration 403 in Production, verified-TLS Postgres, the gated migration runner, and bcrypt cost 12. The 60-route sweep found **no new IDOR, privilege-escalation, injection, or tenant-isolation defect**.

**Audit verdict:** CONDITIONAL NO-GO for formal production sign-off, with the Issue #54 posture retained. H-1, H-2 and M-4 are the blocking items. H-1 and **all five** of the review's code-level findings against it — H-R1, M-R1, M-R2, M-R3 and M-R4a — are now addressed in code in PR #69, and the M-R4 merge gate has been answered by operator-supplied read-only Production evidence. PR #69 is still **not approved for merge**: every one of those fixes was written by the same author as the original change, so an independent security re-review of the whole set is required, and the surviving M-R4 qualification (runtime repair never exercised in Production) plus the operator's edge-configuration decision for M-R1 must be recorded by the reviewer. Because `main` is the production branch, merging PR #69 is expected to deploy it to Production.

### Second independent security review of PR #69 (2026-11-19) — findings register F-1…F-11

The second-round fixes (H-R1 at `5b8fbd1`, then M-R1/M-R2/M-R3/M-R4a at `e4c7b41`) were reviewed
independently of their own claims, the same way as the first round: every changed file was compared
against the commit it claimed to be, runtime behaviour was re-measured with probe scripts against a
disposable PostgreSQL database driving the **real** `POST /api/auth/login`, `GET /api/health` and
`POST /api/users` handlers, the whole CI sequence was re-run, and the fixes were mutation-tested.
The review **failed the PR again** — one HIGH, four MEDIUM, four LOW and two INFO findings. All
eleven are recorded below with what was measured, what changed, and what no repository-side change
can close.

*Measurements labelled "before" were taken against `e4c7b41`; "after" against the working tree that
became this commit. Nothing below was accepted on the strength of a green CI status.*

| ID | Severity | Finding (measured) | Status |
| --- | --- | --- | --- |
| **F-1** | **High** | Column drift was an invisible total login outage. `ALTER TABLE login_attempts DROP COLUMN ip_address` ⇒ **every** login answered 503 while `GET /api/health` answered **200 `ok:true` "Login and registration services are ready."** The probe asked only whether the *relation* existed (`to_regclass`), so it reported the feature present; the self-heal contained no `ALTER`, so it could never repair a drifted relation; and M-R4a's escalation needed a *failed repair*, which never happened because nothing attempted one. A **fresh process** answered 200 before any login had been tried | **Fixed.** `login_attempts` is probed in **columns mode** for the three columns the throttle actually reads (`identifier`, `ip_address`, `created_at`); `login_attempts` and `session_revocation` are marked **security-critical** and escalate on *missing or unverifiable* alone; the self-heal gained three additive `ADD COLUMN IF NOT EXISTS` statements (ledger total **8**, was 5). Measured after: drift ⇒ health **503**, one login self-heals the column and answers **401**, health **200** again; a fresh process with DDL blocked is **503 before any login** |
| **F-2** | Medium | The enforcing client had no `'error'` listener. `pg-pool` detaches its own idle listener on checkout and re-attaches it only on release, so a backend termination *during* the transaction was an unhandled `'error'` event: `pg_terminate_backend` on the enforcing backend **killed the probe process** (`Unhandled 'error' event: Connection terminated unexpectedly`). On a serverless deployment that takes every in-flight request in the isolate with it | **Fixed.** The enforcement path attaches its own listener for the whole checkout, removes it before releasing, and releases *with* the error when the connection is broken so `pg-pool` destroys the client instead of pooling a dead one; a statement-level error (missing column, lock timeout) keeps the connection. Measured after: the same kill degrades **one** login (503 + `Retry-After`, 0 rows recorded), the process survives, `/api/health` stays **200**, ≤1 advisory lock and ≤1 `idle in transaction` backend remain, and the next login is an ordinary **401**. The negative control still reproduces the crash (below) |
| **F-3** | Medium | The attribution chain ended on `x-real-ip` — an ordinary header any client can send — and treated *any* truthy `process.env.VERCEL` as platform provenance. Measured: a request carrying `x-real-ip: 203.0.113.66` plus a forged `x-forwarded-for` prefix was attributed to the forged address and bought a fresh budget | **Fixed.** The `x-real-ip` fall-through is **deleted**; the Vercel step requires the exact marker `process.env.VERCEL === "1"`; an edge header is honoured only when the operator names it with `EASY_LEARN_CLIENT_IP_HEADER` (used exclusively). Measured after, through the real route: five forged-header requests ⇒ **5 × 401 then 429** with all five rows stored as `ip_address IS NULL` — the forged value buys nothing |
| **F-4** | Medium | `session_revocation` had the same false-green as F-1: with repair **enabled** and DDL blocked, a missing `users.session_version` still answered **200 `ok:true`** while token verification failed closed on every authenticated request | **Fixed** by the same security-critical rule. Measured after: health **503 `ok:false`**, and the assertion in `tests/health-session-revocation-route-db.test.ts` that used to *require* 200 was inverted — it had been pinning the false-green as correct behaviour |
| **F-5** | Low → Medium | `pg_advisory_xact_lock` waits forever by default. At the **Production pool (`max: 2`)** two logins wedged on a lock held elsewhere consumed both connections: `GET /api/health` answered **503** and a bare `pool.query('SELECT 1')` errored — an application-wide outage caused by one contested login | **Fixed.** The enforcement transaction runs `SET LOCAL lock_timeout` (transaction-scoped, so it cannot leak into another request's use of the same pooled connection) from `EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS` — default **2000 ms**, clamped 250–10000, non-numeric junk falling back to the default rather than being silently ignored, interpolated as an integer. SQLSTATE `55P03` is contention, not a broken schema: 503 + `Retry-After`, connection straight back to the pool. Measured after, with `NODE_ENV=production` so the pool really is `max: 2`: six concurrent logins against a held lock all answer **503** within bound + acquire timeout, `/api/health` and `SELECT 1` stay healthy **at every 150 ms sample through a 200-way burst**, recovery is **401**, 0 advisory locks left behind |
| **F-6** | Low | Two accounts could share one identifier string. Measured: signing in to an account whose `email` equalled a **second** account's `username` erased the second account's recorded failures **4 → 0**, because `clearFailedLoginAttempts` releases every alias of the account that authenticated and the throttle keys on strings. `POST /api/users` also accepted *any* string as an email | **Fixed** at the only path that creates accounts (public registration is a disabled 403 stub): new `src/lib/login-identity.ts` validates the email format (400), generated usernames must be free in **both** columns, and a cross-column collision is refused with **409**. Measured after: 409 for an email that is another account's username, 400 for a bare username, 200 with a skipped username for an ordinary creation. Cross-column uniqueness is **inexpressible in the schema** (separate unique indexes, no computed union) so an operator with direct database access can still create a collision — recorded as a residual |
| **F-7** | Low | An errored probe produced a self-contradicting body: **`ok:true` with `login_attempts: false` in the same response**, so flag-based alerting fires while `ok` says healthy — and the cause was unretrievable, "(cause unknown)" | **Fixed.** A probe error escalates for security-critical features, and the cause is recorded (`getSchemaProbeFailure`, with SQLSTATE) and cleared by the next probe that answers. Measured after: a stubbed `08006` on the probe ⇒ **503 `ok:false`**, cause retrievable, the *repair* ledger unpolluted (a probe that errored applied no statements), health **200** again once the blip passes |
| **F-8** | Medium | The source documentation claimed an unattributable source made throttling "stricter, not looser". Measured the opposite: with `null` as the source neither source budget applies, so four accounts absorbed **60** guesses before any refusal where the same four from an attributed source are capped at **40** | **Documentation corrected** in `src/lib/rate-limit.ts`, this roadmap and `docs/SECURITY_AUTHENTICATION.md` §11. A **global** bucket for unattributable traffic was considered and **deliberately rejected**: one shared counter is the same denial-of-service shape H-1 removed, since whoever can make traffic unattributable could then exhaust it for everybody. The honest mitigation is to make traffic attributable (F-9); the residual risk stays open |
| **F-9** | Low | The default trust position is a **lockout** decision, not only an attribution one. Behind a second appending proxy — Cloudflare in front of Vercel, which the recommended WAF rate rule implies — the rightmost `x-forwarded-for` entry is the *edge's* address, shared by every visitor: five attacker guesses then exhaust the `(identifier, source)` pair budget and the **account owner is locked out** of their own account, and 40 guesses lock out **everybody** behind that edge for `IP_BLOCK_MINUTES` | **Documentation + an operator decision; no code change is possible.** The Cloudflare WAF recommendation and `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS` are now cross-referenced wherever either appears (this roadmap and §11): adopting the WAF rule requires raising the hop count to `2` **or** setting `EASY_LEARN_CLIENT_IP_HEADER=x-vercel-forwarded-for`, and recording the choice. Setting that header is the single change that removes the class, because nothing is then unattributable. The code cannot see the real edge, so no repository-side test can settle it |
| **F-10** | Low | `normalizeLoginIp` validated IPv6 as "colons and hex digits": `:::`, `a:b:c`, `1:::1`, `....::`, `1:2`, `1:2:3:4:5:6:7:8:9` and `::ffff:999.1.1.1` were all accepted, and **5000 junk inputs produced 5000 distinct source keys** — an attacker could mint a fresh per-source budget per request. Zero-padded IPv4 (`010.001.001.001`) was accepted too, and is a *different host* to a proxy that parses octal. Equivalent spellings of one address occupied two buckets | **Fixed.** Strict parse plus canonicalisation before the value is used as a bucket key or stored: RFC 5952 for IPv6 (`2001:0db8:0000::0001` → `2001:db8::1`), dotted-quad for IPv4-mapped forms (`0:0:0:0:0:ffff:203.0.113.7` → `::ffff:203.0.113.7`), zero-padded octets rejected. Measured after: every junk form above ⇒ `null`; canonical forms unchanged. Valid-but-distinct addresses still produce distinct keys (5000/5000), which is correct |
| **F-11** | Info | Three items: M-R1's trust model was pinned only by **static** assertions (round 2's MUT-08 survived), so the source could have been rewritten without a test noticing; `remainingAttempts` overstates by one; and **L-R5** — `login_attempts_ip_created_at_idx` still exists only in the self-heal DDL, measured at **3 ms** on an empty table versus **40 ms** at 200 001 rows | **Partially addressed.** M-R1 is now pinned **behaviourally through the real route** (the F-3 forged-header test), not only by source assertions. `remainingAttempts` is unchanged (not client-visible, accepted as I-R3). The index decision is unchanged and still open: measure, then add it in a reviewed, gated migration — this PR adds no migration. Also recorded: an attempt costs ~4 pool acquisitions and ~10 statements, which at `max: 2` is why the Production-pool suite now measures a 200-way burst end to end instead of arguing about it |

**Verification (third round).** Local mirror of `.github/workflows/ci.yml` with the same environment
shape — shared PostgreSQL as `TEST_DATABASE_URL`, a deliberately unreachable `DATABASE_URL`, a random
`JWT_SECRET`, and **every** `EASY_LEARN_REQUIRE_*` flag set so a silent skip fails the run:

| CI step | Result |
| --- | --- |
| `security:check-secret`, `npm audit --omit=dev` | pass · **0 vulnerabilities** |
| `npm test` | pass — 11 suites, **388 assertions, 0 failed**, including the login-throttle policy suite at **38** |
| `test:csp-hydration`, `test:auth-security` | pass — 11 and 13 assertions |
| `test:db` | pass — **24 suite invocations**, 83 s, **0 failures**; login-rate-limit database suite **35**, the new Production-pool suite **8**, health-session-revocation route **3** / probe **4** / auto-repair **2** |
| `test:tenant-auth`, `test:review-pr45`, `test:mutation`, `test:integration`, `test:tenant-integrity` | pass — 21, 5, 9, 11 and 24 assertions |
| `typecheck`, `build`, `lint` | pass · `✓ Compiled successfully` · `eslint .` clean |
| `test:tls-e2e` | not run locally (needs TLS-enabled PostgreSQL 16) — CI only |

The chain grew by one suite this round: `tests/production-pool-throttle-db.test.ts`, wired into
`test:db` and hard-required in CI by `EASY_LEARN_REQUIRE_PRODUCTION_POOL_DB=true`. It sets
`NODE_ENV=production` before importing `@/db` and asserts the pool really is `max: 2` with a 10 s
acquire timeout, so the F-2/F-5 and M-R2 measurements are taken in the shape that ships rather than
the development pool of 10 every other suite uses.

**Negative control — the new tests were run against the code they accuse.** A pristine copy of
`e4c7b41` (`git archive`, sources untouched) with only the four changed test files laid over it:

| Suite | Against `e4c7b41` | Against this commit |
| --- | --- | --- |
| `login-rate-limit-policy` | **24 passed / 14 failed** | 38 / 0 |
| `login-rate-limit-db` | **25 passed / 10 failed** | 35 / 0 |
| `production-pool-throttle-db` | **process died** after 5 passes — `Unhandled 'error' event: Connection terminated unexpectedly` (F-2) | 8 / 0 |
| `health-session-revocation-route-db` | **2 passed / 1 failed** (the inverted F-4 assertion) | 3 / 0 |

The 14 policy failures name F-3 (×2), F-10 (×3), F-1 (×3 incl. the M-R4a pins the enlarged ledger
moved), F-2, F-5, F-6, F-8 and F-9; the 10 database failures name F-1 (×3), F-2, F-3, F-4, F-6,
F-7, F-5 and M-R4a. Every finding in the register is therefore detected by a test that fails on the
vulnerable code, and the Production-pool suite does not merely fail against it — it reproduces the
isolate crash.

**Mutation harness — 21 targeted regressions, each a single minimal edit.** Fifteen undo a code
fix, six undo a corrected documentation claim; a mutation that leaves every suite green is a
survivor, i.e. a fix nobody would notice being removed.

| Mutation | What it undoes | Verdict | Suite results |
| --- | --- | --- | --- |
| MUT-F1a | `login_attempts` probe back to relation-mode | detected | policy 37/1 · db 33/2 |
| MUT-F1b | escalation ignores `securityCritical` | detected | policy 36/2 |
| MUT-F1c | the three additive column repairs removed | detected | policy 37/1 · db 33/2 |
| MUT-F4 | `session_revocation` no longer security-critical | detected | policy 37/1 |
| MUT-F2 | no `'error'` listener on the checked-out client | detected | policy 37/1 · db **crashed** · prodpool **crashed** |
| MUT-F2b | broken client released back into the pool | detected | policy 37/1 |
| MUT-F3 | `x-real-ip` fall-through restored | detected | policy 37/1 · db 34/1 |
| MUT-F3b | platform marker becomes a truthiness check | detected | policy 37/1 |
| MUT-F5 | `SET LOCAL lock_timeout` removed | detected | policy 37/1 · prodpool **hung** (120 s bound) |
| MUT-F5b | operator lock-timeout value silently ignored | detected | policy 37/1 |
| MUT-F6 | alias-collision 409 guard removed | detected | db 32/3 |
| MUT-F6b | email format validation accepts anything | detected | policy 37/1 · db 32/3 |
| MUT-F7 | errored probe no longer forces unavailable | detected | db 33/2 |
| MUT-F10 | IPv4 canonicalisation/strictness bypassed | detected | policy 36/2 |
| MUT-F10b | IPv6 accepted on the character set alone | detected | policy 36/2 |

Documentation mutations, run against the policy suite's doc pins:

| Mutation | What it undoes | Verdict | Suite results |
| --- | --- | --- | --- |
| MUT-F9d | the `F-9` register row loses its marker | detected | policy 37/1 |
| MUT-F9e | the F-9 row no longer says anyone is **locked out** | detected | policy 37/1 |
| MUT-F8d | the recorded decision *not* to add a global cap is deleted | detected | policy 37/1 |
| MUT-F8f | the disproved "stricter, not looser" claim is restored | detected | policy 37/1 |
| MUT-F9f | the §11 heading stops calling the hop count a lockout decision | **survived** | policy 38/0 |
| MUT-F8e | one of the two quotes of the F-8 measurement is removed | **survived** | policy 38/0 |

**Both survivors are reported rather than buried, and both are weaker mutations than they look.**
MUT-F9f edits a *heading*; the body two lines below still states the lockout consequence and the
remedy, which is what the pin asserts. MUT-F8e removes the measurement's *second* appearance in the
`rate-limit.ts` header — it is quoted twice, and the surviving quote still carries "measured across
12 accounts … refused after 40 … after 60". Neither survivor leaves a false claim in the tree.

One process note, because it changed a test: the first harness run reported **MUT-F9d as a
survivor**. It was a real gap — the assertion was `roadmap.includes("F-9")`, and the marker appeared
in three other places, so deleting it from the register row went unnoticed. The assertion now pins
the row itself (`| **F-9** | <severity> | … locked out … EASY_LEARN_CLIENT_IP_TRUSTED_HOPS`) and the
§11 tie between the hop count and the lockout, and the mutation was re-run to confirm detection.

**A flake found while verifying, and fixed.** The first full mirror run of this round failed
`test:db` with `3 !== 0` on the F-5 assertion that no advisory lock outlives its request. The three
locks were real but not this suite's: they belonged to backends in a *different* scratch database,
left behind when the mutation harness killed the hung MUT-F5 run mid-wait. `pg_locks` is
**cluster-wide**, so the assertion was counting other databases' locks — a false failure that a
shared CI PostgreSQL service could produce on any run. All three counts (two in the login database
suite, one in the Production-pool suite) are now scoped with
`AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`, and the fix was
verified by holding a foreign advisory lock in another database of the same cluster while the suite
ran: it passes. The orphans were terminated and their scratch databases dropped; the re-run mirror
is green.

Two of the code mutations are worth more than a tick in a table. **MUT-F5** does not fail an assertion, it
*hangs* the Production-pool suite — which is the finding restated as a test result: without the
bound, the suite never finishes. **MUT-F2** crashes two suites outright, because removing the
listener returns the code to the unhandled-`'error'`-event behaviour the review measured.
**MUT-F1b** and **MUT-F4** are the two that a green CI would previously have hidden: with either
applied, the database suites still pass, and only the policy suite's pins notice — which is exactly
why the escalation rule is asserted in source as well as in behaviour.

**Files changed this round:** `src/lib/rate-limit.ts`, `src/lib/schema-resilience.ts`,
`src/app/api/health/route.ts`, `src/app/api/users/route.ts`, new `src/lib/login-identity.ts`;
`tests/login-rate-limit-policy.test.ts`, `tests/login-rate-limit-db.test.ts`,
`tests/health-session-revocation-route-db.test.ts`, new `tests/production-pool-throttle-db.test.ts`;
`package.json`, `.github/workflows/ci.yml`, `.env.example`, `README.md`,
`docs/SECURITY_AUTHENTICATION.md` and this roadmap. No migration was added and none was run against
any Production database; no Production environment variable, permission, backup or deployment was
touched.

**Preserved, and re-measured this round:** H-R1 (four insider sign-in cycles ⇒ 5 allowed / 15
refused, the victim's rows survive), M-R2 (40 parallel from one source ⇒ exactly 5 guesses; 40
sources ⇒ exactly 15; a mixed burst ⇒ 0 deadlocks; 600 parallel ⇒ 5 × 401 / 595 × 429 in 2.2 s with
health 200; refusals do not extend a cooldown — `Retry-After` stays 1800 s), M-R3 (a username switch
from the same source is refused; case and whitespace collapse onto one budget) and the
no-disclosure-leak sweep (14 terms, `[]`). All of these still pass, and the M-R2 budgets are now
additionally measured under the Production pool.

**Still open after this round** (owner-side or explicitly deferred, none introduced by it): **L-R1**
(the 30-minute cooldown is unreachable inside a 15-minute window ⇒ 1,440 guesses/day/account),
**L-R2** (NAT blast radius of `MAX_IDENTIFIERS_PER_IP`), **L-R5** (the `(ip_address, created_at)`
index exists only in the self-heal DDL), **F-8/F-9** (unattributable traffic is less volume-limited,
and the edge topology is an operator decision), **F-6's residual** (cross-column uniqueness is
inexpressible in this schema), **F-11's** `remainingAttempts` off-by-one, **H-2** (no observability —
every signal in this register is a log line or a health body somebody must poll), I-R3, I-R4, I-R5,
and the Task C register (C-2, M-1…M-5, L-1…L-7) which is unchanged.

**Verdict after the third round:** the code-level findings F-1…F-8, F-10 and F-11(a) are fixed and
each is pinned by a test that fails against `e4c7b41`; F-9 and the F-8 residual are documented and
remain **operator decisions**. PR #69 is still **not approved for merge**, and this round does not
change that: the fixes were written by the same author as the code they correct, so a fresh
independent security review of the whole set is required before merge. Because `main` is the
production branch, merging PR #69 is expected to deploy it to Production.

### Follow-up review of PR #69 (2026-11-22) — F-1a repair ordering, F-6a atomic identity

The F-1…F-10 remediation at `5863052` was re-reviewed, and **two defects survived inside the fixes
themselves**. Both were invisible to a green CI: every suite passed at `5863052` with both present.
Each is recorded with the measurement that found it.

**F-1a (Medium) — the self-heal silently lost indexes on a drifted table.** `ALTER TABLE … DROP
COLUMN` also drops every index that depends on the column, and `ensureSchemaFeature` logs and
**skips** a statement that fails rather than aborting the feature. The repair list ran `CREATE
TABLE`, then the four `CREATE INDEX` statements, and only *then* the three additive `ADD COLUMN`
repairs — so on a drifted table the index builds referenced columns that did not exist yet, failed
with 42703, were skipped, and the columns were restored afterwards. The columns-mode probe then
reported the feature **available**, and because it was available the repair never ran again.
Measured on a disposable database against `5863052` (indexes present after the repair, out of the
four required):

| Column dropped | Indexes PostgreSQL took with it | Left missing **permanently** after the repair |
| --- | --- | --- |
| `identifier` | `identifier_idx`, `identifier_created_at_idx` | **2** — only `created_at_idx` and `ip_created_at_idx` came back |
| `ip_address` | `ip_created_at_idx` | **1** — `ip_created_at_idx` never came back |
| `created_at` | `created_at_idx`, `identifier_created_at_idx`, `ip_created_at_idx` | **3** — only `identifier_idx` came back |

No error, no health signal, no ledger entry: the table was "available" with a silently degraded
count query, which is finding L-R5's 3 ms → 40 ms penalty arriving without anybody deciding it.
**Fixed** by reordering the list to *relation → columns → indexes* and documenting the ordering as
load-bearing where the list lives (a statement may only depend on the ones before it). All eight
statements are `IF NOT EXISTS`, so the list stays re-runnable; nothing drops or rewrites anything,
and no `CONCURRENTLY` (it cannot run inside a transaction and is not needed while logins already
fail closed). `FEATURE_SQL` is now exported read-only so the tests assert the order of the list that
is *executed*, not the order it appears in a comment.

**F-6a (Medium) — the cross-column identity check was a check-then-act race.** The F-6 guard ran
separate `SELECT`s and then `INSERT`ed, with **bcrypt cost 12 (~250 ms) in between**, so the window
was hundreds of milliseconds wide. Measured against `5863052` with two opposing concurrent requests
— one creating `email = X`, the other a learner whose generated username (first initial + last name)
is the same string `X`: **both answered 201 and both accounts existed**, i.e. `email=1, username=1,
2 !== 1`. That is precisely the state the guard exists to prevent: two accounts sharing one
login-throttle bucket, where signing in to one releases the other's recorded failures. A wider burst
was worse — eight concurrent creations returned `(201, 500, 500, 500, 500, 201, 500, 500)`: the
same-column race surfaced as an **unmapped 500** from the unique-index violation instead of a
skipped username.

**Fixed** by making the whole sequence atomic in the database, without a migration (an expression
index over `COALESCE(email, username)` would need one, and Production migrations are not authorised
here):

```
BEGIN
  SET LOCAL lock_timeout = 5000                       -- bounded, transaction-scoped
  SELECT pg_advisory_xact_lock(hash('easylearn:login-identity'))
  … every uniqueness read, the username generation, the INSERT, the membership …
COMMIT                                                -- the lock dies with the transaction
```

bcrypt runs **before** the transaction, so the lock covers a handful of short statements. The
membership write moved inside the same transaction, which also removes the compensating
`DELETE FROM users` — a rollback cannot fail the way a compensating delete can. A lock timeout or a
deadlock is classified (`55P03` / `40P01`) and answered with a retryable **503**; nothing is
written. **One namespace key rather than a key per identifier**, deliberately: the generated
username is not known until the uniqueness reads have run and those reads must themselves be inside
the lock, so a per-identifier design has to lock in two phases (base candidate, then chosen
candidate plus email) and two transactions can acquire overlapping key sets in opposite order — a
deadlock cycle traded for concurrency on an authenticated, school-admin-only path. `SERIALIZABLE`
isolation was the alternative and was not chosen: it needs a retry loop, its aborts are
probabilistic rather than prevented, and it would abort every genuinely concurrent creation.

**Verification (round four).** Same environment shape as before, all `EASY_LEARN_REQUIRE_*` flags
set: **15/15 CI-mirror steps `EXIT=0`** — `npm audit --omit=dev` 0 vulnerabilities, `npm test`
(11 suites, **392 assertions, 0 failed**, policy suite **42**), `test:db` (**24 invocations**, 87 s,
0 failures — login-rate-limit database suite **41**, Production-pool suite **9**), tenant/auth/
mutation/integration/integrity suites unchanged and green, `typecheck`, `build`, `lint`.

| Suite | `5863052` | this commit |
| --- | --- | --- |
| `login-rate-limit-policy` | 38 | **42** |
| `login-rate-limit-db` | 35 | **41** |
| `production-pool-throttle-db` | 8 | **9** |

New assertions: for each of `identifier`, `ip_address` and `created_at` — drop the column
independently, establish that PostgreSQL took the dependent indexes with it (so the test cannot pass
vacuously), trigger the repair through a real login, then require **all three columns and all four
indexes**, a clear repair ledger, health 200 and the triggering attempt recorded; the repair list
executed twice more against a healthy table with a row in it, asserting nothing changes and no data
is touched; the order of the executed list asserted statement by statement (every index after every
column repair it references); three rounds of two concurrent opposing creations plus an eight-way
burst, asserting the contested string is held by **exactly one** account across both columns, that
no cross-column collision survives anywhere in the table, that the loser lost *coherently* (409 on
the email side, a suffixed username on the other), and that no advisory lock outlives the requests —
the burst also runs at `NODE_ENV=production` / `max: 2`, sampling `/api/health` and `SELECT 1`
throughout.

**Negative controls (one file reverted at a time, so each finding is isolated):**

| Control | Reverted | Result |
| --- | --- | --- |
| NC-A | `src/lib/schema-resilience.ts` only (indexes-first order restored; the `FEATURE_SQL` export kept so the difference under test is the *order*) | database suite **37/4** — all three drop-column scenarios fail with the exact index that never came back, plus the idempotency test; policy suite **40/2** |
| NC-B | `src/app/api/users/route.ts` only (check-then-insert restored) | database suite **39/2** — `email=1, username=1, statuses=201/201` and the burst's unmapped 500s; Production-pool suite **8/1** — `got 500 (201, 500, 500, 201, 500, 500)`; policy suite **41/1** |

**Mutation harness — 8 targeted regressions of the two fixes, all 8 detected:**

| Mutation | What it undoes | Verdict | Suite results |
| --- | --- | --- | --- |
| MUT-G1 | repair list reordered, indexes before the column repairs | detected | policy 41/1 · db 37/4 |
| MUT-G2 | the `ip_address` column repair removed | detected | policy 40/2 · db suite aborts on its own teardown guard ("the throttle table must exist again") — the table can never be repaired |
| MUT-G3 | the identity advisory lock removed | detected | policy 41/1 · db 39/2 |
| MUT-G4 | `SET LOCAL lock_timeout` removed from the identity transaction | detected | policy 41/1 |
| MUT-G5 | bcrypt moved inside the lock | detected | policy 41/1 |
| MUT-G6 | the account inserted on the pool instead of the transaction | detected | policy 41/1 · **db 41/0** |
| MUT-G7 | `isIdentityLockTimeout` always false | detected | policy 41/1 |
| MUT-G8 | the membership moved back out of the transaction | detected | policy 41/1 |

Two honest notes. **MUT-G6 passes the database suite**: with the lock still held, a pool-level
insert is still serialised against other creations, so the concurrency tests cannot tell the
difference — what is lost is the atomic rollback of account + membership, which only the source pin
catches. **MUT-G5 is a performance regression, not a correctness one**, and is likewise caught only
by the pin. Both are recorded rather than presented as behavioural kills.

**The earlier 21-mutation harness was re-run against the rewritten code, and it found two things.**
Its `MUT-F6` anchor (`if (aliasCollision) { … }`) no longer existed after the route was restructured,
so the harness would have reported a phantom `BAD-PATCH`; the anchor was re-pointed at the guard
inside the transaction and all 16 code mutations were re-verified to have exactly one match before
the run. The run then detected **14 of 16** and left two survivors, both of which were investigated
rather than filed:

| Mutation | Verdict on re-run | What it turned out to be |
| --- | --- | --- |
| MUT-F7 — `if (featureProbeUnavailable \|\| securityCriticalMissing)` becomes `if (securityCriticalMissing)` | **survived** — policy 42/0 · db 41/0 | a **real test gap**, now closed |
| MUT-F9d — the `F-9` *narrative* heading loses its marker | **survived** — policy 42/0 | a **stale anchor**, not a gap |

*MUT-F7 was a genuine gap, and it is worth stating exactly why, because the obvious explanation is
wrong.* The obvious explanation is that `securityCriticalMissing` already covers the probe-error
case, because `probeSchemaFeatures` records a failed probe as `present: false`. It does not: that is
only true for a **security-critical** feature, and it does not cover the case the clause exists for —
`await import("@/lib/schema-resilience")` throwing, i.e. the probe module cannot be loaded at all. In
that case nothing sets any `optionalMigrations` entry, `securityCriticalMissing` is `false`, and the
remaining guard is the only thing standing between an unreadable schema state and `ok:true`. Deleting
it survived everything, including the database test written for F-7, because that test stubs
`pool.query` and so the module always imports. That the policy pin did not catch it either is the
instructive half: the pin was `health.includes("featureProbeUnavailable")`, and the flag is
*declared* in the route and *set* in the `catch`, so the assertion was satisfied by the two places
that do not matter and said nothing about the guard that reads it. A name appearing in a file is not
a behaviour. The pin is now a regex on the condition itself —
`/if\s*\(\s*featureProbeUnavailable\s*\|\|\s*securityCriticalMissing\s*\)/` — and the mutation
is now caught (policy **41/1**) with the assertion message saying that the guard must *read* the flag,
not merely declare it. This is the second time in this review that a static pin was satisfied by an
irrelevant occurrence of the string it was looking for; the first was MUT-F9d.

*MUT-F9d was not a gap at all.* The register-row pin it was supposed to exercise
(`| **F-9** | <severity> | … locked out … EASY_LEARN_CLIENT_IP_TRUSTED_HOPS`) was added in the
previous round and does fire: stripping the row marker alone turns the suite **41/1**. What the
harness was mutating was a *prose* heading elsewhere in the roadmap that no assertion reads, which is
a harmless edit. The mutation was re-pointed at the register row, where it represents the claim the
finding is actually recorded by, and it is detected. Nothing in the documentation changed as a
result — this is an artefact of a harness written against an older revision, and it is recorded in
the table above rather than quietly deleted so that the "14/16" is not mistaken for a defect in the
fixes.

After both corrections the same 16 mutations were re-run against the final tree and **16 of 16 are
detected**, with `HARNESS_EXIT=0`. The per-mutation results are reproducible from `mutate.py`; the
two that changed are MUT-F7 (policy **41/1**) and MUT-F9d (policy **41/1**). One incidental
confirmation: MUT-F7's database suite now *passes* while the policy suite fails, which is exactly the
asymmetry described above — the behaviour is unreachable through the stubbed-probe path, so the
source pin is what protects it, and the roadmap says so rather than implying the database test covers
it.

**A defect found in the new test code itself, and fixed.** The Production-pool suite's liveness
sampler stopped only on the success path, so a FAILED assertion inside the sampled block left the
sampler looping forever and the process never exited: measured, the NC-B run **hung for 900 s**
instead of reporting `8 passed, 1 failed`. In CI that would have consumed the whole job timeout and
reported nothing. The sampler now stops in a `finally`; NC-B re-run afterwards finished in 12 s with
the failure correctly reported.

**Remaining limitations after this round:**

1. The identity invariant is still **application-enforced**. A direct `INSERT`/`UPDATE` against the
   database can create a colliding pair, because cross-column uniqueness is inexpressible without an
   expression index — a Production migration, which this work is not authorised to add. Recorded as
   the F-6 residual in the register above.
2. Every account creation in a deployment serialises on one advisory lock. The path is
   authenticated, school-admin-only and low-volume, the lock covers a handful of statements, and the
   wait is bounded at 5 s with a retryable 503 — but a bulk-import feature would need a different
   design (batch inside one transaction, or the expression index above).
3. `src/app/api/seed/route.ts` also inserts users and does **not** take the identity lock. It
   answers 404 whenever `NODE_ENV=production`, requires `super_admin`, and only seeds an empty
   database inside its own transaction, so it is not a Production collision path; it is recorded
   here so the omission is a decision rather than an oversight.
4. A table missing **only** an index still does not trigger a repair, by design: the probe reports
   availability from the columns the throttle reads, and requiring `login_attempts_ip_created_at_idx`
   in the probe would answer 503 for a healthy Production database that legitimately lacks it
   (L-R5). The repair creates all four indexes whenever it *does* run.
5. **L-R5 is unchanged and still open**: a healthy Production table still has no
   `(ip_address, created_at)` index. That needs the reviewed, gated migration, not this list.
6. Everything else in the F-register stands: F-9 and the F-8 residual remain operator decisions,
   L-R1, L-R2, H-2 and the Task C register are untouched.

## Current progress dashboard — 2026-11-19 production status

| Phase | Estimated completion | Status | Main work still outstanding |
| --- | ---: | --- | --- |
| 1. Critical Security & Access Control | **100%** | Complete for bounded Phase 1 scope; the H-1 login-throttle fix is under review (2026-11-19) | Review and merge the H-1 rate-limit fix, then verify throttling live; verify live role-denial and DB prerequisites; broader session/CSRF security is later scope. |
| 2. Multi-School / Multi-Tenant Architecture | **78%** | Code hardening merged; production gate blocked | Read-only production evidence for migrations 0013–0017 and tenant behavior; safely rehearse migration 0018 against a restored production copy; plan and validate 26 missing child-side FK indexes; separately authorize any production change. |
| 3. School Management & Administration | **25%** | Legacy LMS baseline exists; SaaS workflows not started | Platform school onboarding/provisioning, invitations, membership administration, school lifecycle/settings, safe offboarding and independent-school E2E. |
| 4. Academic & Results Management | **45%** | Core teaching workflows exist | Configurable grading/scales, moderation and result publication, report cards, promotion/rollover, historical-year handling and school-specific configuration. |
| 5. Communication & Notifications | **40%** | Core features exist | Complete tenant-aware verification and production checks; richer school communication workflows and operational acceptance. |
| 6. Reports, Documents & Analytics | **35%** | Existing reports/dashboards; isolation fixes merged | Verify live isolation; complete document/report lifecycle, exports and scalable analytics as product scope requires. |
| 7. SaaS Billing & Subscriptions | **0%** | Not started | Plans, entitlements, subscription lifecycle, payments, invoices, retries, cancellations and billing administration. |
| 8. UI/UX, Mobile, Performance & Reliability | **40%** | Existing UI; hardening ongoing | School branding/switching polish, accessibility/mobile checks, query/index performance and reliability/observability work. |
| 9. Testing, Production Hardening & Enterprise Readiness | **55%** | Test suites and safeguards improved; production proof incomplete | Restored-production-copy rehearsal, verified live schema/data/behavior evidence, confirm branch protections, production smoke tests, security/operational runbooks and launch acceptance. |

**How to read the percentages:** estimates reflect delivered scope against each phase’s full roadmap, not the share of code merged. The overall 46% is a rounded planning estimate across the nine phases. Merged code and passing disposable-database tests do **not** count as production migration or behavior verification.

**What changed in the 2026-11-19 update:** no phase percentage was revised. Two gates moved: Cloudflare R2 object storage went from *deployed, production behaviour unverified* to **production behaviour verified** (assignment uploads, learner submissions and downloads — see "Closed" above), and Phase 1 gained one open review item, the H-1 login-throttle fix. Migration 0018, the 26 child-side FK indexes, and every backup/disaster-recovery gate are unchanged.

### Confirmed progress since the previous roadmap checkpoint

- **2026-11-19 — Cloudflare R2 object storage verified in Production (owner-confirmed).** Assignment uploads, learner submissions and downloads all work end to end after the bucket CORS correction. The C-1 active upload failure is closed and removed from this roadmap; the audit reports are committed at the repository root.
- **2026-11-19 — deployed build identity confirmed.** The GitHub deployments API records a Production deployment of `4069584e99574a4fe2af7d4317a8bcbf13f9bf73` at 2026-11-17T21:20:13Z for the Vercel project `easylearn` (alias `https://easylearn-six.vercel.app`), with CI green on that commit (PostgreSQL isolation suites, typecheck, build, lint) and a successful Vercel build. The legacy duplicate project `easylearnn` still exists and is audit finding M-4.
- **2026-11-19 — full production readiness & security audit completed read-only** (`FULL_PRODUCTION_AUDIT_2026-11-19.md`). A 60-route sweep found no new IDOR, privilege-escalation, injection or tenant-isolation defect, and the existing controls were re-verified in code at HEAD. Verdict: CONDITIONAL NO-GO for formal sign-off, blocked on H-1 (fix now under review), H-2 (observability) and M-4.
- **2026-11-19 — H-1 login throttling remediated in code: PR #69, open for review.** The throttle no longer fails open, client IPs are now limited (per-source volume and credential-spraying budgets), the five-attempt budget is scoped to (identifier, source) so one attacker can no longer lock an administrator out, and two regression suites were added (`tests/login-rate-limit-policy.test.ts`, `tests/login-rate-limit-db.test.ts`). Migration 0018 and backup/DR were untouched by this work.
- **2026-11-19 — PR #69 independently security-reviewed: verdict FAIL, one HIGH finding (H-R1).** The review did not accept the implementation's own claims or the green CI status: all 13 changed files were compared against `main`, the runtime behaviour was re-measured with probe scripts against a disposable database driving the real login handler, and the full CI sequence was re-run locally. It found that the successful-login reset deleted every failure row sharing the source IP, so one valid low-privilege credential could repeatedly erase an attacker's accumulated failures against other accounts (108 unthrottled guesses over three sign-in cycles in the probe) — and that the PR's own test asserted that behaviour as correct. Full register: M-R1, M-R2, M-R3, M-R4 (merge gate), L-R1…L-R5, I-R1…I-R5.
- **2026-11-19 — H-R1 fixed in code on the same PR branch.** `clearFailedLoginAttempts` is now identifier-scoped and can never widen its DELETE by source IP; the vulnerable assertion was **reversed** and a route-level regression test added (database suite 19 → 20 assertions). Both new tests were validated against the vulnerable code — they fail there with `3 insider sign-ins must release at most one budget of 5 guesses, got 12` and pass 20/20 on the fix. The full local CI mirror was re-run afterwards. **PR #69 remains unmerged and unapproved: an independent security re-review is required before merge, and the M-R4 Production check is a merge gate.** No production connection, deployment, migration, setting change, or backup operation was performed.
- **2026-11-19 — M-R4 answered by Production evidence; M-R1, M-R2, M-R3 and M-R4a fixed in code on the same PR branch.** An authorized operator ran the read-only M-R4 check against the Production runtime database (this sandbox has no path to Production and none was created): `public.login_attempts` exists, the effective role is `neondb_owner`, `has_schema_privilege(current_user, 'public', 'CREATE')` and `USAGE` are both `true`, and `AUTO_SCHEMA_REPAIR` is absent from the Vercel Production environment — which the code's only parser treats as **enabled**. M-R4 is therefore recorded as **substantially resolved**, keeping the qualification that **actual runtime repair has never been exercised in Production**. Investigating it produced a new finding, **M-R4a**: `/api/health` answered 200 "Login and registration services are ready" whenever repair was merely *enabled*, even with repair broken, while every login answered 503. All four code findings are now fixed — a declared client-IP trust position (`EASY_LEARN_CLIENT_IP_HEADER`, `EASY_LEARN_CLIENT_IP_TRUSTED_HOPS`, rightmost-trusted-hop), advisory-locked insert-then-decide enforcement before the password is verified, one account budget shared by every alias, and a `repairBlocked` health escalation backed by a read-only privilege probe and a repair-failure ledger. Both login-throttle suites grew 20 → **27** assertions; every new test was validated against `5b8fbd1`, where the database suite fails 6 (25 of 25 concurrent guesses allowed, 24 of 24 sprayed, aliases never sharing a budget, health **200**) and the policy suite fails 9. The full 13-step local CI mirror was re-run: every step `EXIT=0`, `0 vulnerabilities`, `✓ Compiled successfully`. **PR #69 remains unmerged and unapproved — an independent security re-review of the whole set is required.** No production connection, deployment, migration, `drizzle-kit push`, environment-variable change, database-permission change, or backup operation was performed.
- **2026-11-22 — PR #69 follow-up review: two defects inside the F-1…F-10 fixes themselves, both now fixed.** Re-reviewing `5863052` found that the `login_attempts` self-heal listed its four `CREATE INDEX` statements *before* the three additive `ADD COLUMN` repairs, and since `ALTER TABLE … DROP COLUMN` takes the dependent indexes with it while `ensureSchemaFeature` skips (not aborts on) a failing statement, a drifted table came back "available" with 1, 2 or 3 of its four indexes permanently missing — no error, no health signal, no ledger entry (**F-1a**). It also found that the F-6 cross-column identity guard was check-then-act with bcrypt cost 12 (~250 ms) between the checks and the insert: two opposing concurrent creations both answered **201** and both accounts existed, and an eight-way burst returned six unmapped **500**s (**F-6a**). Fixes: the repair list is reordered relation → columns → indexes with the ordering documented as load-bearing and `FEATURE_SQL` exported read-only so tests pin the executed order; account creation now runs its checks, username generation, insert and membership inside one transaction behind a bounded (`SET LOCAL lock_timeout = 5000`) transaction-scoped advisory lock on a single identity namespace, with bcrypt outside the lock and the compensating `DELETE` replaced by rollback. Evidence: policy suite 38 → **42**, login database suite 35 → **41**, Production-pool suite 8 → **9** (the burst also runs at `max: 2`); one-file-at-a-time negative controls give db **37/4** and **39/2** plus Production-pool **8/1**; an 8-mutation harness detects all 8, with two recorded as caught only by source pins; the 15-step CI mirror is green end to end. A defect in the new test code was found and fixed on the way — a failed liveness assertion left the sampler looping so the suite hung for 900 s instead of reporting the failure. **PR #69 remains unmerged and unapproved; a fresh independent security review is still required.** No production connection, deployment, migration, `drizzle-kit push`, environment-variable change, database-permission change, or backup operation was performed.
- **2026-11-19 — PR #69 reviewed a second time: verdict FAIL again (F-1…F-11); all ten code-and-documentation findings now fixed on the same branch.** The second independent review re-measured `e4c7b41` rather than trusting it, and found one HIGH: a **drifted column** on `login_attempts` was a permanent, invisible login outage — every sign-in answered 503 while `/api/health` answered **200 `ok:true` "Login and registration services are ready."**, because the probe asked only whether the relation existed, the self-heal contained no `ALTER`, and M-R4a's escalation needed a failed repair that nothing ever attempted. Also found: no `'error'` listener on the checked-out client (a `pg_terminate_backend` **killed the isolate**); an attribution chain that ended on client-writable `x-real-ip`; an **unbounded** advisory-lock wait that, at the Production pool of two connections, took `GET /api/health` and a bare pool query down with it; `session_revocation` false-green; a probe error producing `ok:true` next to a `false` flag in the same body; cross-account alias collisions erasing another account's recorded failures; IPv6 "validation" that accepted `:::` and minted 5000 distinct source keys from 5000 junk inputs; and two documentation claims that measured the opposite of what they said. Fixes: a **columns-mode** probe plus a `SECURITY_CRITICAL_FEATURES` escalation on *missing or unverifiable*, three additive column repairs, a checked-out-client error listener with a destroying release, the `x-real-ip` fallback **deleted** and the Vercel marker made exact, `SET LOCAL lock_timeout` (`EASY_LEARN_LOGIN_LOCK_TIMEOUT_MS`, default 2000, clamped) failing closed on `55P03`, `src/lib/login-identity.ts` with 400/409 guards at `POST /api/users`, a retrievable probe-failure cause, and strict-plus-canonical IP parsing. Evidence: policy suite **38** assertions, login database suite **35**, and a new `tests/production-pool-throttle-db.test.ts` (**8**) that sets `NODE_ENV=production` and asserts the pool really is `max: 2` before measuring the budgets, the bounded lock wait and the killed backend in the shape that ships. Run against a pristine `e4c7b41` the same tests fail **14**, **10** and **crash the process** respectively; a 21-mutation harness detects 19 (two documentation survivors recorded and explained). The 15-step local CI mirror is green end to end. **PR #69 remains unmerged and unapproved — a fresh independent security review is required, and this round does not change that: the fixes were written by the same author as the code they correct.** No production connection, deployment, migration, `drizzle-kit push`, environment-variable change, database-permission change, or backup operation was performed.
- **PR #32 merged** at `90ec04363cbec3222232c6f912fcad69ab038dba`. It integrated the migration-runner/schema-resilience safeguards and the migration-0018 composite-FK work, plus regression evidence. It did not apply migration 0018 to production.
- **PR #33 merged** at `851156cac0403f1b9e268c0c3584543852399c48`. CI succeeded; scratch database teardown is now shared and asserted, and the LOW-1/2/3 findings were addressed. LOW-4 was deliberately not changed because the proposed change weakened fail-closed authorization.
- The scratch-database leak was reproduced before the fix (four databases left behind by the worst suites); the PR reports repeated suite runs and the complete CI sequence leaving zero scratch databases.
- **Still not confirmed:** production execution of migrations 0013–0017 (no `easylearn_schema_migrations` ledger exists in Production), current production schema/data integrity beyond the owner-verified 2026-10-27 read-only checkpoint (**0/26** composite FKs from 0018, **24/24** objects from 0017), and post-change live tenant-isolation behavior.
- **Still outstanding:** 26 child-side FK indexes identified as a performance/locking risk. They require a separate reviewed and gated migration; PR #32/#33 did not add them, and no such migration exists as of 2026-11-19.
- No production connection, migration, data/settings change, manual deployment, backup operation, or branch-protection change was performed as part of these merges, the 2026-11-19 audit, or this roadmap update.

## Immediate remaining work (ordered)

1. **Re-review, then merge, the H-1 login-throttle fix — PR #69.** It is the only code-level blocker with a finished implementation, and it now carries the H-R1 correction **and** the fixes for M-R1, M-R2, M-R3 and M-R4a. Two gates stand before merge, in order: **(a)** an **independent security re-review of the whole set** — every fix was written by the same author as the original change, so it must not self-approve, and green CI is not approval; **(b)** the reviewer records the two decisions that only an operator can make — the **M-R1 edge configuration** (how many proxies actually append to `X-Forwarded-For` in front of Production, or which platform header to name; nothing is set today, so the default of one trusted hop applies) and the surviving **M-R4 qualification** (runtime repair has never been exercised in Production; the evidence proves the role *can* create the table, not that repair *works*). The former M-R4 gate is **answered**: `login_attempts` exists, the role is `neondb_owner` with `CREATE` on `public`, and `AUTO_SCHEMA_REPAIR` is absent ⇒ enabled. The former M-R1/M-R2/M-R3 decision is **answered in code**, with the vulnerabilities re-measured in the regression harness rather than argued. After merging and deploying, verify in Production that a throttled login returns 429 with a `Retry-After` header, that a degraded throttle returns 503 rather than signing anyone in, that legitimate users — including administrators signing in from a different network than an attacker — are unaffected, that **a successful login by one account no longer releases another account's throttle on the same network**, that **email and username attempts against one account share a single budget**, and that `/api/health` reports the `login_attempts` feature — and returns **503** if that table ever disappears and repair cannot recreate it.
2. **Read-only production checkpoint:** an authorized operator verifies the intended Vercel project/alias and production build identity (both now recorded above for 2026-11-19), then captures sanitized catalog/data evidence for migrations 0013–0017, required NULLs, orphan/cross-school rows, FK validation and indexes, and post-repair role/dual-school behavior. Do not expose secrets.
3. **Restored-copy rehearsal for migration 0018:** use a restored copy of production only. Check PostgreSQL version (confirmed 18.6, and the migration syntax requires PostgreSQL 15+), row/table sizes, preflight results, lock duration and rollback behavior. Record results and review them before any production application. **Blocked in practice while backup/disaster recovery stays paused** — there is no verified restore to rehearse against, so this step needs the DR workstream to resume first or an explicitly authorized alternative source copy.
4. **Index plan and separate migration:** enumerate the 26 missing child-side FK indexes, inspect query plans and table sizes, design a low-lock/concurrent-index approach compatible with the migration runner, and test it on the restored copy. Do not bundle this into an unreviewed production action. The H-1 fix adds one more candidate for the same reviewed migration: an `(ip_address, created_at)` index on `login_attempts`, which the new per-source throttle counts with and which migration 0012 does not create.
5. **Decision gate:** reconcile the evidence. If production is already at the expected state, do not rerun migrations. If there is a gap, prepare a narrowly scoped remediation plan for explicit authorization, with backup/recovery and post-checks.
6. **Close the remaining audit blockers:** H-2 (no `error.tsx`/`global-error.tsx`/`not-found.tsx`, no instrumentation, `/api/health` blind to object storage) and M-4 (confirm the legacy Vercel project `easylearnn` is disconnected or delete it). M-5 (the mobile-navigation fix in PR #61) is still open and live in Production, and the M/L findings in the table above remain scheduled behind these.
7. **Only after Phase 2 gates:** complete independent-school onboarding/lifecycle workflows and proceed with the remaining Phase 3–9 product scope. Phase 3 is not launch-ready while the tenancy production gate is unresolved.

This current roadmap supersedes the historical architecture audit retained below, including
its proposed numbering, table counts, future migration numbers and old “remaining” lists.
Status describes the stated scope, not commercial launch readiness. **Implemented**, **merged**,
**deployed**, **production DB migrated**, and **production behavior verified** are independent gates.
“Reported” is documentary evidence, not independent production confirmation. No production
connections, migrations or deployments were performed for this audit.

## Verified checkpoint and evidence

- GitHub `main` and fetched `origin/main` agree on the SHA above. The supplied checkpoint
  `c9adf6f41389f768de32417474e9b6f8bcdeecd9` is an ancestor (assignment/submission
  filter-overwrite fix in [PR #20](https://github.com/shadrachampah123/easylearn/pull/20)), not latest main.
- [PR #29](https://github.com/shadrachampah123/easylearn/pull/29) merged this roadmap follow-up at `8931095`; latest main has no open PRs and no GitHub Actions workflow runs returned at the 2026-10-18 checkpoint. PR #29 has successful Vercel Preview Comments and Preview status.
- [PR #16](https://github.com/shadrachampah123/easylearn/pull/16) merged Phase 1 at `eaed78c`;
  Production deployment **6402657266** succeeded 2026-09-11 22:16:59 UTC.
- Phase 2 foundations: [#17](https://github.com/shadrachampah123/easylearn/pull/17) `18d32f8` (2A),
  [#18](https://github.com/shadrachampah123/easylearn/pull/18) `9d6c6ce` (2B),
  [#19](https://github.com/shadrachampah123/easylearn/pull/19) `9553b4a` (2C),
  #20 `86e6a44` (2D). All merged; included in deployed main.
- Subsequent Phase 2E work is also merged and included in deployed main:
  [#21](https://github.com/shadrachampah123/easylearn/pull/21) `1fa91b9` (write attribution and narrow legacy fallbacks),
  [#22](https://github.com/shadrachampah123/easylearn/pull/22) `b22d56f` (override write attribution),
  [#23](https://github.com/shadrachampah123/easylearn/pull/23) `dbc19ef` (migration 0017),
  [#24](https://github.com/shadrachampah123/easylearn/pull/24) `1329426` (dashboard/report isolation),
  [#25](https://github.com/shadrachampah123/easylearn/pull/25) `9a654a9` (direct override scope and question DELETE parent anchoring).
- [GitHub Production deployment 6417389439](https://api.github.com/repos/shadrachampah123/easylearn/deployments/6417389439/statuses)
  is tied to the exact main SHA; success recorded 2026-09-13 03:59:23 UTC.
  [Vercel deployment](https://vercel.com/shadrachampah123s-projects/easylearn/GEDjSsuUKbwrSsW8Q45Gk4dUXRUh).
  This proves a successful Production deployment record, **not** database execution, custom-domain
  routing, functional correctness, or that today's production alias still serves that build.
- GitHub also records successful Production deployment **7156708039** for main SHA
  `8931095c5333e4f39f527d4520c0185805bf536f` (status updated 2026-10-18 15:32:44 UTC).
  This later status is deployment metadata only; it does not resolve the intended Vercel project/alias
  ambiguity or establish production DB migration state.
- Open PRs at audit start: **none**. GitHub Actions runs: **none returned**, no `.github/workflows`.
  Main's Vercel status is success; main has no check runs. PR #25's preview Vercel context is
  **ERROR**, last updated 2026-10-13, while Preview Comments succeeded. Its bot comment lists
  two Vercel projects (`easylearn`, `easylearnn`) with inconsistent preview states. Later
  September preview deployments are not newer main or Production evidence. Reconcile project/alias
  ownership and the failed preview before relying on CI as a release gate.

### Migration and production-verification ledger

| Gate | Verified state / evidence | Required closure |
| --- | --- | --- |
| Implemented / merged | 0013–0017 SQL, schema and runner registration exist; root/drizzle copies of 0016/0017 match. 0013/14 establish memberships; 0015 backfills CBISM; 0016 adds direct tenancy; 0017 backfills residual NULLs and enforces NOT NULL on 24 tables, leaving platform `activity_logs` nullable. | Do not rebuild these completed artifacts. |
| Deployed | Exact latest application SHA has successful GitHub Production deployment record above. | Confirm intended project and production alias build identity. |
| Production DB migrated | **Reported applied, independently unverified.** `PHASE2E_MIGRATION_0017.md` records a live post-0016 audit (26 school-ID tables including memberships, FKs/indexes, one school, residual NULLs). `PHASE2E_HARDENING.md` second pass explicitly says production had 0016+0017 applied; #25 assumes both shipped. #23 itself explicitly did not run production migrations. No attached runner output or timestamped production catalog result establishes execution. | Obtain sanitized read-only production catalog/data proof for 0013–0017, especially 0016/17. Do **not** treat the old “0016 awaiting execution” checkpoint as current fact or blindly re-run it. |
| Production behavior verified | Historical audit assertions exist; no reproducible post-#25 production smoke/isolation report found. Local DB tests in PRs are not production tests. | Record build identity, authorized role/school smoke tests, isolation denials, dual-membership attribution and regression results, with timestamp and environment. |

At the main/PR #29 checkpoint, the runner explicitly attempted an ordered list through 0017,
with no applied-migration ledger, no per-file transaction/advisory lock, broad duplicate-error
skips, and weak missing-file handling. Those are the verified pre-PR #30 runner deficiencies,
not the current branch implementation. PR #30's replacement runner and explicit existing-schema
baseline gate are documented in the current-branch continuation below. Drizzle journals remain
file metadata, not production execution evidence. `package.json` builds with `next build`, **not**
the migration runner; no checked-in deployment hook proves automatic migration execution. The
#23 claim that redeploy applies migrations is therefore insufficient.

### Historical test evidence at pre-follow-up audit checkpoint (2026-10-18; superseded by the working-branch evidence below)

- Fresh `npm ci --ignore-scripts --no-audit --no-fund`; no tracked dependency changes.
- `npm test` initially stopped after security tests because `DATABASE_URL` is required at import.
  Re-run with an inert loopback port-1 test URL (no production credentials or DB connection):
  **101 passed** (28 security source checks, 15 pure authorization, 23 tenant foundation,
  35 membership foundation). `npm run typecheck`: **pass**.
- `npm run lint`: latest verification is recorded in the current branch checkpoint below;
  not a new documentation regression, but still a release-quality gap.
- Latest #25 PR reports 13 suites passing: 28 + 15 + 23 + 35 + 26 + 44 + 71 + 17 + 11 +
  7 mutation checks + 11 write-attribution + 12 migration + 21 dashboard-isolation checks.
  These are **author-reported**, not CI-attested. Build/typecheck also reported green there.
- DB, mutation and migration suites were **not rerun** in this audit (no approved disposable
  database provisioned); build not rerun. Some DB harnesses explicitly skip with exit 0 when
  neither `TEST_DATABASE_URL` nor embedded PostgreSQL exists: an exit code alone is not coverage.
  Future CI must require all DB suites to execute against an ephemeral database, never production.

### Focused tenant-isolation audit follow-up (2026-10-18)

**Scope/status:** Source-confirmed findings from the latest production audit were repaired
against the actual fetched `origin/main` (`f19f776a1c32265ea442fb1b44914cfb86d93bbb`),
not just the supplied older application checkpoint. The application changes and executable
regressions are implemented and passed; PR #28 is merged at
`0adb2052841055b994b266618c56ba7ba2d9df40` (2026-10-18), with both Vercel contexts passing.
Deployment, independent review, and production behavior are **not yet verified**. This closes
the code/test finding only; it does not certify production. No production database, secrets, migrations, or deploys
were accessed/performed. Phase 3 remains blocked pending independent review and the separate
production evidence gate above.

| Finding | Repair and regression evidence | Status |
| --- | --- | --- |
| Parent-learner links | `/api/parent-learners` collection reads, pair lookups/deletes, and `/[id]` reads/updates/deletes now predicate on the link row's own `school_id`; dual-member endpoints cannot claim a School B link from School A. Disposable PostgreSQL tests cover both schools and preserve School B's legitimate read/update/delete. | Implemented and merged in PR #28; DB regression and Vercel checks pass; independent review pending. |
| Messages | Conversation and inbox reads plus read-status updates predicate on `messages.school_id` and preserve participant checks. Disposable PostgreSQL test uses two participants who each belong to both schools; School A returns/marks only its message while School B remains hidden/unread. | Implemented and merged in PR #28; DB regression and Vercel checks pass; independent review pending. |
| Notifications | Listing, totals/unread counts, single-ID updates and mark-all updates use both recipient and `notifications.school_id`. Dual-member test proves both schools' notifications stay isolated. | Implemented and merged in PR #28; DB regression and Vercel checks pass; independent review pending. |
| Activity and dashboards | Activity endpoint/dashboard feed now require `activity_logs.school_id = ctx.schoolId` in addition to actor membership. `NULL school_id` remains explicitly platform-global and is excluded from school feeds; no school feed grants platform visibility. Dashboard counts and joins add direct predicates for each relevant owned row (`classes`, `assignments`, `quizzes`, `resources`, `announcements`, `attendance`, `submissions`); users remain membership-scoped because `users` is a global identity table. Dual-member tests cover aggregates and activity rows attributed to both schools. | Implemented and merged in PR #28; DB regression and Vercel checks pass; independent review pending. |
| Global user identity | School admins can update only the active membership role for their own school. Global profile, `is_active`, legacy global role, and password mutations are platform-only; a school admin cannot deactivate a shared identity or reset another school's/global password. Reads return the current school's membership role. Dual-membership PostgreSQL regression confirms School A role changes leave School B membership and global identity fields untouched; existing cross-school denial and same-school user administration tests pass. | Implemented and merged in PR #28; DB regression and Vercel checks pass; independent review pending. |

**PR #28 validation record:** `npm test` passed (101 source/pure authorization/foundation
checks, using an inert loopback port-1 `DATABASE_URL`); `npm run typecheck` passed;
`npm run build` passed with the same inert URL. `npm run test:tenant-auth` passed against
throwaway embedded PostgreSQL (76 authorization, 17 catalog, 11 assignment/submission, and
21 dashboard-isolation checks); `npm run test:db` passed against disposable PostgreSQL,
including write-attribution and migration-0017 suites. At that earlier checkpoint, lint was
reported at 20 errors / 16 warnings in existing UI files. The current unmerged branch has since
repaired those errors; its latest lint result is recorded in the working-branch validation
section below. Build and database suites used no production database.

**Independent review:** still pending; no independent approval is claimed. Do not start Phase 3
until a reviewer other than the implementation pass reviews this repair and the production
verification gate is separately satisfied.

## Historical implementation continuation — explicit school selection, CI, and database defenses (2026-10-18; later merged through PR #32)

The working branch `arena/dc9adcab-easylearn` was based on main `8931095c5333e4f39f527d4520c0185805bf536f`. The school-selection/authentication tranche, required CI, migration 0018 and migration-runner history hardening were subsequently integrated through PR #32, merged at `90ec04363cbec3222232c6f912fcad69ab038dba`. PR #33 then merged test-database cleanup and LOW-1/2/3 follow-up at `851156cac0403f1b9e268c0c3584543852399c48`. These are repository/code and disposable-test results only: production migration and production behavior remain unverified.

### PR #30 self-review record

The full changed-file list and security-sensitive route changes were re-inspected, including login/selection/switching, signed v3 school/membership hints, required-selection guards, membership revalidation, role derivation, assignment/submission/grade/correction paths, parent links, dashboards, user membership roles, and legacy `school_id` fallbacks. Cross-school identifiers are constrained by the selected context and parent-anchor predicates; correction question joins are tied back to the requested assignment. Disposable PostgreSQL tests cover dual-membership users, switching, stale/revoked/mismatched hints, disabled memberships, non-member selection, assignment/question isolation, and data paths. **No additional confirmed PR #30 authorization defect was found during this self-review.** This is implementation-agent self-review only; it is not independent review or a security certification. Keep the independent review gate open.

### Repository-only Phase 2 work added on this branch

- `0018_composite_school_foreign_keys.sql` adds 26 composite FKs among school-owned records. Catalog regression tests verify every constraint is present, validated, ordered as `(school_id, id)`, points at the intended unique parent index, and has the declared delete/update action. Cross-school inserts and legacy anomalies are rejected; a failure after earlier DDL proves the migration transaction rolls those constraints and the ledger entry back without changing the bad row. Timetable class deletion remains CASCADE; timetable subject/term/year and uploaded-file assignment links retain selective SET NULL while preserving `school_id`. This selective column-list syntax requires PostgreSQL 15+ (CI runs PostgreSQL 16; production version is not yet verified). Root and `drizzle/` copies are identical. Child-side supporting indexes are sparse outside existing assignment-file, attendance-class, and timetable-class indexes; this is a potential parent-delete/update performance risk, not a tenant-integrity bypass. Production review must assess table sizes, lock window, and index needs before any authorized application. User-valued membership FKs, legacy/JSON references, and RLS remain out of scope.
- `run-migration.js` now has a checked-in ordered allowlist, SHA-256 `easylearn_schema_migrations` ledger, checksum/drift and gap checks, one transaction per file, a PostgreSQL advisory lock, missing-file failure, and no broad duplicate-error skip. Disposable-PostgreSQL tests cover concurrent serialization, checksum drift, history gaps, per-file rollback/partial-failure recovery, sequential-prefix and explicit-confirmation baseline safety, and fail-closed behavior on an existing schema with no ledger. The baseline records an operator assertion only; it does not inspect or prove prior execution. The branch has not been used against production. Existing-production adoption requires independent catalog/data evidence and separately authorized operator action; it is not assumed from deployment status.
- The pre-existing 0015 backfill is a one-time migration and is not replayed on every runner invocation. Tests now distinguish exercising 0015 SQL on disposable fixtures from the production runner's correct ledger-based skip behavior. Application-created users are assigned to the caller's school by the existing users API.

### Focused migration / runner review findings

- A disposable PostgreSQL delete regression confirmed the initial 0018 `uploaded_files.assignment_id` composite `NO ACTION` FK conflicted with migration 0009's existing scalar `ON DELETE SET NULL`. Fixed 0018 to use `ON DELETE SET NULL (assignment_id)`; a regression now deletes the assignment and verifies the uploaded file remains, its assignment link clears, and its `school_id` remains unchanged. This needs PostgreSQL 15+; CI's PostgreSQL 16 validates the syntax, while the production server version remains an operator evidence item.
- All 26 constraint catalog entries are now asserted for ordered child/parent columns, validated state, target parent index, and delete/update actions. The 0018 failure test deliberately rewinds the composite constraints, triggers a later preflight failure, then proves earlier constraints, the ledger row, and user data roll back atomically. Runtime delete tests verify assignment-file SET NULL and timetable class CASCADE/optional-reference SET NULL without clearing tenant anchors; cross-tenant child updates are rejected.
- Parent-side `(school_id,id)` unique targets exist for all expected A-class parents. Child-side FK support is sparse; existing assignment-file, attendance-class and timetable-class indexes cover some relationships, while many child references lack an index beginning with the referenced key. This can make parent deletes/updates scan child tables. Before production application, an authorized reviewer/operator must assess relation sizes, query plans, required indexes, and the lock window: 0018 preflights and validates multiple relations in one transaction.
- Review identifies no other confirmed defect in this continuation, but this is still implementation-agent self-review, not independent review or a readiness certification.

### Current validation and external gates

All local PostgreSQL validation uses disposable databases with an inert `DATABASE_URL`; no production connection, data access/change, migration, secret, or deployment was involved. The focused tenant DB suite passes **30/30** and the migration 0017/0018 suite **18/18**, including action/order/catalog, DDL rollback, runner concurrency, checksum/gap, and baseline tests. Full local validation: `npm test` **101/101**; `npm run test:db` **153/153** across seven suites (30, 45, 17, 11, 11, 18, 21); `npm run test:tenant-auth` **129/129**; `npm run test:mutation` **7/7**; `npm run typecheck` and `npm run build` pass; `npm run lint` exits 0 with **0 errors and 15 warnings**; `git diff --check` passes. Pure suites/build used `DATABASE_URL=postgres://test:test@127.0.0.1:1/testdb`; DB suites used disposable PostgreSQL. At implementation commit `be85cd241acdd5f307b8c5516c5c9d31049c03af`, GitHub Actions PR run `39151002544` and push run `39150999381` both passed; Vercel Preview and Vercel Preview Comments passed (Preview target `https://vercel.com/shadrachampah123s-projects/easylearn/7BEjdLWMkgqbkFdzdQ3fCxQyRKkr`). These statuses are evidence for that implementation commit; check statuses again after any further source change. Branch-protection API remains inaccessible (403), so protections are unknown.

GitHub currently shows no submitted PR #30 review. A branch-protection API request returned 403 (`Resource not accessible by integration`), so required-review/check rules remain **unknown**, not absent. Do not merge or bypass any review/check. PR #28/#30 independent security review and the separately authorized, read-only production tenancy checkpoint remain outstanding. Do not start Phase 3 until both independent review and production verification are complete.

No production migrations, data repair, or deployment were initiated. Migration 0018 has not been applied to production. The read-only checkpoint now captures PostgreSQL version, intended deployment identity, migration-ledger presence and—only when present—recorded filenames/checksums, relevant schema/data consistency, and estimated affected-table sizes. It uses repeatable-read, read-only transactions and `ROLLBACK`; it does not create or baseline a ledger, and excludes application smoke tests that could have write side effects. Both SQL blocks were executed against disposable PostgreSQL 18 by the migration test suite. This verifies the procedure's syntax/read-only transaction behavior, not production state; independent review and production verification remain blocked.

## Phase status and commercial-launch work

**Gate notation:** I = implemented, M = merged, D = deployment record, DB = production migration,
V = production behavior verification. “Required” below refers to future work, not authorization
to execute it. Historical design-only subscopes were never all delivered merely because a
similarly named PR merged.

### 1. Critical Security & Access Control — **complete** (bounded Phase 1 scope)

- **Evidence/gates:** #16; I/M yes; D yes (above); migration artifacts 0011 attendance uniqueness
  and 0012 login attempts; DB not independently confirmed; V not independently confirmed.
  Role/relationship access, protected seed/register, password ownership, file access, rate
  limiting and security headers exist; current security/pure-auth tests pass.
- **Acceptance/dependencies:** preserve these controls across all later work and verify live
  role-denial/rate-limit/attendance behavior. No reimplementation of Phase 1 is queued.
  Cookie-only auth, CSRF, revocation and enterprise assurance remain explicit later scopes;
  “complete” here does not certify all security work or a penetration test.
- **Required:** no new deployment/migration for already merged work; production verification
  and confirmation of underlying DB prerequisites remain launch gates.

### 2. Multi-School / Multi-Tenant Architecture — **in progress**

| Subphase (actual delivery naming) | Status / evidence / gates | Outstanding scope, dependencies and acceptance | Required |
| --- | --- | --- | --- |
| **2A Foundation** | **complete** for schools + school_users, #17, 0013/14; I/M/D yes; DB reported, unverified; V unverified. | Unique school slug, multi-school memberships and lifecycle schema exist. Original proposed branding/support/audit tables and runner ledger did NOT ship; tracked below, not part of delivered foundation. | Verify live foundation; no duplicate implementation. |
| **2B Membership/auth** | **complete** for delivered membership backfill and DB-derived auth context, #18, 0015; I/M/D yes; DB reported, unverified; V unverified. | Active memberships re-read; token hints not authority. Original session revocation, cookie-only/CSRF scope remains below. Acceptance: existing CBISM users retain correct active memberships without widening access. | Verify production memberships/login; no new migration for delivered scope. |
| **2C Central authorization** | **complete** for delivered gates and route conversion/security fixes, #19; `src/lib/tenant.ts`; I/M/D yes, V unverified. | Preserve fail-closed role, relationship and tenant checks; rerun real two-school denial tests. No claim of comprehensive independent security certification. | Production verification; DB foundation prerequisite. |
| **2D Direct tenant data access** | **complete** for delivered 0016/schema/route isolation and filter-overwrite fixes, #20 (`c9adf6f` included); I/M/D yes; DB reported, unverified; V unverified. | Migration surface is **25 school-owned tables plus school_users**, not the historical “21” count. NOT NULL belongs to delivered 2E, not future 2D work. Acceptance: direct attribution/filtering and cross-school read/write denial hold. | Verify 0016 state and behavior; do not blindly execute. |
| **2E Write/DB/query hardening** | **in progress** overall; delivered slices complete in #21–25: write attribution, 0017, aggregate isolation, override scope, question-parent DELETE; I/M/D yes for those slices. DB reported, unverified; V unverified. PR #30 adds migration 0018 and runner/history hardening in repository only (unmerged/unverified). | Do not relist fixed dashboard/report/override/question gaps as unfixed. The 26 composite FKs have disposable-PG ordering/action/rollback tests; membership-valued FK coverage, audited legacy-fallback removal, full relationship reconciliation, child-side FK indexing, pool/RLS alternatives and production state remain open. The new ledger does not baseline legacy production automatically. Acceptance: no cross-school relational rows, zero required NULLs, constraint/isolation suites pass, verified operator migration history, PG15+ compatibility and planned lock/index window before further writes. | Independent review and production read-only evidence first; no migration/deployment authorization implied. |
| **2F CBISM production reconciliation** | **blocked** on independent production evidence, not known missing execution. | Reconcile actual catalog, FK validation/indexes, required NULL counts, orphan and cross-school relationships against 0016/17 and intended build. Preserve allowed platform activity NULLs. Require backup/restore rehearsal before any separately approved remediation. | Read-only verification now; controlled migration only if a proven gap is later authorized. |
| **2G Isolation testing / launch hardening** | **In progress.** Full local test matrix passes; at implementation commit `be85cd2`, required Actions push/PR workflows and Vercel Preview checks passed. | Branch workflow runs npm test, DB, tenant-auth, mutation, typecheck, build, lint and production audit against disposable PostgreSQL. Require successful checks for any later source changes and verified branch-protection enforcement; complete independent review and authorized production smoke evidence. | Branch-protection lookup remains 403/unknown; independent review and production verification still block merge/Phase 3; no production fixtures.
| **Tenant selection (original proposed 2E)** | **In progress; explicit membership-validated account picker and in-session switch are implemented on the current unmerged branch.** No host-resolved tenancy is implemented. | Branch introduces v3 signed school/membership hints revalidated from active DB memberships, no automatic first-school selection for multi-school users, `/api/auth/select-school`, login picker, and dashboard switcher. Tests cover forged/non-member selection, disabled selected membership (no fallback), and valid dual membership. Independent review, merge/required CI, staging/production behavior and any trusted-host/custom-domain cross-check remain outstanding. | Do not claim deployed or verified. Finish review/CI; production verification remains read-only and separately authorized. |
| **DB defense-in-depth** | **Partially implemented on unmerged PR #30:** 26 composite FKs for direct school-owned parent/child relationships, covered by disposable PostgreSQL negative/rollback tests. Not deployed or production-verified. RLS and user-valued membership FKs remain not started. | Validate legacy relationships before any authorized application; extend membership/role invariants without blocking legitimate multi-school users. Prove transaction-scoped RLS safe under Neon pooling or document an approved alternative. Never infer RLS from application predicates. | Independent review, clean production read-only evidence, then separately authorized migration/deployment and post-check. |
| **Session security** | **not started** for cookie-only/CSRF/revocation completion. | Replace localStorage bearer flow safely, session invalidation/password-change behavior, secure cookie and CSRF tests. Preserve current auth gates. | Deployment, possible session schema migration, production verification. |
| **Tenant branding/storage/support/audit** | **not started** for complete designed scope; existing file authorization, object storage and activity logs are implemented baselines. | Dynamic branding/public tenant content and metadata; school storage namespace/quotas and lifecycle; immutable school/platform audit attribution; expiring, explicit audited support access instead of implicit platform bypass. Decide global gamification data-sharing policy (currently intentional global totals). | Schema migrations as designed + deployment + isolation/operational verification; branding UI also Phase 3. |

**Numbering reconciliation:** original §21 below proposed 2D constraints / 2E resolution;
actual PRs used 2D direct access and 2E hardening. The table above is authoritative. Original
2F/2G acceptance still applies; shipped DB and isolation tests are credited, not queued anew.

### 3. School Management & Administration — **in progress** (legacy baseline; SaaS scope not started)

- **3A Existing school operations — in progress:** users/roles, classes/departments/subjects,
  academic years/terms, enrollment, parent links and teacher allocations already exist and are
  tenant-aware (#19/20). I/M/D yes for baseline; DB/V unverified. Do not rebuild them.
- **3B Commercial school lifecycle — not started:** platform school onboarding/provisioning,
  invitations and membership administration, suspension/reactivation, per-school settings,
  branding, import/export and safe offboarding/retention controls. No complete platform admin flow found.
- **Acceptance/dependencies:** Phase 2 reconciliation/isolation/selection gates before onboarding
  independent schools; prove two schools can be provisioned and administered independently, with
  no global identity destruction when removing one membership.
- **Required:** new workflows need code deployment, school/settings/lifecycle migrations where
  necessary and verified admin/role E2E tests; legacy baseline needs production verification.

### 4. Academic & Results Management — **in progress**

- **4A Learning delivery — in progress:** assignments/submissions, quizzes, resources, attendance,
  timetable, teacher grading and EasyAI exist (including #10–15, then tenant hardening #19–25).
  I/M/D baseline yes; migration artifacts through 0017; DB/V unverified.
- **4B Complete academic outcomes — not started:** configurable grading/scales and curriculum,
  assessment weighting, moderated/approved result publication, term/year report cards,
  promotion/rollover and historical records. Existing grades/reports do not prove this complete.
- **Acceptance/dependencies:** tenant baseline plus school-specific configuration; deterministic
  calculations, permissions, result visibility, cross-year history and rollover tested; validate
  AI privacy/accuracy/human review before commercial reliance.
- **Required:** deployment, academic schema migrations for new workflows, production verification;
  retain already implemented learning features rather than list them as missing.

### 5. Communication & Notifications — **in progress**

- **5A In-app communication — in progress:** announcements, direct messages, notifications and
  parent dashboards exist; tenant/aggregate fixes merged and deployed (#19–25); DB/V unverified.
- **5B Delivery operations — not started:** reliable queued email/SMS/push as selected by product,
  preferences/consent, retries, delivery status, provider limits and tenant-safe templates/audience.
- **Acceptance/dependencies:** prove intended audience only, no cross-school recipients or
  attachments, idempotent delivery and opt-out handling; depends on tenant selection and privacy policy.
- **Required:** deployment and delivery/job/preference migrations as needed, provider configuration
  outside this audit, staging and production delivery verification without unsolicited messages.

### 6. Reports, Documents & Analytics — **in progress**

- **6A Existing reports — in progress:** `/api/reports`, `/api/learner-reports`, grades, dashboard
  metrics and learner stats exist; #24/25 isolate multi-school aggregates. I/M/D yes; DB/V unverified.
- **6B Commercial document/analytics suite — not started:** branded validated report-card PDFs,
  permissioned exports, attendance/academic trend definitions, audit/export history and tenant-safe
  scheduled generation. Existing on-screen reports are not proof of this scope.
- **Acceptance/dependencies:** approved academic formulas (Phase 4), branding, accessible documents,
  reproducible totals and two-school export/scheduled-job denial tests.
- **Required:** deployment, document/job/schema migrations if introduced, production verification.

### 7. SaaS Billing & Subscriptions — **not started**

- **7A Plans/entitlements — not started:** no subscriptions/billing schema or complete billing API
  found; school limits, trials, entitlement model and grace/suspension policy need definition.
- **7B Payments/reconciliation — not started:** provider selection, verified idempotent webhooks,
  invoices/receipts, renewals/cancellation/refunds, taxes/currency and reconciliation.
- **Evidence/gates:** no implementation/merge/deployment/DB/production verification evidence for
  this scope. School records or a role enum are not billing capability.
- **Acceptance/dependencies:** Phase 3 lifecycle; sandbox payment and replay/failure tests, accurate
  tenant ledger and enforcement without destructive data loss. No payout/payment actions in audit.
- **Required:** reviewed migrations, application deployment and separately authorized provider/live verification.

### 8. UI/UX, Mobile, Performance & Reliability — **in progress**

- **8A Baseline — in progress:** role dashboards, responsive UI, PWA assets and resilient schema
  handling exist (README, `public`, `src/app`); I/M/D baseline yes, V unverified.
- **8B Commercial UX — not started:** remove CBISM-only identity from shared entrypoints,
  tenant picker/context visibility and branding, accessibility audit, onboarding, empty/error states,
  browser/device QA and safe offline/logout behavior (including cache isolation).
- **8C Performance/reliability qualification — not started:** tenant-sized load budgets, query/index
  review, connection saturation, job reliability and measurable service objectives; fix lint baseline.
- **Acceptance/dependencies:** depends on Phase 2 context and Phase 3 branding; measured accessibility,
  mobile/caching and load results with zero cross-account/school cache leakage.
- **Required:** deployment + device/load/production verification; performance migrations only after measurement.

### 9. Testing, Production Hardening & Enterprise Readiness — **in progress**

- **9A Automated assurance — in progress:** current 101 non-DB checks/typecheck pass; DB/mutation
  suites implemented and PR-reported green. Lint fails; no Actions enforcement. Add reproducible
  build/lint/test/security/dependency checks and browser E2E with actual non-skipped DB coverage.
- **9B Operations/security readiness — not started** as an evidenced release program: backup and
  timed restore drills, migration/rollback rehearsals, monitoring/alerts, incident response,
  audit retention, secret rotation/session revocation procedures and independent penetration review.
- **9C Enterprise/commercial readiness — not started:** privacy/data-processing terms, school data
  ownership/export/deletion/retention, support/SLA/runbooks, safeguarding and vendor/data residency
  review, quotas/abuse response and a controlled two-school pilot sign-off.
- **Evidence/gates:** code/test baselines merged/deployed; no independent end-to-end production
  acceptance evidence found. Dependencies are all earlier launch gates; no invented compliance certification.
- **Acceptance/required:** required CI green including lint, documented DB/build identity and isolation
  proof, recovery exercises and pilot acceptance before general availability. Deploy operational changes;
  migrations only for reviewed supporting schema, never as an audit side effect.

## Single next action — independent security re-review of PR #69, then the read-only production tenancy checkpoint

**Updated 2026-11-19, after the independent review and the H-R1 fix.** Two actions are outstanding, and only the first needs no production access:

1. **Commission an independent security re-review of PR #69 (H-1 + H-R1 + M-R1 + M-R2 + M-R3 + M-R4a), then merge only if it passes.** The PR is covered by two regression suites (**54 assertions**, both green locally) whose new tests were validated against the vulnerable code — against `5b8fbd1` the database suite fails 6 and the policy suite fails 9, with the failure messages carrying the measured bypasses. It is **not approved for merge** by this roadmap: every fix was written by the same author as the original change, so an independent reviewer must confirm it. The **M-R4 gate is answered** (table present, `neondb_owner`, `CREATE` on `public`, `AUTO_SCHEMA_REPAIR` absent ⇒ enabled) with one qualification the reviewer must carry forward: **runtime repair has never been exercised in Production**. Merging into `main` is expected to deploy to Production. The work touches no migration 0018, no database, no Production setting, and no backup/DR.
2. **Request an authorized, read-only production tenancy verification checkpoint** for the intended
   Vercel project/alias (identity confirmed 2026-11-19: project `easylearn`, `4069584`, deployed
   2026-11-17) and migrations 0013–0017. Capture timestamped sanitized build identity,
   column/nullability/catalog FK/index evidence, required NULL/orphan/cross-school counts and
   post-repair role/dual-school smoke-test results. Establish the actual production state before
   planning any execution. Then rehearse migration 0018 and the separate child-side-index plan on a
   restored production copy — noting that restore capability is **unverified while backup and
   disaster recovery stay paused**, so that rehearsal needs the DR workstream to resume first.
   If production is missing/partial, stop and prepare a separately approved,
   backup-rehearsed remediation; do not blindly rerun migrations. No production migration or deploy
   is authorized by this roadmap update.

---

# Historical Phase 2 Architecture Audit (2026-09-11)

**Archive, not current status:** the following records the original findings and design rationale.
Present-tense “no school”, proposed migration numbering and original phase sequence refer to
that audit date only. Use the current roadmap above for shipped scope and outstanding work.

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
   deployment; a new request-handler file parses `host`, resolves slug → `schoolId`, and
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
- A request-handler file (now `src/proxy.ts` in Next.js 16) does **routing only**
  (host → school attach), never authorization —
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
(cookie fetch wrapper) · `src/proxy.ts` (host → school, NOT implemented) · `src/db/schema.ts`
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

---
