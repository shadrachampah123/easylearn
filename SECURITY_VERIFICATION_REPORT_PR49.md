# PR #49 Security Verification — 2026-10-25

**PR:** [#49](https://github.com/shadrachampah123/easylearn/pull/49) `security/reconciled-attachment-quiz` → `security/pr42-file-attribution` @ `ee001cd` (MERGEABLE, CLEAN)
**Supersedes:** [#43](https://github.com/shadrachampah123/easylearn/pull/43) `security/pr43-object-storage-guard` @ `f9caf0d` (OPEN, same base) — 49 contains 43 + 44-47 + SEC fixes, 43 should be closed after 49 merges.
**Stack:** `40 (d2d05d8 → main) → 41 (c834c2e → 40) → 42 (0403a4c → 41) → 49 (ee001cd → 42)` — linear, no cycles.
**Main:** `016d229` — none of 40-43,49 on main yet (intentional).

## 1. Dependency & Overlap Inspection

| Check | Result | Evidence |
|-------|--------|----------|
| PRs 40-49 chain verified via `gh pr list` + `git merge-base` + `git log --graph` | **PASS** | `gh pr view 49` base=`security/pr42-file-attribution`, head=`ee001cd`; `git merge-base origin/pr42..origin/reconciled` = `0403a4c` (exactly pr42 tip); `git log origin/reconciled --oneline` shows `e0f7199` (pr43) + `07e64a4/df6f2a8/24b4574` (pr44 tip) + `f4194df/df9bb2e/e8e4f51/27dcdb7/7497e51/b3e24ae/9685fc4/1534ebb` (pr45-47) — all present |
| Merged PRs 44-47 remain intact | **PASS** | PR 44 Merged 2026-10-24 `8bb611b→07e64a4`; 45 Merged 2026-10-21 `a4fbc40→5bc889b`; 46 Merged 2026-10-21 via `a3bf2d4`; 47 Merged 2026-10-22 via `f2bd859`. All commits are ancestors of `ee001cd` (checked `git log ee001cd | grep 07e64a4/f4194df/df9bb2e/...`). No revert. |
| Overlapping patches identified | **PASS** | 49 vs 43: both contain `src/app/api/files/[id]/route.ts` attachment auth (same `e0f7199` commit). 49 intentionally supersedes 43 — diff `pr42..43` = 13 files, 925 ins; `pr42..49` = 69 files, 12209 ins (43 + 44 + SEC fixes + quiz). No conflicting hunks; `comm` shows `pr43` files are subset of `pr49` (no file only in pr43). |
| Quiz/CSRF/tenant fixes preserved | **PASS** | `src/lib/tenant.ts` relational fallback + `sqlFileInSchool`, `src/lib/csrf.ts` PUBLIC_ORIGIN/TRUST_PROXY, `src/app/api/quizzes/*` tenancy — all present in 49 (verified via `grep` and 82/17 quiz/tenant tests below). |
| PR44 CSRF proxy trust not regressed | **PASS** | `24b4574` placeholder-bearer fix present in 49 history; `csrf-policy.test.ts` 49/49 pass, `csrf-forged-origin` 13/13 pass. |

## 2. Automated Checks

| Suite | Command | Result |
|-------|---------|--------|
| TypeScript | `npx tsc --noEmit` | **PASS 0 errors** (exit 0, 2026-10-25, worktree `/tmp/easylearn-pr49`) |
| Lint | `npm run lint` | **PASS 0 errors, 13 warnings** (pre-existing: react-hooks/exhaustive-deps, no-img-element, no-page-custom-font; unchanged from main) |
| Build | `npm run build` | **PASS compiled 8.1s + TS 13.3s** — then **EXPECTED FAIL** `Failed to collect configuration for /api/academic-years: No database URL is configured` (no `DATABASE_URL` in sandbox; same as CI without DB, not a code error) |
| `npm test` (pure) | `npm test` | **PASS** 23 tenant-foundation +37 membership-foundation +20 R2 +10 upload-mode = 90/90 (exit 0) |
| `test:auth-security` | `npm run test:auth-security` | **PASS** security.test.js, postgres-tls, assignment-authorization, jwt-secret-policy, csrf-policy (49/49), csrf-credential-consistency, cookie-auth (31/31), upload-content (34/34), object-storage-content-policy (14/14) |
| `attachment-security-regression-db` | `EASY_LEARN_TEST_DATABASE=true npx tsx tests/attachment-security-regression-db.test.ts` (embedded-postgres, installed via `npm i --no-save embedded-postgres`) | **PASS 33/33** (1a-1n assignment, 2a-2e multipart, 3a-3j presign, 4a-4d attach) |
| `sec-fixes-regression-db` | `.../sec-fixes-regression-db.test.ts` | **PASS 16/16** SEC-7a-e, SEC-3a-d, SEC-1a, SEC-5a-b, dual-school, SEC-6a-b, SEC-9a |
| `csrf-forged-origin-regression` | `.../csrf-forged-origin-regression.test.ts` | **PASS 13/13** Origin:null×Sec-Fetch-Site, X-Forwarded-Host single/multi, Bearer carve-out, PUBLIC_ORIGIN exact, ALLOWED_ORIGINS |
| `submission-file-access-db` | `.../submission-file-access-db.test.ts` | **PASS 8/8** uploader/owner/co-teacher/parent/admin/dual-school |
| `tenant-authorization-db` | `.../tenant-authorization-db.test.ts` | **PASS 82/82** |
| `tenant-file-attribution-db` | `.../tenant-file-attribution-db.test.ts` | **PASS 17/17** (A1-H1, legacy NULL, dual) |
| `quiz-access-db` | `.../quiz-access-db.test.ts` | **PASS 17/17** F1/F1a-b, F2 |
| `quiz-remediation-db` | `.../quiz-remediation-db.test.ts` | **PASS** (ran, exit 0 — summary truncated by runner, no failures) |
| `object-storage-r2` | `npx tsx tests/object-storage-r2.test.ts` | **PASS 20/20** (bucket/enabled, endpoint auto, expiry, path-style, RFC3986, signatures, secret never leaks, private bucket signed, PUBLIC_URL only when allowPublic, newObjectKey) |
| `csrf-policy` | `npx tsx tests/csrf-policy.test.ts` | **PASS 49/49** (opt-in, public origin precedence, browser assertion, forwarded-host, wrapper) |
| Real-provider harness | `npx tsx tests/object-storage-real-provider-harness.test.ts` | **BLOCKED — NOT RUN (correctly SKIPPED)** — `bucket=, enabled=false, Live test enabled: false`; harness prints `⚠️ SKIPPED` + 6 manual steps, exit 0, **never printed secrets** (only `bucket=` empty), **never used production bucket** (disposable prefix `__easylearn-test/<uuid>/` only if enabled) |

DB suites requiring `TEST_DATABASE_URL`/`EASY_LEARN_TEST_DATABASE=true` with external Postgres (e.g., `object-storage-live.test.ts`, `real-authorization.test.ts`, full `test:db`/`test:tenant-auth`) are **NOT RUN** in this sandbox (no Postgres service). They are **BLOCKED** — run in CI (`postgres:16` service, `TEST_DATABASE_URL=postgres://easylearn_test:...@127.0.0.1:5432/postgres`) where previous PR44-45 runs were SUCCESS (e.g., run 39557273028 headSha=a4fbc40 success). **Do not claim as PASS.**

## 3. Skipped Real-Provider Test — Investigation

- Checked env: `env | grep OBJECT_STORAGE` — **no credentials set** (correct, never print/commit secrets). `.env.example` shows placeholder `AKIA...`, `...` — not real.
- Harness code `tests/object-storage-real-provider-harness.test.ts` only runs when `OBJECT_STORAGE_LIVE_TEST=true` + `getObjectStorageConfig().enabled` (all of BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY set). Otherwise it SKIPs with documented 6-step manual verification (disposable bucket creation, env, `OBJECT_STORAGE_LIVE_TEST=true npm run test:real-provider`, verify PUT/GET/tampered/mismatched/oversize/response overrides/CORS, delete bucket).
- We did **not** set credentials, did not run destructive test, did not access production bucket. **Status: BLOCKED — requires human with disposable bucket** (never production).

## 4. Manual Verification Checklist (Human Required)

These cannot be fully automated in sandbox; code inspection shows handling, but browser/proxy behavior requires human.

| Item | Code Location | Code Handling | Manual Test | Status |
|------|---------------|---------------|-------------|--------|
| **Browser uploads/downloads** | `src/app/api/uploads/route.ts` (server-derived content type via `servedContentTypeFor`, multipart 409 when object-storage enabled, disk-path guard after auth), `src/app/api/files/[id]/route.ts` (cookie `el_token`, tenant `sqlFileInSchool`, Content-Type from server, CSP `FILE_RESPONSE_CSP`, disposition) | Server decides type, not client; storage path validated | Upload png/pdf/video as learner/teacher, download via `<img>/<video>/<a download>` with session cookie, verify correct rendering & download | **BLOCKED — human browser** |
| **Origin: null** | `src/lib/csrf.ts` evaluateCsrf: `Origin: null` with no `Sec-Fetch-Site` → `missing-origin` reject; `Origin: null` + `Sec-Fetch-Site: cross-site` → reject; `no Origin + same-origin` → allow | Covered by `csrf-forged-origin` 4 tests (PASS) | Open file:// or privacy iframe, POST to `/api/assignments` with cookie, expect 403 | **BLOCKED — human** (unit covered, browser edge needs manual) |
| **Forged X-Forwarded-Host** | `src/lib/csrf.ts` ALLOWED_ORIGINS_ENV, TRUST_PROXY check, multi-value distrust | Multi-value refused even with TRUST_PROXY=true; single ignored without opt-in; trusted only when TRUST_PROXY=true | Send `X-Forwarded-Host: evil.com, legit.com` + `Origin: https://evil.com` with TRUST_PROXY on/off, expect 403; single legit host with TRUST_PROXY=true expect 200 | **BLOCKED — human proxy** (13/13 automated pass, but real proxy header injection needs staging) |
| **EASY_LEARN_PUBLIC_ORIGIN** | `src/lib/csrf.ts` PUBLIC_ORIGIN_ENV — when set, is *only* origin compared, forwarded headers ignored completely, precedence over TRUST_PROXY | 49 csrf-policy tests cover exact match, foreign reject, legit via rewriting proxy | Deploy with `EASY_LEARN_PUBLIC_ORIGIN=https://easylearn.example.com` behind CDN rewriting scheme, POST from app origin 200, foreign 403, forwarded headers ignored | **BLOCKED — human deploy** |
| **OBJECT_STORAGE_PUBLIC_URL** | `src/lib/object-storage.ts` `publicBaseUrl`, `allowPublic` option; `objectDownloadUrl` only uses public URL when `options.allowPublic=true`; protected files never use it; `assertObjectStorageConfigForProduction` throws in prod if PUBLIC_URL set without `OBJECT_STORAGE_ALLOW_PUBLIC_URL=true` | R2 20 tests cover private signed vs public, protected never public | Set `OBJECT_STORAGE_PUBLIC_URL=https://pub.r2.dev` in prod without allowPublic → expect startup error; with allowPublic=true + public-read bucket → GET public URL; protected file still signed | **BLOCKED — human prod config** |
| **Legacy files NULL school_id** | `src/lib/tenant.ts` `sqlFileInSchool`, `legacyPredicate`, fail-closed when ambiguous; `src/app/api/files/[id]/route.ts` tenant predicate inside query | 17 file-attribution tests: H1 purely relational denies dual-reachable, legacy NULL relational attribution, deactivated membership loses access | Upload file before migration 0016, run migration, verify legacy row still readable only in attributed school, ambiguous dual denied; `psql -c "UPDATE uploaded_files SET school_id=NULL WHERE id='...'"` then access test | **BLOCKED — human DB migration** |
| **Video Range requests** | `src/app/api/files/[id]/route.ts` byte-range serving 206 Partial Content, video/audio players issue Range | Code comment documents Range, but no automated Range test | Play video in browser, seek, verify 206, Content-Range, no full download; `curl -H "Range: bytes=0-1023" /api/files/<id>` → 206 | **BLOCKED — human media** |

All automated portions of these (CSRF policy, public URL guard, tenant predicate) are **PASS**; browser/proxy/deploy/DB/migration/media execution is **BLOCKED** pending human.

## 5. Changed Files (69 vs pr42)

`69 files changed, 12209 insertions(+), 509 deletions(-)` — includes pr43+pr44+SEC fixes + pr40-42 docs/migration/seed/quiz.

Security-relevant: `src/app/api/files/[id]/route.ts`, `src/app/api/uploads/*`, `src/lib/csrf.ts` (public origin, proxy trust, browser assertion), `src/lib/object-storage.ts` (allowPublic, expiry 900→300, prod guard), `src/lib/object-guard.ts`, `src/lib/tenant.ts` (NULL legacy), `src/proxy.ts`, `src/lib/session-cookie.ts`, `src/lib/authorization.ts`, `src/lib/quiz-access.ts`, `proxy.ts` matcher.

**No defects fixed this cycle** — all inspected checks PASS or correctly BLOCKED; no new branch needed beyond report. Isolated verify branch `security/reconciled-attachment-quiz-verify` at `ee001cd` (clean except `next-env.d.ts` generated) preserves quiz/CSRF/auth/tenant fixes.

## 6. PR Links & Safest Next Action

- **Review:** [PR #49](https://github.com/shadrachampah123/easylearn/pull/49) (reconciled, MERGEABLE) — **do not merge yet**.
- **Superseded:** [PR #43](https://github.com/shadrachampah123/easylearn/pull/43) — close as duplicate after 49 merges (same base, subset).
- **Upstream:** [PR #42](https://github.com/shadrachampah123/easylearn/pull/42) → [PR #41](https://github.com/shadrachampah123/easylearn/pull/41) → [PR #40](https://github.com/shadrachampah123/easylearn/pull/40) → `main`.

**Safest order (no merges/deploy/prod changes now):**
1. Human completes **manual checklist** above in a preview/staging deploy with `EASY_LEARN_PUBLIC_ORIGIN`, `EASY_LEARN_TRUST_PROXY_HEADERS`, and a **disposable** R2/S3 bucket (never production) for SEC-2 live test (`OBJECT_STORAGE_LIVE_TEST=true`).
2. Merge `40 → 41 → 42 → 49` sequentially (each green in CI), **close 43**.
3. PRs 44-47 already merged and contained in 49 — no separate merge needed.
4. Verify `OBJECT_STORAGE_PUBLIC_URL` is **unset** in production (or set only with `OBJECT_STORAGE_ALLOW_PUBLIC_URL=true` after audit) and `DATABASE_URL`/`JWT_SECRET` are production-valid.
5. Deploy, then re-run browser upload/download + video Range smoke test.

**Do not:** merge PRs, deploy to production, change production settings, delete data, or use production bucket for tests — **stop and report** if credentials/permissions missing (current state: BLOCKED items require human).

---
*Generated 2026-10-25 in `/tmp/easylearn-pr49` from automated typecheck/lint/build + embedded-postgres DB suites + code inspection. Real-provider live test intentionally SKIPPED without credentials.*
