> Integration artifact: this file records how the conflicts between PR #30 and PR #31 were
> resolved on the `arena/97987bec-easylearn` integration branch, and how the follow-up
> risks R1–R5 were addressed. It is a review aid, not an application document.

# EasyLearn — PR #30 / #31 integration conflict-resolution log

Integration branch: `arena/97987bec-easylearn` (session branch; the platform pins the branch
name, and it is already based exactly at verified `main` 8931095c).
Base: `main` = 8931095c5333e4f39f527d4520c0185805bf536f
PR #30 head: 6f209a2b38b0521686e90e6837f0c49c4b0e984a
PR #31 head: 02c3a5a28893ecc002c911cafff107cba149bc2c

Merge order: PR #30 first (it is the larger, foundational change and merges cleanly into
`main`), then PR #31 on top (17 textual conflicts).

## Design decisions (D1..D9)

**D1 — School lifecycle vs. school selection (both preserved).**
PR #31 restricts ordinary tenant context to `schools.status = 'active'` and fails closed on
an unknown lifecycle value. PR #30 restricts the *choice* of school for a multi-school
account to an explicit, membership-validated selection (token schema v3).
These are orthogonal: keep PR #31's lifecycle filter in `listSchoolMemberships` /
`sqlUserInSchool` / `sqlSchoolsOfUser` / `getLearnerIdsInSchool` **and** PR #30's v3 hint
gating in `resolveAuthContext`. A suspended/archived school therefore yields no membership
at all, and a multi-school account still has to select one explicitly.

**D2 — Token hint version gate (PR #30 wins, nothing from PR #31 is lost).**
PR #30 honours a `schoolIdHint` only for `ver >= 3` tokens. PR #31 honours any hint.
Both revalidate the hint against a freshly loaded active membership, so PR #31's rule is
also tenant-safe; PR #30's rule is *stricter* and is what implements the "explicit school
selection" invariant. The merged code keeps PR #30's gate (no silent tenant adoption for a
multi-school account) and adopts PR #31's null-safety (`?? null`).
Consequence: a pre-v3 multi-school token resolves to "no school" and is rejected with the
"Select one of your schools" 403. This is a deliberate, documented behaviour change for
legacy tokens and is covered by a regression test.

**D3 — Assignment ownership predicate (PR #31 wins on the migrated schema).**
PR #31's `sqlAssignmentInSchool` / `sqlSubmissionInSchool` make the direct `school_id`
authoritative and keep the relational ownership set only as a fallback for legacy rows whose
`school_id` is still NULL. PR #30's purely-relational version would deny a legitimate
assignment of a teacher who holds a second active membership, because the relational set
then resolves to two schools. PR #30's relational predicate is *kept* as the fallback used
when the direct column is absent, so no compatibility path is lost.

**D4 — Schema-aware scoping is layered *under* the role rules (not replaced).**
PR #30 introduced `sqlSchoolRowInSchool()` so the school scope keeps working on a database
that has no `school_id` column. PR #31 introduced role-based, query-level authorization
(`assignmentAccessPredicate`). The merged code keeps both: the school scope is resolved
schema-aware (direct column when present, relational ownership when not) and the role rules
are applied on top of it.

> **Schema prerequisite (measured — see `tests/assignment-schema-prerequisite.test.ts`).**
> The school-scope layer is genuinely schema-aware: it attributes a row through
> `school_users.school_id` (migration 0013) and the relational ownership chain, and never
> reads a content table's `school_id`. The **learner and parent role predicates** are the
> exception: they read `learner_classes.school_id` and `parent_learners.school_id`, which
> **migration 0016** adds. Consequently the teacher and school-administrator/head-teacher
> authorization paths work on a pre-0016 schema, while learner and parent assignment access
> requires migration 0016. On a pre-0016 schema the learner and parent paths fail closed with
> a missing-column error — never a cross-tenant row, but a request error rather than an empty
> result. The supported schema versions are **0016 and later** (0017 makes `school_id` NOT
> NULL, 0018 adds the composite tenant foreign keys). The ordinary `node run-migration.js`
> chain applies 0016, so any deployment that has run the chain is on a supported version.

**D5 — Answer-key suppression is preserved and extended.**
PR #31's allowlisted learner/parent DTOs (`toAssignmentQuestionDto`,
`toLearnerAnswerDto`) are kept verbatim, and PR #30's `sqlLearnerClassInSchool` predicate is
added so the enrolled-learner list in the staff view is also tenant-scoped.

**D6 — Migration 0018 stays (PR #30), and is not applied to production.**
PR #31 kept `0018` out of its branch because it was authored directly on `main`. PR #30
contains the tested migration, its preflight validation and the runner ledger. Keeping it is
the union of the two PRs; neither PR applies it to production. The 0018 preflight aborts
atomically on cross-school or orphan references and never repairs or reassigns data.

**D7 — TLS is enforced on every PostgreSQL connection path.**
PR #31's `src/lib/postgres-tls.js` policy (verified certificate + hostname, `sslmode`
downgrade neutralized, `verify-ca` rejected) is applied to the application pool
(`src/db/index.ts`), the migration runner and `drizzle.config.ts`. PR #30's hardened
runner (ordered/checksummed history, per-file transactions, advisory lock, fail-closed
existing-schema handling, guarded baseline mode) is kept in full; its legacy
`ssl: { rejectUnauthorized: false }` Neon special case is replaced by PR #31's policy.

**D8 — Explicit school selection route = union of both implementations.**
Keeps PR #30's v3 token issuance and `tenantErrorResponse` mapping, PR #31's
platform-admin rejection, body validation and `getDatabaseErrorMessage` 503 mapping.

**D9 — Error message wording.**
The 403 message becomes PR #31's "You do not have an active school membership in an active
school" because the merged code now enforces the school lifecycle as well as the membership.
The multi-school hint "Select one of your schools before continuing" (PR #30) is kept.

**D10 — Parent results denial is now 404, not 403 (query-level authorization wins).**
PR #30's `assignments/[id]/results` loaded the assignment first and then rejected a parent
who asked for a foreign `learnerId` with a 403. PR #31 moved the parent rule *into* the
authorization query (`resolveAssignmentAccessPredicate`), so a parent whose `learnerId` is
not an approved, linked learner does not match the assignment row at all and the refusal is
indistinguishable from "not found". PR #31's own suite already asserts 404 for exactly these
cases ("parent cannot choose an unlinked learner" → 404), so the merged code follows
PR #31. The security property is unchanged — the request is refused and nothing foreign is
returned — and 404 discloses strictly less than 403. `tests/tenant-authorization-db.test.ts`
was updated accordingly (and the no-leak assertions were added).

**D11 — A suspended school is refused at the AUTH layer (403), not the query layer (404).**
PR #31's lifecycle filter lives in `listSchoolMemberships`, so a school that is not `active`
yields no membership and therefore no school context. The request is therefore refused by
`guardSchoolContext` with the 403 "You do not have an active school membership in an active
school" before the assignment is ever looked up. This is PR #31's intended behaviour and is
now pinned by a regression test.

**D12 — Merge-specific regression suite added.**
`tests/tenant-integration-regression.test.ts` proves the invariants that only exist in the
COMBINED implementation and that neither PR could prove alone:
 (1) a pre-v3 multi-school token never silently adopts a school (D2),
 (2) a v3 selected token resolves exactly the selected school, and loses it the moment the
     membership is revoked,
 (3) a suspended school revokes assignment access for its own teacher (D11),
 (4) a dual-membership teacher keeps access to the assignment they own, because the direct
     `assignments.school_id` is authoritative (D3),
 (5) the role rules are layered on top of the school scope: a teacher cannot read a
     colleague's assignment, and a learner can neither read a draft assignment nor receive
     an answer key (D5).
The suite is non-vacuous: mutating `claims.ver >= 3` back to `claims.ver >= 1` in
`src/lib/tenant.ts` makes case (1) fail. It is wired into `npm run test:all`, exposed as
`npm run test:integration`, and added as its own CI step.

## Unresolved design decisions (need an owner)

**U1 — When is migration 0018 applied to production?**
0018 (26 composite tenant foreign keys) is present in the merged tree because PR #30
authored and tested it, but PR #31 deliberately excluded it pending production
verification. Neither PR applies it to production. The merge therefore keeps the file and
the risk: a production database with legacy cross-school rows will ABORT 0018 (the
preflight is deliberately atomic and never repairs data). A production preflight report
against a restored copy of production is required before 0018 is applied. The production
read-only checkpoint SQL is in `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md`.

**U2 — `pg-connection-string` is not an explicit dependency.**
`src/lib/postgres-tls.js` and `tests/postgres-tls.test.js` `require("pg-connection-string")`,
which is only present transitively through `pg`. If `pg` ever drops it, the TLS layer
breaks. It should be added to `dependencies` explicitly.

**U3 — 403 vs 404 for cross-tenant reads.**
The merged code answers 404 for a role/authorization failure that happens inside the query
(D10) and 403 for a missing school context (D11). This is consistent with PR #31's
query-level model but it IS an API-contract change relative to PR #30 for a handful of
endpoints. Clients that distinguish 403 from 404 need to be reviewed.

**U4 — Live TLS handshake against PostgreSQL was not exercised.**
The disposable PostgreSQL 16.2 build available in this environment is compiled WITHOUT
OpenSSL, so a live TLS connection to the server could not be tested. The TLS policy is
covered by `tests/postgres-tls.test.js` (10 assertions, including real `tls` handshakes
against a self-signed certificate with the trusted / untrusted / hostname-mismatch cases),
but an end-to-end `sslmode=verify-full` connection to a TLS-enabled PostgreSQL 16 is still
outstanding.

---

# Follow-up: R1–R5 addressed (draft PR #32)

All five risks recorded above were worked on the same integration branch
(`arena/97987bec-easylearn`), in a follow-up commit on top of `a6488bf`.

## R2 — `pg-connection-string` is now a direct production dependency — RESOLVED

`pg` parses every connection string with `pg-connection-string` at runtime
(`node_modules/pg/lib/connection-parameters.js`). The TLS policy is built on that parser:
it is what turns `sslmode=require` into `rejectUnauthorized: false`, and it is exactly what
`src/lib/postgres-tls.js` neutralises. The package was therefore **load-bearing in
production** while only being a transitive dependency.

* `pg-connection-string@2.14.0` is now declared in `dependencies` and **pinned exactly**
  (not a caret range), matching the pinning style used for `pg` and `next`.
* `package-lock.json` records it as a direct dependency; `pg` resolves to the same
  instance (`deduped`), so there is no second copy in the tree.
* `npm ci` from a clean `node_modules` succeeds (410 packages) and does not further modify
  the lockfile. `npm audit --omit=dev` reports **0 vulnerabilities**.
* A new regression test in `tests/postgres-tls.test.js` asserts that the package is
  declared in `dependencies` (not `devDependencies`), that the version is exact, and that
  the locked version matches the declared one.

## R4 — a genuine end-to-end PostgreSQL TLS test — RESOLVED

The earlier limitation was real: the only PostgreSQL build available in the test
environment (the `pgserver` wheel) is compiled **without OpenSSL**, so it cannot serve
TLS. Rather than leave the claim unproven, a TLS-capable PostgreSQL 16 was obtained.

* `@embedded-postgres/linux-x64@16.14.0-beta.17` (and the `darwin-x64` twin) are added as
  **optionalDependencies**. That package ships **PostgreSQL 16.14 linked against
  `libssl`/`libcrypto`**. Because they are optional and carry `os`/`cpu` fields, npm
  installs them on linux-x64 and darwin-x64 and silently skips them elsewhere.
* New suite `tests/postgres-tls-e2e.test.js` boots a **real PostgreSQL 16 cluster with
  `ssl = on`**, generates a CA and a server certificate with `openssl`, and connects with
  the real `pg` driver through `createPostgresConnectionConfig`. Seven assertions:
  1. a **trusted** certificate connects and the server confirms `pg_stat_ssl.ssl = true`
     with a real TLS version and cipher;
  2. an **untrusted** certificate (a CA the server was not issued by) is rejected;
  3. a **hostname mismatch** (a trusted certificate issued for another host) is rejected
     with `ERR_TLS_CERT_ALTNAME_INVALID`;
  4. `sslmode=require` is **upgraded**, not downgraded: a trusted CA connects, an
     untrusted one still fails — proving the `pg-connection-string` downgrade is
     neutralised end to end;
  5. `sslmode=disable` and `sslmode=verify-ca` are refused before any connection;
  6. the disposable-test escape hatch (`allowInsecureLocal`) cannot weaken an explicit
     TLS request, even for a `127.0.0.1` URL;
  7. the refusal happens during the handshake, not later.
* The suite **skips honestly** (exit 0, explicit `⏭️ SKIP` message) when no TLS-capable
  PostgreSQL 16 can be found — it never reports a skip as a pass. Both skip paths were
  exercised: "build without OpenSSL" and "no binary at all".
* Wired into `npm run test:all`, exposed as `npm run test:tls-e2e`, and added as its own
  CI step. On the CI runner (linux-x64) it will **run**, not skip.

## R3 — the 403/404 contract — DOCUMENTED AND TESTED

New document `docs/API_TENANT_ERROR_SEMANTICS.md` states the contract:

* **403** is a statement about *the caller*: no active membership, no explicit school
  selection, the selected school is not `active`, a platform-scoped route, a role that may
  not perform the verb, or ownership of a row that is already visible inside the caller's
  own tenant.
* **404** is a statement about *the resource*: the tenant-scoped, authorization-aware query
  matched nothing. The three cases — the resource does not exist, it exists in another
  tenant, it exists in the caller's tenant but is hidden from their role — are
  **byte-identical**. That is the anti-enumeration guarantee.
* The document contains the full endpoint matrix for every route changed by the
  integration, the reasons the one behaviour change (parent results 403 → 404) is correct,
  and four rules for future changes.

Four new regression tests in `tests/tenant-integration-regression.test.ts` (11 total in
that suite) pin the contract against a real database and the real handlers:

1. a cross-tenant read and a read of a **non-existent** id return the same status **and the
   same body**;
2. a cross-tenant submission read is a 404 and leaks neither content nor id;
3. a same-tenant role denial is a 403 that names the rule and discloses no resource;
4. a multi-school session with no selection is refused with 403.

Non-vacuity was verified: removing the query-level access predicate from the assignment
lookup makes the anti-enumeration test fail.

## R1 / R5 — migration 0018 is gated; TLS requirements and fail-closed behaviour documented — RESOLVED

**The gap was real.** `0018_composite_school_foreign_keys.sql` was registered in the
migration list, and the README documented `node run-migration.js` as the ordinary operator
command — so a default run **would** have applied 0018 to production with no preflight
gate at all.

`run-migration.js` now supports **gated migrations**:

* a gated migration is applied **only** when the file is named explicitly on the command
  line **and** its confirmation token is supplied;
* an ordinary run **skips** it, prints a prominent `⚠️ GATED MIGRATION NOT APPLIED` block
  naming the token, and still exits 0 (the gate must not block unrelated deployments);
* an explicit run without the token is **refused** with a non-zero exit and the reason;
* the gate is data, not a special case: `GATED_MIGRATIONS` in `run-migration.js`.
* 0018 is registered as gated with
  `CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS`.

A new regression test in `tests/migration-0017-school-id-not-null.test.ts` (19 tests in
that suite) proves all three behaviours against a real database, and its non-vacuity was
verified by removing the gate.

The disposable test suites now apply the chain the way an operator must: the ordinary run
first, then each gated migration explicitly with its token. The gated list is read from
`run-migration.js` itself (`tests/helpers/migrations.js`), so a future gated migration
cannot be forgotten there.

**No production connection was made and no production migration was run.** The gate and
the checkpoint procedure were exercised only against disposable PostgreSQL databases.

New document `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md` records:

* the certificate requirements (verified chain **and** hostname match, how to supply the
  CA, why `verify-ca` is refused and `require` is upgraded rather than downgraded);
* the single test-only escape hatch and its strict limits;
* a fail-closed table covering missing/untrusted/mismatched certificates, a missing
  ledger, checksum drift, ledger gaps, unknown files, missing files, per-file rollback,
  the advisory lock, and the gated-migration skip;
* the 0018 preconditions (PostgreSQL 15+, the read-only checkpoint against a restored
  copy, lock impact, backup and rollback);
* an operator runbook.

The README now documents the gate, the TLS requirements, and links to the runbook.

## Still open (needs an owner with production access — deliberately NOT done here)

**R1-production — applying 0018 to production.** The *code* now prevents an accidental or
unreviewed application. The remaining step is an operational one and is out of scope for
this branch: run the read-only checkpoint in
`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` against a restored copy of production,
review the report, and then apply 0018 with the confirmation token. **This branch does not
authorise, perform or schedule that action**, and the production gate remains
*unverified* until an authorized operator does it.

**R5-deployment — a TLS-enabled production connection has not been exercised.** The policy
and the handshake are now proven end to end against a real TLS-enabled PostgreSQL 16
(R4), but no connection to a production database was made — that remains an operator step
against the real provider's certificate chain.
