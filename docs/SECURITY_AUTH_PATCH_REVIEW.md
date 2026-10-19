# EasyLearn — authentication security patch: verified baseline & reviewer acceptance checklist

**Branch:** `security/jwt-secret-validation-and-cookie-auth`
**Base:** `main` @ `016d229183cb615980992178869bb5b17e42962f`
**Document status:** `IMPLEMENTED` (baseline analysis) · `TESTED` (baseline CI) · `BLOCKED` (the patch commit itself is unavailable in this environment)

---

## 1. Status in one paragraph

This branch is the correct, correctly-based home for the EasyLearn authentication security
patch. It was created from `main` at `016d229183cb615980992178869bb5b17e42962f` and the tree is
byte-identical to `main` (`git diff origin/main` is empty). The full local CI replication of the
repository's own GitHub Actions job passes **11/11 steps, 485 assertions, 0 failures** on this base.

**The patch commit itself could not be located.** The commit named in the task,
`f47916fbbff6debe09c25f3d98194a38c6547b06`, does not exist in any location reachable from this
sandbox — not as a local object, not on the remote, not in any pull-request ref, not in any fork,
not in any CI artifact. It was **not** re-implemented from scratch, because the named commit is the
deliverable and a hand-written substitute would not be the reviewed change. This document therefore
delivers everything that does **not** depend on the diff: the verified security baseline of `main`,
the precise gap list the patch must close, the acceptance checklist a reviewer must apply to the
diff, the backward-compatibility constraints the patch must respect, and the exact commands to
supply the patch (§3).

---

## 2. The blocker — exact search performed

| # | Location searched | Method | Result |
|---|---|---|---|
| 1 | Local object store | `git cat-file -t f47916f…` | `fatal: could not get object info` |
| 2 | Local refs | `git for-each-ref --contains f47916f…` | `error: no such commit` |
| 3 | Reflog & stashes | `git reflog --all`, `git stash list` | absent |
| 4 | Unreachable/dangling objects | `git fsck --unreachable --dangling` | **0 objects** (whole repo) |
| 5 | Remote commit API | `gh api repos/shadrachampah123/easylearn/commits/f47916f…` | **HTTP 422 — "No commit found for SHA"** |
| 6 | Direct fetch by SHA | `git fetch origin f47916f…` | `upload-pack: not our ref` |
| 7 | Every remote ref | `git ls-remote origin` (75 refs) | no match for the SHA; **no `security/…` branch at all** |
| 8 | Pull-request refs | fetched all 38 `refs/pull/*` | absent |
| 9 | Forks | `gh api repos/…/forks` | none exist |
| 10 | Tags / releases / gists | `gh api …/tags`, `…/releases`, `users/…/gists` | 0 / 0 / 0 |
| 11 | CI run history | `gh run list` (full history) | **no run on any security branch** — the branch was never pushed |
| 12 | Filesystem | swept `/home/user`, `/tmp`, `/` for `*.patch`, `*.diff`, `0001-*.patch`, `*jwt*`, `*security*`, `*cookie*` | only the repo's own `tests/security.test.js` |
| 13 | Other git repos on the box | filesystem sweep for `.git` directories | none |

A separate sweep of **all 29 remote branches** whose `src/lib/auth.ts` differs from `main`
established that **no branch in this repository contains a CSRF implementation**, and **no branch
removes `el_token` from `localStorage`**. The patch is not hiding in another branch.

---

## 3. How to supply the patch (any one of these is sufficient)

Run from a machine that still has the commit:

```bash
# Option A — push the commit itself to this repository
git push origin f47916fbbff6debe09c25f3d98194a38c6547b06:refs/heads/security/jwt-secret-validation-and-cookie-auth
git fetch origin security/jwt-secret-validation-and-cookie-auth
git cherry-pick f47916fbbff6debe09c25f3d98194a38c6547b06   # or: git reset --hard f47916f…

# Option B — a patch file, placed in /home/user/
git format-patch -1 f47916fbbff6debe09c25f3d98194a38c6547b06 > /home/user/0001-jwt-secret-validation.patch
#   then: git am /home/user/0001-jwt-secret-validation.patch

# Option C — a bundle
git bundle create /home/user/security.bundle f47916fbbff6debe09c25f3d98194a38c6547b06
#   then: git fetch /home/user/security.bundle f47916f…:refs/heads/security/jwt-secret-validation-and-cookie-auth

# Option D — the diff as a plain file
git show f47916fbbff6debe09c25f3d98194a38c6547b06 > /home/user/security.diff
#   then: git apply /home/user/security.diff
```

Once the commit is present, the acceptance checklist in §6 must be satisfied and the CI
replication in §8 re-run before this PR leaves draft.

---

## 4. Verified baseline — `main` @ `016d229`

Everything in this section was read directly from the tree at `016d229` and is reproducible with
the file/line references given.

### 4.1 JWT secret handling

| Location | Current behaviour |
|---|---|
| `src/lib/env.ts:43-56` | `getJwtSecret()` returns the first non-empty of `JWT_SECRET`, `AUTH_SECRET`, `NEXTAUTH_SECRET`, trimmed and unquoted. |
| `src/lib/env.ts:77-89` | `getJwtConfigurationProblem()` — **already** enforces a **32-character minimum** and returns a human-readable message. |
| `src/lib/auth.ts:27-33` | `getJwtKey()` — the single chokepoint for all signing and verification — throws only when the secret is **empty** (`"JWT_SECRET is required"`, line 30). It does **not** apply the 32-character policy. |
| `src/app/api/auth/login/route.ts:40` | Calls `getJwtConfigurationProblem()` → a short secret makes login return **503**. |
| `src/app/api/auth/me/route.ts:12` | Calls `getJwtConfigurationProblem()` → **503**. |
| `src/app/api/health/route.ts:13` | Reports the problem. |
| `src/app/api/auth/select-school/route.ts:53` | Calls `createToken(...)` **without** any `getJwtConfigurationProblem()` guard. |

**Finding B-1 — the secret policy is advisory, not enforced at the chokepoint.** A 32-character
policy exists, but it is applied *per route* by three call sites rather than inside `getJwtKey()`.
Any route that signs a token without remembering to call `getJwtConfigurationProblem()` inherits
the gap — and `select-school` already does exactly that (`src/app/api/auth/select-school/route.ts:53`).
A third-party route added later would repeat the mistake silently.

**Finding B-2 — no entropy/character-class policy.** A 32-character secret of `aaaaaaaa…` passes
today. Length alone is a weak proxy for strength.

**Finding B-3 — no test coverage.** `getJwtConfigurationProblem` appears **0 times** across
`tests/`. A regression that removes the 32-character check would not be caught by any suite.

### 4.2 Cookie transport

`src/app/api/auth/login/route.ts:137-143` already sets the session cookie correctly:

```ts
response.cookies.set("el_token", token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 60 * 60 * 24,
  path: "/",
});
```

`src/app/api/auth/select-school/route.ts:68` re-sets it with the same attributes;
`src/app/api/auth/logout/route.ts:5` clears it with `maxAge: 0`.
`src/lib/auth.ts:172-186` (`getTokenFromRequest`) accepts **either** an `Authorization: Bearer`
header (line 174) **or** the `el_token` cookie (line 181), so the server is already cookie-capable today.

**Finding B-4 — the cookie is not the only credential in the browser.** The login response body
still returns `token` (`src/app/api/auth/login/route.ts:134`), and the browser persists it in
`localStorage` (§4.3). The `httpOnly` cookie therefore does not deliver its main benefit, because
an attacker with script execution can simply read `localStorage.getItem("el_token")`.

**Finding B-5 — the CSP does not meaningfully blunt XSS.** `next.config.ts:11` sets
`script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:`. With `'unsafe-inline'` and
`'unsafe-eval'` present, injected script executes. This raises the value of moving the credential
out of `localStorage` — and it means the patch must not assume CSP is a compensating control.

### 4.3 Browser token storage

| Metric | Count on `main` |
|---|---|
| Files referencing `el_token` | **57** |
| Client files reading `el_token` from `localStorage` | **51** |
| Client files writing `el_token` to `localStorage` | **2** |
| Client files building an `Authorization: Bearer` header | **53** |

The write sites are `src/app/login/page.tsx:58` and `src/components/dashboard/DashboardShell.tsx:97`.
The dominant read pattern is `const token = localStorage.getItem("el_token");` (113 occurrences),
which is then used to build `Authorization: Bearer ${token}`.

**Finding B-6 — the token is readable by any script on the origin.** The consequence of B-4/B-5.
`httpOnly` is the standard control for exactly this, and it is defeated by the localStorage copy.

**Finding B-7 — no test coverage.** `localStorage` appears **0 times** across `tests/`. Removing
the localStorage copy (the patch's central aim) would have **no regression test** unless the patch
adds one; equally, a later regression that re-introduces it would go unnoticed.

### 4.4 CSRF

`git grep -i csrf` over `src/` returns **nothing**. There is no CSRF protection of any kind: no
token, no `Origin`/`Sec-Fetch-Site` validation, no double-submit pattern.

Today this is *mostly* latent, because the browser authenticates with an `Authorization` header
that a cross-site attacker cannot set. It becomes **live** the moment the browser is switched to
cookie-only authentication — which is precisely what this patch does. `sameSite: "lax"` blocks
cross-site `POST`/`PUT`/`DELETE`, but it does **not** block:

* **Top-level cross-site `GET` navigation.** Two `GET` handlers mutate state:
  * `src/app/api/learner/stats/route.ts` — **inserts `learnerAchievements` rows** on a GET.
  * `src/app/api/messages/route.ts` — **marks messages as read** on a GET.
* **Same-site attacks** (a malicious or compromised sibling subdomain).

**Finding B-8 — switching the browser to cookie auth without adding CSRF protection is a
regression, not a hardening.** The patch's two halves are coupled and must land together.

### 4.5 Logout

`src/app/api/auth/logout/route.ts` clears the cookie; `src/components/dashboard/DashboardShell.tsx:110-113`
calls it and then removes `el_token` and `el_user` from `localStorage` before redirecting to
`/login`. The client path is sound.

**Finding B-9 — logout is not revocation.** The JWT is stateless with a 24-hour lifetime
(`src/lib/auth.ts:7`); nothing invalidates an already-issued token server-side. A token captured
before logout stays valid until it expires. This was previously classified as out of scope and
remains out of scope for this patch — but the PR description must say so explicitly rather than
imply logout revokes sessions.

---

## 5. What the patch must close

| # | Gap | Baseline | Required outcome |
|---|---|---|---|
| G-1 | JWT secret policy not enforced at the chokepoint | `src/lib/auth.ts:27-33` checks only for empty | `getJwtKey()` (or an equivalent single chokepoint) enforces the policy so **every** sign and verify path is covered by construction, not by per-route discipline |
| G-2 | No entropy/character-class policy | `src/lib/env.ts:84` checks length only | A stated policy (length and/or character class) enforced at the same chokepoint |
| G-3 | Token readable from `localStorage` | 51 client files read it; 2 write it | The browser no longer persists the token in `localStorage`; the `httpOnly` cookie is the browser's only credential |
| G-4 | No CSRF protection | nothing in `src/` | State-changing routes are protected once the browser is cookie-authenticated |
| G-5 | Logout does not revoke | stateless 24 h JWT | Either a revocation mechanism, or an explicit, documented statement that revocation is out of scope for this patch |
| G-6 | No security tests for any of the above | 0 hits for `csrf`, `localStorage`, `getJwtConfigurationProblem` in `tests/` | Regression tests that fail if any of G-1…G-4 regress |

---

## 6. Reviewer acceptance checklist

The patch must satisfy **every** line. A reviewer should treat a failure on any line as
blocking.

### 6.1 JWT secret validation

- [ ] The policy is enforced inside the **signing/verification chokepoint** (`getJwtKey()` in
      `src/lib/auth.ts`), not only in a route helper. Confirm no route can reach `createToken`
      or `jwtVerify` without passing the check.
- [ ] `src/app/api/auth/select-school/route.ts` is covered — today it signs a token at line 53
      with no policy guard. Whether or not the route gains its own guard, the chokepoint must
      make it unnecessary.
- [ ] The policy states a **minimum length** and the message names the requirement.
- [ ] The policy rejects the obvious weak values (empty, whitespace-only, placeholder strings such
      as `changeme` / `secret` / `your-secret-here` / `development`).
- [ ] The failure mode is **fail-closed**: a misconfigured secret produces a 5xx, never a token
      signed with a weak key.
- [ ] The error path does not **echo the secret** into a response body, a log line, or a health
      endpoint payload.
- [ ] The `AUTH_SECRET` / `NEXTAUTH_SECRET` fallbacks are still considered deliberately, and a
      weak value in a *lower-priority* variable cannot be selected while a strong value exists in a
      higher-priority one.
- [ ] A regression test asserts that a too-short secret is rejected **at the chokepoint** — a
      test that only exercises `getJwtConfigurationProblem()` in isolation does not satisfy this.

### 6.2 HttpOnly / cookie-only browser auth

- [ ] The `el_token` cookie remains `httpOnly: true` on **every** set site: login, select-school,
      and any new set introduced by the patch.
- [ ] `secure` remains `process.env.NODE_ENV === "production"` **and** is `true` in production.
- [ ] `path: "/"` is retained (a narrower path silently breaks the cookie on some routes).
- [ ] `sameSite` is either unchanged (`"lax"`) or changed with a stated justification. **Note:**
      `tests/membership-auth-db.test.ts:1049` asserts `sameSite === "lax"`; changing it to
      `"strict"` will fail that test and must be a deliberate, justified change with the test
      updated in the same commit. `"strict"` also breaks any cross-site redirect flow.
- [ ] `maxAge` matches the token lifetime (`TOKEN_EXPIRY = "24h"`, `src/lib/auth.ts:7`). A cookie
      that outlives its token (or expires before it) is a defect.
- [ ] The server **still accepts** `Authorization: Bearer` (`src/lib/auth.ts:172-186`). Removing
      it breaks non-browser API clients. Cookie-only is a *browser* policy, not a server
      restriction.
- [ ] The `Set-Cookie` header is not cached: `Cache-Control: no-store` is present on the login
      response (it is today, at `src/app/api/auth/login/route.ts:144`).

### 6.3 Removal of browser token storage

- [ ] No client code writes the token to `localStorage`, `sessionStorage`, `IndexedDB`, or a
      readable cookie. Today: `src/app/login/page.tsx:58`, `src/components/dashboard/DashboardShell.tsx:97`.
- [ ] The **51** client files that read `localStorage.getItem("el_token")` are all migrated to
      rely on the cookie. A same-origin `fetch()` sends cookies by default
      (`credentials: "same-origin"` is the default), so the `Authorization` header can simply be
      dropped — but every one of the 113 call sites must be checked, not just the two write sites.
- [ ] The `el_user` object in `localStorage` (`src/app/login/page.tsx:59`) is either removed or
      reduced to non-sensitive display data. It currently holds the user's identity, role, and
      email; the role in particular must never be used for an authorization decision (the server
      already re-derives it from the database — that behaviour must be preserved).
- [ ] A regression test asserts the token is **not** written to `localStorage`/`sessionStorage`.
      There is currently **no** test of this kind, so without one the change is unprotected.
- [ ] The `token` field may remain in the JSON response body **only** if non-browser clients need
      it. If it is removed, the removal is a **breaking API change** and must be called out in the
      PR body with a migration note.
- [ ] Open browser tabs holding the old `localStorage` copy continue to work after deploy
      (backward compatibility, §7).

### 6.4 CSRF protection

- [ ] CSRF protection is added **in the same patch** as the switch to cookie-based browser auth.
      Landing the switch without CSRF protection is a net security regression (B-8).
- [ ] The protection is **server-side and unforgeable**. Rejected designs: checking that a
      request *has* a cookie; comparing a request header to the `Origin` header only; a token
      that is simply echoed from a readable cookie without a secret binding; a token that is
      static per user.
- [ ] The token is bound to the **session** (e.g. HMAC over the JWT with a server-side secret),
      so it cannot be replayed from another session or another user.
- [ ] The protected set covers **all** state-changing methods — `POST`, `PUT`, `PATCH`, `DELETE` —
      across the 60 API routes.
- [ ] The two state-mutating `GET` handlers are addressed:
      `src/app/api/learner/stats/route.ts` (inserts achievement rows) and
      `src/app/api/messages/route.ts` (marks messages read). Either the writes move to a
      non-`GET` method, or the CSRF check covers `GET` as well.
- [ ] Requests **without** a CSRF token fail **closed** with 401/403 — including requests that
      carry a valid session cookie.
- [ ] Legitimate same-origin requests still succeed — the test must assert both the reject case
      and the accept case, otherwise a check that rejects everything passes.
- [ ] API clients that authenticate with `Authorization: Bearer` are not broken by the CSRF
      requirement, or the requirement is scoped so that they are not (this is a compatibility
      decision that must be made explicitly).
- [ ] `sameSite` and the `Origin`/`Sec-Fetch-Site` check are not treated as the *only* control.
      `sameSite: "lax"` (current setting) is a browser default, not a CSRF token.

### 6.5 Logout behaviour

- [ ] The cookie is cleared with `maxAge: 0` and the same `path`/`domain` attributes it was set
      with (today: `src/app/api/auth/logout/route.ts:5`).
- [ ] Client-side storage is cleared on logout, and the code path is reached even when the
      logout request itself fails — a failed `fetch` must not leave a live token in `localStorage`
      (`src/components/dashboard/DashboardShell.tsx:110-113` currently clears only after a
      successful response).
- [ ] The PR body states plainly whether server-side revocation is in scope. If it is not, the
      24-hour stateless lifetime must be documented as the residual risk (B-9).
- [ ] Logout is CSRF-protected (or explicitly reasoned to be safe: the impact of a forced logout
      is low, but the decision must be recorded, not implicit).

### 6.6 Backward compatibility

- [ ] Existing sessions issued before the change still verify. If the secret policy changes the
      accepted value, tokens signed with the *old* secret must either still verify or users are
      force-logged-out deliberately and the PR says so.
- [ ] The token `ver`/schema version (`TOKEN_SCHEMA_VERSION = 3`, `src/lib/auth.ts:16`) is
      handled explicitly if the claims change. Bumping it without a migration path logs every
      user out.
- [ ] `LEGACY_TOKEN_SCHEMA_VERSION` handling (`src/lib/auth.ts:19`) is not accidentally removed.
- [ ] Non-browser API clients using `Authorization: Bearer` continue to work (§6.2).
- [ ] Open tabs that still hold a `localStorage` token keep working after deploy.

### 6.7 Security tests

- [ ] A test asserts the JWT secret policy is enforced **at the chokepoint** (§6.1).
- [ ] A test asserts the login cookie is `httpOnly`, `secure` in production, `path: "/"`, and
      that `maxAge` matches the token lifetime.
- [ ] A test asserts the token is **not** written to `localStorage`/`sessionStorage` (a
      source-level assertion over the client files is acceptable if a runtime assertion is
      impractical — but it must be able to fail).
- [ ] A CSRF test asserts both directions: a state-changing request **with** a valid session
      cookie and **without** a CSRF token is rejected, **and** the same request **with** a valid
      CSRF token succeeds.
- [ ] The tests are wired into the CI job, not only into `npm test` — the CI job runs
      `npm test`, `npm run test:db`, `npm run test:tenant-auth`, `npm run test:mutation`,
      `npm run test:integration`, `npm run test:tenant-integrity`, `npm run test:tls-e2e`,
      `npm run typecheck`, `npm run build`, `npm run lint`
      (`.github/workflows/ci.yml:49-79`).
- [ ] The existing guard `EASY_LEARN_REQUIRE_*` pattern is preserved or extended for any new
      suite that could otherwise **skip** rather than fail.
- [ ] Each new test is **mutation-verified**: temporarily break the corresponding control and
      confirm the test fails. A test that cannot fail proves nothing.

### 6.8 General

- [ ] The patch does **not** weaken tenant isolation or authorization. The server must continue to
      re-derive the role and the school context from the **database**, never from a token claim
      or a client-supplied value.
- [ ] The patch does not touch the migration chain, `run-migration.js`, the 0018 constraint
      guards, or the seed route. Security changes and database-safety changes stay in separate
      pull requests.
- [ ] No secret is added to the repository, and no production credential is used anywhere in the
      test suite.
- [ ] `next-env.d.ts` is not committed (the build regenerates it).

---

## 7. Backward-compatibility constraints, measured

| Constraint | Where it lives | Effect on the patch |
|---|---|---|
| `sameSite === "lax"` on the session cookie | `tests/membership-auth-db.test.ts:1049` | Changing it to `"strict"` **fails an existing test** and breaks cross-site redirect flows. |
| `'httpOnly: true'` literal | `tests/membership-foundation.test.js:359` | A source-literal guard; changing the spelling breaks it. |
| `el_token` cookie is parsed by the auth layer | `src/lib/auth.ts:181`, `tests/real-authorization.test.ts:279` | Renaming the cookie requires updating all three. |
| `Authorization: Bearer` accepted | `src/lib/auth.ts:174-178` | Must be preserved for non-browser clients. |
| `TOKEN_SCHEMA_VERSION = 3`, `LEGACY_TOKEN_SCHEMA_VERSION = 1` | `src/lib/auth.ts:16,19` | Claim changes need a version bump **and** a migration path. |
| `getJwtConfigurationProblem()` 32-char rule | `src/lib/env.ts:84` | The patch should keep this rule and *add* to it at the chokepoint, not replace it silently. |

---

## 8. Validation baseline for this branch

Local replication of the repository's own CI job (`.github/workflows/ci.yml`) against a
**disposable** PostgreSQL 16.14 instance with TLS enabled. No production system was contacted.

| # | CI step | Result |
|---|---|---|
| 01 | `npm audit --omit=dev` | **PASS** |
| 02 | `npm test` | **PASS** |
| 03 | `npm run test:tls-e2e` | **PASS** |
| 04 | `npm run test:db` | **PASS** |
| 05 | `npm run test:tenant-auth` | **PASS** |
| 06 | `npm run test:mutation` | **PASS** |
| 07 | `npm run test:integration` | **PASS** |
| 08 | `npm run test:tenant-integrity` | **PASS** |
| 09 | `npm run typecheck` | **PASS** |
| 10 | `npm run build` | **PASS** |
| 11 | `npm run lint` | **PASS** |

**11/11 steps PASS · 485 assertions PASS · 0 failures · 0 leftover scratch databases.**

`EASY_LEARN_REQUIRE_TLS_E2E`, `EASY_LEARN_REQUIRE_ASSIGNMENT_PREREQ`,
`EASY_LEARN_REQUIRE_SCRATCH_DB_LIFECYCLE` and `EASY_LEARN_REQUIRE_TENANT_INTEGRITY` were all set to
`true` for the replication, so no suite could silently skip.

These results are the **baseline**: they describe `main` @ `016d229`, not the patch. They must be
re-run once the patch is supplied.

---

## 9. Explicitly out of scope

* Server-side session revocation / a JWT denylist (G-5) — unless the patch states otherwise.
* PostgreSQL row-level security.
* Secret rotation in any live environment. The patch may only *validate* a secret; it must not
  rotate one.
* Any change to production configuration, production data, or the migration chain.
* The 26 child-side indexes / migration 0019 — separate, independently reviewed work.
* The seed-transactional-atomicity fix — already tracked in its own draft PR (#36).

---

## 10. Status labels

| Item | Label |
|---|---|
| Branch created from the correct base, tree byte-identical to `main` | **IMPLEMENTED** |
| Baseline security analysis and acceptance checklist in this document | **IMPLEMENTED** |
| Local CI replication on the base (11/11, 485 assertions) | **TESTED** |
| The patch diff itself | **BLOCKED** — commit `f47916f…` unavailable |
| Independent review of the patch | **BLOCKED** — requires the diff |
| Merge | **BLOCKED** — requires review and an explicit authorization |
| Deployment / production verification | **NOT STARTED** |
