# Phase 2B — User Membership & Authentication Context

Internal audit + design record for Phase 2B. Everything in §1 was read out of the
repository at commit `18d32f8` (Phase 2A merged, PR #17) before a single line was changed.

Related documents:

- `docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md` — the architecture this phase implements
  (§6 membership, §7 super admin, §9 JWT/session, §10 tenant gate, §14 CBISM migration plan)
- `SECURITY_PHASE1.md` — the Phase 1 authorization controls that must keep working

---

## 1. CURRENT AUTHENTICATION ARCHITECTURE (AUDITED, NOT ASSUMED)

### 1.1 Identity store

`users` (`src/db/schema.ts`) is the **global** identity store — one row per human, no
school concept:

| column | notes |
| --- | --- |
| `id` uuid PK | referenced by every existing FK (`submissions.learner_id`, `messages.sender_id`, …) |
| `username` varchar(100) unique, nullable | added by `drizzle/0006`; login falls back to email when absent |
| `email` varchar(255) unique, nullable | made optional by `0002_optional_email.sql` |
| `password_hash` text NOT NULL | bcrypt |
| `role` `user_role` NOT NULL default `learner` | enum: `super_admin, school_admin, head_teacher, teacher, parent, learner` |
| `is_active` bool NOT NULL default true | the only account-level kill switch |
| `must_change_password`, `email_verified`, `last_login`, `gender`, `phone`, `avatar_url`, `first_name`, `last_name`, `created_at`, `updated_at` | profile/lifecycle |

There is **no** account-type / system-account marker column, and no soft-delete column.
That fact drives the backfill rule in §3.2 — there is nothing in the schema that could
distinguish a "technical" account from a real one other than `role` and `is_active`.

### 1.2 Tenant tables added by Phase 2A (unused until now)

- `schools` — `id, name, short_name, slug (unique, DNS-label CHECK), status
  (provisioned|active|suspended|archived), created_at, updated_at`.
- `school_users` — `id, school_id → schools.id (cascade), user_id → users.id (cascade),
  role user_role NOT NULL, status (active|invited|disabled), created_at, updated_at`,
  `UNIQUE (school_id, user_id)` (`school_users_school_user_unique`).
- `0014_drop_single_school_guard.sql` replaced 0013's single-school partial **unique**
  index with a **non-unique** placeholder of the same name, so a user may hold memberships
  in several schools and a full re-run of the chain can never resurrect the restriction.
- Nothing in `src/` read or wrote either table before this phase (verified: no route or lib
  file imported `schools`/`schoolUsers`).

### 1.3 Token design (`src/lib/auth.ts`)

- `createToken()` signs `{ userId, email?, username?, role }` — **HS256, 24 h**, no `jti`,
  no session table, no token version, no school context.
- `verifyToken()` re-verifies signature + expiry and requires `userId`/`role` to be strings;
  anything malformed → `null`.
- `getTokenFromRequest()` prefers `Authorization: Bearer`, falls back to the httpOnly
  `el_token` cookie.
- `findAuthUser()` reads a **projection** of `users` and degrades to the pre-0006 column set
  if `username`/`must_change_password` are missing (schema-resilience pattern). Password
  hashes are only selected when explicitly requested.
- `getUserFromToken()` = `verifyToken` + DB re-read + `is_active` check. **Only
  `/api/auth/me` used it.**

### 1.4 Session storage

- Server sets `el_token` (httpOnly, `secure` in production, `SameSite=Lax`, 24 h, `path=/`).
- The login page **also** writes `el_token` and `el_user` to `localStorage`; ~50 client
  pages read `localStorage.el_token` and attach the header themselves.
- `logout` only clears the cookie — with no `jti`/session table the token stays valid until
  expiry if the client kept the localStorage copy (pre-existing Phase 1 limitation).

### 1.5 Flows

| flow | implementation |
| --- | --- |
| login | `POST /api/auth/login` — DB rate limit (`login_attempts`) → `findAuthUser` by email then username → `is_active` check → `bcrypt.compare` → issue token → set cookie → stamp `last_login` |
| logout | `POST /api/auth/logout` — clears the cookie, nothing else |
| session | `GET /api/auth/me` — `getUserFromToken`, returns the DB row |
| change password | `POST /api/auth/change-password` — token required, re-verifies current password, **derives `userId` from the token**, rejects a client-supplied `userId` that differs (403), clears `must_change_password` |
| password reset | no self-service reset exists (no email transport). Admin reset only: `PATCH /api/users/[id]` (`super_admin`/`school_admin`), sets a new `password_hash` |
| registration | `POST /api/auth/register` is hard-disabled (403) |
| admin checks | per-route `if (!["super_admin","school_admin"].includes(payload.role))` |

### 1.6 Where the trust actually sits (the important finding)

- **No `src/middleware.ts` exists.** Authorization is per-route.
- **54 of 59** route files run their own `getTokenFromRequest` + `verifyToken` preamble and
  read `payload.role` (**119** occurrences).
- Consequently the JWT `role` claim is the authorization input for almost the whole API:
  deactivating a user or changing a role takes up to 24 h to apply everywhere except
  `/api/auth/me`.
- No route reads a client-supplied `school_id`/`schoolId` today (verified — zero matches),
  which is exactly the property Phase 2B must preserve.
- `ADMIN_EMAILS` does **not** exist anywhere in the repository (verified — zero matches);
  admin status comes only from `users.role`.
- `create-admin.ts` seeds `admin@cbism.edu` as `school_admin`; `POST /api/seed` is 404 in
  production and `super_admin`-gated in dev, and seeds `admin@cbism.edu` as `super_admin`.

**Conclusion:** the existing architecture does *not* block a safe Phase 2B. Membership can
be added as server-derived context without touching the 54 route preambles — but it also
means the JWT must stay a *hint* and membership must be re-derived from the database.

---

## 2. WHAT PHASE 2B CHANGES

| area | change |
| --- | --- |
| migration | `0015_cbism_school_and_membership_backfill.sql` (root + `drizzle/` copy) |
| runner | registers `0015`, surfaces `RAISE NOTICE` output, verifies the CBISM school/membership counts |
| new module | `src/lib/tenant.ts` — the single server-side membership/context gate |
| `src/lib/auth.ts` | token schema `ver: 2`, optional server-derived `schoolId`/`membershipId` claims, surfaced as **hints** |
| login | resolves membership server-side, issues the claims, returns the school context |
| `/api/auth/me` | returns the DB-derived school context next to the unchanged `user` object |
| tests | `tests/membership-foundation.test.js` (static) + `tests/membership-auth-db.test.ts` (real PostgreSQL) |

**Nothing else changed.** No legacy table gained a column, no query was rewritten, no
`middleware.ts`, no subdomains, no RLS, no branding, no switching UI.

---

## 3. MIGRATION / BACKFILL DECISIONS

### 3.1 The CBISM school

Inserted idempotently, keyed on the unique slug:

```sql
INSERT INTO "schools" ("name", "short_name", "slug", "status")
VALUES ('City Best International School Montessori', 'CBISM', 'cbism', 'active')
ON CONFLICT ("slug") DO NOTHING;
```

- Name/short name come from the repository's own canonical wording
  (`src/app/about/page.tsx`: "City Best International School Montessori (CBISM)").
- `ON CONFLICT ("slug") DO NOTHING` makes re-runs a no-op and makes a second CBISM row
  structurally impossible (`schools_slug_unique`).
- **If a row with `slug = 'cbism'` already exists, the migration does not touch it** — not
  its name, not its `status`. A data migration must never mutate an existing tenant's
  lifecycle state; that is an operator decision, not a deploy side effect.

### 3.2 Which users become members

```sql
INSERT INTO "school_users" ("school_id", "user_id", "role", "status")
SELECT cbism."id", u."id", u."role",
       CASE WHEN u."is_active" THEN 'active' ELSE 'disabled' END
FROM "users" AS u
CROSS JOIN (SELECT "id" FROM "schools" WHERE "slug" = 'cbism' LIMIT 1) AS cbism
WHERE u."role" <> 'super_admin'
ON CONFLICT ("school_id", "user_id") DO NOTHING;
```

Rules and why:

1. **`super_admin` is excluded.** It is a *platform* role (plan §7). Writing it into a
   membership row would (a) misrepresent a platform operator as a school member and (b)
   create a school-wide privilege that no school granted. The exclusion lives in the SQL
   *and* in `toSchoolRole()` in `src/lib/tenant.ts`, so no code path can write it either.
2. **Every other role is an application account.** The audited `users` schema (§1.1) has no
   account-type column, so `role` is the only reliable discriminator available; the rule is
   therefore role-based rather than a hand-maintained list of emails (a list would rot and
   would be a guess about production data we cannot inspect from the repository).
3. **Inactive users get a `disabled` membership, not no membership.** `users.is_active` is
   never modified. A deactivated account keeps its (accurate, non-granting) membership row so
   that Phase 2C's "every user has a membership" invariant already holds, while the
   resolution helpers refuse to treat it as active. Re-activating a user is a Phase 2C admin
   flow, not a migration.
4. **Roles are preserved verbatim** (`u."role"` → `school_users.role`). No role is upgraded,
   downgraded or defaulted.
5. **Nothing is deleted, deactivated, re-hashed or rewritten.** The file contains no
   `UPDATE`, `DELETE`, `DROP`, `TRUNCATE` or `ALTER`; `users`, `login_attempts`, attendance,
   grades, assignments and announcements are not touched.
6. **Idempotent by construction.** `ON CONFLICT ("school_id","user_id") DO NOTHING` means a
   re-run creates only what is missing and **never overwrites an existing membership** — so a
   role an administrator changed in `school_users` after the first run survives later
   deploys. (Deliberate: the migration is a backfill, not a synchroniser.)

Atomicity: `run-migration.js` executes each `--> statement-breakpoint` chunk separately with
no surrounding transaction, so atomicity is per statement. Every statement here is a single
idempotent `INSERT … SELECT`, which is atomic on its own, and a partially applied file is
safe to re-run. A `DO $$ … $$` block at the end emits the affected-row counts as a
`RAISE NOTICE` (printed by the runner) so a deploy log records what the backfill did.

### 3.3 Compatibility decision on `role` (explicit, as required)

`users.role` stays exactly as it is and stays authoritative for the existing 54 route
preambles. `school_users.role` is a **copy at backfill time**, and the effective-role rule
for the remainder of Phase 2 is:

> For a non-`super_admin` user the **effective school role is the membership role**
> (`school_users.role`); `users.role` remains the platform-role home (`super_admin`) and the
> value the legacy routes keep reading until Phase 2C migrates them.

The two can therefore drift (admin changes one and not the other). That is accepted and
documented rather than papered over: Phase 2C is where `users.role` stops being consulted
for school decisions (plan §6.4). No code in this phase makes a decision from
`school_users.role` that Phase 1 used to make from `users.role`, so no behaviour changes
today.

---

## 4. AUTHENTICATION CONTEXT DESIGN

`src/lib/tenant.ts` is the single place that answers "which school is this user in, and with
which role". Route code never queries `school_users` directly.

```ts
isPlatformRole(role)                      // 'super_admin' only
toSchoolRole(role)                        // SchoolRole | null — null for super_admin
listSchoolMemberships(userId, opts)       // DB truth, joins schools
listActiveSchoolMemberships(userId)       // status = 'active' only
resolveSchoolMembership(userId, opts)     // active membership (optionally narrowed by schoolId)
requireActiveSchoolMembership(userId)     // throws AuthContextError(403) when none
getEffectiveSchoolRole(userId)            // SchoolRole | null
resolveAuthContext(request)               // token → DB user → DB memberships
requireSchoolContext(request)             // resolveAuthContext + membership required
selectSchoolForContext(ctx, schoolId)     // validate a resolved school against memberships
resolveLoginSchoolContext(userId)         // never throws — used by the login route
```

Security properties, each with a test:

1. **A client can never choose a school.** `resolveAuthContext` takes only the `Request` and
   reads exactly one thing from it: the token (via the existing `getTokenFromRequest`). It
   never reads a body, a query parameter or a header for a school. `resolveSchoolMembership`'s
   optional `schoolId` can only **narrow** the set of the caller's own verified memberships —
   it is matched against rows already fetched for that `userId`, so an arbitrary value
   resolves to `null` instead of someone else's membership.
2. **Membership is re-derived per request.** The token's school claims are surfaced as
   `schoolIdHint` / `membershipIdHint` and are documented as non-authoritative; every
   resolution path re-reads `school_users`. A stale or forged claim cannot widen access.
3. **`super_admin` is not a school role.** It yields no membership, `toSchoolRole()` returns
   `null` for it, and resolution never grants a platform account school-wide access. There is
   no `role === 'super_admin'` branch anywhere in `tenant.ts`.
4. **`disabled` / `invited` ≠ active.** Only `status = 'active'` rows are returned by the
   active-membership helpers, so `requireActiveSchoolMembership` rejects them.
5. **Multi-school is representable and unambiguous.** Memberships are always fetched
   `WHERE user_id = $1`, so resolving user A can never return user B's rows; ordering is
   deterministic (`created_at`, then `id`).
6. **No lockouts.** Login still succeeds when a user has no membership row (it returns
   `school: null`) and every existing v1 token (no `ver`, no school claims) keeps verifying
   until its natural 24 h expiry. Membership is **additive context in 2B, not a gate**;
   `requireSchoolContext` exists and is tested, but Phase 2C is what wires it into routes.

### 4.1 Token/session migration strategy (no rotation required)

- No claim is removed or renamed; `ver: 2` is *added*. `verifyToken` treats a missing `ver`
  as `1` and accepts both.
- `JWT_SECRET` is untouched, so existing signatures stay valid; nobody is logged out.
- Cookie name, flags and `maxAge` are unchanged.
- No code branches authorization on `ver`, so v1 and v2 tokens behave identically.
- Result: the deploy needs **no** rotation window and **no** forced re-login. A `sid`
  (session id) claim is deliberately **not** added — with no revocation table it would imply
  a control that does not exist; it belongs with the revocation work in a later phase.

### 4.2 Degradation on an un-migrated database

`listSchoolMemberships` catches `relation "school_users" does not exist` (the project's
existing `isMissingRelation` classifier) and returns `[]` after logging once, and
`resolveLoginSchoolContext` swallows any other error. Login, logout, `/api/auth/me` and
password change therefore keep working on a database where `0015` has not been applied yet —
the same degrade-instead-of-crash rule the rest of the codebase follows.

---

## 5. PHASE 2C HANDOFF

- `requireSchoolContext(request)` is the gate; migrate the 54 preambles to it.
- `selectSchoolForContext(ctx, schoolId)` is where Phase 2E host resolution plugs in
  (host → `schoolId` → validated against `ctx.memberships`).
- `src/lib/authorization.ts` helpers need a `schoolId` parameter + school predicates; they
  are intentionally untouched here.
- The `users.role` → `school_users.role` drift documented in §3.3 is resolved in 2C by
  reading only the membership role for school decisions.
- Still open by design: `sid`/revocation, httpOnly-cookie-only cutover + CSRF double-submit,
  `school_id` columns, RLS, subdomains, branding, school switching.
