# PR #40 — Independent Review, Browser Verification and Browser Test Plan

**Repository:** `shadrachampah123/easylearn`
**Branch under review:** `security/address-independent-review-findings` @ `d2d05d86ef34810cd84867908665adf2510ef663`
**Base:** `main` @ `016d229183cb615980992178869bb5b17e42962f`
**PR:** <https://github.com/shadrachampah123/easylearn/pull/40> — **OPEN, DRAFT**
**Incremental diff reviewed:** `3e7b3114fa05798a07b3358f71c3c698dcad1830` (PR #39) → `d2d05d8` (PR #40)
**Status:** REVIEWED — **not merged, not deployed.** Stopping for human approval.

> **Independence disclosure.** This review was produced by the same agent that
> implemented PR #40. It is **not** an independent review and must not be
> treated as one. An independent reviewer is still required before PR #40 is
> merged.

---

## 1. What was verified before the review started

| Item | Expected | Observed | Verdict |
|---|---|---|---|
| PR #40 head SHA | `d2d05d8` | `d2d05d86ef34810cd84867908665adf2510ef663` | ✅ |
| PR #40 base | `main` | `main` @ `016d229` | ✅ |
| PR #40 state | draft, open | `OPEN`, `isDraft: true` | ✅ |
| PR #40 merge state | clean | `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE` | ✅ |
| CI on PR #40 | green | run `39350715493` — "Tests, PostgreSQL isolation, typecheck, build, lint" **success**; Vercel **pass** | ✅ |
| PR #39 | unchanged | `3e7b3114fa05798a07b3358f71c3c698dcad1830`, draft, open | ✅ |
| PR #38 | unchanged | `15c6cc8ed3b0cefbbd31ed0e19b0523378fc6b8e`, draft, open | ✅ |
| PR #37 | unchanged | `329dfc97bfa4f35aed0c0d95bb0064893ae8f983`, draft, open | ✅ |
| PR #36 | unchanged | `4790ecf6417df093f125f2e54e82ad75e34a9005`, draft, open | ✅ |
| PR #35 | unchanged | `0b736d5e0ea2368ef7a7c2cf11b5441ed9be506a`, draft, open | ✅ |
| Remote refs | only the PR #40 branch added | `security/address-independent-review-findings` is the only new remote head | ✅ |
| Production data / secrets / settings / migrations | untouched | nothing in this review touched production | ✅ |

The incremental diff is **15 files, +2731 / −174** across three commits:
`12c1346` (implementation), `d64180a` (tightened assertions), `d2d05d8`
(guarded mutation artifact).

---

## 2. Findings

Severity is this reviewer's own classification. **Nothing in §2 is a
regression introduced by PR #40**; two findings are pre-existing and one is a
documentation/behaviour mismatch inside PR #40's own diff.

### F-1 — LOW / availability — the default configuration still derives the scheme from a client-suppliable header

**Where:** `src/lib/csrf.ts` (`requestScheme`), §4 of
`docs/SECURITY_AUTHENTICATION.md`.

**What.** PR #40's policy is: in the default configuration the origin is the
`Host` header plus the scheme of the request URL, and "the forwarded headers
are **not** consulted". That is true for `X-Forwarded-Host` and **not** true
for `X-Forwarded-Proto`, because Next.js builds the request URL's protocol
from that header:

```js
// next/dist/server/next-server.js:1300
const protocol = req.headers["x-forwarded-proto"]?.includes("https") ? "https" : "http";
```

and the server synthesises the header when it is absent
(`next/dist/server/base-server.js:566`).

**Evidence — measured against a production build on a disposable database**
(`POST /api/auth/select-school`, same-origin `Origin`, single-school teacher):

| Request headers | Status |
|---|---|
| none | **200** |
| `X-Forwarded-Host: evil.test` | **200** ← the host is genuinely ignored |
| `X-Forwarded-Proto: https` | **403** ← the scheme still follows the header |
| `X-Forwarded-Proto: http` | **200** |
| `X-Forwarded-Host: evil.test` + `X-Forwarded-Proto: https` | **403** |

**Why it is not a cross-origin hole.** The **host** still comes from the
`Host` header, which the server routes on. A client cannot make a foreign
origin acceptable: it would have to name another host in `Origin`, and the
derived host would still be the one the request was addressed to. The header
can only cause a **refusal** — a self-inflicted denial. A browser cannot set
`X-Forwarded-Proto` on a cross-site request without a CORS preflight, and the
application enables no CORS.

**Consequence.** The documented deployment rule is right and is now stated
precisely: **`EASY_LEARN_PUBLIC_ORIGIN` is the only configuration in which
neither half of the compared origin depends on a forwarded header.** It is
also the only configuration that survives an edge that appends to
`X-Forwarded-Proto`.

**Status.** Corrected in the follow-up PR (§6): the module comment and §4 now
state exactly this, and two regression tests pin both halves of it. No
behaviour was changed.

---

### F-2 — MEDIUM / pre-existing, functional — a user who is a member of two schools cannot open their own uploaded files

**Where:** `sqlSchoolsOfFile` / `sqlOwnedBySchool`, `src/lib/tenant.ts`.

**What.** `GET /api/files/<id>` resolves the file's owning school
**relationally** — the schools of its uploader and of its assignment — and
then requires that set to resolve to *exactly one* school. A teacher who is an
active member of two schools produces a set of two, so the file is denied in
**both** schools: the upload succeeds and the file is then unreachable by
anyone.

**Evidence.** A production build on a disposable database, a teacher with two
active memberships, one file uploaded through the real upload UI:

```
POST /api/uploads            → 201 (the file is created and stored)
GET  /api/files/<id>         → 404 {"success":false,"error":"File not found"}
```

The same file uploaded by a **single**-membership teacher in the same school
is served with **200**. The failure is not about the uploaded-file policy: it
is the tenant predicate.

**Pre-existing, not a regression.** `sqlSchoolsOfFile` is byte-for-byte
identical in `main`, PR #38, PR #39 and PR #40 (`git show <ref>:src/lib/tenant.ts`).
More importantly, the behaviour is **deliberate and already asserted** by an
existing regression test:

```ts
// tests/tenant-authorization-db.test.ts
/* A file that is reachable from School A (its assignment) and from School B (its
   uploader) is still unattributable under the relational file predicate. */
assertEq(result.status, 404, "a file two schools can reach must be denied to both");
```

**Why it matters here.** PR #40's stated requirement is *"preserve legitimate
assignment submissions, previews and downloads"*. That requirement is met for
single-school accounts; for a shared identity the preview and the download do
not work. PR #40's own live probe (`tests/manual/live-upload-content-probe.js`)
seeds a **single**-school account, so this case was never exercised.

**Recommendation — NOT implemented here.** The file's own
`uploaded_files.school_id` is `NOT NULL` (migration 0017), written
server-side from the authenticated school context and never taken from the
request body, so it is authoritative. Reading the file's owning school from
that column would fix the false "reachable from two schools" signal without
weakening isolation (a file uploaded in school A stays invisible in school B,
including for a uploader who is a member of both). **But that is a
tenant-isolation change and it contradicts a deliberate existing test**, so it
needs its own independently reviewed change. It is recorded in §7 and §9 of
`docs/SECURITY_AUTHENTICATION.md` as risk #12.

---

### F-3 — LOW / pre-existing, design — the object-storage path cannot content-validate the bytes

**Where:** `src/app/api/uploads/presign/route.ts`, `src/lib/object-storage.ts`.

**What.** When `OBJECT_STORAGE_*` is configured, the browser PUTs the bytes
straight to the bucket and the application never sees them. The server can
therefore bind the **content type** (it does — the signed PUT requires exactly
the allow-list's type) but it cannot check that the bytes **are** what the
extension says. A user can store arbitrary bytes under an allowed extension.

**What PR #40 does about it.** The download forces the server-determined type
and the safe disposition onto the object store's own response through
`response-content-type` and `response-content-disposition`, and PR #40 signs
those overrides so they cannot be swapped out by whoever holds the URL.

**Measured residual risk (this review).** S3-compatible stores let a presigned
GET override only `response-content-type`, `response-content-disposition` and
`response-cache-control`. **`nosniff` and `Content-Security-Policy` cannot be
forced onto the bucket's response** — the headers PR #40 sets on the `307`
apply to the redirect, not to the object the browser then fetches.

The open question was whether that missing `nosniff` lets HTML bytes served
as `image/png` execute. **It does not, in Chromium 153** — measured, nine
header combinations (`tests/manual/browser-content-type-sniffing-probe.js`):

| Response | What Chromium did |
|---|---|
| `image/png` + inline, no `nosniff` | `document.contentType: image/png`, **0** `<script>` elements, **no execution** |
| `image/png` + inline + `nosniff` | not rendered as a document, no execution |
| `image/png` + inline + sandbox CSP | not rendered as a document, no execution |
| `application/octet-stream` + inline, no `nosniff` | **downloaded** (`net::ERR_ABORTED`), no execution |
| `application/octet-stream` + attachment | downloaded, no execution |
| `text/plain` + inline, no `nosniff` | rendered as **literal text** (`contentType: text/plain`), **0** `<script>` elements, no execution |
| `text/plain` + attachment | downloaded, no execution |
| a **real PNG** + inline + `nosniff` + sandbox | **decoded as an image** (`naturalWidth: 1`) |
| a **real PNG** + inline + sandbox, no `nosniff` | decoded as an image |

**0 of 9 combinations executed script.** The property that holds everywhere is
the one the policy guarantees: **the served content type is never scriptable**,
and unknown types are served as `application/octet-stream` with a download
disposition.

**What remains open.** Content *integrity* (not execution): a user can store
mis-labelled bytes, and the object store's response carries one fewer
defensive layer than the local-disk path. Closing it properly needs a
server-side validation step after the PUT — fetch the head of the object and
compare it with the extension. **Firefox and Safari were not available** and
have their own sniffing rules; the served-type guarantee is what holds
everywhere.

**Recommendation.** Keep the forced type and disposition. If the deployment
needs the object store to be **same-origin with the application**
(`OBJECT_STORAGE_PUBLIC_URL` on the app's own domain), add a post-upload
validation step, or serve the bucket from a cookieless origin.

---

### F-4 — MEDIUM / test gap — the object-storage path had no automated coverage at all

**What.** PR #40 changed `src/lib/object-storage.ts` (the `presignUrl`
response-header overrides and the `objectDownloadUrl` options) and
`src/app/api/uploads/presign/route.ts` (the server's content type and the
scriptable-type refusal), and added **no** test for either. The repository
has no test file that exercises the object-storage path at all —
`grep -rl "response-content" tests/` returned nothing before this review.

**Why it matters.** The path that cannot content-validate its bytes is exactly
the path with no tests. A future change that dropped the `response-content-type`
override would have failed nothing.

**Status.** Fixed in the follow-up PR: `tests/object-storage-content-policy.test.ts`,
**14/14 passing** — the overrides are present, they are **signed** (changing
them changes the signature, and they sit inside the signed part of the URL),
the signed PUT binds the server's type, the presign route derives the type from
the allow-list and refuses a scriptable declared type, and the file route
passes both overrides to the download URL.

---

### F-5 — INFO — `Content-Disposition: inline` + a sandbox CSP produces console noise on direct navigation

Directly navigating to an uploaded image URL makes Chromium's **own**
image-viewer chrome log a `default-src 'none'` violation, because the sandbox
policy applies to the viewer's inline styles. The image still renders. It is
console noise on **direct navigation only** — an `<img>` in a page logs
nothing. Recorded so a reviewer does not mistake it for a finding.

---

### F-6 — INFO — dead code left behind

`isInlinePreviewable()` in `src/lib/uploads.ts` is no longer used by the
server (the served disposition now comes from the allow-list's category). Its
`"pdf"` branch was already dead before PR #40 — PDFs were served as downloads.
`categoryForFile()` and `isVideoFile()` are still used by the **client**
(`FileUploader.tsx`), where they are UX only. No action needed; recorded so a
reviewer is not surprised by the unused export.

---

## 3. The browser verification that was actually executed

**A real headless Chromium (153.0.8010.0) was obtained and used.** The
environment has no system browser and no browser packages, and no root and no
Debian package lists, so a system Chromium could not be installed. The browser
was obtained from the npm registry as `@sparticuz/chromium` (a self-contained
Chromium build that ships the shared libraries Chromium needs) and driven with
`puppeteer-core`. **No browser was downloaded from outside the npm registry.**

**Target:** a **production build** (`next build` → `next start`) of PR #40's
head, against a **disposable PostgreSQL 16.14** instance on `127.0.0.1:5432`
with the full migration chain applied (0000–0018, including the gated 0018 on
the disposable database only), and a throwaway upload directory under `/tmp`.

**Nothing in production was read, written, deployed or migrated.**

### 3.1 `tests/manual/browser-upload-verification.js` — **34 of 34 checks passed**

| # | Check | Result |
|---|---|---|
| 1 | The login page loads and the login form is submitted | ✅ |
| 2 | A session cookie was issued | ✅ |
| 3 | The session cookie is `HttpOnly` | ✅ |
| 4 | The session cookie is `SameSite=Lax` or `Strict` | ✅ |
| 5 | The session cookie is scoped to `/` | ✅ |
| 6 | `document.cookie` does not expose the session token | ✅ |
| 7 | The login redirects into the dashboard | ✅ |
| 8 | The teacher assignments page loads | ✅ |
| 9 | An account with **two** memberships is offered the school selection | ✅ |
| 10 | Choosing a school opens the dashboard | ✅ |
| 11 | A write with **forged** `X-Forwarded-Host` + `X-Forwarded-Proto` is refused by default (**403**) | ✅ |
| 12 | An ordinary same-origin write still succeeds (**200**) | ✅ |
| 13 | A cross-site write from another origin is refused (not 2xx) | ✅ |
| 14 | The assignment form exposes a file input | ✅ |
| 15 | A legitimate PNG is accepted by the **real UI** | ✅ |
| 16 | **HTML bytes in a `.png`** are refused by the real UI (server **400**, not attached, error shown) | ✅ |
| 17 | An **`.svg`** file is refused by the real UI (client refused it; no request made) | ✅ |
| 18 | An **`.xhtml`** file is refused by the real UI (client refused it; no request made) | ✅ |
| 19 | **ZIP bytes in a `.png`** are refused by the real UI (server **400**) | ✅ |
| 20 | A legitimate `.txt` file is accepted by the real UI | ✅ |
| 21 | The legacy row (`mime_type = 'text/html'`) is served (not a 404) | ✅ |
| 22 | It is **not** served as `text/html` | ✅ |
| 23 | It is served as `image/png` | ✅ |
| 24 | It is served with `nosniff` | ✅ |
| 25 | It is served with a sandboxing policy | ✅ |
| 26 | It forbids cross-origin embedding (`CORP: same-origin`) | ✅ |
| 27 | A legacy `.html` row is served as a download, not a document (`application/octet-stream` + `attachment`) | ✅ |
| 28 | The legacy row served as `image/png` **does not execute script** | ✅ |
| 29 | The legacy row served as a `.html` download **does not execute script** | ✅ |
| 30 | Logout succeeds | ✅ |
| 31 | The session cookie is cleared on logout | ✅ |
| 32 | The API refuses the request after logout (**401**) | ✅ |
| 33 | **No** Content-Security-Policy violation was reported in the console | ✅ |
| 34 | **No** uncaught page error was raised | ✅ |

Two notes on method:

- The **cross-site** write (check 13) is driven from an attacker page served
  from its **own** origin (a second local HTTP server), not from the
  application, so the application's own CSP cannot mask the server's answer.
  The browser reports the request as `opaque`; the server's status was read
  from the DevTools network event and was **not** 2xx.
- The upload refusals (checks 16–19) are asserted from the **network**, not
  from the DOM: the file must not be attached (the attachment list is read by
  its "Remove file" buttons) and the request must have been refused (4xx) or
  never made (client-side refusal).

### 3.2 `tests/manual/browser-content-type-sniffing-probe.js` — **0 of 9 executed script, 0 preview failures**

See the table in **F-3**. The preview check:

```
image: complete=true naturalWidth=1
audio: readyState=4 duration=0.1 error=null
video: networkState=3 readyState=0 error=4     ← fetch confirmed (200), no sample video to decode
responses: 200 text/html · 200 image/png · 200 audio/wav · 200 video/mp4
CSP violations in the console: 0
```

### 3.3 `tests/manual/forwarded-header-configuration-matrix.js` — the same write against all three configurations

Run against three production servers: the default (:3400), the opt-in
(:3401) and the configured public origin (:3402).

| Request | default | opt-in | `EASY_LEARN_PUBLIC_ORIGIN` |
|---|---|---|---|
| Origin = the app's own origin | **200** | **200** | **403** |
| Origin = a foreign origin | **403** | **403** | **403** |
| Origin foreign + forged forwarded headers | **403** | **200** (documented opt-in behaviour) | **403** |
| Origin = the app's own origin + forged forwarded headers | **403** (F-1) | **403** | **403** |
| No `Origin` header at all | **403** (fail-closed, documented) | **403** | **403** |

The third column is the important operational result: with
`EASY_LEARN_PUBLIC_ORIGIN` set to a value that does **not** match the origin
the browser uses, **even the login is refused with 403**. The configured
origin must match the browser's origin **exactly** — scheme, host and port.

---

## 4. Browser test plan — what was executed, and what a reviewer must still run

**Executed (Chromium 153, production build, disposable database):** the 34
checks in §3.1, the 9 header combinations and the preview check in §3.2, and
the configuration matrix in §3.3.

**NOT executed — a reviewer with a real browser must run these.** Each step
states what to look for.

### 4.1 Login, session cookies, school selection, navigation, logout

| # | Step | Expected |
|---|---|---|
| A1 | Open `/login` in a real browser. | The form renders; **no** console errors other than a possible font-CDN failure on an offline machine. |
| A2 | Sign in as a teacher who belongs to **two** schools. | The school picker appears; the dashboard is **not** reached until a school is chosen. |
| A3 | Choose the first school. | The dashboard for that school opens. |
| A4 | Inspect the session cookie in the developer tools. | `el_token`, `HttpOnly`, `SameSite=Lax`, `Path=/`. `document.cookie` in the console shows **no** `el_token`. |
| A5 | Navigate to the assignments, classes, grades and messages pages. | Each renders; **no** 401/403 in the network tab; **no** CSP violation in the console. |
| A6 | Sign out. | The cookie is cleared; the next API call is 401; the app returns to `/login`. |
| A7 | Sign out and press the browser **Back** button. | The dashboard is **not** restored from the bfcache with a live session. |

### 4.2 CSRF-protected writes with the supported proxy configuration

| # | Step | Expected |
|---|---|---|
| B1 | With the **default** configuration, make an ordinary same-origin write from the page. | **200**. |
| B2 | With the default configuration, send a write carrying `X-Forwarded-Host: evil.test` **and** `X-Forwarded-Proto: https`. | **403** — the forged host must not change the compared origin. |
| B3 | With the default configuration, send a write carrying **only** `X-Forwarded-Proto: https`. | **403** — the scheme follows the header (F-1). Self-inflicted; document it. |
| B4 | From a page on **another origin**, `fetch()` a state-changing route with `mode: "no-cors"`. | Not 2xx. |
| B5 | Repeat B2–B4 against a server started with `EASY_LEARN_TRUST_PROXY_HEADERS=true`. | B1 **200**; B2 **200** (the documented opt-in behaviour); B4 not 2xx. |
| B6 | Repeat B2–B4 against a server started with `EASY_LEARN_PUBLIC_ORIGIN` set to the **exact** browser origin. | B1 **200**; B2 **403** (the configured origin wins); B4 not 2xx. |
| B7 | Start a server with `EASY_LEARN_PUBLIC_ORIGIN` set to a **different** origin and sign in. | **403** on login — the configured origin must match the browser's origin exactly. |

### 4.3 Safe image, audio and video previews; downloads; school-file workflows

| # | Step | Expected |
|---|---|---|
| C1 | As a teacher, create an assignment and attach a **PNG**. | The image **renders inline** in the attachment list (not a broken image). |
| C2 | Attach a **JPEG**, a **GIF**, a **WEBP** and a **BMP**. | Each renders inline. |
| C3 | Attach an **MP3** and an **MP4** (or WebM/MOV). | The `<audio>`/`<video>` element loads; the **first frame** of the video is visible; the seek bar works. *(Video decoding was **not** verified in this environment — no sample video was available.)* |
| C4 | Attach a **PDF** and a **DOCX**. | They are listed as **downloads** (a download link), not rendered in the page. |
| C5 | Click the download link for the PDF. | The file downloads; the browser does not render it in a tab. |
| C6 | Open the uploaded image **directly** in a new tab (`/api/files/<id>`). | The image is displayed by the browser's viewer. Expect **console noise** from the browser's own viewer styles (F-5) — the image itself must still render. |
| C7 | Open the uploaded PDF directly. | The browser **downloads** it (the response is `attachment`); it does not open in the PDF viewer. |
| C8 | As a learner, submit an assignment with an attachment, then open the assignment as the teacher. | The attachment is visible to the teacher; the learner **cannot** see another learner's submission attachment. |
| C9 | As a learner, open a **submission** attachment from a different learner. | **403**. |
| C10 | Open an attachment from another school. | **404** — the file must not even be distinguishable from one that does not exist. |

### 4.4 Rejection or safe handling of HTML, SVG, XHTML, mismatched extensions, spoofed MIME types and malformed signatures

| # | Step | Expected |
|---|---|---|
| D1 | Upload a file named `evil.html` containing `<script>…</script>`. | Refused. The client refuses it (the extension is not on the allow-list) and the **server** refuses it too. |
| D2 | Upload `evil.svg` containing `<svg onload=…>`. | Refused, client and server. |
| D3 | Upload `evil.xhtml` containing an XML prologue and a script. | Refused, client and server. |
| D4 | Upload `evil.png` whose **bytes are HTML** and whose declared type is `image/png`. | The client accepts it (the extension is fine); the **server refuses it with 400** and the UI shows *"contains HTML, SVG or XHTML markup"* or *"does not look like the PNG file it claims to be"*. |
| D5 | Upload `archive.png` whose bytes are a **ZIP**. | **400** — the signature does not match. |
| D6 | Upload `notes.txt` whose bytes are HTML. | **400** — the markup check applies even to a type with no signature. |
| D7 | Upload `notes.txt` whose text mentions `<script>` in a code sample. | **Accepted** — a code sample is not a document. |
| D8 | Upload a legitimate PNG/JPEG/TXT/ZIP. | **Accepted**; the correct content type is stored. |
| D9 | With the developer tools' network tab open, upload each of the above and record the request's `Content-Type`. | The **request** may carry the client's type; the **response** must carry the server's. |

### 4.5 Attempts to execute uploaded content in the application's authenticated origin

| # | Step | Expected |
|---|---|---|
| E1 | Insert a row with `mime_type = 'text/html'` and a `.png` stored name (the pre-fix shape) and open `/api/files/<id>`. | Served as `image/png`, `nosniff`, sandbox CSP, `CORP: same-origin`. The page **does not execute** the script and the document title is not `PWNED`. |
| E2 | Insert a row with a `.html` stored name and open it. | `application/octet-stream` + `attachment`; the browser **downloads** it; nothing is rendered. |
| E3 | With the developer tools open, try to reach `/api/auth/me` from the uploaded document's context. | The sandbox gives the document an **opaque origin** with scripting disabled: no script runs at all, so there is nothing to reach. |
| E4 | Paste an HTML payload into a text file, upload it as `notes.txt`, open it. | Downloaded, never rendered. |
| E5 | Repeat E1 and E2 against an **object-storage** deployment (`OBJECT_STORAGE_*` configured). | The bucket's response carries the forced `response-content-type` and `response-content-disposition`. Verify the **final** response (not the 307) in the network tab — and note that `nosniff` and the CSP **cannot** be forced onto it (F-3). |

### 4.6 Browser console errors and CSP violations

| # | Step | Expected |
|---|---|---|
| F1 | Walk the whole application with the console open, filtering for `Content Security Policy`. | **No** violations. |
| F2 | Open an uploaded image directly in a tab. | Only the browser's own image-viewer style noise (F-5). No violation from the application. |
| F3 | Open the uploaded audio and video directly. | No violation; the media plays. |
| F4 | Attempt to load a cross-origin script or frame an uploaded file. | Blocked by `frame-ancestors 'none'` and `CORP: same-origin`; the console shows the refusal. |
| F5 | Check the console after logging in, after a failed login, and after a 403. | No uncaught errors. |

---

## 5. The exact configuration for the intended deployment

The origin policy has three configurations. **The intended deployment must use
the first.**

| Variable | Value | Effect |
|---|---|---|
| `EASY_LEARN_PUBLIC_ORIGIN` | `https://<the exact origin the browser uses>` — scheme, host and port, no trailing slash | **The** origin every state-changing request is compared against. The forwarded headers are ignored completely. This is the only configuration in which neither half of the compared origin depends on a forwarded header. |
| `EASY_LEARN_TRUST_PROXY_HEADERS` | leave **unset** | Off by default. Turning it on lets a single-valued `X-Forwarded-Host` become a candidate origin. Only for an edge that is known to **overwrite** (never append to) the forwarded headers. `EASY_LEARN_PUBLIC_ORIGIN` takes precedence over it. |
| `EASY_LEARN_ALLOWED_ORIGINS` | leave **empty** | Empty means "same origin only". Each entry is a full trust decision. |

**The rules, stated exactly:**

1. If the edge **rewrites** the `Host` header to an internal name, or
   rewrites the scheme, `EASY_LEARN_PUBLIC_ORIGIN` **must** be set — otherwise
   every state-changing request is refused with 403. That is a safe failure,
   but it is an outage.
2. `EASY_LEARN_PUBLIC_ORIGIN` must match the browser's origin **exactly**.
   A mismatch refuses the login itself (measured: **403**).
3. Do not set `EASY_LEARN_TRUST_PROXY_HEADERS` and `EASY_LEARN_PUBLIC_ORIGIN`
   expecting the latter to be overridden — the latter wins (§3.3).

**The object-storage limitation, stated exactly.** When `OBJECT_STORAGE_*` is
configured, the bytes go straight from the browser to the bucket. The
application can bind the content type and the disposition onto the bucket's
response, but it **cannot validate the bytes** and it **cannot** put
`nosniff` or a CSP on that response. Measured in Chromium, none of the nine
header combinations the bucket could return executed script — the served type
is never scriptable. What remains open is content *integrity* and the fact
that only Chromium was tested (F-3).

---

## 6. The follow-up PR

**Nothing in PR #40 was changed.** The follow-up work is a **separate draft
PR**, stacked on PR #40, containing **no behaviour change**:

- `tests/object-storage-content-policy.test.ts` — **14/14 passing**; the
  coverage the object-storage path never had (F-4).
- `tests/csrf-policy.test.ts` — **2 new tests** (40/40 passing) that pin the
  two halves of F-1: the forwarded **host** cannot reach the derived origin,
  and the forwarded **proto** can only refuse a write, never widen it.
- `src/lib/csrf.ts` and `docs/SECURITY_AUTHENTICATION.md` — the module
  comment and §4 now state the scheme behaviour precisely, and §7/§8/§9
  record the browser measurements, the object-storage limitation and the
  two open risks.
- The three browser probes and the review document, so the evidence is
  reproducible.

**It does not contain the F-2 fix.** That is a tenant-isolation change that
contradicts a deliberate existing test; it is recorded as a finding and left
for an independently reviewed change.

---

## 7. What was NOT done

- **No merge, no deploy.** PR #40 stays open and **draft**. The follow-up PR
  is **draft** too.
- **No production access of any kind.** No production data, secrets, settings,
  migrations, deployment configuration or billing was read or changed. Every
  test ran against a disposable PostgreSQL 16.14 on `127.0.0.1` with a
  throwaway upload directory under `/tmp`.
- **PRs #35–#39 were not touched** — not merged, not re-titled, not
  re-based, not force-pushed. The only new remote branch is the follow-up
  branch; PR #40's branch is unchanged.
- **No self-certification.** This is not an independent review.
- **No claim of browser verification for Firefox or Safari**, and no claim
  that a video frame was decoded.

---

## 8. Approval criteria for PR #40

| # | Criterion | Status |
|---|---|---|
| 1 | An independent reviewer has read the incremental diff `3e7b311..d2d05d8` and this document. | ⬜ Outstanding |
| 2 | The browser plan in §4 has been run by a human in a real browser, in at least one browser other than Chromium. | ⬜ Outstanding |
| 3 | §4.3 C3 — a real video plays in the preview with the sandbox CSP applied. | ⬜ Outstanding |
| 4 | `EASY_LEARN_PUBLIC_ORIGIN` is set for the intended deployment, to the exact browser origin, and §4.2 B6/B7 pass against it. | ⬜ Outstanding |
| 5 | The decision on F-2 (the shared-identity file attribution) has been taken by someone independent of this work. | ⬜ Outstanding |
| 6 | The decision on F-3 (post-upload validation for the object-storage path) has been taken. | ⬜ Outstanding |
| 7 | The follow-up PR has been reviewed and merged **before** PR #40 is merged (it is stacked on it). | ⬜ Outstanding |
| 8 | The `'unsafe-inline'` in the production `script-src` (§6 of `docs/SECURITY_AUTHENTICATION.md`) is still open and is **not** closed by this PR. | ⬜ Outstanding — a known, disclosed residual |
| 9 | A copied JWT remains usable until it expires; logout does not revoke it. | ⬜ Outstanding — a known, disclosed residual |

---

## 9. Artefacts

| Artefact | Path |
|---|---|
| This review | `docs/REVIEW_PR40_BROWSER_VERIFICATION.md` |
| The browser verification (34 checks) | `tests/manual/browser-upload-verification.js` |
| The content-type / sniffing probe (9 combinations + preview check) | `tests/manual/browser-content-type-sniffing-probe.js` |
| The forwarded-header configuration matrix | `tests/manual/forwarded-header-configuration-matrix.js` |
| The HTTP-level live probe (from PR #40) | `tests/manual/live-upload-content-probe.js` |
| The uploaded-content unit suite (from PR #40) | `tests/upload-content.test.ts` |
| The object-storage coverage (follow-up PR) | `tests/object-storage-content-policy.test.ts` |
| The CSRF policy suite (from PR #40, extended in the follow-up PR) | `tests/csrf-policy.test.ts` |
| The security documentation | `docs/SECURITY_AUTHENTICATION.md` |
| The earlier review of PR #38 | `docs/SECURITY_REVIEW_PR38.md` |
| The earlier handoff for PRs #38/#39 | `docs/REVIEW_HANDOFF_PR38_PR39.md` |

**How to reproduce the browser evidence** — the scripts are self-documenting;
each file's header states the server and database it needs. A Chromium binary
is the only extra requirement (`puppeteer-core` drives it; nothing is
downloaded from outside the npm registry).
