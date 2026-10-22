# EasyLearn PR #45 — security review

**Date:** 2026-10-21 (Africa/Accra / UTC)

**Reviewed commit:** `a4fbc401e8c1e64d653ba47a814a6fb8c487b0d1`

**Recommendation: CHANGES REQUIRED before the stack advances toward `main`.**

PR #45 is already merged into an intermediate security branch. This review performed no merge, deployment, push, production access, or application fix. The intended F1/F2/F5 changes pass their committed tests, but the actual tree still has confirmed authorization and grading defects. One new test-runner defect also makes a setup failure falsely successful.

## 1. GitHub state and ancestry — verified, not inferred

[PR #45](https://github.com/shadrachampah123/easylearn/pull/45)

| Item | Observed value |
|---|---|
| Head branch | `security/pr45-release-blocker-remediation` |
| Head SHA | `a4fbc401e8c1e64d653ba47a814a6fb8c487b0d1` — matches the requested commit |
| PR base branch | `security/pr44-csrf-proxy-trust` |
| Base at merge / sole parent of head | `8bb611b5f6eb3559b41d9033bc9cbaf078f6cee6` |
| State | **MERGED**, at `2026-10-21T06:53:27Z` |
| Merge commit / current base-branch tip | `5bc889b8784f4f902d23e400f20a0988567a384c` |
| Mergeability | GitHub returns `UNKNOWN` / REST `null`; not an actionable mergeability decision for an already-merged PR |
| Main branch tip | `016d229183cb615980992178869bb5b17e42962f`; this remediation is not on `main` |
| Reviews | No submitted reviews, latest reviews, or review requests returned by GitHub |
| Changed files | 12: nine modified, three added; 1,256 additions / 58 deletions |

The merge commit has **both** expected parents: `8bb611b…` and `a4fbc40…`. Its tree is identical to `a4fbc40…` (`git diff --exit-code` returned 0). There is exactly **one** commit in `8bb611b… .. a4fbc40…`.

The current PR-base chain is:

```text
#45 → #44 → #43 → #42 → #41 → #40 → main
```

PRs #38 and #39 also target `main`, not each other. Their commits are ancestors of #40 and #45. Thus the earlier description of a uniformly stacked “#38–#44” chain was imprecise, but **PR #45 did not flatten or rebase that history**. Ancestry checks returned exit 0 for all of these ancestors of `a4fbc40…`:

```text
main  016d229183cb615980992178869bb5b17e42962f
#38   15c6cc8ed3b0cefbbd31ed0e19b0523378fc6b8e
#39   3e7b3114fa05798a07b3358f71c3c698dcad1830
#40   d2d05d86ef34810cd84867908665adf2510ef663
#41   c834c2e3b6f3d5988922109deb10222b3103d2cd
#42   0403a4c6dd5c378cba875de2b3fbaa638e027e53
#43   0f9fcdb1d8d008d94a34b133022622c92c7408b6
#44   8bb611b5f6eb3559b41d9033bc9cbaf078f6cee6  (pre-merge tip)
```

### Recorded CI

[GitHub Actions run 39557273028](https://github.com/shadrachampah123/easylearn/actions/runs/39557273028) reports `headSha=a4fbc401…`, event `pull_request`, conclusion **success**. The quality job completed in 2m28s, with its audit, unit/authentication, TLS, database, tenant, mutation, integration, integrity, typecheck, build and lint steps all successful. The Vercel and Vercel Preview Comments check contexts also report success.

GitHub verification commands (each exit **0**):

```bash
gh pr checks 45 --repo shadrachampah123/easylearn
gh run view 39557273028 --repo shadrachampah123/easylearn --json headSha,headBranch,status,conclusion,event,jobs,url
gh pr view 45 --repo shadrachampah123/easylearn --json number,state,baseRefName,headRefOid,mergeable,mergeStateStatus,mergedAt,mergeCommit
```

This is GitHub check/run metadata, not independent verification of deployed applications. One Vercel bot comment still describes a second project as “Building”; that comment is not proof of its current deployment state. No Vercel deployment endpoint was tested here.

## 2. Confirmed findings, by severity

All line numbers below refer to **`a4fbc401…`**, not the older working checkout. “Inherited” means the same scenario was reproduced against the exact base commit `8bb611b…`; it is not attributed to newly added lines in PR #45.

### R1 — HIGH · Confirmed · Inherited: quiz tenancy follows memberships instead of the stored tenant

**Locations:** `src/lib/tenant.ts:747–756,858–860,1100–1104`; `src/app/api/quizzes/[id]/route.ts:64`; `src/app/api/quizzes/route.ts:66–73`.

`sqlQuizInSchool()` uses the teacher/class-membership relationship graph. It does not enforce the quiz's stored `school_id`. Meanwhile the list route and `isQuizInSchool()` prefer the direct school ID. These are inconsistent authorization decisions.

**Reproduced with the full disposable migration chain, including composite foreign keys:**

1. Create a School A draft, class and subject, with a teacher initially active only in A. School B's administrator initially receives 404.
2. Disable that teacher's A membership and add an active B membership. Do not change the quiz/class/subject tenant IDs.
3. School B's administrator can now GET the School A draft: **200, with its answer key**. The quiz still has `school_id=A`.

There is also a legitimate-workflow failure: simply adding a second active membership to an enrolled learner or a quiz-owning teacher makes the relationship graph ambiguous. The selected-school list still includes the quiz, but detail returns **404**; learner start returns **404** too. Both single-school cases worked before adding the second membership.

**Proposed narrow first fix:** enforce the stored quiz tenant before returning or mutating the record in every path; a direct tenant mismatch must never be overridden by membership changes. Separately settle direct-vs-relational ownership for legitimate dual members and legacy rows. Do **not** simply replace the predicate and discard existing M2/M5 assertions to get a green result. Preserve their protection and add load-bearing coverage for both membership transfer and dual-member workflows. No attribution change was implemented in this review.

### R2 — HIGH · Confirmed · Inherited: a demoted owner retains quiz write/delete authority

**Locations:** `src/app/api/quizzes/[id]/route.ts:155–169,302–318`.

PUT and DELETE allow historical `teacherId === ctx.userId` without requiring a current staff role. Membership revalidation alone does not fix this.

**Reproduced:** change an owning teacher's membership role to `parent` and reuse their token. Draft GET correctly returns **403** under PR #45's new read policy, but PUT returns **200** and publishes the draft; DELETE then returns **200** and removes it. Thus the current database role is being read correctly, but the write gate ignores it for owners. This is not an F3/token-revocation issue.

**Proposed narrow fix:** require a current staff role for both write methods, then apply the existing owner-or-school-admin rule. Preserve the existing distinction that a non-owning head teacher may read, but not edit/delete, another teacher's quiz.

### R3 — MEDIUM · Confirmed · Inherited: concurrent submissions award points twice

**Locations:** `src/app/api/quizzes/[id]/attempt/route.ts:140–152,238–274`.

The incomplete-attempt check and the update are separate operations. The update is scoped only by attempt ID, without `completed_at IS NULL`, and notification/point writes are not in a transaction with an exclusive completion decision.

**Reproduced:** two requests submit the same valid attempt. A real PostgreSQL row lock provides a deterministic scheduling barrier; no application query is mocked. Both requests return **200**, creating **two point rows and two notifications** for one completion.

**Proposed narrow fix:** atomically claim the incomplete attempt using a tenant/user/quiz-scoped conditional update or row lock. Only the winning transaction may insert its notification and points. Keep those writes in the same transaction, and reject/handle the losing request without additional rewards.

### R4 — MEDIUM · Confirmed · Inherited: a blank fill-in answer earns full credit on submit

**Locations:** `src/app/api/quizzes/[id]/attempt/route.ts:194–207`; compare `src/app/api/quizzes/[id]/check/route.ts:107–120`.

A whitespace string is truthy before normalization. After trimming it to an empty string, `normalizedCorrectAnswer.includes("")` is true. The check endpoint, unlike submit, requires a non-empty normalized answer.

**Reproduced:** the same blank answer yields `check.correct=false`, then submit gives **score 1/1, 100 reward points, and one point row** on a one-question fill-in quiz.

**Proposed narrow fix:** reject an empty normalized answer before comparison in submit, using the same non-empty rule as check. Test whitespace and empty/non-string values without broadening the accepted grading rules.

### R5 — MEDIUM · Confirmed · Introduced in PR #45: quiz test setup errors can exit successfully

**Location:** `tests/quiz-access-db.test.ts:581–600`.

The catch block sets `process.exitCode=1`, but the later `process.exit(failed > 0 ? 1 : 0)` overrides it. A migration/setup error before any individual assertion leaves `failed=0`.

**Reproduced:** a child-process preload makes only the test runner's migration subprocess report a controlled failure. The suite prints the migration error, executes **zero assertions**, cleans up, then exits **0**. The supplemental regression correctly fails with exit **1** because it expects a nonzero child exit.

**Proposed narrow fix:** preserve a fatal setup error in the final exit decision (or remove the explicit success exit), and keep a subprocess regression proving setup failures fail CI. Also use `finally` for temporary enrollment/publication changes in the existing suite: assertions at lines 449/473 currently precede restoration at 456–459/480, so a failed case contaminates subsequent cases. Do not weaken any authorization assertion.

### R6 — MEDIUM (workflow) · Confirmed · Inherited: one-attempt quizzes cannot resume

**Location:** `src/app/api/quizzes/[id]/attempt/route.ts:62–90`.

The max-attempt check counts an incomplete attempt and rejects the request before reaching the resume branch.

**Reproduced:** with `maxAttempts=1`, first start returns **201**, immediate resume returns **400** instead of returning the existing attempt. The committed tests use `maxAttempts=3`, masking the default one-attempt workflow failure.

**Proposed narrow fix:** after current authorization checks, resume an existing incomplete attempt before enforcing the cap on creation of a new attempt. Retain tests for exhaustion and concurrent starts; do not relax the cap itself.

### R7 — LOW (validation) · Confirmed · Inherited: M6 is an invalid-SQL mutant

**Locations:** `tests/tenant-authorization-mutation.test.ts:168–172,214–222`.

M6's replacement inserts `// MUTANT M6: …` **inside** an SQL template. PostgreSQL rejects it with SQLSTATE **42601**, `syntax error at or near "M6"`. The runner nevertheless reports M6 killed because it accepts a nonzero suite result plus any failing assertion. This makes the unqualified “six mutations killed” claim misleading.

**Reproduced:** an added validity regression extracts the actual M6 replacement and executes it against a temporary table on the disposable server. It fails with 42601 on both the PR head and the base. A positive control using an SQL-style comment succeeds.

For independent confirmation, a separate throwaway export applied the **same guard removal**, changing only the injected comment from `//` to `--`. The unchanged `tests/tenant-authorization-db.test.ts` then exited **1**, with **75 passed / 6 failed**, including actual cross-school reads changing from expected 404 to 200. No SQL syntax error occurred. Thus the existing assertions do catch the intended guard removal when M6 is syntactically valid; the committed mutation runner still needs repair.

**Proposed narrow fix:** make the injected comment valid SQL and distinguish a meaningful authorization assertion failure from an invalid mutant/runtime failure. Keep every original assertion. The original harness and PR-head application were not changed by this review; the semantic mutation was confined to a separate export.

## 3. What the quiz and CSRF review did establish

### Quiz authorization

- `src/lib/quiz-access.ts:92–138` fails closed for unknown roles, unpublished learner/parent reads, unenrolled learners, and non-owning teachers. Staff answer-key permission is explicit.
- `isLearnerEnrolledInClass()` (`:149–168`) checks learner, class **and selected school**, with UUID validation. A second school's enrollment does not satisfy it. The helper itself is not the cause of R1.
- List GET scopes learner enrollment to the selected school and filters parents to published quizzes. Detail GET redacts `correctAnswer` for both learners and parents.
- Start/check/submit require the current membership role to be `learner`. Submit now rechecks publication and enrollment before reading questions or writing results. Check validates quiz, question, attempt ownership and incomplete status before feedback.
- Added controls verified same-school non-owner teacher denial; head-teacher/admin reads; parent list and all parent attempt/check/submit denials; wrong attempt owner/question IDs; and de-enrollment/unpublication. Denials left attempts incomplete and produced no points, notifications, or answer-key disclosure in these cases.
- `showResults=false` withheld `correctAnswer` in check and submit responses in the tested normal flow. `showResults=true` intentionally permits learner feedback; “learners never receive answers” is not a correct description of the entire API.
- Quiz creation already requires staff and validates the target class. Tenant consistency of subject/term references additionally relies on the composite foreign keys in migration 0018. Tests used that migration; the deployed schema was not inspected.
- The advertised “single policy decision point” is overstated: only detail GET calls `evaluateQuizReadAccess`; list/start/check/submit still contain separate rules and share the enrollment helper. No broad refactor is proposed here.

### Credential selection and CSRF

**Locations:** `src/lib/auth.ts:186–196`; `src/lib/session-cookie.ts:23–59`; `src/lib/csrf.ts:497–502,518–604`; `src/proxy.ts:34–51`.

- Auth chooses a non-empty, exactly cased `Bearer ` header first, then the first matching `el_token` cookie. Invalid selected bearer tokens do not fall back to the cookie after JWT verification.
- CSRF uses a broader, case-insensitive bearer regex. That mismatch remains, but the added presence check prevents the dangerous cookie-fallback case from being exempted. A malformed/lowercase/tab-separated bearer without a cookie selects no usable auth credential; real HTTP requests were refused with 401.
- `hasSessionCookie()` and `readSessionCookie()` share the same cookie-name pattern. Duplicate cookies select the first value for auth; an empty or malformed first value does not fall through to a later one. Presence remains true, so none of these requests gains the bearer exemption.
- Cookie-plus-bearer requests were refused with 403 for a foreign/null Origin, absent metadata, and absent Origin with `same-site` or `cross-site` Fetch Metadata. With no Origin, `same-origin` and `none` remain allowed by the documented policy; this is not “all missing-Origin requests are refused.”
- Same-origin mixed-credential traffic passed the proxy. Bearer-only traffic retained its exemption. Empty/unusable session cookies deliberately remove that exemption too; non-browser clients carrying a cookie jar must omit the cookie or supply acceptable origin evidence.
- Default-mode forged forwarded hosts did not authorize a foreign Origin. Derived-scheme same-origin recovery worked only under its intended metadata conditions; a configured public origin remained exact in policy tests.
- Proxy refusals had `Cache-Control: no-store`, without credential values in the response. The actual production Next build included and exercised the `/api/:path*` proxy.

**No CSRF/authentication bypass was reproduced at this PR head.** Synthetic HTTP requests are not a substitute for a real-browser cross-site/CORS deployment test.

## 4. Validation: exact commands, exit codes, results

### Isolation and environment

The assigned branch remained `arena/7d4511bc-easylearn`. Its pre-existing working changes were preserved byte-for-byte. No branch switch or new branch was used. Review/testing used these exports:

```bash
git fetch --no-tags origin refs/pull/45/head refs/heads/security/pr44-csrf-proxy-trust refs/heads/main
git archive a4fbc401e8c1e64d653ba47a814a6fb8c487b0d1 | tar -x -C .arena/pr45-review/head
git archive 8bb611b5f6eb3559b41d9033bc9cbaf078f6cee6 | tar -x -C .arena/pr45-review/base
```

Each command completed with exit 0. The base comparison reused the installed head dependencies; the lockfile has no PR #45 changes. After validation, **all 290 committed files in the head export matched their Git blob hashes**. Build-generated `next-env.d.ts` was restored in the export only. Supplemental test files are additional files, not modifications to the committed tests or application.

PostgreSQL **16.14** came from the locked optional embedded binary package and ran locally with a throwaway data directory. Tests created scratch databases and applied their migrations only there. Test environment (not production configuration):

```bash
export TEST_DATABASE_URL='postgres://easylearn_test@127.0.0.1:5432/postgres'
export DATABASE_URL='postgres://test:test@127.0.0.1:1/testdb'
export JWT_SECRET="$(openssl rand -base64 48)"
export EASY_LEARN_REQUIRE_TLS_E2E=true
export EASY_LEARN_REQUIRE_ASSIGNMENT_PREREQ=true
export EASY_LEARN_REQUIRE_SCRATCH_DB_LIFECYCLE=true
export EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true
export NEXT_TELEMETRY_DISABLED=1
```

Database npm scripts set `EASY_LEARN_TEST_DATABASE=true` themselves; direct supplemental DB/harness invocations also exported it explicitly. No production credentials were loaded.

### Original PR-head checks

Executed from `.arena/pr45-review/head`:

| Command | Exit | Actual result |
|---|---:|---|
| `npm ci` | 0 | Locked dependencies installed |
| `npm run security:check-secret` | 0 | Fresh disposable secret satisfies policy |
| `npm audit --omit=dev --json` | 0 | Zero production vulnerabilities reported |
| `npm run test:all` | 0 | Every included suite ran; no skips |
| `npm run test:quiz-access` | 0 | 17 passed / 0 failed, also rerun separately |
| `npm run test:csrf-credentials` | 0 | 14 passed / 0 failed, also rerun separately |
| `npm run test:mutation` | 0 | Runner reports 8/8 (baseline, six mutants, restoration); **M6 is invalid SQL — see R7 and the separate valid-M6 probe** |
| `npm run typecheck` | 0 | No TypeScript errors |
| `npm run lint` | 0 | 0 errors / 13 warnings in unchanged files |
| `npm run build` | 0 | Successful production build, proxy included |
| `git diff --check 8bb611b5f6eb3559b41d9033bc9cbaf078f6cee6 a4fbc401e8c1e64d653ba47a814a6fb8c487b0d1` | 0 | No committed whitespace errors |

Within `test:all`, the CSRF policy suite passed 49, tenant authorization passed 81, membership auth passed 48, and real PostgreSQL TLS end-to-end passed 7. The full-suite log contains an intentionally injected cleanup-error message from the scratch-lifecycle tests; that suite itself passed 7/7. The unrestricted dependency installation reported 13 advisories, but the separate production-only audit was clean; dependencies were not upgraded.

### Additional tests for actual gaps

The five reviewer-authored reproductions now live permanently in `tests/` and run in CI. They
were originally delivered out-of-band as `docs/reviews/pr45/additional-tests.patch`; that patch
has been applied and deleted so the coverage cannot drift away from the code it checks.

| File | Scope | CI |
|---|---|---|
| `tests/pr45-review-db.test.ts` | R1, R2, R3, R4, R6 — live PostgreSQL, real route handlers, 14 cases | **required** |
| `tests/pr45-review-mutation.test.cjs` | R7 — the M6 mutant must be executable SQL | **required** |
| `tests/pr45-review-harness.test.cjs` | R5 — a failed setup must exit nonzero | **required** |
| `tests/pr45-review-csrf.test.ts` | credential/CSRF edge cases (24 cases) — runs in its own process | **required** |
| `tests/pr45-review-http.test.cjs` | the same CSRF policy through a real `next start` server (20 cases) | **not in CI** — needs a built app |

Required coverage runs as `npm run test:review-pr45` in the
`PR #45 reviewer regressions (PostgreSQL required)` CI step. `npm run test:review-pr45-http` is
a deliberate manual run; it has not been validated in CI and is not claimed to be.

**One assertion was adopted, not copied.** The R3 concurrent-submission case originally required
that exactly one of the two responses be HTTP 200. That contradicts the documented idempotent
replay contract (see `README.md`, "Repeating a submission"): a repeat of a completed submission
answers 200 with the persisted grade and `alreadySubmitted: true`. The case now asserts that both
statuses are 200 **and** that exactly one response carries `alreadySubmitted: false` and exactly
one `true`, then that only one points row, one notification and one completed attempt exist. The
security property under test — a single award — is unchanged; only the transport expectation was
corrected to match the contract.

The original reviewer results at `a4fbc401` are retained below for the record. They describe the
state *before* the remediation and are not the current CI expectation.

| Command (at `a4fbc401`) | Exit | Actual result |
|---|---:|---|
| `npx --no-install tsx tests/pr45-review-db.test.ts` | **1** | **7 passed / 7 failed**; the failures reproduce R1–R4/R6, including both dual-member cases |
| `npx --no-install tsx tests/pr45-review-csrf.test.ts` | 0 | **24 passed / 0 failed** |
| `node --test tests/pr45-review-harness.test.cjs` | **1** | **0 passed / 1 failed**; detects the erroneous child exit 0 in R5 |
| `node --test tests/pr45-review-http.test.cjs` | 0 | **20 passed / 0 failed**, real Next HTTP proxy |
| `node --test tests/pr45-review-mutation.test.cjs` | **1** | **0 passed / 1 failed**; detects M6's invalid SQL in R7; same result on the base |

The HTTP probe used `npm run start -- --hostname 0.0.0.0 --port 3015`, with a disposable secret
and `EASY_LEARN_TEST_DATABASE=true`. It sent only synthetic invalid credentials to `/api/quizzes`;
403 indicated proxy rejection, while 401 indicated passage to authentication. It did not exercise
production accounts. Temporary servers were stopped after the review.

**The red tests were findings, not successful security checks.** No assertion was relaxed to make
them pass; the single R3 transport expectation was corrected against a documented contract.

### Base comparison and corrections to the earlier report

The same supplemental DB test file was run against `8bb611b…` with only the inherited scenarios selected:

```bash
PR45_REVIEW_FILTER='multi-school|moving a teacher|demoted|one-attempt|concurrent|blank fill-in' \
  npx --no-install tsx tests/pr45-review-db.test.ts
# exit 1: 0 passed / 7 failed; the same inherited behaviors reproduced
```

The two original new regression files were also copied unchanged into the base export and run:

```text
npx --no-install tsx tests/quiz-access-db.test.ts
  exit 1: 8 passed / 9 failed
npx --no-install tsx tests/csrf-credential-consistency.test.ts
  exit 1: 5 passed / 9 failed
```

These are **not** the earlier reported 11/17 and 10/14 failures. Some quiz failures cascade because restoration is after a throwing assertion; for example, the base run's mid-game test sees a quiz left unpublished, rather than independently demonstrating the enrollment flaw. The new review cases use separate fixtures for the reported application findings.

The original quiz suite also has **no dual-school fixture**, and its “non-owner teacher” case is a teacher from a different school. It does not establish same-school ownership or dual-member compatibility. Those gaps were exercised separately in this review.

## 5. Potential / unverified issues and scope boundaries

- **Potential · Medium · Assessment policy:** `/check` returns a correctness boolean repeatedly without persisting a per-question decision (`src/app/api/quizzes/[id]/check/route.ts:106–148`). For a high-stakes assessment, an enrolled learner could use that as an answer oracle even with `showResults=false`. Instant feedback is explicitly intentional for the Kahoot flow, so changing that behavior needs a product/security decision; it is not asserted here as a newly introduced authorization defect.
- **Potential · Low · Parent-scope decision:** `src/lib/quiz-access.ts:126–130` permits parents to read any published quiz admitted by the school gate, not only a linked child's class. That matches this PR's stated F2 scope, but a child-linked-only requirement would need a separate authorization rule. Parent draft/key access is not permitted by the new read policy.
- **Unverified · Deployment-dependent:** production migration state, reverse-proxy header sanitation/public-origin configuration, real-browser CORS behavior, and real-provider object-storage/SigV4 behavior were not inspected. No production access or configuration changes were attempted.
- **F3 remains out of scope.** No token version, revocation table, logout, password-change or session-invalidation implementation was added. The existing quiz auth gate already checks `users.isActive` on each request (`src/lib/tenant.ts:325–327`); a blanket claim that deactivated users can continue using these quiz routes would be inaccurate. This is not a claim that copied tokens are permanently revoked.

## 6. Delivery and recommendation

Reviewed all changed source files: the four quiz route modules, `quiz-access.ts`, `session-cookie.ts`, `csrf.ts`, and `proxy.ts`, plus `package.json` and all three changed/added test files. Also traced the relevant unchanged auth, tenant, schema and migration code.

Only this report and a test-only patch are added to the assigned branch's working tree. The original working changes are preserved. There were **no commits, pushes, merges, deployments, production migrations, production data operations, production configuration edits, or production-secret changes** in this review.

**Recommendation: CHANGES REQUIRED.** Fix R5 in the focused remediation's test coverage and repair the invalid M6 mutant (R7). Address the inherited high-severity R1/R2 findings and grading-integrity defects R3/R4 before promoting the stack. Preserve all original assertions and mutation protections, add the reproduced cases, and rerun independent review after the narrow fixes. Green existing CI is not sufficient evidence that this tree is safe to advance to `main`.
