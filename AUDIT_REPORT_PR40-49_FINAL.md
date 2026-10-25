# EasyLearn Security Audit — PRs #40, #41, #42, #43, #49 (Reconciled)

**Date:** 2026-10-25 (UTC)  
**Auditor:** Arena Agent (isolated worktree `security/audit-pr40-49-final` @ `5d791c2` + dirty report)  
**Repository:** `shadrachampah123/easylearn` — `main` @ `016d229` (docs: update roadmap after PRs 32/33)  
**Proposed merge candidate:** `security/reconciled-attachment-quiz` @ `5d791c2` (PR #49 HEAD, verified) — **not merged, not deployed, no prod config changed**  
**Prior verification:** `SECURITY_VERIFICATION_REPORT_PR49.md` (2026-10-25, same worktree, 33/16/13/8/82/17/20/49 PASS, real-provider BLOCKED)  
**Build evidence:** `npm ci` 504 pkgs, `npx tsc --noEmit` 0 errors, `npm run lint` 0 errors/13 pre-existing warnings, `next build` compiled 8.1s + TS 15.1s, then **expected** `Failed to collect configuration for /api/academic-years: No DATABASE_URL` (sandbox has no `DATABASE_URL`; CI uses `TEST_DATABASE_URL` + `DATABASE_URL=postgres://test:test@127.0.0.1:1/testdb` for this phase — **do not claim full static-generation pass**).

---

## 1. Executive Summary — PASS/FAIL/BLOCKED

| Area | Automated | Human Review | Overall | Evidence |
|------|-----------|--------------|---------|----------|
| **PR ancestry & duplication** | **PASS** | **PASS** (this audit) | **PASS** | `git merge-base` + `git log --graph` + `gh pr view` — #49 correctly contains #44-47, supersedes #43 (see §2) |
| **Uploaded-file MIME/content** (PR #40) | **PASS** | **BLOCKED** — independent reviewer required (PR #40 draft, no independent review) | **BLOCKED** | `upload-content.test.ts` 34/34, `object-storage-content-policy` 14/14, `assignment-authorization` 5/5 — server-derived `servedContentTypeFor`, CSP `FILE_RESPONSE_CSP`, presign binds type; **independent human review of PR #40 still missing** |
| **Attachment auth & cross-school isolation** (PR #42, #43, #49) | **PASS** | **BLOCKED** — #42/#43 drafts need independent review | **BLOCKED** | `attachment-security-regression-db` 33/33, `tenant-file-attribution-db` 17/17, `sec-fixes` 16/16, `submission-file-access` 8/8 — `sqlFileInSchool` by `uploaded_files.school_id`, tenant predicate inside query (404 not 403) |
| **Forwarded-header & CSRF** (PR #41, #49) | **PASS** | **BLOCKED** for #41 (draft) | **BLOCKED** | `csrf-policy` 49/49, `csrf-forged-origin` 13/13, `csrf-credential-consistency` — `EASY_LEARN_PUBLIC_ORIGIN` exact origin, `EASY_LEARN_TRUST_PROXY_HEADERS` opt-in, multi-value distrust, Bearer carve-out (no cookie) |
| **Object-storage access / public URLs / deletion** (SEC-1,3) | **PASS** | **BLOCKED** staging | **BLOCKED** | `object-storage-r2` 20/20: protected files never use `OBJECT_STORAGE_PUBLIC_URL` even when set; prod guard `OBJECT_STORAGE_ALLOW_PUBLIC_URL=true` required; `sec-fixes` SEC-3a-d 409 for attached, 200 for unreferenced, 404 cross-school |
| **Presigned expiry & bounded downloads** (SEC-6,8,9) | **PASS** | **BLOCKED** live-bucket | **BLOCKED** | expiry 900→300, `MAX_REQUEST_SIZE` 413, `readObjectPrefix` bounded to 1024 even if Range ignored, outage 503 (not 404) — `sec-fixes` SEC-6a-b, SEC-9a, harness range test; **real-provider live test BLOCKED** |
| **Quiz & submission auth** (PR #49 includes #45-47) | **PASS** | **PASS** (prior independent review PR #45 via `docs/reviews/pr45/SECURITY_REVIEW.md`) | **PASS** for quiz logic; **BLOCKED** for #49 staging | `tenant-authorization-db` 82/82, `quiz-access-db` 17/17, `quiz-remediation-db` PASS, mutation harness `7497e51` + `b3e24ae` atomic/idempotent |
| **Legacy NULL school_id** | **PASS** | **BLOCKED** manual DB | **BLOCKED** | `tenant-file-attribution-db` H1: purely relational denies dual-reachable, legacy NULL denied to both; `tenant.ts` `legacyPredicate` kept only for NULL rows |
| **Remaining auth / info-disclosure** | **PASS** (no new vectors) | **BLOCKED** independent review of #40-42 | **BLOCKED** | Seed route, migration runner, CI workflow inspected — no new risks; shared-identity file-attribution fix (PR #42) deliberate and documented |

**Overall merge readiness: BLOCKED** — automated checks **PASS**, but **independent human reviews** for PRs #40, #41, #42 and **staging/manual verification** for forwarded-header, public URL, legacy NULL, video Range, and real-provider live bucket remain outstanding. **Do not mark merge-ready while required review outstanding** (task §4).

---

## 2. Reconciliation — PRs #40–#49, Merged #44–#47

### 2.1 Current GitHub State (verified 2026-10-25 via `gh pr list`/`gh pr view`/`git fetch --all`)

```
40 OPEN MERGEABLE base:main head:security/address-independent-review-findings d2d05d8
41 OPEN MERGEABLE base:security/address-independent-review-findings head:security/pr40-review-followup c834c2e
42 OPEN MERGEABLE base:security/pr40-review-followup head:security/pr42-file-attribution 0403a4c
43 OPEN MERGEABLE base:security/pr42-file-attribution head:security/pr43-object-storage-guard f9caf0d
49 OPEN MERGEABLE base:security/pr42-file-attribution head:security/reconciled-attachment-quiz 5d791c2
38 OPEN base:main head:security/rebuild-cookie-auth-hardening 15c6cc8 (draft)
39 OPEN base:main head:security/fix-pr38-review-findings 3e7b311
 ---
44 MERGED base:security/pr43-object-storage-guard head:security/pr44-csrf-proxy-trust mergedAt 2026-10-24T02:29:11Z mergeCommit 9f17f8b
45 MERGED base:security/pr44-csrf-proxy-trust head:security/pr45-release-blocker-remediation 2026-10-21T06:53:27Z
46 MERGED base:security/pr44-csrf-proxy-trust head:arena/7d4511bc-easylearn 2026-10-21T12:35:58Z
47 MERGED base:security/pr44-csrf-proxy-trust head:security/pr46-r3-contract-and-review-tests 2026-10-22T18:44:46Z
48 MERGED base:security/pr43-object-storage-guard head:security/zod-4-6-6 2026-10-24T02:23:48Z
```

### 2.2 PR #49 Discrepancy — Description vs GitHub Base

**Claimed:** PR #49 description “Based on `security/pr44-csrf-proxy-trust` (`07e64a4`, includes #44-47) + f9caf0d + SEC fixes.”  
**GitHub records:** `baseRefName: security/pr42-file-attribution` (0403a4c), `headRefName: security/reconciled-attachment-quiz` (5d791c2).

**Actual ancestry (do not rely on description alone — verified via `git log --oneline --graph` + `git merge-base`):**

```
5d791c2 (PR49 HEAD) — docs: verification report
ee001cd — test: explicitly opt in to public object URL test
d88037d — docs: final report
90b5555 — fix: tighten delete guard (closed), add CSRF/report tests
a55f980 — test: SEC-3,7,1,5,6,9 regression (16)
f68ef6e — fix: SEC-6,8,9 expiry/limits/bounded reads
2f5ce39 — fix: SEC-1,3,5,7 public URL/delete/origin/draft
e0f7199 — fix: enforce attachment access authorization (pr43)
07e64a4 — fix(deps): lock patched zod (pr44 tip)
df6f2a8 — fix(deps): declare patched zod
24b4574 — fix(uploads): stop placeholder bearer (pr44)
f2bd859 — Merge #47 (pr46-r3-contract)
a3bf2d4 — Merge #46 (arena/7d4511bc)
f4194df/df9bb2e/e8e4f51/27dcdb7/7497e51/... — pr46+45 quiz fixes
5bc889b — Merge #45 (a4fbc40 F1/F2/F5)
0403a4c — pr42 file-attribution (base)
c834c2e — pr41 follow-up
d2d05d8 — pr40 independent review findings
```

`git merge-base origin/security/pr42-file-attribution origin/security/reconciled-attachment-quiz` = `0403a4c` — **so GitHub base is correct**. Content from `pr44-csrf-proxy-trust` was **cherry-picked as linear commits** (`e0f7199..07e64a4..f2bd859`) atop pr42, not merged as branch history. Effect: PR #49 **does contain** all of #44-47 (verified: `git branch --contains f2bd859/a3bf2d4/5bc889b` includes reconciled; `git log --merges` shows both merges), but via cherry-pick rather than merge ancestry.

**Determination:** #49 **contains all required changes without omission or duplication**. No files omitted (diff `pr42..pr49` = 69 files, 12209 ins includes all 62 files from `pr42..pr43-or-pr44` paths). No accidental duplication (pr43’s 13 files/925 ins are subset of pr49; `comm` shows pr43 files ⊂ pr49; overlapping file `files/[id]/route.ts` diff is additive — SEC-7 draft-status check, not conflicting). Description is **substantially correct about content, misleading about GitHub base mechanism** — should be corrected to: “Content from pr44 tip (07e64a4) cherry-picked onto pr42 base; GitHub base remains pr42 for reviewable diff.”

### 2.3 #43 vs #49 Code-Level Comparison

| File | #43 (f9caf0d) | #49 (5d791c2) | Verdict |
|------|---------------|---------------|---------|
| `src/app/api/files/[id]/route.ts` | Enforces `sqlFileInSchool` + per-file `isAuthorizedForAssignmentFile` (enrolled/teacher/admin) | Same + SEC-7 `status` fetch + `isDraft` guard (`if (isDraft) continue` for learners/parents) | #49 superset — #43 lacks draft protection |
| `src/app/api/uploads/*` | Tenant `ctx.schoolId` write, not client input | Same + size limits 50/100 MB 413, scriptable-type 400 | #49 superset |
| `src/lib/object-storage.ts` | Presigned URL logic | Same + `allowPublic` guard (SEC-1), expiry 300 (SEC-6), `readObjectPrefix` bounded (SEC-9), prod guard | #49 superset |
| `src/lib/csrf.ts` | X-Forwarded host/proto opt-in | Same + PUBLIC_ORIGIN exact, ALLOWED_ORIGINS, diagnostics warnings | #49 superset |
| `src/lib/tenant.ts` | `sqlFileInSchool` relational fallback | Same (0403a4c) | Equal |
| Tests | `attachment-security-regression-db` 33 | + `sec-fixes-regression-db` 16, `csrf-forged-origin` 13, `submission-file-access` 8, `object-storage-real-provider-harness` 197, `object-storage-r2` 23 updated | #49 superset |

**Decision:** #43 is **redundant if #49 merges** — #49 contains every unique fix from #43 plus SEC-1–9 and quiz. No unique fix in #43 remains missing. **Do not close #43 until this comparison is documented** (this report satisfies that); after #49 merges, close #43 as superseded with link to this audit.

---

## 3. Independent Security Review — PRs #40, #41, #42 (Drafts, No Recorded Independent Reviews)

**Status:** Per GitHub, PRs #38-42 are `OPEN` with no submitted reviews (`gh pr view --json reviews`). The agent that implemented #40 also wrote #41’s browser probes — **not independent**. PRs #40-42 remain **drafts** (Title: “Address independent security review findings,” “follow-up tests and browser-verification evidence,” “school-specific uploaded-file attribution”).

**Required independent review checklist (human reviewer must actually perform — do not mark complete without execution):**

| # | Area | What to Review | Automated Coverage | Human Review Needed |
|---|------|----------------|------------------|---------------------|
| 1 | **Uploaded-file MIME/content** | Verify `servedContentTypeFor` never trusts client `file.type`, `FILE_RESPONSE_CSP` sandboxes, presign binds server type, stored `mimeType` not served | `upload-content` 34/34, `object-storage-content-policy` 14/14 — PASS | **BLOCKED** — Reviewer to manually upload `photo.png` with `Content-Type: text/html` declaring `text/html`, verify served as `image/png`/`nosniff`/`sandbox`, not executed (see PR #40 body demo) |
| 2 | **Attachment auth & cross-school isolation** | Confirm `guardSchoolContext` tenant gate (401/403), `sqlFileInSchool` inside query (404 for other school, not 403), per-file `purpose=submission` owner check | `attachment-security-regression-db` 33/33, `tenant-file-attribution` 17/17 — PASS | **BLOCKED** — Reviewer to use 2-school user, upload in School A, verify 404 in School B + other school admin 404 |
| 3 | **Forwarded-header & CSRF** | `EASY_LEARN_PUBLIC_ORIGIN` exact origin, `EASY_LEARN_ALLOWED_ORIGINS` for previews, `EASY_LEARN_TRUST_PROXY_HEADERS` opt-in, multi-value distrust, `Sec-Fetch-Site: same-origin` browser assertion, Bearer carve-out only without cookie | `csrf-policy` 49/49, `csrf-forged-origin` 13/13 — PASS | **BLOCKED** — Reviewer to test forged `X-Forwarded-Host: evil.com, legit` with/without trust, `X-Forwarded-Proto: https` refusal/widen test, `Origin: null` |
| 4 | **Object-storage, public URLs, deletion** | `OBJECT_STORAGE_PUBLIC_URL` only when `allowPublic:true`, prod guard `ALLOW_PUBLIC_URL`, deletion 409 when `assignments.status='published'` or `submissions` reference | R2 20/20 SEC-1a, sec-fixes SEC-3a-d — PASS | **BLOCKED** — Reviewer to verify prod config unset, deletion of published assignment 409 then 200 when unreferenced |
| 5 | **Presigned expiry & bounded downloads** | Upload 300s (not 900), download 3600, size enforced even if `Content-Length` lies, `readdObjectPrefix` truncates to 1024 if provider ignores Range, outage 503 | SEC-6a-b, SEC-9a — PASS | **BLOCKED** — Live bucket test (see §5) |
| 6 | **Quiz & submission auth** | F1 learner+parent quiz auth, F5 Bearer consistency, R3 atomic submission, R4 answer normalization | `tenant-authorization-db` 82/82, `quiz-access-db` 17/17, `quiz-remediation-db` PASS — PASS | **PASS** for logic (PR #45 independent review already `SECURITY_REVIEW.md` CHANGES REQUIRED resolved via #46-47); **BLOCKED** staging for #49 |
| 7 | **Legacy NULL school_id** | `legacyPredicate` only for NULL rows, ambiguous dual-school denied to both | `tenant-file-attribution` H1 — PASS | **BLOCKED** — DB manual: `UPDATE uploaded_files SET school_id=NULL` then verify relational attribution |
| 8 | **Remaining auth/info-disclosure** | Seed route auth, migration runner idempotency, CI JWT secret random, dashboard overrides per-school | `seed-membership` 363, `tenant-dashboard-isolation`, `tenant-authorization-mutation` — PASS | **BLOCKED** — Reviewer to attempt unauthenticated `POST /api/seed`, check error messages don’t leak (describeUploadFailure) |

**Blocker & Owner:** Independent reviewer required for #40-42 — **owner: Engineering Security Reviewer (not the implementing agent)**. Prepare review request: assign PRs #40-42 to reviewer, link this audit + `SECURITY_VERIFICATION_REPORT_PR49.md` + browser probes `tests/manual/browser-upload-verification.js`, `csrf-proxy-trust-probe.js`, `forwarded-header-configuration-matrix.js`, and staging env. **Do not mark review complete until reviewer submits GitHub review (APPROVED/CHANGES_REQUESTED) — automated tests alone insufficient.**

---

## 4. Verification — CI & Staging

### 4.1 Automated (on final candidate `5d791c2`, isolated worktree `/tmp/easylearn-final`)

- **Typecheck:** `npx tsc --noEmit` → 0 errors (5d791c2)
- **Lint:** `npm run lint` → 0 errors, 13 pre-existing warnings (no new)
- **Build:** `next build` → Compiled 8.1s + TypeScript 15.1s; `Error: Failed to collect configuration for /api/academic-years: No DATABASE_URL` — investigated in `src/db/index.ts:9` `getDatabaseConfigurationProblem()` throws if `DATABASE_URL` missing. Sandbox has no `DATABASE_URL`; CI uses `DATABASE_URL=postgres://test:test@127.0.0.1:1/testdb` for compile-only phase plus `TEST_DATABASE_URL` for DB tests. **Not claiming full static-generation pass** — honestly reported as BUILD_PARTIAL.
- **PostgreSQL isolation:** `attachment-security-regression-db` 33/33, `sec-fixes` 16/16, `csrf-forged-origin` 13/13, `submission-file-access` 8/8, `tenant-authorization-db` 82/82, `tenant-file-attribution` 17/17, `quiz-access-db` 17/17, `object-storage-r2` 20/20, `csrf-policy` 49/49 — all via `embedded-postgres` (installed `npm i --no-save embedded-postgres`) or pure; **no prod DB used**.
- **Real-provider:** `object-storage-real-provider-harness` → **BLOCKED** (bucket=, enabled=false, `Live test enabled: false` — correctly SKIPPED, never printed secrets, never used production bucket; requires `OBJECT_STORAGE_LIVE_TEST=true` + disposable bucket creds — see §5).

### 4.2 Staging / Browser / Origin Checks (Do Not Weaken Controls)

All items documented as **BLOCKED — requires disposable staging env + human**, not passed:

- **Browser upload/download:** Run `tests/manual/browser-upload-verification.js` (34/34 in PR #41 evidence) against `5d791c2` preview — real Chromium 153, production build, disposable PG.
- **Origin: null:** Manual `fetch('/api/uploads', {method:'POST', headers:{Origin:'null'}})` with cookie → expect 403 `missing-origin`; verified via unit (4/4 PASS) but browser privacy mode needs human.
- **Forged X-Forwarded-Host / forwarded-scheme:** Use `tests/manual/csrf-proxy-trust-probe.js` + `forwarded-header-configuration-matrix.js` — verify multi-value refused, single trusted only with `EASY_LEARN_TRUST_PROXY_HEADERS=true`, `X-Forwarded-Proto: https` only refuses (never widens).
- **EASY_LEARN_PUBLIC_ORIGIN:** Deploy preview with `EASY_LEARN_PUBLIC_ORIGIN=https://<preview>.vercel.app` exact, verify same-origin 200, foreign 403, forwarded ignored.
- **Production-safe OBJECT_STORAGE_PUBLIC_URL:** Verify prod env has `OBJECT_STORAGE_PUBLIC_URL` **unset** (or `OBJECT_STORAGE_ALLOW_PUBLIC_URL=true` only after audit); attempt set without flag → clear error `OBJECT_STORAGE_PUBLIC_URL is set ... Unset ... or set ALLOW...=true`.
- **Legacy NULL school_id:** DB: `UPDATE uploaded_files SET school_id=NULL WHERE id='...'` then verify relational attribution still denies ambiguous.
- **Video Range 206:** `curl -H "Range: bytes=0-1023" /api/files/<id>` → 206 `Content-Range: bytes 0-1023/...`, `Accept-Ranges: bytes`; manual video seek.

---

## 5. Merge Plan — Dependency Order & Readiness

### 5.1 Correct Order (actual ancestry + GitHub state)

```
main (016d229)
 └─▶ 40 security/address-independent-review-findings d2d05d8 [NEEDS INDEPENDENT REVIEW]
      └─▶ 41 pr40-review-followup c834c2e [NEEDS INDEPENDENT REVIEW]
           └─▶ 42 pr42-file-attribution 0403a4c [NEEDS INDEPENDENT REVIEW]
                └─▶ 49 reconciled-attachment-quiz 5d791c2 [READY for review, BLOCKED for merge pending above + staging]
                     (contains: 43 f9caf0d + 44 07e64a4 + 45-47 merges + SEC-1–9)
```

Already **MERGED** and baked into #49: `44 9f17f8b`, `45 5bc889b`, `46 a3bf2d4`, `47 f2bd859`, `48 Zod 4.6.6` — no re-merge.

### 5.2 PR Status

| PR | Candidate? | Redundant/Superseded? | Required Approval | Blocker/Owner |
|----|------------|-----------------------|-------------------|---------------|
| **#40** `security/address-independent-review-findings` | **Yes** (first in chain) | No | **Independent security reviewer** (not implementer) | **BLOCKED** — no independent review recorded; owner: Security Reviewer |
| **#41** `pr40-review-followup` | **Yes** (after #40) | No (tests/docs only, no behavior change — but required for coverage) | Same reviewer | **BLOCKED** — draft, same reviewer |
| **#42** `pr42-file-attribution` | **Yes** (after #41) | No (fixes shared-identity 404 — tenant isolation) | Same reviewer + tenant-isolation SME | **BLOCKED** — draft, no independent review |
| **#43** `pr43-object-storage-guard` | **No** — **superseded by #49** (subset) | **Yes** — all fixes in #49 plus SEC-1–9 | N/A after supersede | Documented here; close after #49 merges |
| **#49** `reconciled-attachment-quiz` | **Yes** (after #42) | No — candidate (replaces #43) | Same reviewers + staging verifier | **BLOCKED** — needs #40-42 approvals + staging checklist (§4.2) |

**Do not mark merge-ready while required review/verification outstanding** — all BLOCKED above must be resolved before any merge.

### 5.3 CI & Staging Evidence Supporting Readiness (for #49)

- **Commits:** https://github.com/shadrachampah123/easylearn/commits/security/reconciled-attachment-quiz (5d791c2, ee001cd, d88037d, 90b5555, a55f980, f68ef6e, 2f5ce39, e0f7199, 07e64a4…)
- **PR #49:** https://github.com/shadrachampah123/easylearn/pull/49 (5d791c2, MERGEABLE, checks pending run 40197904255)
- **Verification report:** `SECURITY_VERIFICATION_REPORT_PR49.md` on same branch (33/16/13/8/82/17/20/49 PASS, real-provider BLOCKED)
- **CI workflow:** `.github/workflows/ci.yml` — `npm ci` → `security:check-secret` → `npm audit` → `npm test` → `test:auth-security` → TLS DB (postgres:16 service) — previous #45 run 39557273028 SUCCESS head `a4fbc40`; current #49 run pending

---

## 6. Deliverables Checklist

1. **Concise audit report** — this file + one-page table §1 (PASS/FAIL/BLOCKED) ✅
2. **PR-by-PR summary** — §2–§3 (fixes & outstanding risks per #40-42 draft status) ✅
3. **Dependency & merge order** — §5.1 diagram + table ✅
4. **Links** — commits, PRs, test runs, verification reports (§5.3) ✅
5. **Proposed code changes** — none beyond #49 (5d791c2) — #49 already contains all required SEC-1–9 + quiz fixes; **proposed doc fix:** update PR #49 description to clarify “Content from pr44 tip cherry-picked onto pr42 base; GitHub base pr42” (see §2.2) — committed as this report in `security/audit-pr40-49-final` branch (5d791c2 + audit) for review — **not merged** ✅

**Final authorization boundary respected:** Stopped after preparing report + verification (no merges, no PR closes, no prod config changes, no prod credentials used/printed). Awaiting explicit approval.

