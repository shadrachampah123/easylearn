# EasyLearn — Authentication and Session Security

This document describes how the EasyLearn session actually works: how the signing
key is chosen, how the browser session is carried, how cross-site requests are
refused, what logging out does and does not do, and which risks remain open.

It is written to be checked against the code. Every claim below points at the
file that implements it. Where something is **not** fixed, this document says so
rather than describing the intended state.

- **Status:** IMPLEMENTED and TESTED on the branch `security/rebuild-cookie-auth-hardening`.
  Not merged, not deployed, not production-verified.
- **Scope of the change:** the JWT signing secret policy, the browser session
  transport, the CSRF policy, the safe-method guarantee, the logout guarantee and
  the production CSP.
- **Out of scope:** database-level row security, session revocation, MFA, rate
  limiting on non-login endpoints, and the migration work that is tracked
  separately.

---

## 1. The signing secret

### The policy

`src/lib/jwt-policy.ts` is the single place where the JWT secret is judged. The
rules are:

| Rule | Value | Why |
|---|---|---|
| Minimum length | 32 characters | A short secret is brute-forceable. |
| Minimum distinct characters | 10 distinct characters | Rules out `aaaaaaaaaaaaaaaa…` and `abababab…`. |
| Placeholder set | rejected | `changeme`, `secret`, `your-secret-here`, `example`, `test` … must never reach production. |
| Repeated character | rejected | `xxxx…` passes a length check but carries no entropy. |
| Repeating block | rejected | A block of ≤ half the length repeated is not random. |
| Entropy claim | **not** asserted | A length check is not a proof of randomness. See below. |

**A long secret is not necessarily a random secret.** "32 characters" is a floor,
not a certificate. The policy deliberately does not claim that a secret is
unguessable; it only rejects the values that are *demonstrably* weak. The actual
entropy comes from how the secret is generated, which is why the next section is
the operationally important one.

### Where it is enforced

`getJwtKey()` in `src/lib/auth.ts` calls `assertJwtSecretIsUsable()` before it
signs or verifies anything. Because every issuance and every verification goes
through `getJwtKey()`, the policy is enforced at one chokepoint rather than at
each call site — `src/app/api/auth/login/route.ts` and
`src/app/api/auth/select-school/route.ts` no longer need their own ad-hoc
guards.

`verifyToken()` re-throws a configuration error rather than swallowing it, so a
misconfigured deployment fails loudly instead of quietly rejecting every token.

`src/lib/database-errors.ts` maps the configuration error to an **actionable
503** whose message names the environment variable and how to fix it. The message
never contains the secret, and never echoes any part of it.

### Generating and rotating the secret

Generate one:

```bash
openssl rand -base64 48      # 64 characters, 384 bits of entropy
```

The same check the CI runs is available to an operator:

```bash
npm run security:check-secret
```

It exits `0` when `JWT_SECRET` is acceptable and `1` with an explanation when it
is not. It never prints the secret.

**Rotation** is a full key change, not an in-place edit:

1. Generate a new secret with `openssl rand -base64 48`.
2. Set `JWT_SECRET` to the new value in the deployment environment.
3. Redeploy. **Every existing session is invalidated**, because the old token was
   signed with the old key and no longer verifies. This is the desired outcome
   after a suspected compromise; it is also the reason to plan rotation for a
   time when nobody is mid-task.
4. Keep the old value only long enough to roll back a bad deployment, then
   discard it. A rotation does not need a dual-key window, because the cost of
   the window is that the compromised key still works.

Do not reuse a secret across environments. Do not commit a secret. `.env.example`
carries the guidance and an empty value, so it cannot be used by accident.

---

## 2. The browser session

### The transport

The browser session is a single **`httpOnly` cookie** named `el_token`.

| Property | Value | Why |
|---|---|---|
| `httpOnly` | `true` | JavaScript on the page cannot read it, so an XSS bug cannot exfiltrate it directly. |
| `secure` | `true` in production | It is never sent over plain HTTP in production. |
| `sameSite` | `lax` | A second layer only — see §4. |
| `path` | `/` | The cookie is sent to every route. |
| `maxAge` | 24 hours | Matches the token lifetime (`TOKEN_EXPIRY = "24h"`). |

The name is defined once, in `src/lib/session-cookie.ts`, and imported by every
producer and consumer — the login route, the school-selection route, the logout
route and the request reader in `src/lib/auth.ts`. There is no second literal
anywhere, so the set/clear pair cannot drift apart and leave a cookie behind
after a logout.

### What the server returns

The login response body and the school-selection response body **do not contain
the token**. The body carries the user and the available schools; the session
travels in the `Set-Cookie` header only.

This matters because a response body is reachable by script. A body is written to
the network panel, to a proxy log, to a browser extension and to any
`fetch()` caller on the page. The cookie is not.

### The client's call path

All browser API calls go through `apiFetch()` in `src/lib/api-client.ts`:

- `credentials: "same-origin"` — the cookie is attached to same-origin requests
  and is **never** sent to a cross-origin URL.
- Any `Authorization` header on the request is **deleted** before the request is
  made, so a call site cannot reintroduce bearer authentication in the browser
  even by mistake.
- Nothing is read from or written to `localStorage` or `sessionStorage`. There is
  no `getToken()` for a caller to reach for.

The browser learns who it is from `GET /api/auth/me`, which reads the cookie on
the server. `src/components/dashboard/DashboardShell.tsx` and
`src/app/change-password/page.tsx` hydrate from that endpoint.

One `localStorage.removeItem("el_token")` remains in `DashboardShell.tsx`. It is
a deliberate clean-up of the token that earlier releases cached, so that a user
who used an older build does not keep a readable credential lying around. It
reads nothing.

### What was removed

- The `token` field from the login and school-selection response bodies.
- The `?token=` query-parameter fallback on `GET /api/files/[id]`. A token in a
  URL leaks into the browser history, into `Referer` headers, into proxy and
  server logs and into any screenshot. Same-origin `<img>` and `<video>` tags
  carry the cookie by themselves.
- The `tokenOverride` parameter from `src/lib/tenant.ts`. Every authorization
  decision now derives the caller from the request and nothing else.
- The `Bearer` headers from the browser code. There are none left.

### What is deliberately still supported

`Authorization: Bearer <token>` is still accepted **by the server**. This is a
supported path for non-browser integrations — a script, a service, a mobile
client — that cannot use a browser cookie jar. It is not a browser feature and
the browser code does not use it.

This support is the reason the CSRF policy in §4 treats a bearer request
differently from a cookie request.

---

## 3. Safe methods

A `GET` must not change state.

Two routes used to break that rule:

| Route | What it did | What it does now |
|---|---|---|
| `GET /api/learner/stats` | Awarded achievement rows as a side effect of reading the statistics. | `GET` only reads. `POST /api/learner/stats` awards, and returns the newly awarded achievements. |
| `GET /api/messages?userId=…` | Marked the conversation as read. | `GET` only reads. `POST /api/messages/read` marks it, and the client calls it when the user opens the conversation. |

The reason this matters is not only CSRF. A `GET` that writes can be triggered
by a link prefetch, by a crawler, by a browser's speculative connection, or by a
`<img>` tag on someone else's page. Each of those would have marked a user's
messages as read or awarded an achievement without the user doing anything.

The check is enforced by a test (`tests/cookie-auth.test.ts`) that parses every
API route with the TypeScript compiler and fails if a `GET` handler contains a
write. Adding a new state-changing `GET` fails the suite.

---

## 4. Cross-site request forgery

### The threat

The session is a cookie. A cookie is attached to a cross-site request as well
as a same-origin one. `SameSite` reduces that, but `SameSite` is a single
browser-level heuristic: it is not configured per route, it has known gaps, and
it is not available to non-browser clients at all. It is a second layer. The
control is the origin check.

### The policy

`src/lib/csrf.ts` evaluates every state-changing request. `src/proxy.ts` — the
file Next.js 16 calls `proxy`, formerly `middleware` — applies it to **every**
`/api/*` route, so no route can opt out by accident.

A request is evaluated as follows, in order:

| # | Condition | Outcome |
|---|---|---|
| 1 | The method is not `POST`, `PUT`, `PATCH` or `DELETE` | **Allowed.** A safe method does not change state. |
| 2 | The request carries `Authorization: Bearer …` | **Allowed.** A deliberately supported non-browser client. |
| 3 | `Origin` matches the request's own origin | **Allowed.** |
| 4 | `Origin` matches an entry in `EASY_LEARN_ALLOWED_ORIGINS` | **Allowed.** |
| 5 | There is no `Origin`, but `Sec-Fetch-Site` is `same-origin` or `none` | **Allowed.** |
| 6 | There is no `Origin`, and `Sec-Fetch-Site` is `cross-site` or `same-site` | **Refused.** |
| 7 | There is neither an `Origin` nor a `Sec-Fetch-Site` | **Refused.** |

**Rule 7 is the important one.** When a request carries no information at all
about where it came from, the policy refuses it. Failing open would make "strip
the `Origin` header" a bypass, which is exactly the kind of bypass an attacker
tries first. A request that genuinely has neither header — an old client, a
command-line tool — can present a bearer token and be allowed by rule 2.

`Sec-Fetch-Site: same-site` is refused. A sibling subdomain is a different
origin and is not this application; allowing it would hand the session to every
subdomain of the deployment's domain.

### Why the bearer exception does not weaken the cookie path

A browser cannot set the `Authorization` header on a cross-site request without
a CORS preflight, and this application does not enable CORS. A cross-site
`fetch` with `Authorization` is therefore refused by the browser before it
reaches the server. The exception only lets non-browser clients through.

The one thing a browser *can* do cross-site is send a cookie, and that is
precisely the case rules 3–7 refuse.

### The request's own origin

The request origin is derived from `X-Forwarded-Host` and `X-Forwarded-Proto`
when they are present, and from the `Host` header and the URL otherwise. A
comma-separated forwarded header uses its first value. The comparison ignores
the path and the query, treats `https://host` and `https://host:443` as the
same, and compares the **host**, not a suffix of it — `evil.app.example.test` is
not `app.example.test`.

### The refusal

A refused request gets `403` with a JSON body and `Cache-Control: no-store`.
The message says which rule refused it and names the origin it saw. It never
contains a token, a cookie value or a credential.

### Configuration

`EASY_LEARN_ALLOWED_ORIGINS` is an optional comma-separated list of additional
origins that may make state-changing requests. It is empty by default, and an
empty list means "same origin only".

### The development seed endpoint

`POST /api/seed` is `404` in production and requires a `super_admin` session in
development, so it was never reachable by an unauthenticated request. Under this
policy it additionally has to identify its origin, which means a command-line
invocation has to present the session token as a bearer token:

```bash
curl -X POST https://YOUR-APP.vercel.app/api/seed \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN"
```

A browser-driven request from the application's own origin works without any of
that. The documentation that showed a bare `curl -X POST .../api/seed` was
already stale — it would have been refused with `401` — and has been corrected.

### `SameSite` was deliberately not changed

`SameSite` stays `lax`. Switching it to `strict` was considered and rejected:

- `lax` still sends the cookie on a top-level `GET` navigation, which is what
  keeps an emailed link to the application working.
- `strict` would not send the cookie on any cross-site navigation, including a
  link from another site. That is a usability change with a real failure mode
  (the user lands on the sign-in page instead of the page they were sent to),
  and it protects only against the top-level-navigation case that `lax` already
  covers.
- An existing test asserts `sameSite === "lax"`; changing it would have meant
  changing a test to match the code rather than the other way round.

The origin check is the control. `SameSite` is defence in depth.

---

## 5. Logging out

### What it does

`POST /api/auth/logout` clears the `el_token` cookie in the browser that made
the request, using the same `path`, `sameSite`, `httpOnly` and `secure`
attributes it was set with, and answers with `Cache-Control: no-store` so the
response cannot be cached and replayed.

### What it does not do

**It does not revoke the token.**

The session token is a stateless, signed JWT. There is no server-side session
store and no revocation list. A token that was copied out of the cookie before
the logout — by a browser extension, by a user who was already on the machine,
by a log that captured it — remains valid until its 24-hour expiry, whoever
holds it. Including a deliberately supported non-browser bearer client.

This is a real limitation and it is stated here rather than implied away. It is
also inherent to the stateless design, not a defect in the logout handler.

### Adding revocation

Revocation fits the architecture in two ways, and both are larger than a patch:

1. **A token-version column on the user.** Bump the version on logout; compare
   it on every authenticated request. It needs a migration, a write on every
   logout, and a read on every request. It also revokes *all* of that user's
   sessions, not one.
2. **A server-side session store.** A session identifier in the cookie, a row
   per session. It gives per-session revocation and immediate expiry, at the
   cost of a database round trip on every request and a new cleanup job.

Both are follow-up work. Neither is in this change.

### Session expiry

The token expires after 24 hours (`TOKEN_EXPIRY = "24h"`), and the cookie's
`maxAge` matches. An expired token fails verification and the API answers `401`;
the client sends the user back to the sign-in page. There is no refresh token
and no silent renewal, so the session ends at the 24-hour mark regardless of
activity.

---

## 6. Security headers and the CSP

`next.config.ts` sets the response headers.

The Content Security Policy is **different in production and in development**,
deliberately:

| Directive | Production | Development | Why |
|---|---|---|---|
| `script-src` | `'self' 'unsafe-inline' blob:` | `'self' 'unsafe-eval' 'unsafe-inline' blob:` | The development server compiles modules with `eval` (React Fast Refresh). The production build does not use `eval` anywhere. |
| `connect-src` | `'self' https:` | `'self' https: wss: ws:` | The development server's hot-reload socket. The application opens no WebSocket of its own. |

Removing `'unsafe-eval'` from the production `script-src` is the single most
effective way to tighten a script policy, because `eval` turns a string into
code and defeats the policy entirely.

The rest of the policy is unchanged and was already reasonable:
`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`.
`style-src` keeps `'unsafe-inline'` because React inline `style` attributes
require it.

### The remaining exposure, stated plainly

**`'unsafe-inline'` is still in the production `script-src`.** An injected inline
`<script>` would still execute. The CSP is therefore **not** a hardened
allow-list for scripts, and this document does not claim that it is.

Removing it requires a **nonce-based** policy, which is a separate piece of work
with a concrete plan:

1. Generate a per-request nonce in `src/proxy.ts` (it already runs on every
   request) and set it on the forwarded request headers.
2. Build the CSP there with `script-src 'self' 'nonce-<value>'
   'strict-dynamic'` and set it on the response. The `headers()` block in
   `next.config.ts` must stop emitting a competing `Content-Security-Policy`, or
   the response will carry two policies and the browser will enforce the
   intersection.
3. Read the nonce in the root layout and pass it to any `<Script>` component the
   application renders.
4. Audit every third-party script the application loads. A nonce only helps for
   scripts the application controls; a third-party script loaded from another
   origin needs `'strict-dynamic'` (which trusts scripts loaded by a nonced
   script) or an explicit allow-list entry.

The risk of doing this in the same change as the authentication work is that a
policy that breaks the application is worse than a policy that is merely
incomplete, and the breakage would be invisible to every test in this
repository — a CSP violation appears in a browser console, and this repository
has no browser-level test harness (§8). It is therefore sequenced as a
follow-up, with the plan recorded here.

### The other headers

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` — production only |

---

## 7. What is tested, and what is not

### Automated tests

| Suite | File | What it proves |
|---|---|---|
| JWT secret policy | `tests/jwt-secret-policy.test.ts` | Weak, short, low-diversity, placeholder and periodic secrets are rejected; a 5000-sample random sweep produces no false rejections. |
| CSRF policy | `tests/csrf-policy.test.ts` | Every rule in §4, including the fail-closed case and the fact that a `Basic` header is not a bypass. |
| Cookie auth and safe methods | `tests/cookie-auth.test.ts` | The response bodies carry no token; no browser file stores, reads or sends a token; no route reads a token from a URL; no `GET` handler writes; the cookie name has one definition. |
| Membership and session | `tests/membership-auth-db.test.ts` | The login flow, the school-selection flow and the session, read from the cookie the way a browser does, and asserting that the response body carries no token. |
| The existing suites | `tests/security.test.js`, `tests/tenant-*.test.ts`, `tests/membership-*.test.ts`, … | The tenant isolation and authorization boundaries are unchanged. |

The `test:auth-security` script runs the first three suites on their own, and
the CI workflow runs them as an explicit step in addition to `npm test`.

### Not verified here — and stated as such

- **No browser-level test.** This environment has no browser, no Playwright and
  no Puppeteer. The cookie behaviour, the CSP enforcement and the
  `SameSite` behaviour are therefore verified at the HTTP level and by source
  analysis, not by a real browser. A reviewer should open the application in a
  browser and confirm that: signing in works; the dashboard loads; the file
  preview loads; a cross-origin `POST` to an API route is refused with `403`;
  the browser console shows no CSP violation.
- **The production CSP change could not be observed in a browser.** The
  reasoning for removing `'unsafe-eval'` is that the production build does not
  use `eval` — which was checked by searching the application source — but the
  *bundled dependencies* were not audited for it. If the preview environment
  shows CSP violations in the browser console, that is where to look.
- **No deployment, no production verification.** Nothing in this change has been
  deployed, and no production setting, secret, migration or record was touched.
- **No independent security review.** The changes were implemented and tested by
  the same author. A review by someone else is still required before this is
  merged.

---

## 8. Remaining risks, ranked

| # | Risk | Status |
|---|---|---|
| 1 | A copied JWT is usable until it expires; logout does not revoke it. | **Open.** Documented in §5. Needs a token-version column or a session store. |
| 2 | `'unsafe-inline'` remains in the production `script-src`. | **Open.** The follow-up plan is in §6. |
| 3 | No browser-level verification of the cookie or CSP behaviour. | **Open.** Blocked by the environment, not by the design. |
| 4 | The bearer path lets a non-browser client act without an origin check. | **Accepted.** Deliberately supported; it is the only way a script or a service authenticates. It cannot be exercised by a browser cross-site (§4). |
| 5 | `EASY_LEARN_ALLOWED_ORIGINS` widens the set of origins that may make state-changing requests. | **Accepted.** Empty by default. It must be set deliberately, and each entry is a full trust decision. |
| 6 | The rate limit on the login route is in-process. | **Open.** A multi-instance deployment does not share it. Out of scope for this change. |
| 7 | No MFA, and no account lockout beyond the login rate limit. | **Open.** Out of scope. |
| 8 | No database-level row security (RLS). | **Open.** Out of scope; tenant isolation is enforced in the application layer and covered by the tenant test suites. |

---

## 9. Where to look in the code

| Concern | File |
|---|---|
| The JWT secret policy | `src/lib/jwt-policy.ts` |
| Signing, verifying and reading the session | `src/lib/auth.ts` |
| The secret in the environment | `src/lib/env.ts` |
| The cookie name and the cookie reader | `src/lib/session-cookie.ts` |
| The browser call path | `src/lib/api-client.ts` |
| The CSRF policy | `src/lib/csrf.ts` |
| The CSRF enforcement point | `src/proxy.ts` |
| The session lifecycle routes | `src/app/api/auth/{login,select-school,me,logout}/route.ts` |
| The security headers | `next.config.ts` |
| The operator secret checker | `scripts/check-jwt-secret.mjs` |
