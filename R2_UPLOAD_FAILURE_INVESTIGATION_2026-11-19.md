# EasyLearn — R2 Upload Failure Investigation (read-only)

**Date:** 2026-11-19 · **Production deployment:** `4069584` (2026-11-17T21:20:13Z) = current `main` — the code examined here is exactly the code running in Production.
**Mode:** strictly read-only. No code, env var, Cloudflare setting, DB record, or deployment was modified. No secret value was retrieved or printed. Production and R2 were **not reachable from this sandbox** (network allow-list is GitHub/npm/PyPI only; no Vercel connector), so all conclusions are derived from code-path evidence plus the reported observations.

> **RESOLVED 2026-11-19 (after this report was written; body left unchanged).** The owner corrected the Cloudflare R2 **bucket CORS policy**, and assignment uploads, learner submissions and downloads were then all verified working in Production. That confirms hypothesis **H1 (CORS policy mismatch)** and rejects **H2 (endpoint not live / `amazonaws.com` mis-signing)**. R2 integration is recorded as COMPLETED in `docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md`; the finding previously tracked as C-1 in `FULL_PRODUCTION_AUDIT_2026-11-19.md` is closed. The one residual item is documentation: the CORS policy lives only in Cloudflare, so its exact allowed origins, methods and headers should be recorded alongside the `OBJECT_STORAGE_*` variables — a rebuilt bucket would otherwise reintroduce this exact failure with no code change to explain it.

**Reported observations (taken as given):**
1. Production `GET /api/uploads` → `{"success":true,"data":{"storage":"object"}}`
2. All five `OBJECT_STORAGE_*` variables assigned to Production and Preview
3. Production domain added to the R2 CORS policy
4. Bucket is `easylearn-uploads`
5. Assignment-attachment upload fails with **"Network error — the upload could not be completed."**

---

## 1. Verdict summary

- **The failing request is established exactly:** the browser's cross-origin `XMLHttpRequest PUT` of the file bytes to the presigned bucket URL (and its mandatory CORS preflight `OPTIONS`) — `putFile()` in `src/components/dashboard/FileUploader.tsx`, error emitted at **line 186** (`xhr.onerror`). The failure happens at the **network layer, before any HTTP response is available to the page**.
- **Everything server-side is excluded by evidence** (see §4): the presign API call *succeeded* (its failures produce different messages), and every R2-side rejection (bad key, bad signature, wrong region, missing permission, missing bucket, expired URL) would return an HTTP status and produce the *other* message, `"The upload to cloud storage failed (HTTP xxx)"` (line 180–185). The user did not see that message.
- **Root cause class (established):** the browser was prevented from completing the presigned PUT — either **(H1)** R2's CORS policy for `easylearn-uploads` does not effectively match the real request, or **(H2)** the presigned URL's *host* is not the reachable R2 endpoint (most plausibly: the **running** Production deployment does not carry a valid `OBJECT_STORAGE_ENDPOINT`, so the code signed an AWS-style `https://easylearn-uploads.s3.<region>.amazonaws.com/...` URL, or the endpoint host has a typo → DNS failure).
- **The single exact root cause cannot be established from this sandbox** — the discriminating evidence (browser console/network output, the bucket's CORS policy JSON, the endpoint hostname baked into the live deployment) exists only owner-side. §5 lists each missing item and the 30-second check that discriminates H1 from H2. **Per the no-guessing rule, both hypotheses are stated with their evidence, and neither is asserted as fact.**
- **Smallest safe fix:** depends on the branch — H1: correct the bucket CORS JSON (config-only, no redeploy, immediate). H2: ensure a valid `OBJECT_STORAGE_ENDPOINT` is present **in the deployment** (Vercel bakes env at deploy time — a redeploy of current `main` is required for post-2026-11-17 env edits to take effect). Details in §6.

---

## 2. Complete flow trace (frontend → API → Cloudflare R2)

**Step 0 — backend discovery (works; observation #1).**
`FileUploader` mounts → `apiFetch("/api/uploads")` (same-origin, session cookie; `src/lib/api-client.ts` — `credentials:"same-origin"`, Authorization stripped) → `src/app/api/uploads/route.ts` GET → `isObjectStorageEnabled()` → `{"storage":"object"}` → component sets `mode="object"` (`FileUploader.tsx:86–97`). **This proves the live Production function sees non-empty `OBJECT_STORAGE_BUCKET` + `OBJECT_STORAGE_ACCESS_KEY_ID` + `OBJECT_STORAGE_SECRET_ACCESS_KEY`** (`object-storage.ts`, `getObjectStorageConfig()`: `enabled = Boolean(bucket && accessKeyId && secretAccessKey)`). Note what it does **not** prove: `OBJECT_STORAGE_ENDPOINT` is *optional* for `enabled` — see H2.

**Step 1 — file selection & client validation (works).**
Teacher form (`src/app/dashboard/teacher/assignments/page.tsx:280`, `purpose="assignment"`) → `handleFiles` → `validateFile` (client mirror of server allow-list/size rules) → `uploadOne` → `mode==="object"` → `uploadOneDirect` (`FileUploader.tsx:128–160`).

**Step 2 — presign (SUCCEEDED — proven by the message the user saw).**
`POST /api/uploads/presign` (`apiFetch`, JSON metadata only, no bytes) → `src/app/api/uploads/presign/route.ts`:
- `guardSchoolContext` (auth+tenant) → extension allow-list & scriptable-MIME refusal → size limits (100 MB video / 50 MB other) → `authorizeUpload` (teacher may upload `assignment` material) → `config.enabled` check (would answer **503 "Cloud object storage is not configured…"** if the triple were missing — not seen) → `ensureFileUploadSchema()` (0009/0010 self-heal) → `newObjectKey("assignment", ext)` = `uploads/assignment/<uuid>.<ext>` → `presignedUploadUrl(config, key, contentType)` (SigV4) → **INSERT `uploaded_files` row (`storage_backend='object'`)** → **201** with `{fileId, attachment, upload:{method:"PUT", url, headers:{"Content-Type": <server-derived type>}, expiresInSeconds:300}}`.
- Any failure here surfaces as `data.error` / "The upload could not be prepared…" / the 503 text / a schema-aware 500 (`FileUploader.tsx:144–146`) — **none of which is the observed message**. Therefore the presign call returned 201 and the DB row was created.

**Step 3 — direct PUT to the bucket (THIS IS WHERE IT FAILS).**
`putFile()` (`FileUploader.tsx:163–190`): raw `XMLHttpRequest` (not `apiFetch` — no cookies are sent cross-origin), `xhr.open("PUT", presigned.url)`, `xhr.setRequestHeader("Content-Type", …)` exactly the signed value, `xhr.send(file)`.
Because the request is cross-origin, the method is `PUT` (never CORS-safelisted) and the header `Content-Type: application/pdf|image/png|video/mp4|…` is not a safelisted value, the browser **must first send a preflight**:

```
OPTIONS <presigned-url>            →  R2 (bucket CORS policy is evaluated)
Origin: https://easylearn-six.vercel.app        (the page's real origin)
Access-Control-Request-Method: PUT
Access-Control-Request-Headers: content-type
```

R2 must answer with `Access-Control-Allow-Origin: <exact origin>`, `Access-Control-Allow-Methods` including PUT, `Access-Control-Allow-Headers` including `content-type`; then the actual PUT response must again carry `Access-Control-Allow-Origin`. **If any of these is missing — or if the URL's host doesn't resolve/refuses — the browser discards everything and fires `xhr.onerror` with zero status detail, and the UI shows exactly: "Network error — the upload could not be completed."** (`FileUploader.tsx:186`).

**Step 4 — signature check by R2 (never reached, or its answer discarded).**
Had the PUT reached R2 with a readable response, every credential/signature/permission problem would return 403/404/400 → `xhr.onload` → `"The upload to cloud storage failed (HTTP <status>). Please try again."` (lines 180–185). The SigV4 implementation itself is **live-proven against real Cloudflare R2**: the operator harness passed **6/6** (presigned PUT/GET, tampered-signature 403, content-type binding, size reporting, response overrides, bounded prefix read) — `SECURITY_AUDIT_ISSUE54_REPORT.md` §7b, PR #59. That harness ran **server-side**: no browser, no preflight, no CORS — which is why a CORS/endpoint problem could pass every recorded test and fail only now (see §4.6).

**Step 5 — post-upload (not reached).** On success the attachment is added to the form; the later `POST /api/assignments` re-verifies attachments against `uploaded_files` (`src/lib/attachment-auth.ts`); downloads go `GET /api/files/[id]` → 307 → presigned GET (`files/[id]/route.ts:150–201`). None of this participates in the reported failure.

---

## 3. The exact failing request

| Property | Value |
|---|---|
| Request | `PUT` (preceded by mandatory `OPTIONS` preflight) |
| URL (as designed) | `https://<account_id>.r2.cloudflarestorage.com/easylearn-uploads/uploads/assignment/<uuid>.<ext>?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=…&X-Amz-Expires=300&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=…` |
| Request header | `Content-Type: <server-derived type>` (signed; must be echoed verbatim — it is) |
| Origin | the production page origin (records: `https://easylearn-six.vercel.app`) |
| Failure signal | `xhr.onerror` → `FileUploader.tsx:186` → "Network error — the upload could not be completed." |
| Meaning | The browser never obtained a usable HTTP response: preflight/PUT blocked by CORS, DNS/TLS failure on the URL host, or client-network interference. |

The observed string exists in exactly two places in the codebase (`FileUploader.tsx:186` object path, `:216` multipart path). The multipart path is excluded: the live deployment reports `"object"` (observation #1, and detection clearly succeeded in the teacher's browser), and in object mode on Vercel's read-only filesystem the multipart POST would answer **409** with `MULTIPART_DISABLED_MESSAGE` (`upload-mode.ts` + `uploads/route.ts` writability probe) — a readable HTTP response producing a *different* error text. Therefore **line 186 — the direct PUT — is the failure site.**

---

## 4. Area-by-area findings

### 4.1 Presigned URL generation — code correct; one configuration trap
`presignUrl`/`objectUrlParts` (`src/lib/object-storage.ts`): with `endpoint` set → path-style R2 URL `/<bucket>/<key>` (pinned by unit tests `tests/object-storage-r2.test.ts:211–227` and proven live 6/6). **Without `endpoint` → AWS virtual-hosted URL `https://<bucket>.s3.<region>.amazonaws.com/<key>`** — silently, with no error, because endpoint is optional in `getObjectStorageConfig()`. URL generation performs no DNS/validation, so presign returns 201 either way. This trap is hypothesis H2 (§5).

### 4.2 R2 credentials — excluded as the cause of THIS symptom
The live function holds the triple (Step 0). An invalid/rotated/unauthorized key would make **R2 answer HTTP 403** (`InvalidAccessKeyId` / `SignatureDoesNotMatch` / `AccessDenied`) → the *onload* branch → "…failed (HTTP 403)". The user saw the *onerror* message ⇒ **no readable R2 response ever arrived** ⇒ credential/permission problems are ruled out for this incident. (Their validity remains untested end-to-end until the PUT actually reaches R2.)

### 4.3 Bucket permissions — excluded, same reasoning (any S3 API denial is an HTTP response).

### 4.4 CORS — prime suspect (H1); never verified anywhere in the project record
The bucket CORS policy is the only *required, browser-only* configuration in this flow, and **no recorded test ever exercised it**: the live R2 harness is server-side; the Puppeteer browser verification (`tests/manual/browser-upload-verification.js`) ran a **local-disk** deployment (`UPLOAD_DIR`, disposable DB); `docs/REVIEW_PR40_BROWSER_VERIFICATION.md` step **E5** ("repeat against an object-storage deployment") was deferred and never recorded as done. Specific ways "the production domain was added" can still fail the exact-match preflight:
- **Origin string mismatch** — the policy must contain the page's *exact* origin. Records show production is served at `https://easylearn-six.vercel.app`; adding `https://easylearn.vercel.app` (project default domain), a preview URL, a custom domain that isn't in use, or any string with a **trailing slash** fails the match.
- **`AllowedMethods` missing `PUT`** (e.g. only GET/HEAD added).
- **`AllowedHeaders` missing `content-type`** (the preflight requests it; `*` also works).
- **Policy attached to the wrong bucket** — the project's history includes a second bucket (`easylearn-security-test`, the disposable test bucket).
- **Policy not saved / invalid JSON** (Cloudflare's CORS editor accepts only a well-formed array).

### 4.5 Endpoint value in the RUNNING deployment — co-prime suspect (H2)
Vercel **bakes env values at deploy time**. The running Production deployment is from **2026-11-17T21:20Z**. "All five variables are *now* assigned" does not prove the running deployment contains a valid `OBJECT_STORAGE_ENDPOINT`:
- If the endpoint was added/edited **after** that deployment, the live function still runs without it → `enabled` is true (triple present) → **AWS-style `amazonaws.com` URL is signed** → the browser preflights against S3, which has no CORS rule for this bucket → blocked → exactly the observed network error. (Same outcome if `OBJECT_STORAGE_REGION=auto` with empty endpoint: `s3.auto.amazonaws.com` is a DNS dead end.)
- A typo in the `<account_id>` host → NXDOMAIN → identical symptom.
- These are fully consistent with every reported observation, including `"storage":"object"`.

### 4.6 Upload response handling (frontend) — no defect found
`putFile` implements the XHR contract correctly: signed Content-Type echoed verbatim; `onload` branches on status with an actionable message; `onerror` produces the observed generic message (the browser deliberately exposes no detail for CORS/network failures — this is a diagnostics gap, not the cause). No cookies/Authorization are attached to the cross-origin PUT. One robustness note: the 300 s PUT expiry (`SEC-6`, `object-storage.ts:83`) can time out 100 MB videos on slow links — but that failure mode returns HTTP 403 (*onload* message), so it is **not** this incident.

### 4.7 App-side blockers — excluded
- **CSP:** production policy is `connect-src 'self' https:` with `upgrade-insecure-requests` (`src/proxy.ts:21–36`) → any HTTPS host (R2 included) is allowed; even an `http://` endpoint value would be upgraded to https by the browser. CSP is not blocking this XHR.
- **CSRF proxy:** only guards the app's own `/api/*`; the PUT goes straight to R2. The presign POST is same-origin and passed.
- **Vercel body limit:** irrelevant — bytes never traverse the serverless function (that is the point of the design).
- **DB/schema:** the presign INSERT succeeded (otherwise a 500/503 message) — migrations 0009/0010 are effectively present in Production.
- **Client-network interference** (school/ISP/proxy blocking `*.r2.cloudflarestorage.com`) remains a residual possibility (H3) if the failure is specific to one reporter/network.

---

## 5. Root cause determination and the missing evidence

**Established beyond doubt (code + observations):** the presigned direct PUT from the browser to the bucket fails at the network layer; all server-side and R2-HTTP-level causes are excluded; the two live hypotheses are:

| # | Hypothesis | Consistent with all facts? | Discriminating evidence |
|---|---|---|---|
| **H1** | `easylearn-uploads` CORS policy does not effectively match the real request (origin string / missing PUT / missing `content-type` / wrong bucket / unsaved) | Yes | Browser console CORS text; preflight probe (§5.1); policy JSON |
| **H2** | Running Production deployment signs a non-R2/unreachable host — missing-or-typo'd `OBJECT_STORAGE_ENDPOINT` (env added after the 2026-11-17 deploy is **not live** until redeploy) | Yes | Network-tab PUT host (`amazonaws.com` = smoking gun); endpoint value + deploy timeline |
| H3 | Client-network blocking of `cloudflarestorage.com` (single network/reporter only) | Yes, if not universal | Failure universality across users/networks |

**Missing evidence (any ONE item settles it — all owner-side, all read-only, none requires exposing a secret):**

1. **Browser DevTools → Network tab** during one failed attempt: (a) the **host** of the failed `OPTIONS`/`PUT` — `*.r2.cloudflarestorage.com` ⇒ H1/H3, `*.amazonaws.com` ⇒ H2 (endpoint not live), NXDOMAIN on an R2 host ⇒ H2 (typo); (b) the preflight's status and its `access-control-allow-*` response headers ⇒ pinpoints which CORS field fails.
2. **Browser DevTools → Console** text: Chromium prints the exact CORS failure reason ("No 'Access-Control-Allow-Origin' header…", "Method PUT is not allowed…", "Request header field content-type is not allowed…"), or `net::ERR_NAME_NOT_RESOLVED` (H2 typo), or `ERR_BLOCKED_BY_CLIENT`/proxy errors (H3).
3. **The bucket's CORS policy JSON** (Cloudflare dashboard → R2 → `easylearn-uploads` → Settings → CORS policy) compared against the required shape in §6a — not a secret.
4. **The `OBJECT_STORAGE_ENDPOINT` value visible to the CURRENT Production deployment** (Vercel → project `easylearn` → Deployments → current → Environment Variables; the endpoint hostname is not a credential — do not print the two keys) **plus the assignment timestamps vs the 2026-11-17T21:20Z deploy**. Expected format: `https://<32-hex-account-id>.r2.cloudflarestorage.com` — https scheme, host only, no path, no trailing slash.
5. **Failure universality:** does every user on every network fail, or only the reporter? (H3 check.)

### 5.1 Unauthenticated preflight probe (safe, no credentials, creates nothing)

From any machine with unrestricted internet (this sandbox is network-restricted and could not run it):

```bash
curl -sS -i -X OPTIONS \
  "https://<ACCOUNT_ID>.r2.cloudflarestorage.com/easylearn-uploads/uploads/assignment/cors-probe.bin" \
  -H "Origin: https://easylearn-six.vercel.app" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type"
```

Interpretation: `204/200` **with** `access-control-allow-origin: https://easylearn-six.vercel.app`, allow-methods containing `PUT`, allow-headers containing `content-type` ⇒ CORS is fine ⇒ H2 (check the endpoint host in the presigned URL the app actually generates). Missing ACAO / `403` ⇒ **H1 confirmed**. `curl: (6) Could not resolve host` ⇒ **H2 (typo) confirmed**. A preflight never authenticates and never creates/reads objects — it is read-only by construction.

---

## 6. Smallest safe fix (per branch — NOT implemented here)

**a) If H1 (CORS mismatch):** update the CORS policy **on bucket `easylearn-uploads`** to exactly (adjust origins to the real production origin(s) in use; one exact string each, no trailing slashes; do **not** add preview domains to the production bucket — per the prior audit, Preview should point at a disposable bucket):

```json
[
  {
    "AllowedOrigins": ["https://easylearn-six.vercel.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD", "DELETE"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Config-only; effective immediately; no code change, no redeploy. Verify with the §5.1 probe, then one real attachment upload + opening it (download path).

**b) If H2 (endpoint not live / wrong):** ensure `OBJECT_STORAGE_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com` (and `OBJECT_STORAGE_REGION=auto`) are set on the Vercel project, then **redeploy current `main`** (Vercel only applies env changes to new deployments — this is the step that makes the already-assigned values live). No code change. Verify the same way; the Network-tab PUT host must now be `*.r2.cloudflarestorage.com`.

**c) If H3 (client network):** no server-side change; confirm from a second network/device; if a specific ISP/proxy blocks `cloudflarestorage.com`, that is an infrastructure decision for the school, not an app fix.

**Deliberately NOT recommended as "the fix":** any code change. The upload code path is verified correct end-to-end and its signing is live-proven against real R2; the evidence places the defect in configuration/deployment state, and the smallest safe fix is configuration-side.

---

## 7. Side observations (no action taken)

1. **Orphaned DB rows:** each failed attempt already inserted an `uploaded_files` row at presign time (`storage_backend='object'`, no bytes behind it); the client only deletes rows for attachments the user removes. A read-only `SELECT count(*) FROM uploaded_files WHERE storage_backend='object'` will (a) corroborate that presign succeeded N times and (b) quantify orphans. Cleanup is a write operation — out of scope here; note for a later maintenance task.
2. **Diagnostics gap (future, optional):** `xhr.onerror` cannot distinguish CORS/DNS/block, so every future incident needs DevTools. A small enhancement (e.g., surfacing `xhr.status===0` context, or a health flag `objectStorageConfigured` + endpoint *host* — never keys) would shorten triage; not required for this fix.
3. **Expiry tuning (separate issue):** presigned PUT lifetime is 300 s; a 100 MB video on a slow uplink can exceed it and fail as "HTTP 403". `OBJECT_STORAGE_UPLOAD_EXPIRY` exists for that; unrelated to the current network-level failure.

## Appendix — evidence index

| Fact | Source |
|---|---|
| Error string emitted only at `xhr.onerror` (both paths) | `src/components/dashboard/FileUploader.tsx:186,216` (repo-wide grep: only matches) |
| Object-mode flow: presign → `putFile` XHR PUT; different messages for presign failure and HTTP failure | `FileUploader.tsx:128–190` |
| Presign success path: auth → rules → `enabled` check → schema self-heal → key → SigV4 → INSERT → 201 | `src/app/api/uploads/presign/route.ts` |
| `enabled` = bucket+key+secret only; **endpoint optional**; region default `auto` iff endpoint set | `src/lib/object-storage.ts` `getObjectStorageConfig()` |
| Endpoint set ⇒ path-style R2 URL; endpoint empty ⇒ AWS virtual-hosted URL | `src/lib/object-storage.ts` `objectUrlParts()` |
| Signed PUT headers `content-type;host`; expiry default 300 s | `presignUrl()`, `object-storage.ts:83` |
| Multipart path on Vercel would answer 409 with a different message | `src/lib/upload-mode.ts`; `src/app/api/uploads/route.ts` writability probe |
| CSP allows all https connect-src; `upgrade-insecure-requests` | `src/proxy.ts:21–36` |
| `apiFetch` same-origin only; PUT does not use it | `src/lib/api-client.ts`; `FileUploader.tsx:163–190` |
| SigV4 live-proven against real R2 (server-side, 6/6, disposable bucket) | `SECURITY_AUDIT_ISSUE54_REPORT.md` §7b; PR #59 |
| Browser verification recorded only in local-disk mode; E5 object-storage browser check deferred, never done | `tests/manual/browser-upload-verification.js` header; `docs/REVIEW_PR40_BROWSER_VERIFICATION.md` E5; follow-up doc |
| Production deployment = `4069584` = `main` (2026-11-17T21:20:13Z); production alias `https://easylearn-six.vercel.app` | GitHub deployments API; `SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md:55,65` |
| Sandbox cannot reach Production/R2/Vercel (allow-list); no Vercel connector | verified this session (`api.vercel.com` connection test failed; connector status `disconnected`) |

*No secret value appears in this report; none was requested, retrieved, or printed.*
