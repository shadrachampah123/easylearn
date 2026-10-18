> Integration artifact: this file records how the conflicts between PR #30 and PR #31 were
> resolved on the `arena/97987bec-easylearn` integration branch. It is a review aid, not
> an application document.

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
then resolves to two schools. PR #30's relational predicate is *kept* as the pre-0016
fallback so no compatibility path is lost.

**D4 — Schema-aware scoping is layered *under* the role rules (not replaced).**
PR #30 introduced `sqlSchoolRowInSchool()` to keep working on a pre-0016 database that has
no `school_id` column. PR #31 introduced role-based, query-level authorization
(`assignmentAccessPredicate`). The merged code keeps both: the school scope is resolved
schema-aware (direct column when present, relational ownership when not) and the role rules
are applied on top of it.

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
