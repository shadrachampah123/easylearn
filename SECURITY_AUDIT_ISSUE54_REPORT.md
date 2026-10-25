# EasyLearn Security Audit — Issue #54 (Current-State Verification & Recovery Assessment)

**Date:** 2026-10-25 (UTC) · **Auditor:** Arena Agent (senior security review, isolated sandbox)
**Repository:** `shadrachampah123/easylearn` · **Audited commit:** `main` @ `4b361dad7fcb8e9f25463985bb4f4ba08c2d2eb2` ("fix(security): forward nonce CSP to Next.js", PR #53)
**Working branch:** `arena/ec41b0fe-easylearn` (from `4b361da`) · **Issue:** #54 · **Historical report preserved:** `AUDIT_REPORT_PR40-49_FINAL.md` on branch `security/audit-pr40-49-final` @ `4d66fbb` (not modified)
**Open PRs at start:** none · **Working tree at start:** clean · **CI on audited commit:** GitHub Actions run `40226098233` **success** (3m29s); Vercel status success

> Nothing in this report was fabricated: every PASS below names the command actually run and its observed output. Checks that could not run are marked BLOCKED with the exact missing prerequisite. No production database, bucket, or secret was touched; all live testing used a disposable embedded-PostgreSQL database and a production build on loopback.

---

## 1. Finding-by-finding matrix (historical SEC-1…9 + PRs #40–#53, reconciled to current code)

| # | Finding (source) | Status | Evidence on `4b361da` |
|---|---|---|---|
| SEC-1 | Public object-storage URLs used for protected files | **FIXED** | `object-storage-r2` 20/20 incl. "protected files never use public URL"; `sec-fixes` SEC-1a PASS (DB suite, this run) |
| SEC-2 | Real R2/S3 provider presign→upload→download + tamper test | **BLOCKED** | Harness `object-storage-real-provider-harness` PASSED as skip (`Live test enabled: false`); no disposable bucket/credentials in sandbox. Owner action §6 |
| SEC-3 | Deleting files referenced by published assignments/submissions | **FIXED** | `sec-fixes` SEC-3a–d PASS (409 attached / 200 unreferenced / 404 cross-school); `src/app/api/uploads/[id]/route.ts` |
| SEC-5 | Public-origin misconfiguration diagnostics | **FIXED** | `sec-fixes` SEC-5a–b PASS; `validatePublicOriginForProduction` in `src/lib/csrf.ts` |
| SEC-6 | Presigned upload expiry 900s → 300s; size limits | **FIXED** | `object-storage-r2` + SEC-6a–b PASS |
| SEC-7 | Learners/parents reading draft-assignment attachments | **FIXED** | `sec-fixes` SEC-7a–e PASS; `src/app/api/files/[id]/route.ts` |
| SEC-8 | Chunked/missing Content-Length bypassing size limits | **FIXED** (unit/DB evidence; raw-HTTP chunked case UNVERIFIED) | SEC-6/8 checks in `sec-fixes` PASS; no raw chunked live test exists in CI |
| SEC-9 | Unbounded reads when provider ignores Range; outage → 404 | **FIXED** | SEC-9a PASS (503 on outage); `readObjectPrefix` bounded in `src/lib/object-storage.ts` |
| F-40 | Uploaded-file MIME/content sniffing (server-derived type, `nosniff`, sandbox) | **PARTIALLY FIXED → fixed by this PR** | Upload-content 34/34 + content-policy 14/14 PASS, but live probe found the sandbox CSP was overwritten by the proxy (NEW-1 below). Fixed + live probe 39/39 |
| F-41/44 | Forwarded-header / CSRF proxy trust | **FIXED** | `csrf-policy` 49/49, `csrf-forged-origin` 13/13; live matrix 24/24 and CSRF probe 9/9 against 3 disposable production instances (this run) |
| F-42/43/49 | Attachment authorization + cross-school isolation (`sqlFileInSchool`, 404-not-403) | **FIXED** | `attachment-security-regression-db` 33/33, `tenant-file-attribution-db` 17/17, `submission-file-access-db` 8/8 (this run) |
| F-45/46/47 | Quiz tenancy, atomic/idempotent submission, grading normalization (R1–R7) | **FIXED** | `tenant-authorization-db` 82/82, `quiz-access-db` 17/17, `test:review-pr45`, `test:mutation`, `test:tenant-auth` all PASS (this run) |
| F-48 | Zod patched 4.6.6 | **FIXED** | `npm audit --omit=dev` → 0 vulnerabilities (this run) |
| F-50 | Seed atomicity (single transaction) | **FIXED** | `test:db` incl. `seed-atomicity` 4/4 with injected failures + complete retry (this run) |
| F-51 | JWT revocation on logout via `session_version` | **FIXED** | `src/app/api/auth/logout/route.ts:48`; `verifyToken` revocation check `src/lib/auth.ts:99–115`; auth suites PASS |
| F-52/53 | Per-request CSP nonce + `strict-dynamic`, secure randomness, forwarded to Next.js | **PARTIALLY FIXED** | `csp-nonce` 6/6 PASS; `'unsafe-inline'` retained as documented fallback (modern browsers ignore it with a nonce); nonce regression NEW-1 below |
| Legacy NULL `school_id` attribution | **UNVERIFIED** (manual DB check outstanding) | H1 automated case PASS in `tenant-file-attribution-db`; the manual `UPDATE … SET school_id=NULL` staging check from the historical report was not re-run against any real (non-disposable) database |
| Independent human review of PRs #40–#42 | **BLOCKED** | PRs are merged, so this is now a post-merge review gap, not a merge blocker. No independent reviewer is available in this environment; do not mark complete |

### New findings from this audit

| # | Severity | Finding | Status |
|---|---|---|---|
| NEW-1 | Medium | **Proxy CSP overwrote the uploaded-file sandbox CSP (regression from PRs #52/#53).** `src/proxy.ts` set the global nonce CSP on every `/api/` response; for `/api/files/*` this replaced `FILE_RESPONSE_CSP` (`sandbox; default-src 'none'; …`) that the route handler and `next.config.ts` set. Live probe before fix: `live-upload-content-probe` 37/39, failing "the PNG response is sandboxed" and "the legacy row is sandboxed" (served CSP was the global policy). Residual protection existed (server-derived non-scriptable content types, `nosniff`, `frame-ancestors 'none'`), so exploitability was limited, but a documented defence layer was silently gone. | **FIXED in this PR** — proxy no longer sets CSP for `/api/files/`; regression assertion added to `tests/csp-nonce.test.ts`; live probe after fix: **39/39 PASS** |
| NEW-2 | Low–Medium | **Password change did not revoke sessions; weaker hash cost.** `POST /api/auth/change-password` updated only the hash (bcrypt cost **10** vs `hashPassword` cost **12**) and never bumped `users.session_version`, so a pre-change JWT (24h) survived a password change. Cross-user change was already correctly rejected (route derives user from token, 403 on mismatched `userId`), and current-password verification was present. | **FIXED in this PR** — uses `hashPassword` (cost 12) and bumps `session_version` in the same update (missing-column fallback preserved); new DB regression test `tests/change-password-revocation-db.test.ts` **5/5 PASS** |
| NEW-3 | Low | **Public announcements leak across schools.** `GET /api/announcements?public=true` is unauthenticated (by design, marketing) but returns `is_public` announcements from **all** schools with no school scoping. Content is author-marked public; still a cross-tenant disclosure to fix by scoping to a configured/public school or documenting intent. | **OPEN** — not fixed here (product decision: which school's announcements are "the" public ones). Recommend owner decision |
| NEW-4 | Low (info) | `GET /api/health` is unauthenticated and reveals configuration booleans and per-migration warnings. No secrets or connection strings are exposed. Acceptable for an ops endpoint; consider restricting in production. | **OPEN** (accepted-risk candidate) |
| NEW-5 | Low (dev-only) | Seed route error path returns `String(error)` in its 500 body. Route is 404 in production and `super_admin`-gated in development, so exposure is minimal. | **OPEN** (minor) |

### Areas audited with no defect found (current code, traced route → guard → DB)

- **Auth/session:** bcrypt cost 12 (`src/lib/auth.ts:46`), JWT 24h expiry, `session_version` revocation on logout, login rate-limiting via `login_attempts` (`src/app/api/auth/login/route.ts:51`), JWT-secret policy (26/26 tests), cookie-only browser auth (31/31).
- **Authorization/IDOR & parent→learner:** `guardSchoolContext` (DB membership role, never the JWT claim) + `canAccessLearner` relationship checks in grades/attendance/learner-stats; user directory admin-only and school-scoped (`src/app/api/users/route.ts:36–45`); notifications strictly `user_id = caller AND school_id = ctx` (GET/PUT).
- **Registration/seed:** public registration disabled (403 stub); seed 404 in production.
- **Files/uploads:** presign binds content type, expiry 300s, size 413s, disk-fallback guard after auth, cross-school 404s — DB suites above.
- **Config/secrets:** `npm audit` clean; CI generates a fresh random JWT secret per run; TLS-to-Postgres enforced (a non-TLS disposable DB was refused until the explicit loopback-only test flag was set — verified live).

---

## 2. Test evidence (all commands actually run on `4b361da`, 2026-10-25)

Environment: Node 22.22.3, npm 10.9.8, `npm ci` clean, disposable JWT secret generated per CI practice, embedded-PostgreSQL for DB suites (installed `--no-save`, not committed).

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** 0 errors |
| `npm run lint` | **PASS** 0 errors, 13 pre-existing warnings |
| `npm audit --omit=dev` | **PASS** 0 vulnerabilities |
| `npm test` | **PASS** (incl. R2 signatures 20/20, upload-mode 10/10; DB-gated files skip cleanly without a DB) |
| `npm run test:auth-security` | **PASS** — JWT policy 26/26, CSRF 49/49, cookie-auth 31/31, upload-content 34/34, content-policy 14/14 |
| `npm run test:db` (with `EASY_LEARN_REQUIRE_*` strict flags) | **PASS** — all suites 0 failed (tenant 30, membership 48, assignment 7+8+11, scratch-lifecycle 7, catalog 17, file-attribution 17, migration-0017 19, dashboard-isolation 21, seed-membership 7, seed-atomicity 4, constraint-integrity 24, …) |
| `npm run test:tenant-auth` | **PASS** — 82/82 + quiz-access 17/17 + remediation/mutation |
| `npm run test:review-pr45` | **PASS** |
| `npm run test:mutation` | **PASS** |
| `npm run test:integration` | **PASS** 11/11 (slow embedded-PG shutdown; initially looked like a hang in a combined loop — re-run alone, exit 0) |
| `npm run test:tenant-integrity` | **PASS** 24/24 |
| `npx tsx tests/csp-nonce.test.ts` | **PASS** 6/6 (after fix; was 5/5 before, +1 regression) |
| `npx tsx tests/csrf-forged-origin-regression.test.ts` | **PASS** 13/13 |
| `npx tsx tests/object-storage-signature.test.ts` | **PASS** 2/2 |
| `EASY_LEARN_TEST_DATABASE=true` attachment / sec-fixes / submission suites | **PASS** 33/33, 16/16, 8/8 |
| `npm run test:tls-e2e` | **PASS** 7/7 |
| `npx tsx tests/change-password-revocation-db.test.ts` (new) | **PASS** 5/5 (via `TEST_DATABASE_URL`; embedded fallback hit a local auth race with parallel disposable clusters — environmental, CI uses the service container) |
| `npm run build` (CI-style placeholder `DATABASE_URL`) | **PASS** |
| Historical `main` CI (GitHub Actions `40226098233`) | **PASS** success |

**Live probes (Phase 4)** — disposable embedded-PostgreSQL (migrations applied via the repo chain, loopback-only insecure flag) + `next start` production instances on :3400 (default), :3401 (`EASY_LEARN_TRUST_PROXY_HEADERS=true`), :3402 (`EASY_LEARN_PUBLIC_ORIGIN` set):

| Probe | Result |
|---|---|
| `tests/manual/csrf-proxy-trust-probe.js` | **PASS 9/9** (7/7 on re-run without second instance) |
| `tests/manual/forwarded-header-configuration-matrix.js` | **PASS 24/24** (first run showed 401s = missing fixture user, i.e. CSRF had passed; after seeding the documented fixture, 24/24) |
| `tests/manual/live-upload-content-probe.js` | **37/39 before fix → 39/39 after fix** (NEW-1) |
| Real object-storage (R2/S3) live presign/tamper | **BLOCKED** — no disposable bucket or non-production credentials in this environment; harness skips safely and prints manual steps. Never pointed at production |

**Browser verification (Phase 5): BLOCKED.** The repo has no Playwright config or browser tests, no browser is installed in the sandbox, and `playwright install chromium` fails (browser CDN is outside the sandbox network allowlist). Chromium/Firefox/WebKit were **not** tested; no result is claimed for them. Next step: run `npx playwright install` + the manual browser probes (`tests/manual/browser-upload-verification.js`, `browser-content-type-sniffing-probe.js`, which need `CHROMIUM_EXECUTABLE`) on a machine with browser downloads enabled.

---

## 3. Neon recovery assessment (Phase 6) — **BLOCKED, owner action required**

**Verified:**
- GitHub branch `security/audit-pr40-49-final` still exists @ `4d66fbbc6dba76d0414f1fd38fb21acc16509f92`; its only content beyond history is the historical audit report (preserved; this report supersedes it, it was not rewritten).
- The sandbox has **no** Neon credentials: no `NEON_API_KEY`, no `neonctl`, no Neon session. Neon API/dashboard access is therefore **unavailable**, and the deleted database branch's existence, parent, point-in-time state, and retention status could **not** be verified. Nothing was restored, and no production database was touched.

**What the owner (Neon project owner) should do — exact steps:**
1. In the Neon Console, open the EasyLearn project → **Branches**. Deleted branches are not listed there; check **Settings → Storage** / project **History** and the **Operations log** for the deletion event of the branch associated with `security/audit-pr40-49-final` to record its branch ID, parent branch, and deletion timestamp.
2. Neon supports **restore (point-in-time / instant restore) only within the project's history-retention window** (plan-dependent; free-tier retention is short). If the deletion is inside the window, use **Branches → Restore / "Restore branch"** (or create a new branch from the parent at a timestamp just before deletion). Restoring creates a **new branch ID/endpoint** — update the preview environment's `DATABASE_URL` secret accordingly (do not print it).
3. If the branch is outside the retention window, its data is **not recoverable** from Neon; an empty replacement can be created from the parent branch and re-migrated with `node run-migration.js` against that branch only. Note this recovers schema, not the preview data.
4. Important expectation-setting: this was a **disposable preview database** for an audit branch. Nothing in `main`, CI, or production depends on it (CI provisions its own PostgreSQL; Vercel on `main` is green). Recovery is a convenience for historical preview parity, not a release blocker.
5. To let an agent verify this in future: provide a **non-production, read-only-scoped** Neon API key via the environment (never in chat/commits), or run `neonctl branches list` / `neonctl branches get <id>` and share the redacted output.

---

## 3b. Follow-up (same PR): session-revocation fail-open — NEW-6

A post-PR review question asked whether revocation can silently fail open. Traced answer: **yes, it could**, in two places:

- `verifyToken` (`src/lib/auth.ts`) wrapped the `session_version` comparison in a catch-all that **accepted the token on any failure** — missing column with repair disabled/no DDL privilege, schema-helper failure, or database outage — with no logging.
- The change-password route's fallback changed the password **without** the revocation bump and returned 200.

Fix (fail closed, no outage on migrated databases): `verifyToken` now uses the `ensureSessionRevocationColumn()` verdict; unavailable schema or a failed DB check throws the new `SessionRevocationCheckError`, which tenant context maps to **503** (never a silently accepted token). The password-change route refuses with **503 and changes nothing** when revocation cannot be guaranteed, and the hash+bump is one atomic update; the non-critical `must_change_password` clear keeps its separate tolerant path. Deleted-user tokens keep the documented seed-bootstrap behaviour (downstream user re-reads still reject missing accounts).

Evidence: `session-revocation-failclosed-db` **3/3** (missing column → throw; password change 503 + password unchanged; DB error → throw), `session-revocation-autorepair-db` **2/2** (default lazy repair recreates the column, no lockout, revocation then works), `change-password-revocation-db` **5/5**; `jwt-secret-policy` updated to assert the fail-closed contract. Full suites re-run green (`test:db` 252 PASS incl. all three revocation suites, tenant-auth, review-pr45, mutation, integration 11/11, tls-e2e 7/7, build, lint).

## 3c. Independent review of PR #55 (self-review, reviewer stance)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| R-1 | High | **Admin password reset did not revoke sessions.** `PATCH /api/users/[id]` updated only the hash; a reset victim's 24h tokens survived. | **FIXED** — atomic hash+`session_version` bump, 503-and-change-nothing if schema unavailable; new `admin-password-reset-revocation-db` **4/4** |
| R-2 | Medium | **`must_change_password` partial failure misreported.** After a successful revoking password change, a failing flag-clear rethrew → caller got 500 "Failed to update password" though the password HAD changed. | **FIXED** — clear is now log-and-succeed (documented deliberate) |
| R-3 | Low | Deactivated accounts could still change password (route bypasses `resolveAuthContext`'s `isActive` rule). | **FIXED** — explicit `isActive` check |
| R-4 | Low | Direct `verifyToken` consumers (`images/search`, `seed`) receive the new thrown revocation error. | **PASS (verified)** — image-search outer catch already answers 503; seed's is dev-only/404-in-prod. No change warranted |
| — | — | Logout bump, login version minting, select-school reissue, JWT-failure → null, weak-secret rethrow, seed bootstrap (nonexistent-user claim), CSP `/api/files/` carve-out, 60s schema-probe cache | **PASS** — traced, no defect |
| — | Info | Admin reset minimum length 6 vs self-service 8 | Pre-existing product policy; owner may align — not changed unilaterally |

**Blocker checklist:** PR #55 review **PASS** (fixes above, suites green) · R2/S3 live **BLOCKED** (no disposable credentials in environment) · Browser verification **BLOCKED** (no installable browsers) · Announcements `?public=true` **BLOCKED on owner decision** — exact question: *"Should public announcements be scoped to a single designated school (which one?), or is a cross-school public feed intended for the marketing site?"* · Health endpoint **PASS** (booleans/migration names only, no secrets — accepted) · Neon **BLOCKED** (no Neon access; §3 owner steps; nothing claimed) · Production readiness **NOT READY** until human approval + blocked items close. No critical/high findings remain open in code.

## 4. Changes in this PR

| File | Change |
|---|---|
| `src/proxy.ts` | Do not set the global CSP on `/api/files/*` responses, so `FILE_RESPONSE_CSP` (route + `next.config.ts`) survives (NEW-1) |
| `src/app/api/auth/change-password/route.ts` | Hash with `hashPassword` (cost 12) and bump `session_version` in the same update, revoking pre-change tokens; missing-column fallback preserved (NEW-2) |
| `tests/change-password-revocation-db.test.ts` | New DB regression test (5 checks) |
| `tests/csp-nonce.test.ts` | +1 regression assertion for the file-sandbox CSP |
| `SECURITY_AUDIT_ISSUE54_REPORT.md` | This report |

Diff reviewed: no secrets, no migrations, no unrelated changes. **This PR must not be merged without independent security review** (per Issue #54); the author has not merged it.

## 5. Go / No-Go

- **Code security: GO (conditional).** All automated suites, DB isolation suites, and disposable live probes pass on `4b361da`; the two defects found (NEW-1, NEW-2) are fixed with regression tests in this PR. Conditional on: independent review + green CI on this PR before merge.
- **Infrastructure readiness: NO-GO / unverified** until: (a) real-bucket R2/S3 live test (SEC-2) is run with a disposable bucket, (b) browser verification is run where browsers can be installed, (c) the manual legacy-NULL attribution check is done on staging, (d) the owner completes the Neon assessment in §3 and confirms production has migration `0019` (`session_version`) applied (it is also lazily applied by schema-resilience, but verify).

## 6. Remaining actions (by severity / owner)

1. **[Owner/Reviewer]** Independently review and approve this PR; confirm CI green; then merge (do not merge on this report alone).
2. **[Owner]** Run the SEC-2 live object-storage test against a **disposable** bucket: `OBJECT_STORAGE_LIVE_TEST=true` + test-bucket credentials → `npx tsx tests/object-storage-real-provider-harness.test.ts` (presign→PUT→GET, tampered signature, content-type mismatch, Range bound). Never use the production bucket.
3. **[Owner]** Decide NEW-3 (scope `?public=true` announcements to one public school or accept cross-school public feed) and NEW-4 (restrict `/api/health` in production if desired).
4. **[Owner]** Neon: follow §3 steps 1–3; report branch ID/parent/retention outcome on Issue #54.
5. **[Owner/QA]** Browser pass (Chromium + Firefox + WebKit) with Playwright/manual probes on a machine where browsers install; record results on Issue #54.
6. **[Owner/DBA]** Staging manual checks: legacy NULL `school_id` attribution; confirm `users.session_version` exists in production; video Range 206 seek test.
7. **[Team]** Post-merge independent review of the already-merged PRs #40–#42 (historical BLOCKED item), filed as its own issue.


---

## 7. Current-state addendum — 2026-10-25 (main @ fb31b39)

This addendum supersedes the report's earlier audited-commit label and any status that has changed since the original run. It does not claim unavailable infrastructure checks were performed.

### Reconciled GitHub evidence

- Current main: fb31b39b175b66b832f15344907495765fd137fa, commit `fix(security): scope public announcements to CBISM`.
- Main CI run #96 succeeded: [run 40242086333](https://github.com/shadrachampah123/easylearn/actions/runs/40242086333). Its single job shows the disposable PostgreSQL suites, security/auth tests, TLS E2E, typecheck, production build, and lint all completed successfully.
- PR #56 merged as fb31b39. `src/app/api/announcements/route.ts` resolves the designated school through `getDesignatedPublicSchoolId()` and filters public announcements by that school; `src/lib/tenant.ts` returns no designated school on lookup failure, so the public feed fails closed to an empty result.
- The older report's statement that public-announcement scope was awaiting an owner decision is superseded by PR #56. It is scoped to the designated `cbism` school today; per-school public-site configuration remains future work.
- Preserve `security/audit-pr40-49-final` untouched.

### Session revocation follow-up — do not conflate commit with main

Commit `346aba04df7a4bb1c6b9d98a54f73164b8ea479f` describes a further fail-closed correction for session-revocation checks: token verification should not accept a token when the revocation database check fails, and password change should return 503 without changing the password if revocation cannot be guaranteed. Its PR #55 CI run #88 succeeded ([run 40237532084](https://github.com/shadrachampah123/easylearn/actions/runs/40237532084)). However, the currently fetched main head is `fb31b39`; this follow-up commit is not the current main head. Treat the fail-closed follow-up as not yet verified on current main until ancestry/source confirms it is included. Do not infer production deployment from CI success on a PR commit.

### Current-state matrix

| Area | Current assessment | Evidence / next action |
|---|---|---|
| Public announcements tenant boundary | **FIXED on main** | `src/app/api/announcements/route.ts` filters by designated `cbism` school; `src/lib/tenant.ts` fail-closed resolver. Main CI #96 green. |
| Proxy CSRF / forwarded-header behavior | **Automated checks pass; external live matrix not re-run in this addendum** | Main CI #96 includes auth/CSRF suites. Do not treat historical disposable production probes as newly executed against this exact SHA. |
| Uploaded file CSP sandbox | **Code fix present on main; runtime re-probe not performed here** | `src/proxy.ts` documents the `/api/files/*` carve-out; historical report records 39/39 disposable probe on PR #55's earlier head. Main CI #96 green. |
| Attachment authorization / cross-school access | **Automated regression coverage passes in main CI** | CI job reports tenant authorization, database, integration, and mutation suites passed. Live object-storage provider behavior remains separate. |
| Password-change session revocation | **Fail-closed follow-up requires ancestry confirmation** | PR #55 CI passed on its commit, but current main is `fb31b39`. Confirm whether `346aba0` is in current main ancestry and inspect the exact current route/auth implementation before marking fully verified. |
| Real R2/S3 presign → upload → download, expiry, tampered signature, content type, range, deletion safeguards | **BLOCKED / not verified against a real provider** | No disposable test-bucket credentials/infrastructure have been provided in this environment. Do not use production bucket credentials. |
| Playwright Firefox/WebKit | **BLOCKED / not verified in this run** | No browser installation/run was performed here. Run in a disposable CI/QA environment with browser binaries installed and attach results. |
| Legacy rows with NULL school attribution | **Automated negative case reported; manual staging verification outstanding** | Do not mutate production. In staging, verify cross-school denial for legacy NULL attribution and record redacted results. |
| Neon deleted preview branch recovery | **UNVERIFIED — no Neon access** | No Neon API/dashboard access was available to confirm branch ID, parent, retention window, or restore outcome. Follow owner-only console steps in §3; restore only to a new branch and do not change production connection settings. |
| Independent security review | **NOT COMPLETE unless a separate reviewer submits a review** | Author self-review and green CI are not a substitute for independent review. |

### Execution limits for this addendum

This update was reconciled using GitHub API source, pull-request metadata, and workflow job summaries. It did not execute repository commands in a local checkout, connect to a disposable database, start production-mode HTTP probes, install Playwright browsers, or access Neon/R2. Therefore, no local test, real-provider, browser, or Neon recovery result is newly claimed here. Main CI #96 is the verified automated evidence for `fb31b39`.

### Go / No-Go — current main

- **Code/CI: conditional GO** for the exact current main commit because configured CI #96 is green.
- **Release/security sign-off: NO-GO pending** confirmation of the session-revocation fail-closed follow-up on main, independent security review, and the infrastructure-blocked R2/browser/legacy-row/Neon checks as applicable.
- No production database, secret, storage, Neon branch, or historical audit branch was modified by this addendum.
