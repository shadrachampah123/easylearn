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

All browser API calls go through `apiFetch()` in `src/lib/api-client.ts`. This is
enforced, not merely intended: `tests/cookie-auth.test.ts` parses every browser
file with the TypeScript compiler and fails if any of them contains a `fetch()`
call site or constructs an `Authorization` header. The check is on the parsed
call sites, so a file cannot be exempted by mentioning `apiFetch` in an import.

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
| 8 | The comparison origin was **derived**, the `Origin` header's **host** is one of ours, and the browser reports `Sec-Fetch-Site: same-origin` | **Allowed.** The browser's own proof of same-origin — see "The browser's own assertion" below. |

**Rule 7 is the important one.** When a request carries no information at all
about where it came from, the policy refuses it. Failing open would make "strip
the `Origin` header" a bypass, which is exactly the kind of bypass an attacker
tries first. A request that genuinely has neither header — an old client, a
command-line tool — can present a bearer token and be allowed by rule 2.

**Rule 8 is the narrow one.** It exists because the derived *scheme* is not
fully trustworthy (Next.js keeps a client-supplied `X-Forwarded-Proto`), and it
only ever allows what rule 3 would have refused, and only when the browser
itself asserts the request is same-origin. A foreign origin, a same-host
different-scheme request and a request with no `Sec-Fetch-Site` are all still
refused.

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

The comparison origin is **not guessed**. It is resolved in this order.

**1. `EASY_LEARN_PUBLIC_ORIGIN` — the deployment's canonical public origin.**

```
EASY_LEARN_PUBLIC_ORIGIN="https://easylearn.example.com"
```

When it is set, it **is** the origin: the request is compared against that
value and the forwarded headers are ignored completely. This is the
recommended configuration for any deployment behind a reverse proxy, a CDN or
a platform edge, because it removes every question about what the edge does
with the headers it forwards.

**2. Otherwise the origin comes from the request itself** — the `Host` header
and the scheme of the request URL. The forwarded headers are **not** consulted.
The derived scheme is not fully trustworthy, and rule 8 of the policy above
exists for that reason.

**3. `EASY_LEARN_TRUST_PROXY_HEADERS=true` opts in to the forwarded headers.**

```
EASY_LEARN_TRUST_PROXY_HEADERS="true"
```

With the opt-in, the **host** is the `Host` header plus a single-valued
`X-Forwarded-Host`, and the **scheme** is `X-Forwarded-Proto` or the scheme of
the request URL, with `https` also a candidate.

#### Why the forwarded headers are not trusted by default

The application **cannot tell a client-supplied `X-Forwarded-Host` from one the
edge set**:

- RFC 7239 lets a proxy *append* to a client-supplied value, and the client's
  value comes **first** in the list;
- an edge that does not set the header at all leaves the client's value in
  place, with nothing to mark it.

Trusting it by default would let a client choose the origin its own request is
compared against — it would only have to name the origin it wanted to reach.
The `Host` header does not have that problem: the server routes on it, so it is
the host the request was actually addressed to.

The multi-valued rule still applies with the opt-in: a multi-valued
`X-Forwarded-Host` is distrusted **entirely**, because the first element of
such a list is the one the client controls.

The extra `https` candidate matters because the scheme that reaches the
application is the scheme of the **last hop**: the server synthesises
`X-Forwarded-Proto: http` for a plain internal hop even when the browser spoke
`https` to the edge. It does not widen the set of **hosts** — it only lets the
public scheme be recognised for the host the proxy already published.

A browser cannot set `X-Forwarded-Host` or `X-Forwarded-Proto` on a cross-site
request without a CORS preflight, and this application does not enable CORS, so
these headers cannot be used to forge an origin from a foreign page even with
the opt-in on.

The comparison ignores the path and the query, treats `https://host` and
`https://host:443` as the same, and compares the **host**, not a suffix of it —
`evil.app.example.test` is not `app.example.test`.

#### The scheme is still forwarded-header-derived — and what the application does about it

The **host** is taken from the `Host` header, and the **scheme** from the
request URL. In Next.js those two are not independent of the forwarded
headers:

```js
// next/dist/server/next-server.js
const protocol = req.headers["x-forwarded-proto"]?.includes("https") ? "https" : "http";
```

and the header is **synthesised** when it is absent, from the socket's TLS
state — but it is **kept** when the client sent one:

```js
// next/dist/server/base-server.js
req.headers["x-forwarded-proto"] ??= isHttps ? "https" : "http";
```

So in the default configuration:

- `X-Forwarded-Host` is genuinely ignored — the host comes from `Host`;
- `X-Forwarded-Proto` still reaches the derived scheme, indirectly, through
  the request URL, and a **client-supplied** value survives.

What that can and cannot do:

| | |
|---|---|
| Can it make a **foreign** origin acceptable? | **No.** The host still comes from `Host`, so a client that names another host in `Origin` is refused. |
| Can it **refuse** a write? | **Yes.** A client that sends `X-Forwarded-Proto: https` to a deployment the browser reaches over plain HTTP makes the application compare the request against `https://<host>` while the browser sent `http://<host>`. The write is refused — a self-inflicted denial, not a cross-origin hole. |

A browser cannot set `X-Forwarded-Host` or `X-Forwarded-Proto` on a cross-site
request without a CORS preflight, and this application does not enable CORS, so
these headers cannot be used to forge an origin from a foreign page.

##### The browser's own assertion (rule 3b)

The denial above is now gone. When the comparison fails, and the comparison
origin was **derived** (no `EASY_LEARN_PUBLIC_ORIGIN`), and the `Origin`
header's **host** is one of the hosts the request was addressed to, and the
browser reports **`Sec-Fetch-Site: same-origin`**, the request is **allowed**.

`same-origin` means the request's origin **is** the initiator's origin, so the
browser has already answered the question the derived origin was supposed to
answer — about the **real** origins, not about a header a client could send. A
page on another origin cannot set `Sec-Fetch-Site`: it is a forbidden header
name, so only the browser sets it.

What the rule does **not** weaken:

| | |
|---|---|
| A foreign origin | Still refused — its host is not one of ours. |
| A same-host, **different-scheme** browser request (a page on the plaintext version of the same host) | Still refused — the browser reports `same-site` for it, not `same-origin`. This is the attack the scheme comparison used to stop. |
| A request with **no** `Sec-Fetch-Site` | Still refused — without the browser's own claim there is no proof about the real origins, so the comparison stays strict. Failing closed. |
| A deployment with `EASY_LEARN_PUBLIC_ORIGIN` | The rule does **not** apply. The configured origin is exact, and it is the authoritative answer. |
| The trusted-proxy opt-in | The forwarded host joins the trusted host set, exactly as it already joins the candidate origins. A multi-valued forwarded host is distrusted entirely. |

The rule only ever allows what the strict comparison would have refused, and
only when the browser itself has said the request is same-origin.

#### Deployment assumptions

| Deployment | What to set |
|---|---|
| Direct, no proxy | Nothing. The `Host` header is the public host and the request URL's scheme is the public scheme. |
| Behind an edge that **preserves** the `Host` header | Nothing. Next.js derives the request URL's scheme from `X-Forwarded-Proto`, so a TLS-terminating edge already presents an `https` URL. |
| Behind an edge that **rewrites** the `Host` header to an internal name, or that rewrites the scheme | `EASY_LEARN_PUBLIC_ORIGIN`. Without it the derived origin is the internal one and every state-changing request is refused with `403`. That is a safe failure — it refuses writes — but it is an outage. |
| Behind an edge known to **overwrite** (never append to) the forwarded headers, and the operator accepts the trade-off | `EASY_LEARN_TRUST_PROXY_HEADERS=true`. |

The same assumptions are stated in `.env.example`.

### The refusal

A refused request gets `403` with a JSON body and `Cache-Control: no-store`.
The message says which rule refused it and names the origin it saw. It never
contains a token, a cookie value or a credential.

### Configuration

`EASY_LEARN_ALLOWED_ORIGINS` is an optional comma-separated list of additional
origins that may make state-changing requests. It is empty by default, and an
empty list means "same origin only". It is documented in `.env.example`.

Each entry is a full trust decision: anything running on that origin can make
state-changing requests with the session cookie. Add an entry only if a
separate, trusted origin genuinely has to make state-changing calls.

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

## 7. Uploaded files

### The rule

**The server decides what an uploaded file is.** The client never does.

Before this rule, `POST /api/uploads` stored the MIME type the *client*
declared in `uploaded_files.mime_type`, and `GET /api/files/<id>` served that
column back as the `Content-Type`. A client could therefore upload a file
called `photo.png`, declare `Content-Type: text/html`, and have the
application's own origin serve the uploaded bytes as an HTML document — a
stored cross-site scripting hole in the **authenticated** origin, with the
session cookie attached. The same hole applied to `image/svg+xml`, and to any
file whose extension was on the allow-list but whose bytes were something else.

Now, in order:

1. **The extension must be on the server's allow-list.** The extension is the
   only part of the request the server stores, so it is the anchor. `html`,
   `htm`, `xhtml`, `svg`, `xml` and friends are not on it, and there is no
   configuration that adds them.
2. **The bytes must match that extension's signature.** The server reads the
   file's own header — the PNG signature, the ZIP header, the OLE2 header, the
   `ftyp` box — and refuses the file if it does not match. A ZIP renamed to
   `.png` is refused; so is HTML renamed to `.txt`.
3. **The bytes must not look like HTML, SVG or XHTML**, whatever the extension
   claims. The check looks for the *document* markers — a doctype, an `<html>`
   root, an `<svg>` root, an XML prologue followed by SVG — and not for the
   word `<script>`, because a plain-text assignment that contains a code
   sample is a legitimate upload.
4. **The content type that is served is the server's**, taken from the
   allow-list. It is never `text/html`, `image/svg+xml`,
   `application/xhtml+xml` or any other type a browser can execute. The
   client's declared type is used for one thing only: to produce a clearer
   error when the client asked for something dangerous.

The policy lives in `src/lib/upload-content.ts` and is applied in
`src/app/api/uploads/route.ts` (local disk), `src/app/api/uploads/presign/route.ts`
(object storage) and `src/app/api/files/[id]/route.ts` (serving).

### How a file is served

| | |
|---|---|
| `Content-Type` | The server's type for the stored file's extension — **not** the stored `mime_type` column. |
| `Content-Disposition` | `inline` for images, video and audio; `attachment` for documents and archives. |
| `X-Content-Type-Options` | `nosniff`, so the browser never guesses a different type. |
| `Content-Security-Policy` | `sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` — a response the browser treats as a document is put into an opaque origin with scripting disabled. |
| `Cross-Origin-Resource-Policy` | `same-origin`. |

The sandbox is the second layer. The first is that the served type is never
scriptable and an unknown file is never rendered inline.

**Files uploaded before this rule are covered too.** The serve route derives
the type from the stored file name, not from the stored column, so a row
written by the old code — with `mime_type = 'text/html'` and a `.png` stored
name — is served as `image/png`. A stored name whose extension is not on the
allow-list is served as `application/octet-stream` with a download
disposition.

### What is deliberately NOT allowed

`html`, `htm`, `xhtml`, `xht`, `svg`, `svgz`, `xml`, `mhtml`, `mht`, `js`,
`mjs`, `swf`, `jar`, `hta`, `vtt`, `shtml` and `php` are refused outright.

HTML and SVG are **document** formats: the browser renders them and they can
carry script. Serving them safely needs an origin that cannot reach the
session — a separate, cookieless file origin, with the application talking to
it over a server-side channel. That is a real piece of architecture and it is
**not** implemented here. Until it is, the formats are refused, and the
refusal is a refusal rather than a warning.

### The object-storage path

When `OBJECT_STORAGE_*` is configured, the browser PUTs the bytes straight to
the bucket and the application never sees them. The complete flow is:

1. `POST /api/uploads/presign` — the server authenticates the caller, checks
   the role/purpose rules, derives the content type **from the extension
   allow-list** (never from the client's declared type), refuses a client that
   declares a scriptable type, applies the size limits to the declared size,
   mints the object key (`uploads/<purpose>/<uuid>.<ext>`), registers the
   `uploaded_files` row with `storage_backend = "object"` and returns a
   presigned PUT bound to the server's content type.
2. The browser PUTs the bytes to the bucket. **The application never sees
   them.**
3. `GET /api/files/<id>` — the tenant predicate resolves the file, the
   per-file rules run, and the route redirects (**307**) to a presigned GET
   that carries the response-header overrides.
4. The bucket serves the object. **Its** response headers are the ones the
   browser finally sees; the 307's own headers never reach it.

#### What the provider can and cannot enforce — measured, not assumed

`tests/object-storage-live.test.ts` runs a real S3 API server
(`s3rver`, a from-scratch implementation of the S3 REST API) and measures the
store's actual behaviour:

| Response header on the object store's response | Possible? |
|---|---|
| `Content-Type` | **Yes** — `response-content-type` |
| `Content-Disposition` | **Yes** — `response-content-disposition` |
| `Cache-Control` | **Yes** — `response-cache-control` |
| `Content-Language`, `Expires`, `Content-Encoding` | **Yes** — the remaining three |
| `X-Content-Type-Options` (`nosniff`) | **No** — not in the overridable set |
| `Content-Security-Policy` | **No** — not in the overridable set |
| Any other `response-*` parameter | **No** — the store answers **400 `InvalidArgument`** and names the S3-documented set |

So an object-store response **cannot** carry `nosniff` or a CSP. The
protection on that path is therefore the *forced content type* (never a
scriptable one) plus the *forced disposition* (inline only for images, audio
and video), and the bucket must live on a **separate, cookieless origin** —
see "Deployment requirements" below.

**Measured in Chromium 153** (`tests/manual/browser-content-type-sniffing-probe.js`,
nine header combinations): serving HTML bytes with `Content-Type: image/png`
and `Content-Disposition: inline`, **without** `nosniff` and **without** the
sandbox policy, does **not** execute the script — the browser treats
`image/png` as a known image type and does not sniff it into a document.
`application/octet-stream` is downloaded rather than rendered, and
`text/plain` is rendered as literal text. **0 of the 9 combinations executed
script.** That is an observation about Chromium, not a guarantee of the
platform: the served types are never scriptable, which is the property that
holds everywhere.

#### What the application now does about it

The decision is **private storage plus a controlled download endpoint, with the
object verified before the URL is handed out**. Proxying every download
through the application was rejected: it would put hundreds of megabytes of
video through a serverless function, which is the whole reason the direct path
exists. A separate cookieless origin is required as a *deployment*
requirement rather than something the application can enforce.

- **The bytes are verified before the URL is handed out.** `GET /api/files/<id>`
  reads the object's first bytes back from the store (a small ranged GET) and
  applies the same policy the local-disk path applies
  (`verifyObjectContent` in `src/lib/upload-content.ts`): the bytes must match
  the signature of the extension, must not be markup, and the type the store
  recorded must be the type the server derived. A verdict is remembered per
  object ETag, so an unchanged object is not re-validated on every range
  request, and a **changed** object always is.
- **The real size is enforced.** The size the presign request carried is a
  number the *client* supplied; the object that actually arrived is now
  measured, and an object over the 50 MB / 100 MB limits is refused.
- **The store's response is told not to be cached by a shared cache.** The
  download URL signs `response-cache-control: private, max-age=3600`. Without
  it the store sends no cache directive at all, so a CDN in front of the
  bucket could store a private file and serve it to the next user. (The
  307's own `Cache-Control` does **not** help: it governs the redirect
  response, not the object's.)
- **A refused object is reported as "not found"**, so a caller learns nothing
  about what the store holds; a store that cannot be reached is reported as
  **503**, because the file may well exist.

**Measured against the real store** (`tests/object-storage-live.test.ts`):
an object whose bytes are HTML under a `.png` key is refused (404), an object
over the size limit is refused (404), a deleted object is reported as not
found, a legitimate object is served with the forced type and disposition, and
the store's response carries the signed `private` cache directive — and still
no `nosniff` and no CSP, which is the provider limit, not an oversight.

#### Deployment requirements (not enforceable by the application)

- The bucket must be served from an origin that is **not** the application's
  origin and that sets **no cookies**. The session cookie `el_token` is
  host-only (no `Domain` attribute), so the browser does not send it to the
  bucket — but that protection depends on the bucket being a different host.
- `OBJECT_STORAGE_PUBLIC_URL` must **not** be used for private content: it
  makes the download URL an unsigned, permanently public address.
- `OBJECT_STORAGE_DOWNLOAD_EXPIRY` (default 3600 s) is the window in which a
  presigned URL is a bearer credential. The presigned URL grants access with
  **no application session at all** — that is measured in the live suite and
  is inherent to presigned URLs.

### Who can open a file

`GET /api/files/<id>` resolves the file's owning school from the file's own
`uploaded_files.school_id` — the school that wrote it (NOT NULL since
migration 0017, written server-side from the caller's verified school). A
file is readable in that school and **in no other**: a user who belongs to
two schools sees the files they uploaded to each of those schools in the
school that stored them, and never in their other school.

That is the same rule Phase 2D applies to assignments and classes, and it
replaces an earlier relational rule that resolved a file's schools from its
uploader's memberships and its assignment — a rule that made a two-school
uploader's own upload unreadable in **both** schools (`201` on upload, `404`
on download). The purely relational predicate survives as
`sqlFileOwnedRelationally()` and is still used for legacy rows whose
`school_id` is NULL, which remain unattributable and denied to everyone.

`tests/tenant-file-attribution-db.test.ts` (17 assertions, real route handlers
against a real PostgreSQL) covers one school, multiple schools, unauthorized
users, cross-school access, the delete route, membership revocation, the
legacy fallback and the per-file submission rules.

### What is NOT verified here

The sandbox does not break the inline previews of images, video and audio:
this has now been **measured** in Chromium 153
(`tests/manual/browser-content-type-sniffing-probe.js` — the image decodes
(`naturalWidth > 0`), the audio element reaches `readyState 4`, the video
element fetches the resource, and the preview page logs **no**
Content-Security-Policy violation).

Two things are still **not** verified, and are stated as such:

- **Video decoding.** The sandbox in this environment has no sample video
  file and no media tooling, so the video *element's* request was confirmed
  (200, the application's file headers, no CSP violation) but the frame was
  never decoded. A reviewer with a real video should confirm the seek bar and
  the first frame.
- **Other browsers.** Only Chromium 153 was available. Firefox and Safari
  have their own sniffing rules; the property that holds everywhere is the
  one the policy guarantees — the served content type is never scriptable.

Directly navigating to an uploaded image URL makes Chromium's own image-viewer
chrome log a `default-src 'none'` violation, because the sandbox policy
applies to the viewer's inline styles. The image still renders. It is console
noise on direct navigation only, not on an `<img>` in a page.

---

---

## 8. What is tested, and what is not

### Automated tests

| Suite | File | What it proves |
|---|---|---|
| JWT secret policy | `tests/jwt-secret-policy.test.ts` | Weak, short, low-diversity, placeholder and periodic secrets are rejected; a 5000-sample random sweep produces no false rejections. |
| CSRF policy | `tests/csrf-policy.test.ts` | Every rule in §4, including the fail-closed case and the fact that a `Basic` header is not a bypass; the four forwarded-header cases the review asked for — **forged headers, chained proxies, HTTPS termination and ordinary legitimate writes** — under each of the three configurations (default, `EASY_LEARN_TRUST_PROXY_HEADERS`, `EASY_LEARN_PUBLIC_ORIGIN`); and the **browser's own assertion** (rule 8): that a forged `X-Forwarded-Proto` no longer refuses a legitimate same-origin write, that the rule does not apply without `Sec-Fetch-Site`, that a foreign origin and a same-host different-scheme request are still refused, and that it does not apply at all when `EASY_LEARN_PUBLIC_ORIGIN` is configured. |
| Cookie auth and safe methods | `tests/cookie-auth.test.ts` | The response bodies carry no token; no browser file stores, reads or sends a token; no route reads a token from a URL; no `GET` handler writes; the cookie name has one definition; and, on the **parsed** call sites, no browser file calls `fetch()` or builds an `Authorization` header. The call-path guard covers the **aliased** `fetch` (`const f = fetch`), the **destructured** `fetch` (`const { fetch } = window`), **bracket-notation** access (`window["fetch"]`) and `navigator.sendBeacon`, and pins the one justified `XMLHttpRequest` exception. |
| Uploaded file content | `tests/upload-content.test.ts` | The served content type is server-determined for every allow-listed extension; a mismatched declared MIME type, an HTML/SVG/XHTML payload, an extension-spoofed file and an inline-rendered unknown file are all refused; the routes store and serve the server's type rather than the client's; and the forbidden extensions are refused outright. |
| Object-storage content policy | `tests/object-storage-content-policy.test.ts` | The download URL forces the server-determined type and the safe disposition onto the object store's response **and signs them**, so they cannot be swapped out by whoever holds the URL; the signed PUT binds the server's content type; the presign route derives the type from the allow-list and refuses a scriptable declared type. |
| Object storage, against a **real** S3-compatible server | `tests/object-storage-live.test.ts` | The full round trip (presign → PUT → `GET /api/files/<id>` → 307 → the store serves the object) against a real S3 API server and a real PostgreSQL; that the store **applies** the signed content type, disposition and private cache directive; that the store **cannot** apply `nosniff` or a CSP and **rejects** any `response-*` override outside the S3-documented set; that the presigned URL is a bearer credential; and that the application refuses an object whose bytes do not match its key, an object over the size limit, and an object that no longer exists. |
| Uploaded-file tenant attribution | `tests/tenant-file-attribution-db.test.ts` | One school, multiple schools, unauthorized users, cross-school access, the delete route, membership revocation, the legacy `NULL school_id` fallback and the per-file submission rules — each against the real route handlers. |
| Membership and session | `tests/membership-auth-db.test.ts` | The login flow, the school-selection flow and the session, read from the cookie the way a browser does, and asserting that the response body carries no token. |
| The existing suites | `tests/security.test.js`, `tests/tenant-*.test.ts`, `tests/membership-*.test.ts`, … | The tenant isolation and authorization boundaries are unchanged. |

The `test:auth-security` script runs the first four suites on their own, and
the CI workflow runs them as an explicit step in addition to `npm test`.

There are also **manual** probes. They are not run by CI, because they need a
running server, a seeded database and (for the browser ones) a Chromium
binary; the instructions are in each file's header.

| Probe | What it proves |
|---|---|
| `tests/manual/live-upload-content-probe.js` | The **actual served response** against a production build — including a row written directly into the database to simulate a file uploaded before the fix. |
| `tests/manual/browser-upload-verification.js` | The same flow in a **real browser**: login, session cookie, school selection, navigation, the forged-forwarded-header write, an ordinary write, a cross-site write, the real upload UI with legitimate and hostile files, the served response, the attempt to execute an uploaded payload, logout, and the console. |
| `tests/manual/browser-content-type-sniffing-probe.js` | What Chromium **does** with each header combination the object store could return, and whether the sandbox CSP breaks the image / audio / video previews. |
| `tests/manual/forwarded-header-configuration-matrix.js` | The same state-changing request against all three origin configurations. |

### Not verified here — and stated as such

- **Browser-level verification: DONE, with one browser.** A real headless
  Chromium (153.0.8010.0) was driven against a production build on a
  disposable database. `tests/manual/browser-upload-verification.js` runs the
  whole flow — login, session cookie, school selection, navigation, the
  forged-forwarded-header write, an ordinary write, a cross-site write, the
  real upload UI with legitimate and hostile files, the served response, the
  attempt to execute an uploaded payload, logout, and the console — and
  reports **34 of 34 checks passed**. `tests/manual/browser-content-type-sniffing-probe.js`
  reports **0 of 9 header combinations executed script** and **0 preview
  failures**. `tests/manual/forwarded-header-configuration-matrix.js` runs the
  same write against all three configurations. **Firefox and Safari were not
  available** — see §7.
- **Video decoding in a browser.** The element's request was confirmed; no
  sample video was available in the environment, so no frame was decoded (§7).
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

## 9. Remaining risks, ranked

| # | Risk | Status |
|---|---|---|
| 1 | A copied JWT is usable until it expires; logout does not revoke it. | **Open.** Documented in §5. Needs a token-version column or a session store. |
| 2 | `'unsafe-inline'` remains in the production `script-src`. | **Open.** The follow-up plan is in §6. |
| 3 | Browser-level verification of the cookie, the CSP and the upload flows. | **Closed for Chromium 153** — 34/34 browser checks, 0/9 sniffing combinations, 0 preview failures (§8). **Still open for Firefox and Safari**, which were not available. |
| 4 | The bearer path lets a non-browser client act without an origin check. | **Accepted.** Deliberately supported; it is the only way a script or a service authenticates. It cannot be exercised by a browser cross-site (§4). |
| 5 | `EASY_LEARN_ALLOWED_ORIGINS` widens the set of origins that may make state-changing requests. | **Accepted.** Empty by default. It must be set deliberately, and each entry is a full trust decision. |
| 6 | The rate limit on the login route is in-process. | **Open.** A multi-instance deployment does not share it. Out of scope for this change. |
| 7 | No MFA, and no account lockout beyond the login rate limit. | **Open.** Out of scope. |
| 8 | No database-level row security (RLS). | **Open.** Out of scope; tenant isolation is enforced in the application layer and covered by the tenant test suites. |
| 9 | In the object-storage path the bytes never reach the application, so they are not content-validated. | **Closed for the retrievable object.** The application now reads the object's first bytes back from the store and applies the same content policy the local path applies, measures the real size against the limits, and refuses anything that does not match (§7). The upload itself is still a direct browser→bucket PUT, so a **quarantined** object can exist in the bucket; it is inert, but it is stored. |
| 9b | An object-store response cannot carry `nosniff` or a CSP. | **Open, provider limit.** The S3 API allows exactly six `response-*` overrides and the store rejects any other (§7). The protection is the forced content type plus the forced disposition, and the bucket must be on a separate cookieless origin. |
| 9c | A presigned download URL is a bearer credential. | **Accepted, inherent.** It grants access with no application session for `OBJECT_STORAGE_DOWNLOAD_EXPIRY` seconds (default 3600). Measured in the live suite (§7). Keep the expiry short; never set `OBJECT_STORAGE_PUBLIC_URL` for private content. |
| 10 | `EASY_LEARN_TRUST_PROXY_HEADERS=true` lets a client-supplied `X-Forwarded-Host` choose the comparison origin. | **Accepted, and off by default.** It is an explicit operator decision that the edge overwrites the header (§4). A browser still cannot set it cross-site without a CORS preflight. |
| 11 | In the **default** configuration the derived scheme still comes from `x-forwarded-proto`, because Next.js builds the request URL from it and keeps a client-supplied value. | **Closed for availability.** It can never make a foreign origin acceptable — the host still comes from `Host` — and it can no longer refuse a legitimate write either: the browser's own `Sec-Fetch-Site: same-origin` is accepted as proof of same-origin when the derived scheme disagrees (§4, rule 8). The dependency itself is removed by `EASY_LEARN_PUBLIC_ORIGIN`, which remains the recommended configuration behind an edge. |
| 12 | A user who is an active member of **two** schools cannot open their own uploaded files: the file's owning-school set resolves to two schools and is denied to both. | **Closed.** A file is now attributed by its own `uploaded_files.school_id` — the school that wrote it — the same rule Phase 2D applies to assignments and classes. The file is readable in that school and in no other; the uploader's second school still gets 404. The relational predicate survives for legacy `NULL school_id` rows, which stay denied to everyone (§7). **Needs an independent review**, because it is a tenant-isolation change. |

---

## 10. Where to look in the code

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
| The uploaded-file content policy | `src/lib/upload-content.ts` |
| The object-storage client and the provider's limits | `src/lib/object-storage.ts` |
| The guard for objects that live in the bucket | `src/lib/object-guard.ts` |
| The upload and file-serving routes | `src/app/api/uploads/route.ts`, `src/app/api/uploads/presign/route.ts`, `src/app/api/files/[id]/route.ts` |
| The operator secret checker | `scripts/check-jwt-secret.mjs` |
