# EasyLearn — Read-only Cloudflare R2 Configuration Audit

**Date:** 2026-11-19 · **Branch audited:** `arena/4416888f-easylearn` (base = `main` @ `4069584`) · **Repo:** `shadrachampah123/easylearn`
**Mode:** strictly read-only. No environment variable was changed, nothing was deployed, no file was uploaded/deleted/moved, no secret value was retrieved or printed, Production and the database were not touched.

> **STATUS 2026-11-19 (after this audit was written; body left unchanged).** Every application-side finding here stood up: no code or environment change was needed. The upload failure was caused by the missing Cloudflare R2 **bucket CORS policy**, which the owner has since corrected — assignment uploads, learner submissions and downloads are all verified working in Production, and R2 integration is recorded as COMPLETED in `docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md`. The hardening items this audit listed as *not verified* (bucket versioning, lifecycle policy, an explicit `OBJECT_STORAGE_PUBLIC_URL` check) remain open and are paused together with the backup/disaster-recovery workstream (finding M-3).

---

## 0. Method and access limits (read this first)

**Direct inspection of the Vercel environment-variable dashboard was NOT possible from this session**, for three independent reasons (each verified, not assumed):

| Check | Result |
|---|---|
| Vercel connector in Arena | `disconnected` (user has not connected the Vercel app) |
| Vercel CLI / `VERCEL_TOKEN` in the sandbox | absent — only GitHub tokens are present (names checked, values never printed) |
| Network path to `api.vercel.com` | blocked (connection test failed; sandbox allow-list is GitHub/npm/PyPI only) |

This matches every prior audit in this repo (`SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md` line 43: "this environment holds **no** production/Neon/R2 credentials (env inspected, names only)"). Therefore, statements below about *which Vercel environments hold which variables* are derived from repository records and are explicitly labelled **UNVERIFIED** where the dashboard is the only source of truth. Exact owner-side read-only checks that close each gap are listed in §7.

**Sources actually examined (all read-only):**

- Application code: `src/lib/object-storage.ts`, `src/lib/upload-storage.ts`, `src/lib/upload-mode.ts`, `src/lib/upload-auth.ts`, `src/app/api/uploads/route.ts`, `src/app/api/uploads/presign/route.ts`, `src/app/api/files/[id]/route.ts`, `src/app/api/assignments/[id]/submit/route.ts`, `src/components/dashboard/FileUploader.tsx`, `src/db/schema.ts`, `drizzle/0010_object_storage.sql`, `src/app/api/health/route.ts`.
- Tests: `tests/object-storage-real-provider-harness.test.ts`, `tests/object-storage-harness-safety.test.ts`, `tests/object-storage-r2.test.ts`.
- Repo records: `.env.example`, `README.md`, `SECURITY_AUDIT_ISSUE54_REPORT.md`, `SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md`, `SECURITY_VERIFICATION_REPORT_PR49.md`, `SECURITY_REVIEW_OCT25_FINAL_REPORT.md`, `docs/REVIEW_PR40_BROWSER_VERIFICATION.md`, `docs/BACKUP_RESTORE_VERIFICATION.md`.
- GitHub (REST API, read-only): Issues #54; PRs #13/#14/#40/#41/#49/#55/#59/#63–#66/#68 bodies + comments (including Vercel-bot deployment metadata); repository deployment list; GitHub environment names.

**Vercel project facts established from Vercel-bot metadata on PRs:**

- Current project: **`easylearn`** (`prj_9q2A950CdVcmjWlsLwCmIk7ZEM60`), team `shadrachampah123s-projects`. Latest Production deployment: **2026-11-17**, commit `4069584` (current `main`). Production alias documented in repo records: `https://easylearn-six.vercel.app` (owner-observed `GET /api/health` → HTTP 200 on 2026-10-27).
- A **second, legacy project `easylearnn`** (`prj_UMJnGXOIWQzDRnCMiM5bM1kKTlBo`) built the same repo up to ~2026-10-26; the newest bot payloads (PR #68, Nov 2026) list only `easylearn`. Two projects on one repo means env vars can diverge between them — see §6.
- No `vercel.json` exists in the repo; no deploy script records env configuration; `.github/workflows` never sets any `OBJECT_STORAGE_*` variable (CI does not touch object storage).

---

## 1. The five `OBJECT_STORAGE_*` variables — presence and assigned environments

### 1a. What the code requires (verified from source)

`getObjectStorageConfig()` in `src/lib/object-storage.ts` (lines ~58–88):

| Variable | Role in code | Required for R2 to activate? |
|---|---|---|
| `OBJECT_STORAGE_BUCKET` | bucket name | **YES** — one of the three enable-variables |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | SigV4 credential | **YES** |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | SigV4 signing key | **YES** |
| `OBJECT_STORAGE_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com`; also switches URL style to path-style and region default to `auto` | Not for "enabled", but **for R2 it is mandatory in practice** — without it the code signs AWS-style virtual-hosted URLs (`<bucket>.s3.<region>.amazonaws.com`), which do not exist for R2 |
| `OBJECT_STORAGE_REGION` | SigV4 region; defaults to `auto` when an endpoint is set | No (correct default for R2) |

Enable rule: `enabled = Boolean(bucket && accessKeyId && secretAccessKey)` — **all three must be non-empty** in the running environment; a deployment missing any one silently behaves as "no object storage".

### 1b. Presence per Vercel environment (Production / Preview / Development)

**UNVERIFIED — cannot be read from this environment** (see §0). What the repository records *do* establish:

- **No document, issue, PR, or commit in this repo records the five variables as having been added to the Vercel project** (any environment). Searches across Issues/PRs and all audit docs found zero "set in Vercel" statements for `OBJECT_STORAGE_*`.
- `SECURITY_VERIFICATION_REPORT_PR49.md` (§ checklist) and `SECURITY_REVIEW_OCT25_FINAL_REPORT.md` (line 189) both leave as an **open owner action**: "Verify `OBJECT_STORAGE_PUBLIC_URL` is **unset** in production … in Vercel env dashboard" — i.e., as of the last recorded audit (2026-10-25/27) the dashboard state had never been documented.
- The owner demonstrably **possesses working R2 credentials for this account**: the live provider harness was run by the operator against real Cloudflare R2 (disposable bucket `easylearn-security-test`), first 5/6, then after PR #59's test fix **6/6 passed with verified cleanup** (`SECURITY_AUDIT_ISSUE54_REPORT.md` §7b). Those runs were executed **locally with disposable credentials — not through a Vercel deployment** — so they do not prove the Vercel env vars exist.
- GitHub-side environments `Preview` and `Production` exist on the repo, but their secrets/variables are not readable with the available token (HTTP 403) — and in any case GitHub Actions environments are not Vercel environments; CI never uses storage variables.

**Presence matrix (best available evidence):**

| Variable | Vercel Production | Vercel Preview | Vercel Development |
|---|---|---|---|
| `OBJECT_STORAGE_BUCKET` | UNVERIFIED (owner check §7.1) | UNVERIFIED | UNVERIFIED |
| `OBJECT_STORAGE_ENDPOINT` | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| `OBJECT_STORAGE_REGION` | UNVERIFIED (optional; defaults to `auto` with endpoint) | UNVERIFIED | UNVERIFIED |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | UNVERIFIED | UNVERIFIED | UNVERIFIED |

No secret value was requested, retrieved, or printed at any point; none exists in the repo (`.env.example` contains only commented-out placeholders; `SECURITY_VERIFICATION_REPORT_PR49.md` line 43 previously confirmed `env | grep OBJECT_STORAGE` → no credentials in agent environments).

---

## 2. Configured R2 bucket name

**All repository records identify the production bucket as `easylearn-uploads`.** Evidence:

- `tests/object-storage-real-provider-harness.test.ts` line 43: `export const PRODUCTION_BUCKET = "easylearn-uploads";` — the live harness **refuses to run** when `OBJECT_STORAGE_BUCKET` equals it (guard added after second-pass review F-1/F-2; pinned by `tests/object-storage-harness-safety.test.ts`, wired into `npm test` / `test:uploads`).
- `SECURITY_AUDIT_ISSUE54_REPORT.md` line 29: "Never use production bucket `easylearn-uploads`."
- PR #59 description (merged): "Production bucket `easylearn-uploads` untouched."

Answering objective 5 explicitly:

| Candidate | Verdict |
|---|---|
| **`easylearn-uploads`** | **The production bucket**, per every record in the repo. |
| `easylearn-backups` | **Zero mentions anywhere** (code, docs, issues, PRs). Not referenced as the app's bucket. |
| `easylearn-files` | Appears **only as a generic example** in `README.md`, `.env.example`, PR #14 and unit tests — never as the deployed value. |
| `easylearn-security-test` | **Disposable test bucket** used for the operator's live R2 harness runs (6/6 pass, cleanup verified). Not production. |

**Caveat:** the *current value of `OBJECT_STORAGE_BUCKET` inside Vercel* can only be confirmed from the dashboard/CLI (§7.1) or at runtime (§7.2). The bucket name is not a secret, so those checks are safe.

---

## 3. Is Production connected to R2?

**UNVERIFIED from this environment; the code path is fully R2-ready and the signing machinery is live-proven against real R2, but no record shows the Vercel Production environment holding the variables.**

- Production runs current code: latest Production deployment 2026-11-17 @ `4069584` (= `main`), project `easylearn`, alias `easylearn-six.vercel.app` (`/api/health` owner-observed 200 on 2026-10-27).
- R2 support is dependency-free SigV4 in `src/lib/object-storage.ts`; the operator's live run against real Cloudflare R2 passed 6/6 (presigned PUT/GET, tampered-signature rejection, content-type binding, size reporting, response overrides, bounded prefix read) — with a disposable bucket.
- If the three enable-variables (plus the R2 endpoint) are present in Production, then Production **is** on R2: `GET /api/uploads` would answer `{"storage":"object"}` and the browser would PUT directly to `easylearn-uploads`.
- If they are absent, Production **silently runs in local-disk mode** — and on Vercel that mode is broken for real uploads (§5). There is no startup error for missing storage variables; the only production startup guard is `assertObjectStorageConfigForProduction()`, which throws **only** when `OBJECT_STORAGE_PUBLIC_URL` *is* set.
- Two-minute definitive checks for the owner are in §7.1–§7.3 (dashboard listing, authenticated `GET /api/uploads`, and a read-only `uploaded_files.storage_backend` count — the DB records which backend every historical upload actually used).

## 4. Is Preview connected to R2?

**UNVERIFIED — same access limitation, plus two Preview-specific observations:**

- Preview deployments are actively built (GitHub deployment list shows Preview builds through 2026-11-19) on project `easylearn`; whether the Preview environment carries `OBJECT_STORAGE_*` has never been recorded.
- **Risk if Preview does carry them:** unless deliberately pointed elsewhere, Preview would write to the *same production bucket* `easylearn-uploads` (one bucket constant appears in all records). Best practice (and the pattern the repo's own harness enforces for tests) is a separate disposable/staging bucket per non-production environment.
- **Legacy-project risk:** until ~2026-10-26 every PR built previews under **two** Vercel projects (`easylearn` and `easylearnn`). If the legacy project is still connected, its Preview env vars are a separate, unaudited copy. Newest PRs list only `easylearn`, suggesting it was disconnected — owner should confirm (§7.6).

---

## 5. Do uploads fall back to local storage?

**By design, yes — but on Vercel the fallback cannot actually store files. Verified from code:**

1. **Discovery:** `GET /api/uploads` (authenticated) returns `{storage: "object" | "local"}` from `isObjectStorageEnabled()`. `FileUploader.tsx` (line 92) switches to the direct-to-bucket flow only when it sees `"object"`; otherwise it stays on multipart ("stay on local").
2. **Local path:** `POST /api/uploads` writes bytes under `uploadStorageDir()` = `UPLOAD_DIR` or `<cwd>/storage/uploads` (`src/lib/upload-storage.ts`), registering each file in `uploaded_files` with `storage_backend='local'`.
3. **On Vercel's read-only serverless filesystem:**
   - Object storage **enabled** + disk unwritable → the route's non-mutating writability probe returns **409** with `MULTIPART_DISABLED_MESSAGE` ("This deployment stores files in cloud object storage… Retry the upload: the browser should use the direct cloud upload path") — `src/lib/upload-mode.ts` documents this replaced an opaque EROFS 500.
   - Object storage **not enabled** + disk unwritable → the guard does not fire (it keys on filesystem state *and* config), and the write attempt fails on the read-only bundle — uploads simply do not work. `/tmp` is writable but wiped on every invocation/redeploy, and nothing points `UPLOAD_DIR` there by default.
   - Even if bytes landed, Vercel caps request bodies (~4.5 MB), so videos (the 100 MB use case) could never go through the multipart path — that limit is the entire reason PR #14 built the R2 flow.
4. **Consequence:** on Vercel there is **no functional local-disk fallback**. Local mode is for development/self-hosted only. If Production lacks the `OBJECT_STORAGE_*` variables, assignment attachments and learner submissions fail at upload time (and files registered as `'local'` before any redeploy would have had ephemeral bytes anyway).
5. **Serving:** `GET /api/files/[id]` branches on the row's `storage_backend`: `'object'` → 307 redirect to a fresh presigned GET (private bucket, Range-seeking preserved, forced `response-content-type` / `response-content-disposition` / `response-cache-control`); `'local'` → streamed from disk with the same auth/access control. `DELETE /api/uploads/[id]` deletes the object from the bucket.

## 6. Are R2 (or the storage layer) used for assignment attachments AND learner submissions?

**Yes — one storage layer serves both purposes, gated per-deployment by the env vars (code-verified):**

- Both `purpose="assignment"` (teacher materials) and `purpose="submission"` (learner work) flow through the same endpoints: `POST /api/uploads/presign` (object mode) or `POST /api/uploads` (local mode), with role/purpose/assignment authorization in `src/lib/upload-auth.ts` (`authorizeUpload`; submissions require `assignmentId` + enrollment checks).
- Object keys are purpose-scoped: `uploads/assignment/<uuid>.<ext>` and `uploads/submission/<uuid>.<ext>` (`newObjectKey()`).
- Submission attachments are re-verified server-side against `uploaded_files` rows at `POST /api/assignments/[id]/submit` (`resolveUploadedAttachments` in `src/lib/attachment-auth.ts` — uploader + purpose + assignment must match).
- Access control on download: submission files readable only by the uploader, the assignment's teacher, and admins (`src/app/api/files/[id]`).
- SEC-1: `isPublicUrlSafeForPurpose()` returns `false` for both `assignment` and `submission` — presigned URLs always; permanent public URLs never.
- Whether the bytes actually land in R2 depends solely on that deployment's env vars; the `uploaded_files.storage_backend` column (`drizzle/0010_object_storage.sql`, `'local'` default) records which backend each file used.

---

## 6b. Missing configuration / deployment blockers (consolidated)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| B-1 | **Presence of the five `OBJECT_STORAGE_*` variables in Vercel (Production/Preview/Development) is undocumented and unverifiable from the agent environment.** No record shows they were ever added. If missing in Production, all uploads fail (§5). | **Critical (until checked)** | §0, §1b |
| B-2 | `OBJECT_STORAGE_PUBLIC_URL` must be **unset** in production (code throws otherwise unless `OBJECT_STORAGE_ALLOW_PUBLIC_URL=true`); the "verify in dashboard" owner action from the Oct-25 audit was never recorded as done. | High | `SECURITY_VERIFICATION_REPORT_PR49.md` line 81; `assertObjectStorageConfigForProduction()` |
| B-3 | **Bucket CORS for `easylearn-uploads` is unverified.** Browser direct PUT requires AllowedOrigins = production alias (+ preview origins if Preview uses R2), Methods `PUT, GET, HEAD, DELETE`, Headers `content-type`, Expose `ETag`. The harness's 6/6 pass was server-side and proves nothing about browser CORS. | High (only if B-1 resolves to "configured") | README/.env.example CORS block; PR #14 |
| B-4 | **No object-storage backup/versioning**: `docs/BACKUP_RESTORE_VERIFICATION.md` marks file-byte coverage **FAIL as a complete-recovery claim** — DB dumps hold only object keys; bucket versioning/sync and object-count reconciliation vs `uploaded_files` are open corrective steps. | High | doc lines 135–158, 176, 207 |
| B-5 | **Legacy Vercel project `easylearnn`** built the same repo until ~2026-10-26; if still connected, it holds an unaudited duplicate env set and spawns parallel previews. | Medium | Vercel-bot metadata on PRs #14–#59 vs #65–#68 |
| B-6 | **No storage observability**: `/api/health` reports DB/JWT flags only; nothing unauthenticated reveals the storage backend, and `GET /api/uploads` requires login. An env-var regression would surface only as user upload failures. | Medium | `src/app/api/health/route.ts` |
| B-7 | Preview-on-production-bucket risk: nothing records a separate Preview/Development bucket; if Preview carries the same values it writes test uploads into `easylearn-uploads`. | Medium | §4 |
| B-8 | Context (non-R2, still open per Issue #54 records of 2026-10-27): production catalog gaps — `users.session_version` absent, migration ledger absent, 0/26 composite tenant FKs. PRs #58/#65/#66/#68 fixed the code-side fail-closed honesty and production login; the DB reconciliation remains owner/DBA work and gates any production sign-off. | Context | Issue #54 comments; PRs #64–#68 |

---

## 7. Recommended next steps (NOT implemented — owner actions, all read-only unless stated)

1. **Enumerate the variables (closes B-1).** Either connect the Vercel app to this Arena conversation, or in the dashboard: Vercel → team `shadrachampah123s-projects` → project **`easylearn`** → Settings → Environment Variables; or CLI: `vercel env ls production`, `vercel env ls preview`, `vercel env ls development` (lists names/targets/ages — values stay hidden; `vercel env pull` is **not** needed and would write secrets to disk). Confirm for each of the five variables: present? which targets? sensitive-flag on the two keys? Also record whether `OBJECT_STORAGE_PUBLIC_URL`, `OBJECT_STORAGE_ALLOW_PUBLIC_URL`, `UPLOAD_DIR` exist (expected: absent).
2. **Runtime probe (definitive, zero-config).** Signed in as a teacher or learner, call `GET https://easylearn-six.vercel.app/api/uploads` → `{"storage":"object"}` proves Production runs on R2; `{"storage":"local"}` proves the enable-triple is missing/incomplete there. Repeat on the newest Preview URL if Preview matters.
3. **Historical proof from the DB (read-only query).** `SELECT storage_backend, COUNT(*) FROM uploaded_files GROUP BY storage_backend;` — any `'object'` rows prove real users' files already went through R2 in that environment; `'local'` rows quantify files whose bytes were ephemeral.
4. **Bucket sanity (R2 dashboard, read-only).** Confirm `easylearn-uploads` exists, is **private**, has CORS per B-3 for the production origin, and — if versioning is off — enable it (that one change is a write; schedule with the owner). Confirm no app environment points at `easylearn-backups`; confirm what `easylearn-backups` is used for, since nothing in the repo references it.
5. **Environment separation.** Recommended target state: Production → `easylearn-uploads` with a least-privilege R2 API token scoped to that bucket; Preview → a disposable/staging bucket (e.g. the `easylearn-security-test` pattern) with its own token; Development → unset (local disk works on a laptop). Never reuse the production key pair in Preview/Development. (Future change, not made here.)
6. **Decommission or reconcile the legacy `easylearnn` project** (B-5) so exactly one Vercel project builds this repo.
7. **Observability (future PR, not made here).** Add non-sensitive booleans to `/api/health` (e.g. `objectStorageConfigured`, `multipartDisabled`) — no bucket name, no keys — so B-1-class regressions are visible without a login (B-6).
8. **Close the audit trail.** Record the results of steps 1–4 on Issue #54 (or a successor), replacing the "UNVERIFIED" cells in §1b, and keep the production sign-off NO-GO until B-1–B-4 and the Issue #54 DB items are resolved.

---

## Appendix — evidence index

| Claim | Source |
|---|---|
| Enable rule = bucket + access key + secret key; endpoint ⇒ path-style + region `auto` | `src/lib/object-storage.ts` `getObjectStorageConfig()` |
| Backend discovery `object`/`local`; client switches flow | `src/app/api/uploads/route.ts` GET; `src/components/dashboard/FileUploader.tsx` line 92 |
| 409 `MULTIPART_DISABLED_MESSAGE` on read-only FS; EROFS-500 history | `src/lib/upload-mode.ts`; `src/app/api/uploads/route.ts` `uploadDirIsWritable()` |
| Local dir default `<cwd>/storage/uploads`, override `UPLOAD_DIR` | `src/lib/upload-storage.ts`; `.env.example` |
| Purpose-scoped keys `uploads/{assignment,submission}/<uuid>` | `newObjectKey()` in `src/lib/object-storage.ts` |
| 307 → presigned GET; forced response type/disposition/cache; SEC-1 no public URLs for either purpose | `src/app/api/files/[id]/route.ts` lines ~150–201; `objectDownloadUrl`, `isPublicUrlSafeForPurpose` |
| `storage_backend` column (`local` default) | `drizzle/0010_object_storage.sql`; `src/db/schema.ts` |
| Submission attachment re-verification | `src/app/api/assignments/[id]/submit/route.ts`; `src/lib/attachment-auth.ts` |
| Production bucket = `easylearn-uploads` | harness line 43; safety test lines 56–62; audit report line 29/172; PR #59 |
| Disposable bucket `easylearn-security-test`; live R2 6/6 + verified cleanup | `SECURITY_AUDIT_ISSUE54_REPORT.md` §7b; PR #59 |
| No credentials in agent environments (precedent) | `SECURITY_VERIFICATION_REPORT_PR49.md` line 43; follow-up doc line 43 |
| Owner action "verify PUBLIC_URL unset in Vercel env dashboard" open | `SECURITY_REVIEW_OCT25_FINAL_REPORT.md` line 189; PR49 report line 81 |
| Production alias `easylearn-six.vercel.app`, `/api/health` 200 (2026-10-27) | follow-up doc line 65 |
| Latest Production deployment 2026-11-17 @ `4069584`; active Previews through 2026-11-19 | GitHub deployments API |
| Two Vercel projects historically; only `easylearn` now | Vercel-bot payloads on PRs #14/#40/#59 vs #65/#66/#68 |
| Object bytes not covered by DB backups | `docs/BACKUP_RESTORE_VERIFICATION.md` lines 135, 158, 176 |

*No secret value appears in this report; none was available to the auditor. Access keys were never requested, retrieved, or printed.*
