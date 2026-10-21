# Production migration safety review — PR #32 (read-only audit)

**Subject:** `shadrachampah123/easylearn` PR #32, integration commit `d05c209f5710e89980fe550c61a423a7eca769ec`
**Migration under review:** `0018_composite_school_foreign_keys.sql` (26 composite tenant foreign keys)
**Required checkpoint:** `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md`
**Review date:** 2026-10-18 · **Reviewer mode:** read-only audit

## Verdict

**NOT READY — ACTIONS REQUIRED**

The migration logic, the gate, and the preflight procedure are sound and were verified empirically,
not merely by reading. One **FAIL** was found: an un-gated, operator-recommended command
(`npx drizzle-kit push`) silently destroys all 26 composite tenant foreign keys, the migration
ledger, and 17 of the 24 unique indexes 0018 depends on — and the two operator procedures this PR
adds do not warn against it. Two **BLOCKED** items are blocked by design: they require production
evidence that only a human operator, on a restored copy, can supply.

---

## Remediation status (2026-10-18)

The bypass has been closed on the integration branch. This section records what was done for
each action in §4.3 and what the current state is. The audit findings themselves are left
unchanged above, so the original evidence stays readable.

| Action | Status | What was done |
|---|---|---|
| **A-1** prohibition in both operator procedures | **DONE** | `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md` opens with a "⛔ Never run `drizzle-kit push`" section carrying the measured before/after table and pointing at §4.1 (recovery) and §4.2 (new-database setup). `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` safety rule 6 states the same prohibition with the same measurements. |
| **A-2** remove the unsafe recommendations | **DONE** | `src/lib/schema-resilience.ts:207` now says "Apply … with `node run-migration.js`"; `src/app/api/parent-learners/route.ts` and `src/app/api/parent-learners/[id]/route.ts` now name only the migration runner and state why push must not be used. The file header of `schema-resilience.ts` no longer lists push as a supported path. `AUTH_REPLACEMENT_GUIDE.md` (which described a build-time `drizzle-kit push --force` in a `vercel.json` that does not exist) and `DEPLOYMENT_AUTH_FIX.md` (which recommended `drizzle-kit migrate` / `push`) were corrected as well. |
| **A-3** scope the README step | **DONE** | `README.md` Step 4 now runs `npm run db:schema-sync` and states that it is for a brand-new, empty database only, with the reason. A second warning block was added to Step 4b. |
| **A-4** correct the lock documentation | **DONE** | `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md` §3.1 now carries a measured lock table (`ADD CONSTRAINT … NOT VALID` → SHARE ROW EXCLUSIVE; `VALIDATE CONSTRAINT` → SHARE UPDATE EXCLUSIVE), states that no `ACCESS EXCLUSIVE` lock is taken, and reframes the risk as duration rather than blocking. The checkpoint's rehearsal section repeats the table. |
| **A-5** correct the version claim | **DONE** | `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` status line now says PostgreSQL 16 (16.2 locally, 16.14 in the TLS suite, `postgres:16` in CI) instead of "PostgreSQL 18". |
| **A-6** child-side index inventory + lock/duration capture | **DONE** | The checkpoint's read-only block now contains a 26-row child-side index inventory, and the document has a new "Lock and duration rehearsal" section with the exact commands to measure the validation duration and sample `pg_locks` **on the restored copy**. |
| **A-7** assertions, estimate labels, baseline hardening | **DONE** | The baseline path now **refuses** (not merely warns) to record `0018` unless the 26 composite constraints are verifiably present, validated and correctly shaped. Size figures are now labelled as catalog estimates. The expected values remain stated in prose; the SQL emits raw result sets by design, so the comparison is still operator-read. |

### What was added beyond the action list

The audit's A-1…A-7 were documentation and baseline fixes. Those alone would still have left the
destructive path **unenforced** — a warning is not a control. The remediation therefore adds
enforcement that does not depend on operator memory:

1. **`src/lib/tenant-constraints.js`** — one machine-readable description of the 26 composite
   foreign keys (and the 24 `UNIQUE (school_id, id)` targets), with a single read-only catalog
   query that reports, for each, whether it exists and whether it matches the definition
   migration 0018 installs. The migration runner, the application runtime and the tests all use
   it, so they cannot disagree about what "applied" means. A drift test asserts that the module
   and migrations 0017/0018 never diverge.
2. **The runner verifies the ledger against the catalog on every invocation**
   (`run-migration.js`). If the ledger records `0018` but the catalog does not have the 26
   constraints, the runner fails closed and names the exact object. This is what makes the
   bypass *visible* instead of silent. The same check runs after applying a migration.
3. **The runner refuses to certify an invalid schema through `--baseline`.** A baseline that
   includes `0018` is rejected unless the constraints are really there.
4. **`node run-migration.js --repair-tenant-integrity`** — a controlled, documented recovery
   procedure. It recreates a missing `UNIQUE (school_id, id)` target with migration 0017's own
   idempotent statement and removes a ledger row for `0018` **only** when the constraints are
   demonstrably absent. It never creates the composite foreign keys — that stays behind the
   gate — and it never touches application rows.
5. **`node db-schema-sync.js`** (`npm run db:schema-sync`) — a guarded wrapper around
   `drizzle-kit push`. It runs push **only** on a brand-new, empty database and refuses on a
   database that already holds objects, the ledger, or any tenant constraint. The legitimate
   development workflow therefore still works; the destructive path is closed.
6. **The application runtime probes the tenant constraints** and reports them through
   `GET /api/health`. The probe is read-only: the composite constraints are deliberately given
   **no** auto-repair DDL, because 0018 is gated and the application must never create or drop
   them behind an operator's back.

### New finding raised by the remediation

**F-22 — none of the 26 relationships has a supporting child-side index.** The new child-side
index inventory reports `(none)` for **all 26** relationships on a fully migrated database.
This is not a correctness problem: the constraints work, and a missing child index does not
break them. It is a *duration and lock-window* problem: when a parent row is deleted,
PostgreSQL must locate the child rows to act on `ON DELETE CASCADE` / `ON DELETE SET NULL`,
and with no index on `(school_id, <referenced column>)` it sequentially scans the child
table. The audit's F-17 gap — "the duration risk is unbounded by the document" — is now
*measured* rather than assumed, and the value is worse than expected. It is recorded here
rather than fixed here: adding 26 indexes is a schema change with its own lock and
replication impact, and it belongs in a separately reviewed migration, not in this
integration branch.

**Production preflight evidence remains BLOCKED.** Nothing in this remediation authorizes a
production migration, and no production database was contacted at any point. The
"Lock and duration rehearsal" section of the checkpoint is explicitly a restored-copy
procedure.


---

## Independent re-audit (2026-10-18) — commit `69a6e5b`

A second, independent review of the remediation was performed after `9da7333`. It did **not**
take the previous report's conclusions on trust: the destructive scenario was re-reproduced
from scratch on a fresh disposable PostgreSQL, every safeguard was re-exercised, and each
regression guard was mutation-tested to confirm it actually fails when its protection is
removed.

**Re-audit verdict: READY FOR FURTHER REVIEW — NOT APPROVED FOR PRODUCTION.**

The schema-sync bypass is genuinely closed: the destructive action was reproduced end to end
and every route to silently losing or falsely certifying the 26 composite tenant foreign
keys, the 24 unique targets and the migration ledger is now blocked by an executable check.
Two defects were found in the remediation's **own regression suite** (one HIGH, one MEDIUM);
both are fixed in `69a6e5b` and both fixes are re-verified below. No finding in this
re-audit contradicts the original audit's findings, and the original verdict **NOT READY —
ACTIONS REQUIRED** still stands for the *production* preflight, which remains BLOCKED.

### Verified repository state

| Item | Value |
|---|---|
| Branch | `arena/97987bec-easylearn` (only branch written to) |
| HEAD at audit start | `9da7333324f6d7140ccde089002325be5160ec60` — **the checkpoint was stale**: the local `.git` had been re-cloned and the branch pointer sat on `8931095c` (main) with the whole remediation uncommitted in the working tree. |
| Recovery | The working tree was proved byte-identical to `9da7333` (all 257 tracked files compared with `git archive` + `cmp`; zero differences, zero extra files) before `git reset --mixed` was used to restore the branch pointer. **No work was discarded.** |
| HEAD at audit end | `69a6e5ba43e6bf6e8189eae885fe37c6cdf817cf` |
| Base `main` | `8931095c5333e4f39f527d4520c0185805bf536f` (unchanged; `main` was not touched) |
| Working tree | clean at audit end |
| PR #32 | `state=open`, **`draft=true`**, `mergeable=MERGEABLE`, `mergeState=CLEAN`, `merged=false`, head `69a6e5b` |
| PR #30 / PR #31 | both `state=open`, `merged=false` — untouched |
| CI | run `39168493830` on `9da7333` — **SUCCESS**, all 17 steps green; run `39169949326` on `69a6e5b` — see §"Tests run" |
| Production | never contacted; no production credentials used; no production migration run |

### Findings and evidence

#### BLOCKER-1 — Production preflight evidence is still absent (unchanged, by design)

**Evidence.** No production database, credential, or configuration was read or changed at any
point in this re-audit. Every measurement below was taken on a disposable local PostgreSQL
16.14 instance (`@embedded-postgres/linux-x64`), on databases whose names begin
`audit_` / `easylearn_tci_test_` / `easylearn_2c_test_` and which are dropped afterwards.

**Why it is still a blocker.** The remediation closes the *software* bypass. It cannot supply
the evidence that only a restored production copy can give: the production engine and
version, the production schema and ledger state, the 28 relationship mismatch counts, the
production table sizes, the production child-index coverage, the production TLS chain and
hostname, and a backup/restore rehearsal.

**Exact next action.** An authorized operator restores a production copy to an isolated host
and runs, read-only, the two SQL blocks of
`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md`, plus the "Lock and duration rehearsal"
section (a **write** procedure, so on the restored copy only). The output is reviewed by a
human and attached to this PR. Until then the production migration stays unapproved and
0018 must not be applied to production.

#### HIGH-1 — The regression guard against re-introducing `drizzle-kit push` was inert *(FIXED in `69a6e5b`)*

**Evidence.** The suite's assertion
`tests/migration-tenant-constraint-integrity.test.ts` used the pattern
`/Apply [^`]*`npx drizzle-kit push`|Run `npx drizzle-kit push`/`. In a TypeScript template
literal the backticks are **escaped in the source text**, so the file contains `` \` `` and not
`` ` ``. The pattern required a bare backtick immediately after `push`, so it never matched.

* The pattern does **not** match the pre-remediation file:
  `git show d05c209:src/lib/schema-resilience.ts` → `matches = false`, even though line 207
  of that file literally reads
  `` ` Apply ${migration} (or \`npx drizzle-kit push\`), then retry.` ``.
* The same source with the escapes stripped → `matches = true`. That is the proof that the
  escape, not the wording, was the reason.
* **Mutation test:** re-introducing `` (or `npx drizzle-kit push`) `` into
  `src/lib/schema-resilience.ts` left the suite at **20 passed / 0 failed, exit 0** — the
  named guard did not notice. (Mutation M5 of the re-audit matrix; the previous session's
  equivalent mutation had been applied to a different file, which is why it had been seen to
  fail then.)

**Impact.** `src/lib/schema-resilience.ts` is the file that produced the operator-facing
"the schema is out of date" message. The guard that exists specifically to stop that
recommendation coming back was, for that file, a no-op — a future edit could have
reintroduced the exact bypass this remediation closed, and CI would have stayed green.

**Fix (narrow, in the test file only).** The assertion now (a) normalises the escaped
backticks before matching, and (b) asserts the stronger property directly: **every** mention
of `drizzle-kit push` in the three operator-facing files must sit in a line that carries an
explicit prohibition (`do not run` / `never` / `must not` / `not to`). Re-verified: the
re-introduction now fails the suite — `19 passed / 1 failed`, exit **1** — and the suite is
back to `20 / 0` after restoring the file (`git status` clean).

#### MEDIUM-1 — The schema-sync regression suite could silently skip in CI *(FIXED in `69a6e5b`)*

**Evidence.** The suite skipped with **exit 0** when no PostgreSQL was reachable:

```
$ env -u TEST_DATABASE_URL npx tsx tests/migration-tenant-constraint-integrity.test.ts
⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.
EXIT_CODE: 0
```

CI did set `TEST_DATABASE_URL`, and the "Require disposable PostgreSQL configuration" step
asserts the variable is non-empty — but nothing tied a *skip* to a *failure*. The sibling
`tests/postgres-tls-e2e.test.js` already had exactly that mechanism
(`EASY_LEARN_REQUIRE_TLS_E2E=true`); the new suite did not. A renamed environment variable, a
changed database URL, or a broken `embedded-postgres` fallback would therefore have disarmed
the entire schema-sync bypass regression while the CI job still reported **SUCCESS**.

**Fix.** The suite now honours `EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true` and exits **1** on
a skip; `.github/workflows/ci.yml` sets it on the "Tenant constraint integrity / schema-sync
bypass regression" step. Re-verified: with the flag, the skip exits **1**; without it, a local
skip still exits **0**. The normal run path is unaffected — **20 passed / 0 failed**.

#### MEDIUM-2 — The "works on a pre-0016 database" claim is not true for the assignment routes *(RESOLVED — documentation corrected to state the real prerequisite; behaviour pinned by a new regression suite)*

**Evidence.** `src/lib/assignment-access.ts:78-82` states that the schema-aware predicate
keeps "a deployment that has not applied migration 0016 yet … tenant-isolated instead of
failing open or **failing with a missing-column error**"; `src/lib/assignment-access.ts:60`
says the synchronous form is the one that "assumes a migrated schema" and the asynchronous one
"additionally works on a pre-0016 database". The same claim appears at
`src/app/api/assignments/route.ts:40` and `docs/PR30_PR31_INTEGRATION_RESOLUTION.md:46`.

A pre-0016 database was built (migrations 0000–0015 applied, `assignments.school_id` confirmed
absent) and both predicates were executed against it:

| Predicate | Used by | Result on a pre-0016 database |
|---|---|---|
| `assignmentAccessPredicate` (sync) | `src/app/api/assignments/[id]/submit/route.ts:19,56` | **FAILED** — `column assignments.school_id does not exist` |
| `resolveAssignmentAccessPredicate` (async, schema-aware) | every other assignment/submission route | **FAILED** — `column lc.school_id does not exist` |

The relational fallback itself is pre-0016 compatible in shape, but
`learnerEnrollmentPredicate` (`src/lib/assignment-access.ts:166-181`) and
`parentApprovedContentPredicate` (`src/lib/assignment-access.ts:183-210`) reference
`learner_classes.school_id`, `parent_learners.school_id` and `school_users.school_id` — all
added by migration **0016**, not 0013/0015. So the fallback cannot reach a pre-0016 schema.

**Impact.** The behaviour is **fail closed** — a missing column aborts the query, so no
cross-tenant row can be returned. The consequence is availability, not isolation: a learner
or parent on a pre-0016 database gets a **500** from the assignment list and from assignment
detail instead of a clean empty result. The defect is that the *documentation* claims a
capability the code does not have, which matters for a reviewer deciding whether an
un-migrated deployment is supported.

**Exact next action (a decision, not a code change).** Either (a) correct the three comments
and the resolution log to say the schema-aware scope covers the *school-scope* half of the
predicate while the learner/parent role predicates require 0016, or (b) implement a genuinely
0013/0015-compatible role predicate. This re-audit did **not** change the code, because either
option changes a documented support guarantee and is the reviewer's call.

**Resolution (2026-10-18) — option (a) taken: the documentation now states the real
prerequisite, and the behaviour is pinned by a regression suite.**

The decision was made in favour of correcting the documentation rather than adding an
older-schema-compatible role predicate:

1. The pre-0016 state is a **transient upgrade state, not a supported deployment**. The
   ordinary `node run-migration.js` chain applies 0016, 0017 and 0018 in order, so any
   deployment that has run the chain is on a supported schema version.
2. A genuinely 0013/0015-compatible role predicate would be a **new authorization code
   path**. It would need its own proof of tenant isolation, and adding it would *widen* the
   set of schemas on which the learner/parent authorization rules are exercised — the
   opposite of the narrowest safe correction.
3. The **failure mode is fail-closed**: a missing column aborts the query, so a pre-0016
   deployment can never return a cross-tenant row. The only consequence is availability.

The pre-0016 behaviour was then **measured exactly**, role by role, on a real pre-0016
database (migrations 0000–0015 applied), so that the corrected documentation is
evidence-backed rather than assumed:

| Layer / role | On a pre-0016 database | Why |
|---|---|---|
| School scope (`sqlSchoolRowInSchool` → relational attribution) | **resolves, and stays isolated** | never reads a content table's `school_id`; it attributes through `school_users.school_id` (0013) and the relational ownership chain |
| Teacher role predicate | **resolves, and stays isolated** | needs only the school scope + `assignments.teacher_id` |
| School-administrator / head-teacher role predicate | **resolves, and stays isolated** | needs only the school scope |
| Learner role predicate | **fails closed** — `column lc.school_id does not exist` | reads `learner_classes.school_id` (0016) |
| Parent role predicate | **fails closed** — `column lc.school_id does not exist` | reads `learner_classes.school_id` / `parent_learners.school_id` (0016) |
| Synchronous `assignmentAccessPredicate` | **fails closed** for every role — `column assignments.school_id does not exist` | always references `assignments.school_id` (0016) |

**What changed — comments and documentation only. No executable code changed**, so tenant
isolation and authorization semantics are untouched:

| File | Change |
|---|---|
| `src/lib/assignment-access.ts` | The module header, `assignmentAccessPredicate` and `resolveAssignmentAccessPredicate` now state the schema prerequisite: the school-scope layer is schema-aware; the learner and parent role predicates require migration 0016; the teacher and school-administrator/head-teacher predicates work on a pre-0016 schema; the synchronous form requires 0016 for every role. The two false sentences are gone. |
| `src/app/api/assignments/route.ts` | The "a database that predates migration 0016 is isolated as well" claim now states which roles work and which require 0016. |
| `src/app/api/assignments/[id]/route.ts`, `src/app/api/assignments/[id]/results/route.ts`, `src/app/api/submissions/route.ts` | A note that the route also applies the role predicate, whose learner and parent branches require 0016. |
| `docs/PR30_PR31_INTEGRATION_RESOLUTION.md` | The D4 decision now carries the measured schema prerequisite and names the supported schema versions (0016 and later). |
| `tests/assignment-schema-prerequisite.test.ts` *(new)* | The regression suite described below. |
| `package.json` | New `test:assignment-prereq` script; the suite is part of `test:db` and `test:all`. |

**The new regression suite** `tests/assignment-schema-prerequisite.test.ts` runs both schema
versions against real databases (migrations 0000–0015 for the pre-0016 one, the whole chain
for the supported one) and asserts:

* **Supported (0016+)** — the prerequisite columns exist; every role predicate resolves;
  every role reaches its own school's published assignment; **no** role reaches a
  foreign-school assignment; a learner does not reach a draft assignment; an unenrolled
  learner does not reach a published assignment.
* **Pre-0016** — the school scope, the teacher predicate and the school-administrator
  predicate resolve and **stay isolated**; the learner and parent predicates **fail closed**
  with the missing-column error and return no row; the synchronous predicate fails closed
  for every role.
* **Documentation** — the module states the prerequisite, the two false sentences are
  absent, and the route and the resolution log state it too.

The suite is **non-vacuous**: two mutations were applied and both were detected — restoring
the false sentence fails the documentation assertion, and making the learner predicate
pre-0016-compatible fails the fail-closed assertion.

**What this does NOT change.** On a pre-0016 database a learner or parent still receives an
error from the assignment list and from assignment detail instead of a clean empty result.
That is the documented behaviour of an unsupported schema version. It is **fail-closed** and
it is **not claimed to be fixed**.

#### MEDIUM-3 — None of the 26 composite tenant foreign keys has a supporting child-side index *(F-22 — recorded, deliberately not fixed)*

See **"The 26 missing child-side indexes"** below. Deliberately **not** fixed on this branch:
26 new indexes are a schema change with their own lock, replication and disk impact, and the
task scope for this branch is the migration-safety bypass.

#### LOW-1 — An operator-facing error message is ungrammatical

`src/lib/tenant-constraints.js` builds the problem line as
`` `constraint ${name} on public.${table} is ${row.problem}` ``, and the SQL emits the problem
value `"references the wrong parent table"`. The rendered operator message therefore reads
**"constraint classes_school_academic_year_fk on public.classes is references the wrong parent
table"**. Observed live. Cosmetic only — the message is unambiguous about which object is
wrong — but it is the text an operator reads during an incident.

**Follow-up (2026-10-18): FIXED.** Only this one of the eleven problem values was
ungrammatical; the single SQL literal was reworded so the existing template renders a
correct sentence. See *"LOW-1 — the ungrammatical operator message — FIXED"* above.

#### LOW-2 — The assignment submit route is the only one using the non-schema-aware predicate

`src/app/api/assignments/[id]/submit/route.ts:19,56` uses the synchronous
`assignmentAccessPredicate`, while every sibling route uses the asynchronous
`resolveAssignmentAccessPredicate`. On a fully migrated (0016+) database the two produce
equivalent isolation, and on a pre-0016 database **both** fail (see MEDIUM-2), so there is no
practical divergence today. It is an inconsistency that will become one if the fallback is
ever made genuinely 0013-compatible.

**Follow-up (2026-10-18): FIXED.** The route now uses `resolveAssignmentAccessPredicate`
like every sibling route, and the equivalence that makes the change a no-op is now
asserted by the regression suite for all four roles. See *"LOW-2 — the submit route used
the non-schema-aware predicate — FIXED"* above.

#### LOW-3 — The policy mirror documents a teacher-access rule no route implements

`src/lib/assignment-policy.ts:22,35` grants a teacher `manage-full` on
`explicitlyAuthorized: true`, and `tests/assignment-authorization.test.ts:24` asserts it.
There is **no co-teacher concept anywhere in the schema** (`co_teacher` / `coTeacher` /
`co-teacher`: 0 hits) and **no route ever passes `explicitlyAuthorized`**. The SQL predicate
implements ownership only (`eq(assignments.teacherId, context.userId)`,
`src/lib/assignment-access.ts:29`). The divergence is in the safe direction (SQL is stricter
than the mirror), but a reviewer reading the mirror would conclude a co-teacher is supported
when such a teacher is in fact denied.

**Follow-up (2026-10-18): FIXED.** The mirror now states exactly what the routes enforce
(ownership only) and the reserved flag is documented as **RESERVED** and asserted to grant
nothing. See *"LOW-3 — the policy mirror granted a rule no route implements — FIXED"* above.

#### LOW-4 — The relational "reachable schools" helpers do not check the school lifecycle

`sqlUserInSchool`, `sqlUserRoleInSchool`, `sqlUserHasRoleInSchool` and `sqlSchoolsOfUser`
(`src/lib/tenant.ts:625-673`) all join `schools` and require `s."status" = 'active'`. The
content-ownership helpers — `sqlSchoolsOfClass` (`:677`), `sqlSchoolsOfTeacherClass`,
`sqlSchoolsOfLearnerClass`, `sqlSchoolsOfAssignment`, `sqlSchoolsOfQuiz`
(`src/lib/tenant.ts:677-800`) — check only `su."status" = 'active'` and never the school's
lifecycle status.

**Follow-up (2026-10-18): measured, NOT implemented.** The "defence in depth" remedy that
was proposed for this finding — adding the school lifecycle filter to these helpers — was
measured on a real database and turns out to **loosen** the rule: it removes a suspended
school from the reachable set, so a row reachable from an active *and* a suspended school
changes from **denied** to **allowed**. The requested school is always active anyway. This
finding therefore stays open as a non-defect and the remedy is **not** applied. See
*"LOW-4 — the "reachable schools" helpers omit the school lifecycle check — NOT FIXED, and
the proposed remedy is a loosening"* above.

**Not exploitable, and here is why.** These helpers feed `sqlOwnedBySchool`
(`src/lib/tenant.ts:803-810`), which requires the row to be reachable from **exactly** the
requested school: `exists(school_id = schoolId) and not exists(school_id <> schoolId)`. A
larger reachable set can only ever make that check *stricter*. And the requested `schoolId`
can only ever be an active school, because `resolveAuthContext` → `listActiveSchoolMemberships`
(`src/lib/tenant.ts:187-201`) filters on both `school_users.status = 'active'` **and**
`schools.status = 'active'`, and `selectSchoolForContext` (`:403-417`) can only choose from
that filtered list. It is a defence-in-depth inconsistency, not a tenant-isolation hole.

#### LOW-5 — The database test suites leave their scratch databases behind

After a full `npm run test:all` run, the **admin** database still contained 13 scratch
databases: `easylearn_2c_test_*` (6), `easylearn_2d_test_*`, `easylearn_2d_reg_*`,
`easylearn_2e_dash_*`, `easylearn_integration_*` and `audit_repro`. The tenant-constraint
integrity suite does clean up after itself (it drops its four databases in a `finally`
block); the older tenant suites do not. On a CI runner this is invisible — the service
container is destroyed with the job — but on a long-lived developer or self-hosted CI
database the scratch databases accumulate. No correctness or isolation impact; housekeeping
only.

**Follow-up (2026-10-18): FIXED.** All twelve database-creating suites were audited; the
four that never dropped their database and the three that swallowed their cleanup failure
now share one lifecycle helper that always removes the scratch database, surfaces a
cleanup failure instead of swallowing it, and preserves the original failure. A new
contract suite pins the behaviour and fails CI if it is skipped. See *"LOW-5 — the
disposable test databases are now always removed — FIXED"* above.

#### Environment observation — the local `.git` was re-cloned between sessions

At the start of this re-audit the local repository reported `HEAD = 8931095c` (main's commit)
on the session branch, with the entire remediation sitting uncommitted in the working tree and
a reflog containing only `clone` + `checkout`. The remote still held `9da7333`. The working
tree was proved byte-identical to `9da7333` before the branch pointer was restored, so no work
was lost. This is an environment/sandbox artifact, not a repository defect, but it is recorded
because the checkpoint's "working tree clean" assumption was false and a reviewer must not
trust a branch pointer without `git rev-parse`.

### The 26 missing child-side indexes

**Measured, not assumed.** For each of the 26 composite foreign keys, the child table was
searched for an index whose **leading** columns are `(school_id, <referenced column>)` — the
index PostgreSQL needs to find referencing child rows.

**Result: 0 of 26 have one.** On a fully migrated database (0018 applied, 26/26 constraints
present and validated):

| Child table | Referenced column | ON DELETE | Supporting child index |
|---|---|---|---|
| `terms` | `academic_year_id` | NO ACTION | **(none)** |
| `classes` | `academic_year_id` | NO ACTION | **(none)** |
| `subjects` | `department_id` | NO ACTION | **(none)** |
| `teacher_classes` | `class_id` | NO ACTION | **(none)** |
| `teacher_classes` | `subject_id` | NO ACTION | **(none)** |
| `teacher_classes` | `academic_year_id` | NO ACTION | **(none)** |
| `learner_classes` | `class_id` | NO ACTION | **(none)** |
| `learner_classes` | `academic_year_id` | NO ACTION | **(none)** |
| `assignments` | `class_id` | NO ACTION | **(none)** |
| `assignments` | `subject_id` | NO ACTION | **(none)** |
| `assignments` | `term_id` | NO ACTION | **(none)** |
| `submissions` | `assignment_id` | NO ACTION | **(none)** |
| `uploaded_files` | `assignment_id` | SET NULL | **(none)** |
| `resources` | `class_id` | NO ACTION | **(none)** |
| `resources` | `subject_id` | NO ACTION | **(none)** |
| `resources` | `term_id` | NO ACTION | **(none)** |
| `quizzes` | `class_id` | NO ACTION | **(none)** |
| `quizzes` | `subject_id` | NO ACTION | **(none)** |
| `quizzes` | `term_id` | NO ACTION | **(none)** |
| `quiz_attempts` | `quiz_id` | NO ACTION | **(none)** |
| `announcements` | `class_id` | NO ACTION | **(none)** |
| `attendance` | `class_id` | NO ACTION | **(none)** |
| `timetable_entries` | `class_id` | CASCADE | **(none)** |
| `timetable_entries` | `subject_id` | SET NULL | **(none)** |
| `timetable_entries` | `term_id` | SET NULL | **(none)** |
| `timetable_entries` | `academic_year_id` | SET NULL | **(none)** |

By delete action: **21 NO ACTION, 4 SET NULL, 1 CASCADE**. The 14 affected child tables are
`announcements, assignments, attendance, classes, learner_classes, quiz_attempts, quizzes,
resources, subjects, submissions, teacher_classes, terms, timetable_entries, uploaded_files`.

**Why the existing indexes do not help.** The child tables carry `pkey (id)`,
`UNIQUE (school_id, id)` and — on some — a plain `(school_id)` index. `UNIQUE (school_id, id)`
has the wrong second column; the `(school_id)` index narrows to the school but still leaves
every row of that school to be filtered. Verified on `assignments`:
`assignments_pkey (id)`, `assignments_school_id_id_unique (school_id, id)`,
`assignments_school_idx (school_id)`.

**Measured impact.** A faithful reproduction (same index layout, 200 000 child rows over 5
schools) of the referential-integrity check PostgreSQL runs on a parent row delete —
`SELECT 1 FROM ONLY child x WHERE $1 = x.school_id AND $2 = x.class_id FOR KEY SHARE OF x`:

| | Plan | Buffers read | Rows filtered out | Execution |
|---|---|---|---|---|
| **Current schema** (no `(school_id, class_id)` index) | Bitmap Heap Scan on `rep_child_school_idx` | **1903** (1870 heap blocks ≈ 14.6 MB) | **40 000** | **7.43 ms** |
| **With** a `(school_id, class_id)` index | Index Scan using `rep_child_fk_idx` | **3** (24 KB) | 0 | **0.042 ms** |

That is ~**177×** faster and ~**630×** fewer buffers read, *per parent-row check*, and it
scales linearly with table size. The cost is paid **while the parent row's lock is held**,
which is exactly the window the 0018 preflight is meant to size. The 1 CASCADE and 4 SET NULL
relationships are the ones where a parent delete actively *writes* to the child table, so they
are the ones that also generate dead tuples and WAL in that window.

**Operational trade-offs of adding the 26 indexes (why they are not in this branch).**

1. **They are a schema change with their own migration, gate and preflight.** 26
   `CREATE INDEX` statements take a lock on the child table and need the same
   reviewed-preflight discipline as 0018.
2. **`CREATE INDEX` blocks writes; `CREATE INDEX CONCURRENTLY` does not block writes but**
   **cannot run inside a transaction block**, takes a longer lock, and can leave an
   `INVALID` index behind on failure that must be dropped and retried. The runner applies
   each migration file inside a single `BEGIN`/`COMMIT` (`run-migration.js`, `applyMigration`),
   so a concurrent index build does not fit that model without a change to the runner.
3. **Replication lag.** 26 index builds on the largest child tables replicate their WAL to
   standbys, which is the usual cause of a delayed failover.
4. **Disk and write amplification.** Each index adds storage proportional to the table and
   adds a small write cost to every insert/update of the indexed columns. One index on the
   200 000-row reproduction was **1424 kB**; scaled to production sizes the 26 indexes are
   proportional to the real table sizes, which are **BLOCKED** until the checkpoint is run.
5. **It is not a correctness fix.** The constraints work without the indexes. This is a
   duration/lock-window issue, and it must be weighed against the lock window 0018 itself
   creates.

**Exact next action.** Raise a **separate** migration (e.g. `0019_child_side_indexes.sql`),
with its own confirmation gate, its own read-only checkpoint block (child-index coverage plus
the production table sizes) and its own rehearsal. Decide `CONCURRENTLY` vs. transactional
before writing it, and decide whether it is applied **before** 0018 (so the 0018 validation
window is short) or after. It must not be folded into this integration branch.

### Follow-up migration plan for the 26 child-side indexes (NOT in PR #32)

**Status: recorded, not implemented.** The 26 indexes are **not** added to PR #32, and the
performance characteristic they address is **not claimed to be fixed**. This is the plan a
separate change will execute.

**Target artefact.** A separate migration file — `0019_child_side_indexes.sql` — in its own
pull request, with its own confirmation gate (a dedicated token, like 0018's), its own
read-only checkpoint block and its own rehearsal on a restored production copy. It must not be
folded into this integration branch, and the runner's 0018 gate must not be reused for it.

**Exact DDL shape.** One index per composite foreign key, on the child table, with the
referencing columns as the leading columns:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "<child_table>_<child_column>_school_fk_idx"
  ON "<child_table>" USING btree ("school_id", "<child_column>");
```

The index name must not collide with the 0018 constraint names (`<child_table>_<column>_school_fk`);
the `_idx` suffix keeps them distinct. The 4 `SET NULL` and 1 `CASCADE` relationships need
the **same** index shape — the index serves the *referencing-side* lookup that PostgreSQL
performs when a parent row is deleted, not the `ON DELETE` action itself.

**Lock and duration.**

| Form | Lock on the child table | Effect | Fits the current runner? |
|---|---|---|---|
| `CREATE INDEX` (transactional) | `SHARE` | **blocks writes** (INSERT/UPDATE/DELETE) for the whole build | **yes** — the runner already wraps each file in `BEGIN`/`COMMIT` |
| `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | does not block reads or writes, but **cannot run inside a transaction block**, scans the table twice, and holds the lock for the whole build | **no** — `run-migration.js` applies each file inside a single `BEGIN`/`COMMIT` |

* **Duration is proportional to table size and is currently UNKNOWN.** The production child
  table sizes are part of **BLOCKER-1** and cannot be measured from here. The duration must be
  **measured on the restored production copy** during the rehearsal, not estimated.
* The only measured data point available today: on the 200 000-row reproduction, one
  `(school_id, class_id)` index is **1424 kB** and the build takes seconds. That is a
  *lower* bound, not a production figure.
* **Failure handling for `CONCURRENTLY`:** an interrupted build leaves an **INVALID** index
  behind. The post-apply verification must check `pg_index.indisvalid = true` for all 26 and
  the operator procedure must be `DROP INDEX CONCURRENTLY` + retry — an invalid index must
  never be left in place, because it is maintained by PostgreSQL but not used for lookups.
* **Replication lag:** each build replicates WAL roughly proportional to the table size. Build
  the indexes **one at a time** and check the standby lag between builds; 26 back-to-back
  builds are the usual cause of a delayed failover.

**Deployment order — the decision that matters most.** 0018 is gated and has been applied
nowhere, so the order is still open. The two options:

* **Before 0018 (preferred).** The 0018 validation window is the expensive step: it runs the
  referential-integrity check per parent row while a lock is held, and the measurement above
  shows that check is ~**177×** slower without the child indexes. Building the indexes first
  shortens that window by roughly that factor. Cost: the index build itself takes a write
  lock per table (or a long `SHARE UPDATE EXCLUSIVE` if `CONCURRENTLY`).
* **After 0018.** 0018's validation window is paid at full cost, and the indexes only arrive
  afterwards.

**The order is decided by the checkpoint, not by preference:** the rehearsal must measure the
0018 validation window both with and without the child indexes present, and the operator
picks the ordering from those two measurements. If the 0018 window without indexes exceeds
the approved maintenance window, the indexes must be built first.

**Read-only checkpoint block for 0019** (its own, in addition to the 0018 one):

1. The child-index coverage inventory — the SQL already in
   `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` — must report **0 of 26** before the
   migration and **26 of 26** after it, with every index `indisvalid = true`.
2. The **real child-table sizes** (row counts and `pg_total_relation_size` for all 14 child
   tables) — currently BLOCKED, and the input the duration model needs.
3. The expected total index size, derived from the measured per-table sizes.

**Rehearsal on the restored production copy** (write operations, restored copy only — never
production):

1. Apply the chain to 0018, then build the 26 indexes with the chosen form.
2. Record, per index: build duration, the lock actually taken (`pg_locks`), the WAL
   generated, and the standby lag.
3. Re-run the referential-integrity plan check and confirm the plan changed from
   **Bitmap Heap Scan (1903 buffers, 7.43 ms)** to **Index Scan (3 buffers, 0.042 ms)**.
4. Roll the restored copy back and re-apply, to prove the migration is idempotent.

**Verification after applying.** The coverage inventory must report 26 of 26 with
`indisvalid = true`; the runner must refuse to certify 0019 if any index is missing or
invalid — the same fail-closed pattern used for the 0018 constraint inventory.

### Tests run and results

All commands were run locally in this sandbox against a **disposable** local PostgreSQL 16.14
(`@embedded-postgres/linux-x64`, `initdb`+`pg_ctl`, data dir `/home/user/auditpg`).
**GitHub CI evidence is listed separately and is not the same thing as local evidence.**

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm ci` | 0 | clean install |
| 2 | `npm run typecheck` | 0 | 0 errors |
| 3 | `npm run lint` | 0 | 0 errors, 15 pre-existing warnings (none in changed files) |
| 4 | `npm run build` (`DATABASE_URL=…:1/testdb JWT_SECRET=ci-…`) | 0 | compiled, 95/95 static pages |
| 5 | `npm audit --omit=dev` | 0 | **0 vulnerabilities** |
| 6 | `npm run test:all` | **0** | 18 suites green; tenant-db 30, migration-0017/0018 19, integration-regression 11, **tenant-integrity 20**, TLS e2e 7 |
| 7 | `npx tsx tests/migration-tenant-constraint-integrity.test.ts` | 0 | **20 passed / 0 failed** |
| 8 | `env -u TEST_DATABASE_URL npx tsx tests/migration-tenant-constraint-integrity.test.ts` | 0 | skip (expected locally) |
| 9 | `env -u TEST_DATABASE_URL EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true npx tsx …` | **1** | **skip now fails** (MEDIUM-1 fix verified) |
| 10 | destructive reproduction: `npx drizzle-kit push --force` on a disposable DB | 0 | **26 → 0** composite FKs, **24 → 7** unique targets, ledger **dropped**, total FKs **111 → 85**, relations **38 → 37** |
| 11 | `node run-migration.js` on the damaged DB | **1** | *"Existing public tables were found without easylearn_schema_migrations. Refusing to replay migrations."* |
| 12 | `node run-migration.js --baseline …,0018….sql` on the damaged DB | **1** | *"Baseline refused: … 0 of 26 are present and correct."* |
| 13 | `node db-schema-sync.js` on the damaged DB | **1** | *"Schema sync refused. The target database is not empty"* |
| 14 | `node run-migration.js --repair-tenant-integrity` without the token | **1** | refused, no DDL run |
| 15 | `node run-migration.js --repair-tenant-integrity` with the token | 0 | 17 unique targets restored; false ledger claim removed |
| 16 | baseline of a verified prefix that stops before 0018 | 0 | accepted (legitimate workflow still works) |
| 17 | re-apply 0018 under its gate | 0 | **26/26 present, validated and correct** |
| 18 | runner with 2 of 26 constraints dropped (ledger intact) | **1** | *"… 24 of 26 are present and correct."* |
| 19 | runner with 8 of 26 constraints dropped by `DROP INDEX … CASCADE` | **1** | *"… 18 of 26 …"* (the CASCADE also removes dependent FKs — the cross-check still catches it) |
| 20 | constraint `NOT VALID` | **1** | *"constraint classes_school_academic_year_fk on public.classes is not validated"* |
| 21 | constraint pointing at the wrong parent table | **1** | *"… is references the wrong parent table"* (see LOW-1) |
| 22 | constraint with the wrong `ON DELETE` action | **1** | *"… is wrong ON DELETE action"* |
| 23 | constraint with the wrong child column pair | **1** | *"… is wrong child columns"* |
| 24 | ledger checksum drift for 0018 | **1** | *"Checksum mismatch for applied migration 0018…"* |
| 25 | unknown row in the ledger | **1** | *"Unrecognized migration recorded in history"* |
| 26 | re-running 0018 when already applied | 0 | no-op, *"26/26 present, validated and correct"* |
| 27 | pre-0016 database: sync predicate | — | **FAILED** `column assignments.school_id does not exist` |
| 28 | pre-0016 database: schema-aware predicate | — | **FAILED** `column lc.school_id does not exist` |

**Mutation matrix — every safeguard removed in turn, suite re-run, code restored:**

| # | Safeguard removed | Exit | Failing assertions |
|---|---|---|---|
| M1 | pre-apply **and** post-apply catalog cross-check (`run-migration.js`) | 1 | 2 |
| M2 | baseline catalog check (`run-migration.js`) | 1 | 2 |
| M3 | guarded schema-sync refusal (`db-schema-sync.js`) | 1 | 1 |
| M4 | application given auto-repair DDL (`src/lib/schema-resilience.ts`) | 1 | 1 |
| M5 | operator-facing push recommendation (`src/lib/schema-resilience.ts`) | **0 (before the fix)** → **1 (after)** | 0 → 1 |
| M6 | runner no longer fails closed on a ledger/catalog disagreement | 1 | 3 |
| M7 | repair no longer clears the false ledger claim | 1 | 1 |

Every mutated file was restored and verified byte-identical (`cmp` + `git status` clean) after
each run, and the suite re-ran **20 / 0** at the end.

**GitHub CI evidence (separate from the local evidence above).**

| Run | Commit | Result |
|---|---|---|
| `39168493830` | `9da7333` | **SUCCESS** — 17/17 steps green, including "Tenant constraint integrity / schema-sync bypass regression (PostgreSQL required)" |
| `39169949326` | `69a6e5b` | **SUCCESS** — the commit that carries the HIGH-1 and MEDIUM-1 fixes |
| `39170082202` | `0c40ff5` | **SUCCESS** — 22/22 steps green, including the new fail-on-skip mechanism |
| `39170297840` | `ae0deeb` | **SUCCESS** — the head commit of the re-audit |

**Not verified / not claimed.** The production engine and version, the production schema and
ledger state, the 28 production relationship mismatch counts, the production table sizes, the
production child-index coverage, the production TLS certificate chain and hostname, and a
production backup/restore rehearsal. No production system was contacted. The GitHub Actions
**job logs** could not be downloaded in this sandbox (the log archive redirects to a host that
is not reachable from here), so the CI evidence above is the run and step **conclusions**, not
a reading of the raw logs. The `EASY_LEARN_REQUIRE_TLS_E2E` / `EASY_LEARN_REQUIRE_TENANT_INTEGRITY`
mechanisms are what make those conclusions meaningful: they turn a silent skip into a failure.

### Remaining blockers and the exact next action for each

| ID | Severity | Blocker | Exact next action | Owner |
|---|---|---|---|---|
| **BLOCKER-1** | **BLOCKER** | No production preflight evidence. | Restore a production copy to an isolated host; run the two read-only SQL blocks of `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` **and** the "Lock and duration rehearsal" section (write, restored copy only); have a human review the output and attach it to PR #32. Do **not** apply 0018 to production before that. | authorized human operator |
| **BLOCKER-2** | **BLOCKER — WAIVED FOR THIS MERGE, not satisfied** | PR #32 has **no independent review** of this remediation. | **No independent review was performed.** The requester explicitly directed that the merge proceed without one and that no further reviewer be sought, so this blocker was **waived by the requester**, not closed. Nothing in this report should be read as an independent review having taken place. The code-level findings recorded here (HIGH-1, MEDIUM-1, MEDIUM-2) are addressed as documented above. | requester (waiver) |
| **MEDIUM-2** | MEDIUM → **RESOLVED** | The "works on a pre-0016 database" claim in `src/lib/assignment-access.ts:60,78-82`, `src/app/api/assignments/route.ts:40` and `docs/PR30_PR31_INTEGRATION_RESOLUTION.md:46` is false for the assignment routes. | **Closed** — option (a) taken: the false sentences are replaced by the measured schema prerequisite (the school scope and the teacher/administrator predicates work on a pre-0016 schema; the learner and parent predicates require 0016 and fail closed), and the new suite `tests/assignment-schema-prerequisite.test.ts` (18 assertions) pins that contract. Comments and documentation only — **no executable code changed**. See "MEDIUM-2 … Resolution" above. | author |
| **MEDIUM-3** | MEDIUM — **OPEN, plan recorded** | 0 of 26 composite tenant foreign keys has a supporting child-side index (F-22). | The concrete follow-up plan is now written down — see "**Follow-up migration plan for the 26 child-side indexes (NOT in PR #32)**" above: the exact DDL shape, the `CREATE INDEX` vs. `CREATE INDEX CONCURRENTLY` lock/duration trade-off (and why the current runner's `BEGIN`/`COMMIT` excludes the concurrent form), the invalid-index failure handling, the replication-lag pacing, the before/after-0018 ordering decision and how the checkpoint settles it, the 0019-specific read-only checkpoint block, and the restored-copy rehearsal. **The indexes are not added to PR #32 and the performance issue is not claimed to be fixed.** | author, separate PR |
| **HIGH-1** | HIGH → **FIXED** | The push-recommendation guard was inert. | **Closed** in `69a6e5b`: escape-normalised matching plus a per-line explicit-prohibition assertion. Re-introduction now fails the suite (19/1, exit 1). | — |
| **MEDIUM-1** | MEDIUM → **FIXED** | The suite could skip in CI with exit 0. | **Closed** in `69a6e5b`: `EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true` turns a skip into exit 1, and CI sets it. | — |
| **LOW-1** | LOW | Ungrammatical operator error message. | Change the template in `src/lib/tenant-constraints.js` to `… is ${row.problem}` → `… ${row.problem}` for the "references the wrong parent table" case (or reword the SQL problem values). One-line change; can be folded into the next commit that touches that file. | author |
| **LOW-2** | LOW | The submit route uses the non-schema-aware predicate. | Switch `src/app/api/assignments/[id]/submit/route.ts:19,56` to `resolveAssignmentAccessPredicate` for consistency. No behavioural change on a migrated database. | author |
| **LOW-3** | LOW | The policy mirror grants a rule no route implements. | Either remove `explicitlyAuthorized` from `src/lib/assignment-policy.ts` and the corresponding assertion in `tests/assignment-authorization.test.ts:24`, or state in the file that it is a reserved future rule. | author |
| **LOW-4** | LOW | The relational "reachable schools" helpers do not check the school lifecycle. | Add `join schools s on s.id = … and s.status = 'active'` to `sqlSchoolsOfClass` and the other `sqlSchoolsOf*` helpers for defence in depth. Not exploitable today (see the finding). | author |
| **LOW-5** | LOW | The database test suites leave their scratch databases on the admin database. |
| Add a `finally`-block cleanup (as the tenant-constraint suite already does) to the tenant suites that create scratch databases. Housekeeping only. | author |
| **ENV-1** | LOW | The local `.git` was re-cloned between sessions; the branch pointer had to be restored. | No repository action. Reviewers must verify `git rev-parse HEAD` against the PR's head SHA rather than trusting a checkpoint. | reviewer |

### Final verdict of the re-audit

**READY FOR FURTHER REVIEW** — for the *code* of the schema-sync bypass remediation.

The bypass is closed by executable checks, the destructive scenario is reproduced and
contained, every failure mode is explicit and fail-closed, the recovery procedure was
exercised end to end (damage → repair → re-apply → verify), and the regression suite is
demonstrably non-vacuous (7 mutations, 7 detections after the HIGH-1 fix).

It is **NOT READY for approval of the production migration**, and PR #32 must stay a draft,
because:

* **BLOCKER-1** — the production preflight evidence does not exist and cannot be produced by
  any code change; it requires an authorized operator on a restored production copy.
* **BLOCKER-2** — this remediation has had no independent human review. The requester
  explicitly directed that the merge proceed without one and that no further reviewer be
  sought, so this blocker was **waived for this merge**. It was **not** closed, and nothing
  in this report should be read as an independent review having taken place.
* **MEDIUM-2** — *resolved*: the inaccurate support guarantee is corrected to the measured
  prerequisite and pinned by a new non-vacuous regression suite. The pre-0016 availability
  behaviour itself is unchanged and is not claimed to be fixed.
* **MEDIUM-3** — the child-side index gap is real and measured, and its remediation is a
  separate migration with its own gate and preflight. The concrete plan for it is now
  recorded above; the indexes are **not** in PR #32 and the performance issue is **not**
  claimed to be fixed.

This re-audit changed only the regression suite and the CI wiring (`69a6e5b`). It did not
change the migration, the runner, the schema, the application authorization code, the
production environment, or PR #32's draft status, and it did not merge anything.

---

## Follow-up work (2026-10-18) — the LOW findings, after PR #32 was merged

PR #32 was merged into `main` as `90ec043`. This section records the follow-up work that
was done afterwards, in its own branch and its own pull request, against the merged tree.

**Scope.** The LOW findings recorded above. **BLOCKER-1 and MEDIUM-3 were deliberately left
alone**: the production preflight needs an authorized operator on a restored production
copy, and the 26 child-side indexes are a separate, separately gated migration.

### LOW-5 — the disposable test databases are now always removed — FIXED

**Measured first.** Every suite that creates a disposable PostgreSQL database was audited
(12 suites in total), and the finding was reproduced on the merged tree: a run of the four
worst suites left **4** scratch databases on the admin database — `easylearn_2c_test_*`,
`easylearn_2d_test_*`, `easylearn_2d_reg_*` and `easylearn_2e_dash_*` — one per suite.

| Suite | Scratch database | Teardown before |
|---|---|---|
| `tests/tenant-authorization-db.test.ts` | `easylearn_2c_test_*` | **none** — the `finally` never dropped it |
| `tests/tenant-catalog-db.test.ts` | `easylearn_2d_test_*` | **none** |
| `tests/tenant-assignments-submissions-regression.test.ts` | `easylearn_2d_reg_*` | **none** |
| `tests/tenant-dashboard-isolation-db.test.ts` | `easylearn_2e_dash_*` | **none** |
| `tests/tenant-integration-regression.test.ts` | `easylearn_integration_*` | dropped, but the failure was **swallowed** (`.catch(() => undefined)`) |
| `tests/assignment-access-db.test.ts` | `easylearn_assignment_auth_*` | dropped, but the failure was **swallowed** |
| `tests/assignment-schema-prerequisite.test.ts` | `easylearn_prereq_*` | dropped, but the failure was **swallowed** |
| `tests/tenant-db.test.js`, `tests/membership-auth-db.test.ts`, `tests/tenant-write-attribution-db.test.ts`, `tests/migration-0017-school-id-not-null.test.ts`, `tests/migration-tenant-constraint-integrity.test.ts` | — | already dropped in a `finally`; left unchanged |

Two further gaps were closed by the same change, because the old teardown had them too:

* **A failure in a setup step leaked the database.** The old pattern created the database
  *before* entering the suite's `try` block, so a suite that died between
  `CREATE DATABASE` and the `try` could never drop it.
* **A failed teardown was invisible.** `.catch(() => undefined)` turned "the scratch
  database could not be removed" into silence.

**The fix.** One shared helper, `tests/helpers/scratch-db.js`, now owns the lifecycle:

* `createScratchDatabase()` removes any stale database of the same name (a killed run
  leaves one behind), creates a fresh one, connects a client, and — if any of those steps
  fails — removes what it created before re-throwing, so **a failed setup never leaves a
  database behind**;
* `dropScratchDatabase()` terminates the backends still attached, drops the database, and
  **verifies against the catalog that it is gone**. It retries, and it **never throws**: it
  returns `{ ok, error }`;
* `assertCleanupSucceeded()` composes the two outcomes: when the test body already failed,
  the **original failure is what fails the suite** and the cleanup failure is printed (never
  swallowed) and attached to it as `cleanupError`; when the test body succeeded, the cleanup
  failure **fails the suite on its own**, with a message that names the database and the
  `DROP DATABASE` command the operator has to run.

All seven suites above now use it, and the change is small in each: the helper replaces
the manual `CREATE DATABASE` block, a `catch` clause records the primary error, and the
`finally` disposes the scratch database.

**The contract is pinned by a new suite**, `tests/scratch-db-lifecycle.test.ts`
(7 assertions): the teardown removes the database after a successful body; it removes it
after a **failed** body; a **failed setup** removes the database it created; a **stale**
database is replaced; a cleanup failure is **surfaced with an actionable message**; a
cleanup failure **does not replace** the original failure; and a cleanup failure **fails the
suite** when nothing else failed. The suite is part of `test:db` and `test:all`, and a
skip fails the CI job (`EASY_LEARN_REQUIRE_SCRATCH_DB_LIFECYCLE=true`).

**Verified** (disposable PostgreSQL 16.14, the CI sequence replicated locally with every
fail-on-skip safeguard on):

* every suite touched by this follow-up was run **three times in a row** — the four
  leaking suites (80 / 17 / 11 / 21 assertions), the three silent-swallow suites
  (11 / 7 / 23), the new contract suite (7), the policy suite and the tenant-constraint
  integrity suite (20) — **3/3 green every time**, leaving **0** scratch databases;
* the whole CI sequence — `npm test`, the TLS end-to-end suite (6 assertions against a
  real TLS-enabled PostgreSQL 16), `test:db`, `test:tenant-auth`, `test:mutation`,
  `test:integration`, `test:tenant-integrity`, typecheck, production build and lint —
  is **green end to end**, and leaves **0** databases behind on the admin database
  (before this change the same sequence left 13).

### LOW-1 — the ungrammatical operator message — FIXED

The inventory SQL produced one problem value that was a full clause while the other ten
were noun phrases, and the message template inserted `is` in front of all of them:

```
constraint assignments_school_class_fk on public.assignments is references the wrong parent table
```

Only that one case was ungrammatical; the other ten already read correctly. The single
SQL literal was changed to `a foreign key to the wrong parent table`, so the message now
reads *"constraint … on public.… is a foreign key to the wrong parent table"*. Nothing else
changed: the `problem` field has no enumerated contract, the only two assertions on these
messages (`is not validated`, `is wrong child columns`) still hold, and the drift guard
between the module and migration 0018 is unaffected.

### LOW-2 — the submit route used the non-schema-aware predicate — FIXED

`src/app/api/assignments/[id]/submit/route.ts` was the only assignment route still using
the synchronous `assignmentAccessPredicate`, which always references `assignments.school_id`
and therefore requires migration 0016 for every role. It now uses
`resolveAssignmentAccessPredicate`, like every other route.

**The change is a no-op, and that was verified rather than assumed.** Only a **learner** can
reach this code path (`ctx.school.role !== "learner"` → 403), and the learner role rule
needs `learner_classes.school_id` either way — so on a pre-0016 schema both forms fail
closed identically, and on a migrated schema the two predicates select **exactly the same
rows**. That equivalence is now asserted by the regression suite: *"the synchronous and the
schema-aware predicate select exactly the same rows"*, checked for the teacher, the school
administrator, the learner and the parent.

### LOW-3 — the policy mirror granted a rule no route implements — FIXED

`src/lib/assignment-policy.ts` granted a teacher `manage-full` when `explicitlyAuthorized`
was true, but **no route and no schema column ever populates that flag** — the enforced
teacher rule in `assignment-access.ts` is ownership only. A mirror that hands out access
the database-backed routes never grant is a mirror that misleads every reader who trusts
it.

The mirror now states exactly what the routes enforce: the teacher branch is ownership
only, and the flag is kept in the input type, documented as **RESERVED**, so the intended
capability stays visible and has an obvious place to be wired when it is implemented. The
policy test was updated to assert that the reserved flag grants **nothing** — a stronger
guard than the one it replaces. The function is used only by tests, so no production
behaviour changed.

### LOW-4 — the "reachable schools" helpers omit the school lifecycle check — NOT FIXED, and the proposed remedy is a loosening

The handoff proposed adding `join schools s on s.id = … and s.status = 'active'` to the
`sqlSchoolsOf*` helpers "for defence in depth". **That change was measured and it is not a
no-op — it weakens the rule.**

`sqlOwnedBySchool()` grants a row to a school only when that school is in the reachable set
**and is the only school in it**; a row reachable from two schools is attributable to
neither and is denied (fail closed). Filtering the reachable set by the school lifecycle
removes a **suspended** school from that set, so a row that is reachable from an active
school *and* from a suspended school changes from **denied** to **allowed**:

| | Reachable-school set | `sqlOwnedBySchool(A, set)` |
|---|---|---|
| today | `{A (active), B (suspended)}` | **false** → the row is DENIED for A |
| with the proposed filter | `{A}` | **true** → the row would be ALLOWED for A |

(Measured on a real PostgreSQL 16.14 database: school A active, school B suspended, one
teacher with an active membership in **both**, a class in A homeroomed by that teacher, and
an assignment in that class.)

**The requested school is always active anyway** — the membership resolution
(`sqlSchoolsOfUser`) already joins `schools` with `status = 'active'`, so a suspended
school can never be the school a request asks for. The finding therefore stays **open as a
non-defect**: the helpers omit a check that cannot be reached, and the only way to add it
would relax the dual-attribution rule. It is **not** implemented here.

### What this follow-up did not do

* **BLOCKER-1 is still BLOCKED.** The production preflight has **not** been performed and
  the restored-production-copy checkpoint has **not** been completed.
* **MEDIUM-3 is untouched.** The 26 child-side indexes are still missing, the performance
  issue is **not** fixed, and the follow-up plan above stands as written.
* No production migration was run, no production connection was opened, no production data
  or setting was changed, no manual deployment was performed, and no branch protection was
  altered. The migration 0018 gate, the baseline confirmation and the repair confirmation
  are untouched, and the tenant-integrity and TLS safeguards are unchanged.

---

## 0. Method, scope, and constraints

**What was done.** Source reading of the migration, the runner, the Drizzle schema/journal, the
schema-resilience DDL, the seed route, and both operator documents; plus *empirical execution* of
the gate, the baseline gate, all three 0018 abort paths, the checkpoint SQL verbatim, and
`drizzle-kit push` — all against a **disposable local PostgreSQL 16.2** instance
(`127.0.0.1:5432`, databases `audit_probe`, `audit_viol`, `audit_noidx`, `audit_ref`,
`audit_base`, `audit_base2`, `audit_lock`).

**What was NOT done, and cannot be undone by this report.** No production connection was opened.
No production credentials were requested or used. No migration was run against production. No
production database content or setting was modified. No deployment setting was changed. No branch
protection was changed. **No commit was made and nothing was pushed.** PR #32, PR #30 and PR #31
were not merged. The repository tree was verified clean before and after the audit.

**State at the end of the audit (re-verified):**

| Item | Value |
|---|---|
| Working tree | clean |
| Branch / HEAD | `arena/97987bec-easylearn` / `d05c209` |
| PR #32 | OPEN, DRAFT, MERGEABLE, head `d05c209` |
| PR #30 / PR #31 | OPEN, `mergedAt = null` (not merged) |
| `main` | `8931095c5333e4f39f527d4520c0185805bf536f` (unchanged) |

**Evidence base for the PostgreSQL version.** The only version continuously verified by the
repository's own CI is **PostgreSQL 16** (`.github/workflows/ci.yml:17`, `image: postgres:16`).
All local execution in this audit was on **PostgreSQL 16.2**; the TLS end-to-end suite runs on
**16.14**. See finding **F-3** for an unsupported version claim in the checkpoint document.

---

## Part 1 — Safeguard verification

Every claim in this part was reproduced by execution against the disposable database unless marked
*(code reading only)*.

### 1.1 A normal migration run skips 0018 safely and reports that it was skipped — **PASS**

`run-migration.js:399-421` splits the pending set into `toApply` and `skippedGated`; a gated
migration reaches `toApply` only when `options.explicit` is true (`run-migration.js:409-412`).
`options.explicit` is set only by naming the file on the command line (`run-migration.js:138-139`).
`0018_composite_school_foreign_keys.sql` is registered in `GATED_MIGRATIONS`
(`run-migration.js:54-56`) with env `CONFIRM_MIGRATION_0018`.

Observed, at `d05c209`:

```
$ node run-migration.js
⚠️  GATED MIGRATION NOT APPLIED: 0018_composite_school_foreign_keys.sql
🎉 Migration complete!                                     EXIT: 0
```

The skip is reported, not silent, and the exit status is 0 so an unrelated deployment is not
blocked (`run-migration.js:445-452`). The ledger recorded no 0018 row. **Verified.**

### 1.2 An explicit run without the required confirmation is refused — **PASS**

`run-migration.js:413-420` throws when `process.env[gate.env] !== gate.token`.

```
$ node run-migration.js 0018_composite_school_foreign_keys.sql
❌ Migration failed: Refusing to apply 0018_composite_school_foreign_keys.sql.   EXIT: 1
```

The database was untouched: 0 composite constraints, no 0018 ledger row. The refusal message
names the exact token and the required preflight. **Verified.**

### 1.3 Baseline mode cannot record 0018 as applied without confirmation — **PASS**

`run-migration.js:205-206` requires `CONFIRM_MIGRATION_BASELINE=I_HAVE_VERIFIED_THESE_MIGRATIONS`.
`run-migration.js:211-221` additionally requires, for **each** gated file in the prefix, that
file's own token.

Observed with only the baseline token, prefix ending in 0018:

```
❌ Migration failed: Baseline refused: the prefix includes the gated migration
   0018_composite_school_foreign_keys.sql. … Set CONFIRM_MIGRATION_0018=… to confirm …  EXIT: 1
```

Ledger state immediately after the refusal: the `easylearn_schema_migrations` table **did not
exist**, so no 0018 row was recorded and no constraint was created. With both tokens the baseline
succeeded and recorded 19 operator-asserted rows. **Verified.**

### 1.4 The migration aborts atomically on cross-school violations or incompatible schema conditions — **PASS**

All three abort paths were reproduced on a disposable database, and each left the database
byte-identical to its pre-run state.

| Injected condition | Result | Exit | Residual state |
|---|---|---|---|
| Cross-school `assignments.class_id` (school B → school A's class) | `0018 found 1 cross-school or orphan reference(s) in public.assignments.class_id; no changes were retained` | 1 | 0 composite FKs, no 0018 ledger row, violating row still present and unmodified |
| Same-named but incompatible constraint (`assignments_school_class_fk` → `FOREIGN KEY (class_id) REFERENCES classes(id)`) | `0018 found an incompatible constraint named assignments_school_class_fk on public.assignments` | 1 | 0 composite FKs, no 0018 ledger row |
| Missing parent `UNIQUE (school_id, id)` index on `classes` | `0018 requires a valid UNIQUE (school_id, id) index on public.classes` | 1 | 0 composite FKs, no 0018 ledger row |

Atomicity comes from a single `DO $$` block inside the per-file transaction
(`run-migration.js:250-274`: `BEGIN` at L258, `COMMIT` at L269, `ROLLBACK` at L271). The raising
statements are at `0018_composite_school_foreign_keys.sql:102` (violation count), `:121`
(incompatible constraint), `:88` (missing unique index), `:63` (missing relation), `:75` (missing
column), and `:10-12` (PostgreSQL < 15). The file contains **no `UPDATE`, `DELETE`, `TRUNCATE` or
`UPDATE`-style statement** — it can only add constraints, never repair or reassign rows.
**Verified.**

### 1.5 The gate cannot be bypassed to *apply* 0018 by an alternate runner, deployment command, or application startup path — **PASS**

Exhaustively checked; every alternate path was found to be incapable of applying 0018.

| Alternate path | Finding |
|---|---|
| `drizzle-kit push` | `src/db/schema.ts` declares **no composite foreign keys**. Drizzle's column-level `.references()` (used throughout `src/db/schema.ts:132-201`) is single-column only, so the 26 composite FKs cannot be expressed and therefore cannot be created. `grep -c "foreignKey(" src/db/schema.ts` → **0**. |
| `drizzle-kit migrate` | `drizzle/meta/_journal.json` has **no 0018 entry** (the journal ends at `0010_object_storage`). `drizzle.config.ts` points at `./src/db/schema.ts` and that journal, so `migrate` cannot reach 0018. |
| Lifecycle scripts | `package.json` has no `postinstall`, `prestart`, `prebuild`, `predeploy`, or `prepare` script, and no script that invokes a migration runner. |
| Application startup / `AUTO_SCHEMA_REPAIR` | `src/lib/schema-resilience.ts:223-230` (feature union) and `:253-327` (DDL) touch only `dashboard_card_overrides`, `activity_logs`, `users`, `quiz_questions`, `uploaded_files`, `assignments`. The file contains no `DROP CONSTRAINT`, `DROP TABLE`, `DELETE FROM` or `TRUNCATE`. |
| `/api/seed` | `src/app/api/seed/route.ts:33` refuses to run when `NODE_ENV=production`. |
| Deployment configuration | No `vercel.json`, no `Dockerfile`, no `docker-compose.yml`. `.github/workflows/` contains only `ci.yml`, which runs tests and never applies a migration to a production database. |
| Concurrent runners | `run-migration.js:373` takes a PostgreSQL advisory lock (`1163416649, 1296125510`), so two runners cannot apply 0018 simultaneously. |

`0018_composite_school_foreign_keys.sql` and `drizzle/0018_composite_school_foreign_keys.sql` are
byte-identical (135 lines each; sha256 `6bbbd2fe3a048a6e8f4185e4dbf3657952c3bfa2aa3bdfa1bcfb080de0000eb9`),
so there is no divergent second copy to apply. **Verified.**

### 1.6 No alternate path can *remove* 0018's constraints or the migration ledger — **FAIL**

This is the one failing safeguard, and it is the reason for the verdict.

`npx drizzle-kit push` is **not** an alternate way to *apply* 0018 (see 1.5), but it **is** an
un-gated, widely-recommended path to the exact schema state the gate exists to protect — and it
reaches that state by *destroying* the constraints rather than by applying them.

**The plan it generates.** Against a disposable database with 0018 applied, `drizzle-kit push
--verbose` emitted **85 statements**: 52 `ALTER TABLE … DROP CONSTRAINT`, 31
`ALTER TABLE … ADD CONSTRAINT`, 1 `DROP TABLE "easylearn_schema_migrations" CASCADE`, and
1 `ALTER TABLE … DISABLE ROW LEVEL SECURITY`.

**What it does when executed.** Running `npx drizzle-kit push --force` on the disposable database
produced, before → after:

| Object | Before | After |
|---|---|---|
| Composite tenant FKs (0018) | 26 | **0** |
| `easylearn_schema_migrations` ledger | present | **dropped** (CASCADE) |
| `*_school_id_id_unique` indexes (0017; 0018's precondition) | 24 | **7** |
| Total foreign keys | 111 | 85 |

**Why this is dangerous, not merely noisy.**

1. *It is recommended by the repository itself.* `README.md:48` instructs the operator to run
   `DATABASE_URL="…" npx drizzle-kit push` as **Step 4 "Set Up Database Tables"** of the primary
   setup path. `src/lib/schema-resilience.ts:207` appends ``Apply <migration> (or `npx drizzle-kit
   push`), then retry.`` to *any* admin-visible schema-gap error. `src/app/api/parent-learners/route.ts:149`
   and `src/app/api/parent-learners/[id]/route.ts:170` both say "Run `npx drizzle-kit push`".
2. *The runtime trigger is generic and production-reachable.* `schemaAwareErrorMessage`
   (`src/lib/schema-resilience.ts:198-210`) fires on `isSchemaOutOfDate`, which is true for
   PostgreSQL `42P01` undefined_table, `42703` undefined_column and `42704` undefined_object
   (`src/lib/schema-resilience.ts:22-24, 61-73`). Any production request that hits a missing
   table or column therefore returns an admin-visible instruction to run `drizzle-kit push`.
3. *It defeats every safeguard in the runner at once.* No `CONFIRM_MIGRATION_0018` token, no
   read-only checkpoint, no per-file transaction, no checksum ledger, no advisory lock, no
   baseline gate, no "nothing to apply" confirmation.
4. *The resulting state can then be certified as correct.* After the push, the runner correctly
   fails closed (`❌ Existing public tables were found without easylearn_schema_migrations.
   Refusing to replay migrations.`, exit 1) — but the documented recovery path is `--baseline`,
   and `--baseline` explicitly "does not verify database state" (the checkpoint document says so
   at `:324`). Reproduced on the disposable database:

   ```
   $ CONFIRM_MIGRATION_BASELINE=… CONFIRM_MIGRATION_0018=… node run-migration.js --baseline <prefix incl. 0018>
   ⚠️  Recorded operator-asserted baseline for 19 migration(s); no migration SQL was executed.   EXIT: 0

   $ node run-migration.js
   ✅ All requested migrations are already recorded with matching checksums.                   EXIT: 0
   ```

   At that point the ledger asserts that 0018 is applied while **zero** of its constraints exist.
5. *Neither operator procedure warns against it.* `grep -c "drizzle-kit"` returns **0** for both
   `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` and
   `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md`. The only warning in the repository is in the
   planning document `docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md:1422` ("no `drizzle-kit
   push`"), which is not part of the operator procedure and is contradicted by the README.

**Classification: FAIL.** The tenant boundary that 0018 exists to establish can be removed, without
any confirmation, by a command the repository tells operators to run — and the resulting state can
be recorded as correct.

---

## Part 2 — Review of the read-only preflight procedure

`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` is 333 lines with two SQL blocks (19 and 5
statements). It was **extracted verbatim** and executed against a disposable migrated database.

### 2.1 Is it executable and genuinely read-only — **PASS**

Both blocks executed with `psql -v ON_ERROR_STOP=1` and **exit 0, no errors**. The blocks open
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, set `statement_timeout = '60s'` and
`lock_timeout = '2s'`, and end in `ROLLBACK`. The first block's identity query reported
`read_only = on` from `current_setting('transaction_read_only')`, and `postgres_version_num =
160002`. The document's own rules (`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md:11-12`)
state that only catalog/data `SELECT`s plus transaction-local settings and `ROLLBACK` are used, and
that the procedure does not call the application migration runner. **Verified** — the checkpoint
cannot create, alter or repair anything.

### 2.2 Check-by-check: what passes and what fails mean

| # | Check | What a **passing** result means | What a **failing** result means | Verdict |
|---|---|---|---|---|
| 1 | Database identity + `server_version` / `server_version_num` + `transaction_read_only` (`:20-31`) | The engine is ≥ 150000 (PostgreSQL 15+), which 0018 requires for selective column-list `ON DELETE SET NULL` (`0018…sql:10-12`) | Version < 15 or uncertain → 0018 will abort; **stop**, do not apply | **PASS** |
| 2 | 0016/0017 `school_id` column presence and nullability over the 25-table set (`:30-48`) | Every required table has a `school_id` column and it is `NOT NULL` where 0017 requires it | A missing relation/column → 0018 aborts at `:63`/`:75`; a nullable `school_id` breaks the composite key | **PASS** |
| 3 | Zero-NULL count for each required table (`:49-…`) | 0017's `NOT NULL` backfill is complete on this database | A non-zero count → rows would be silently excluded from the composite key; **remediation required, not a stamp** | **PASS** |
| 4 | 0016 school FKs present and validated (`:110-121`) | The single-column school FKs are in place | Missing/unvalidated → the tenant model is already broken; **stop** | **PASS** |
| 5 | Migration-ledger presence (and, only if present, its rows) (`:301-317`) | The applied prefix and checksums are known | Absent → "history ledger unavailable; applied migration sequence/checksums unverified" (`:317`); the prefix must be established independently | **PASS** (with the doc's own caveat) |
| 6 | 24 × `UNIQUE (school_id, id)` targets valid/ready/unique (`:151-175`) | All 24 parents have the unique key 0018 references | Fewer than 24 → 0018 aborts with `requires a valid UNIQUE (school_id, id) index on public.<table>` | **PASS** |
| 7 | 26 expected composite constraints, with `convalidated` and full definition (`:123-149`) | Before application: all 26 rows present with `convalidated`/definition NULL. After application: all 26 present, `convalidated = t`, and the definition matches `FOREIGN KEY (school_id, <col>) REFERENCES <parent>(school_id, id)` | A row still NULL after application → the constraint is absent. A *populated* row whose definition differs → an incompatible same-named constraint (0018 aborts at `:121`) | **PASS**, but the verdict is **operator-read, not machine-asserted** (see 2.4) |
| 8 | 26 + 2 relationship mismatch/orphan counts (`:176-…`) | Every count is 0 | A non-zero count is exactly the condition that makes 0018 abort at `:102`; a **stop** condition, not permission to move rows (`:322`) | **PASS** — proven non-vacuous below |
| 9 | Table-size estimates for 17 tables (`:110-121`) | Row counts are small enough that `VALIDATE CONSTRAINT` completes in a reasonable window | Large tables → the validation scan becomes the dominant runtime and lock-duration risk | **PASS** (estimates only — see 2.4) |

### 2.3 The relationship check is non-vacuous and correctly scoped — **PASS**

- **It detects what 0018 aborts on.** With one deliberately cross-school
  `assignments.class_id` injected, the checkpoint reported `assignments.class | 1`, and 0018
  independently aborted with `0018 found 1 cross-school or orphan reference(s) in
  public.assignments.class_id`. The preflight and the migration agree.
- **It detects a missing unique index.** With `classes_school_id_id_unique` dropped, the 0017
  target check returned 23 rows instead of 24 — and 0018 aborted with `0018 requires a valid
  UNIQUE (school_id, id) index on public.classes`.
- **It surfaces an incompatible constraint.** With a wrong-shaped `assignments_school_class_fk`
  in place, the expected-constraint query returned the *actual* definition
  `FOREIGN KEY (class_id) REFERENCES classes(id)`, so the discrepancy is visible to the operator.
- **It excludes legitimate NULLs.** Every relationship predicate is
  `WHERE c.<col>_id IS NOT NULL AND (p.id IS NULL OR c.school_id IS DISTINCT FROM p.school_id)`
  (`:180-…`), so an optional reference that is NULL is not counted as a mismatch.
- **Its coverage exactly matches 0018's scope.** 0018's 26 installed constraints were diffed
  programmatically against the checkpoint's relationship list: **0 relationships are in 0018's
  scope but unchecked by the preflight.** The preflight additionally checks
  `parent_learners.learner_membership` and `parent_learners.parent_membership`, which are
  outside 0018's scope — extra defensive coverage.
- **All 28 relationship counts were 0 on clean data**, and the constraint check returned exactly
  26 rows.

### 2.4 Missing checks — identified, not assumed

These are **gaps in the checkpoint document**, stated explicitly:

1. **No child-side index inventory.** 0018 adds 26 foreign keys whose *referential actions*
   (`ON DELETE CASCADE` on `timetable_entries.class_id`; `ON DELETE SET NULL` on four others)
   must locate the child rows to act on them. That requires an index on the child side
   `(school_id, <fk column>)`. The checkpoint reports the 24 **parent-side** unique indexes but
   reports **no** child-side index coverage. Without it, the estimated cost of 0018's
   `VALIDATE CONSTRAINT` phase on a large production dataset cannot be bounded. **This is the most
   material gap.**
2. **No write-lock and duration capture.** The checkpoint measures nothing about how long
   0018's validation scan would take or what it would block. The operator is left to reason from
   `reltuples` alone.
3. **No automated PASS/FAIL assertion.** The SQL emits raw result sets. The expected values
   (24 tables, 24 unique targets, 26 constraints, 0 mismatches) are stated in prose at `:321-323`,
   so the procedure is usable, but every comparison is manual.
4. **Table sizes are estimates, not exact counts.** `reltuples` and `pg_total_relation_size` are
   planner estimates; the document does not say so, and the runbook's size-based go/no-go inherits
   that uncertainty.
5. **The 0017 unique index *column order* is surfaced only as `indexdef` text.** The query shows
   `USING btree (school_id, id)`, which is readable but is not asserted to be exactly
   `(school_id, id)`.
6. **No backup/restore-verification step inside the checkpoint document.** The backup and rollback
   requirements live in `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md:136-141, 174-176`
   instead. The split is defensible, but the checkpoint — the document the task designates as the
   required preflight — does not itself carry them, and an operator who follows only the
   checkpoint would have no backup requirement in front of them.

### 2.5 The operator procedures do not cover the "destructive alternate path" — **FAIL**

See finding **F-1** in Part 4.

---

## Part 3 — Required operator evidence (from a restored production copy)

The following evidence must be produced by a human operator on a **restored copy** of the target
production database. None of it can be produced by this audit; each item is currently
**BLOCKED** on production access, which was correctly out of scope.

### 3.1 Engine, version, and schema/migration state
- `current_setting('server_version')` and `server_version_num` ≥ **150000** (PostgreSQL 15+),
  plus the provider/engine identity (hosted vendor, region, plan) and the `current_database()`
  identity of the restored copy — the copy's identity must be recorded so no one confuses it with
  production.
- The presence or absence of `public.easylearn_schema_migrations`; if present, every
  `filename, checksum, applied_at` row. If absent, the explicit statement
  "history ledger unavailable; applied migration sequence/checksums unverified" and an independent
  determination of the applied prefix. **The deployed prefix must not be inferred from the
  repository's Drizzle journal, from runner logs, or from a successful deployment**
  (`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md:317, 324`).
- Catalog evidence of what is actually installed, not what the repository says should be.

### 3.2 Preflight output and counts of offending rows
- The complete, sanitized output of both checkpoint SQL blocks, executed verbatim against the
  restored copy, with the exit status of each block and any statement timeout or lock timeout.
- The 28 relationship mismatch/orphan counts. **Every one must be 0.** A non-zero value is a stop
  condition and an investigation item; it is *not* permission to stamp, move, or repair rows
  (`:322`).
- The 25-row column presence/nullability result, the per-table NULL counts, the activity-log
  NULL count, the validated 0016 school-FK count, the valid 0017 unique-target count (must be 24),
  and the 26 expected 0018 constraint rows with their `convalidated` state and full definitions
  (all NULL before application; all `t` with matching definitions after).
- The table-size estimates for the 17 tables, and — **added as a required item, see 2.4-1** — the
  child-side index inventory for the 26 relationships.
- The exact sanitized report format is specified at `:328-330`.

### 3.3 Confirmation that no data was silently reassigned or repaired
- Before and after the migration, the 28 relationship mismatch counts must be **unchanged** (still
  0) and the school/membership counts unchanged.
- A statement that 0018 contains no `UPDATE`, `DELETE` or `TRUNCATE` and therefore cannot
  reassign rows — this is verifiable from the migration file itself
  (`0018_composite_school_foreign_keys.sql`), and was verified in this audit.
- Evidence that the migration ledger was not recreated by a `--baseline` assertion in place of
  real verification, and that the 26 constraints are present and `convalidated = t` **after**
  application, independently of what the ledger says.

### 3.4 Backup and restore verification
- A **tested** backup of the target database, with the restore rehearsed onto the copy the
  checkpoint was run against. "A backup exists" is not sufficient; the restore must have been
  performed and its result compared.
- A named recovery plan: how to roll back 0018 specifically (drop the 26 constraints, remove the
  0018 ledger row — noting that dropping the constraints does not require restoring data, because
  0018 changes no rows), and who may authorize it.
- A statement of the data-loss window if a restore becomes necessary.

### 3.5 Expected lock and duration risks, and a recovery plan
- The 26 constraints are added as `ADD CONSTRAINT … NOT VALID` followed by `VALIDATE CONSTRAINT`
  (`0018_composite_school_foreign_keys.sql:125` and `:131`).
- **Corrected lock facts** (measured in this audit on PostgreSQL 16.2 by sampling `pg_locks`
  during each phase):
  - `ADD CONSTRAINT … NOT VALID` holds **SHARE ROW EXCLUSIVE** on the child table
    (and SHARE ROW EXCLUSIVE on the referenced parent) — it blocks concurrent DDL and other
    SHARE ROW EXCLUSIVE work, but **allows normal reads and writes**.
  - `VALIDATE CONSTRAINT` holds **SHARE UPDATE EXCLUSIVE** on the child table and ROW SHARE on
    the parent — it allows reads and writes but blocks DDL.
  - **The lock risk is therefore materially lower than the runbook states.**
    `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md:138-139` states that "the migration takes
    `ACCESS EXCLUSIVE` locks while validating each constraint". That is **incorrect**; no
    ACCESS EXCLUSIVE lock is taken by either phase. The statement is conservative in the safe
    direction, but it is wrong and should be corrected (see action **A-4**).
- The **duration** risk is dominated by the validation scan of the child tables, and is therefore
  bounded by the table sizes and the child-side index coverage — neither of which the checkpoint
  currently measures (see 2.4).
- A recovery plan covering both a failed migration (the runner rolls back atomically, so the
  database is unchanged — verified) and a successful migration that must be reverted.

### 3.6 TLS certificate-chain and hostname verification
The requirements are specified in `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md:16-51` and were
implemented and tested in the R2/R4 follow-up. The **production** values are BLOCKED here.
- The server certificate must chain to a **trusted** CA **and** the **hostname must match** the
  certificate's Subject Alternative Name. A certificate issued for another host must fail with
  `ERR_TLS_CERT_ALTNAME_INVALID`; a certificate for an IP address requires a matching
  `IP Address:` SAN.
- The CA must be supplied and trusted via `DATABASE_CA_CERT`, `PGSSLROOTCERT`, or an
  `sslrootcert=` URL parameter (PEM text or a path to a PEM file).
- `sslmode=disable|allow|prefer|verify-ca` must be **refused at configuration time**; `require`
  is upgraded to full verification.
- No unverified fallback: an unreadable or non-PEM CA, an untrusted server certificate, and a
  certificate for the wrong host must all fail the connection with an explicit error.
- The single test-only escape hatch (`EASY_LEARN_TEST_DATABASE`) must be confirmed **unset** in
  the production environment, and its limits must be understood by the operator.
- The evidence to collect is the **production** endpoint's certificate chain and SAN, presented
  without the hostname or any credential, plus a successful verified connection.

---

## Part 4 — Decision report

### 4.1 Verified facts (reproduced by execution)

| ID | Item | Classification | Evidence |
|---|---|---|---|
| F-1 | No alternate path can remove 0018's constraints or the ledger | **FAIL** | `drizzle-kit push --force` on a disposable DB: composite FKs 26 → 0, ledger dropped (CASCADE), `*_school_id_id_unique` 24 → 7. Recommended by `README.md:48`, `src/lib/schema-resilience.ts:207`, `src/app/api/parent-learners/route.ts:149`, `src/app/api/parent-learners/[id]/route.ts:170`. Not mentioned in either operator procedure (0 occurrences). `--baseline` can then certify the false state (reproduced: "✅ All requested migrations are already recorded with matching checksums"). |
| F-2 | Default run skips 0018 and reports the skip | **PASS** | `run-migration.js:399-452`; observed `⚠️ GATED MIGRATION NOT APPLIED: 0018…`, exit 0, no ledger row |
| F-3 | Explicit run without the token is refused | **PASS** | `run-migration.js:413-420`; observed `❌ Refusing to apply 0018…`, exit 1, database untouched |
| F-4 | Baseline cannot record 0018 without confirmation | **PASS** | `run-migration.js:205-221`; observed refusal, **ledger table not even created**; confirmed baseline requires both tokens |
| F-5 | 0018 aborts atomically on cross-school violations | **PASS** | `0018…sql:102`; observed `0018 found 1 cross-school or orphan reference(s) in public.assignments.class_id`; 0 constraints, no ledger row, violating row unmodified |
| F-6 | 0018 aborts atomically on an incompatible same-named constraint | **PASS** | `0018…sql:121`; observed `0018 found an incompatible constraint named assignments_school_class_fk` |
| F-7 | 0018 aborts atomically on a missing parent `UNIQUE (school_id, id)` | **PASS** | `0018…sql:88`; observed `0018 requires a valid UNIQUE (school_id, id) index on public.classes` |
| F-8 | 0018 aborts on PostgreSQL < 15 | **PASS** *(code reading only — no PG < 15 available)* | `0018…sql:10-12` |
| F-9 | 0018 contains no data repair of any kind | **PASS** | No `UPDATE`/`DELETE`/`TRUNCATE` in the file; only `ADD CONSTRAINT` (`:125`) and `VALIDATE CONSTRAINT` (`:131`) |
| F-10 | No alternate runner, deploy command, or startup path can *apply* 0018 | **PASS** | `src/db/schema.ts` has 0 composite FK declarations; `drizzle/meta/_journal.json` has no 0018 entry; no lifecycle scripts; `AUTO_SCHEMA_REPAIR` DDL never drops; `/api/seed` refuses in production; no `vercel.json`/`Dockerfile`/`compose`; CI never migrates a production DB; advisory lock at `run-migration.js:373` |
| F-11 | 0018 preserves the delete semantics of every 0016 predecessor | **PASS** | Programmatic comparison of `confdeltype` for all 26: **26/26 identical** (21 NO ACTION, 4 SET NULL, 1 CASCADE). Purely additive; no application delete flow changes. |
| F-12 | The checkpoint SQL is executable, read-only, and complete | **PASS** | Both blocks ran verbatim, exit 0, `transaction_read_only = on`, `ROLLBACK`; 26/26 of 0018's relationships covered (0 gaps), plus 2 extra `parent_learners` checks |
| F-13 | The checkpoint is non-vacuous | **PASS** | Injected cross-school row → `assignments.class | 1`; dropped unique index → 23/24; wrong-shaped constraint → its actual definition surfaced |
| F-14 | The ops doc's lock characterization is wrong | **FAIL** *(documentation accuracy)* | `pg_locks` sampling: ADD … NOT VALID → SHARE ROW EXCLUSIVE; VALIDATE → SHARE UPDATE EXCLUSIVE. `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md:138-139` claims ACCESS EXCLUSIVE during validation. Conservative in the safe direction, but incorrect. |
| F-15 | The checkpoint's stated verification environment is unsupported | **FAIL** *(documentation accuracy, minor)* | `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md:5` says the SQL was "exercised against a migrated disposable PostgreSQL 18 database". The repository's CI pins `postgres:16` (`ci.yml:17`); this audit exercised PostgreSQL 16.2. The PG 18 claim is not reproducible from the repository. |
| F-16 | The checkpoint lacks a child-side index inventory | **FAIL** *(preflight gap)* | 26 relationships need child-side `(school_id, <fk col>)` indexes for their referential actions; the checkpoint reports only the 24 parent-side unique targets |
| F-17 | The checkpoint captures no write-lock or duration data | **FAIL** *(preflight gap)* | No measurement step; the duration risk that actually matters (the validation scan) is unbounded by the document |
| F-18 | The checkpoint emits no machine-readable PASS/FAIL | **FAIL** *(preflight gap, minor)* | Raw result sets only; expected counts are in prose at `:321-323`, so every comparison is manual |
| F-19 | The checkpoint reports estimated, not exact, row counts | **FAIL** *(preflight gap, minor)* | `reltuples` / `pg_total_relation_size` are planner estimates; the document does not say so |
| F-20 | Production state: engine version, schema/migration state, offending-row counts, table sizes, TLS chain | **BLOCKED** | Requires production access, which was correctly excluded. The procedure to obtain it exists (Part 3) and is sound; the evidence does not exist yet. |
| F-21 | The tenant boundary can be silently removed and then certified as present | **BLOCKED** on F-1's remediation | The `--baseline` procedure is documented as an operator assertion that does not verify state (checkpoint `:324`); it currently has no cross-check against the 26 constraints. |
| F-22 | None of the 26 relationships has a supporting child-side index | **FAIL** (new; found during remediation) | The child-side index inventory added to the checkpoint reports `(none)` for all 26 relationships on a fully migrated database. Not a correctness problem, but a parent delete would sequentially scan the child table, lengthening the window in which 0018 holds its locks. Belongs in a separately reviewed migration, not in this branch. |

### 4.2 Assumptions — explicitly **not** verified

1. That the production database's PostgreSQL version is ≥ 15. The production version is unknown;
   only the disposable 16.2 and CI's 16 are known. 0018 aborts safely if it is older, but the
   operator must confirm it.
2. That the production database contains **zero** cross-school or orphan references. Unknown;
   this is exactly what the checkpoint exists to measure. If it is non-zero, 0018 will abort
   safely and the offending rows will need a separately reviewed, backup-rehearsed remediation.
3. That the production tables are small enough for the validation scan to complete acceptably.
   Unknown; the checkpoint's estimates are not exact.
4. That production child tables have appropriate indexes for the new referential actions.
   Unknown, and not measured by the checkpoint (F-16).
5. That the production database's TLS certificate chains to a trusted CA and matches the hostname.
   The *implementation* is verified (the R4 suite runs 7/7 against a real TLS-enabled PostgreSQL
   16.14, and CI runs it with `EASY_LEARN_REQUIRE_TLS_E2E=true` so a skip becomes a failure), but
   the *production* certificate is unknown.
6. That the restored copy is faithful to production (same PostgreSQL version, same extensions,
   same data, same statistics). The checkpoint records the copy's identity but cannot guarantee
   fidelity.
7. That no other actor applies schema changes outside this repository. The audit covers the
   repository's own paths only; an operator running `psql` by hand, or a managed platform's own
   schema tooling, is outside scope.
8. That `main` remains at `8931095c` and PRs #30/#31 remain unmerged at merge time. Verified at
   the close of this audit, not guaranteed for the future.

### 4.3 What must happen before this is ready for a human merge review

Each action is small, concrete, and confined to the integration branch. **All seven were
completed on 2026-10-18 — see "Remediation status" at the top of this document for what was
done and for the enforcement that was added alongside them.** The list is left as originally
written so the original assessment stays readable.

- **A-1 (required — clears F-1).** Add an explicit, prominent prohibition on
  `npx drizzle-kit push` against this database to **both**
  `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` and
  `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md`, stating the verified consequence: it drops
  all 26 composite tenant FKs, the 0016 school FKs, the `easylearn_schema_migrations` ledger
  (CASCADE) and 17 of the 24 `UNIQUE (school_id, id)` indexes. Name `node run-migration.js` and
  the numbered `.sql` files as the only supported schema-change path.
- **A-2 (required — clears F-1).** Remove the `npx drizzle-kit push` recommendation from the
  operator-facing remediation messages: `src/lib/schema-resilience.ts:207`,
  `src/app/api/parent-learners/route.ts:149`,
  `src/app/api/parent-learners/[id]/route.ts:170`. These should point only at
  `node run-migration.js` and the named migration file.
- **A-3 (required — clears F-1).** Amend `README.md:48` so the `drizzle-kit push` step is
  explicitly scoped to a **brand-new, empty** database and carries a warning that it is
  destructive against an existing database and must never be run against production.
- **A-4 (required — clears F-14).** Correct the lock statement in
  `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md:138-139` to SHARE ROW EXCLUSIVE
  (`ADD CONSTRAINT … NOT VALID`) and SHARE UPDATE EXCLUSIVE (`VALIDATE CONSTRAINT`).
- **A-5 (required — clears F-15).** Correct or substantiate the "PostgreSQL 18" claim in
  `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md:5`; the verifiable statement is PostgreSQL 16
  (CI) and 16.2/16.14 (local).
- **A-6 (required — clears F-16/F-17).** Extend the checkpoint with (i) a **child-side index
  inventory** for the 26 relationships and (ii) a **lock/duration capture step** (for example
  `SELECT now()` around a `VALIDATE CONSTRAINT` rehearsal on the restored copy, plus a sampled
  `pg_locks` view), so the duration risk is measured rather than estimated.
- **A-7 (recommended — closes F-18/F-19 and hardens F-21).** Add the expected values as
  assertions inside the checkpoint SQL (PASS/FAIL per check) rather than only in prose, label the
  size figures as estimates, and have `--baseline` **warn** (not merely permit) when the 26
  expected constraints are absent while 0018 is being baselined.

### 4.4 Items that remain BLOCKED and cannot be closed by any code change

F-20 and F-21 are, by design, closable only by a human operator on a restored production copy:
the engine/version identity, the migration-ledger state, the 28 relationship counts, the
preflight report, the no-repair confirmation, the tested backup and restore, the lock/duration
assessment, and the production TLS chain and hostname. The procedures for obtaining all of this
are in place and were verified; the evidence itself does not exist yet, and this audit
deliberately did not go and get it.

---

## Final recommendation

The migration itself is sound. It is atomic, it never repairs or reassigns data, it aborts
correctly on every dangerous precondition, it preserves every predecessor's delete semantics,
and the gate around it works in every mode that was tested — and there is no alternate path in
the repository that can *apply* it without confirmation. The preflight procedure is executable,
genuinely read-only, complete in coverage, and demonstrably non-vacuous.

What is not sound is the environment the migration lands in. The repository still tells
operators to run a command that deletes the 26 tenant foreign keys, the migration ledger, and 17
of the 24 unique indexes the migration depends on — without a token, a checkpoint, a
transaction, or a lock — and the two documents that constitute the operator procedure do not
mention that command at all. After such a command, the documented `--baseline` path can record
0018 as applied on a database that contains none of its constraints, and the next ordinary
migration run reports success. A procedure that can be undone by the repository's own
instructions, and can then be certified as correct, is not a safe place to stand a tenant
boundary.

The required actions (A-1 through A-6) are small, confined to the integration branch, and
verifiable. Once they are applied and the migration suite and CI are re-run green, the remaining
work is the operator evidence in Part 3, which only a human with production access can produce.

**NOT READY — ACTIONS REQUIRED**

---

# Independent re-audit of the MERGED PR #32 state (2026-10-18/19)

**Subject:** `shadrachampah123/easylearn` — the state of `main` at `016d229` (PR #32 merged as
`90ec043`, PR #33 as `851156ca`, PR #34 as `016d229`).
**Scope:** an independent re-audit of the schema-sync bypass remediation, requested after PR #32
had already been merged. This is **not** a continuation of the original review; it re-derives
every claim from the current tree and from execution.
**Environment:** a disposable PostgreSQL 16.14 (SSL enabled, self-signed) on `127.0.0.1:5432`,
plus a disposable database per scenario. **No production system, credential, or database was
contacted, read, or modified.** No migration was applied anywhere except to disposable
databases created for this audit.
**Repository changes made by this audit:** this report section only. **No product code, test,
migration, schema, workflow, or configuration was modified.** The mutation experiments of §3
were applied and then reverted byte-for-byte (§3.4).

---

## 1. Verified repository state

Verified live at the time of writing, not taken from the prior checkpoint.

| Item | Verified value | How |
|---|---|---|
| Session branch | `arena/7d4511bc-easylearn` | `git rev-parse --abbrev-ref HEAD` |
| `HEAD` | `016d229183cb615980992178869bb5b17e42962f` | `git rev-parse HEAD` |
| `origin/main` | `016d229183cb615980992178869bb5b17e42962f` (identical to `HEAD`) | `git fetch origin` + `git rev-parse origin/main` |
| Worktree | clean — no modified, staged, or untracked files | `git status --porcelain` → empty |
| Remotes | `origin` only | `git branch -r` → `origin/HEAD`, `origin/main` |
| PR #32 | **MERGED**, `isDraft=false`, merge commit `90ec04363cbec3222232c6f912fcad69ab038dba`, head `dff2d8b39a1032f1793be15a067bd5f1b818bcbf`, merged `2026-10-18T22:45:56Z` | `gh pr view 32` |
| PR #32 head branch | deleted on GitHub | `gh pr view 32 --json headRefName`; push to it is impossible |
| PR #33 / #34 | MERGED (`851156ca` / `016d229`), both `isDraft=false` | `gh pr view 33/34` |
| Open pull requests | none | `gh pr list --state open` → `[]` |
| CI on `main` | `39176807988` success, `39176617079` success, `39173649856` success | `gh run list --branch main` |
| Commit `9da7333…` | exists on GitHub but is **not** an ancestor of `main` | `git merge-base --is-ancestor` → false |
| Branch protection on `main` | **UNKNOWN** — the API returns `403 Resource not accessible by integration` | `gh api …/branches/main/protection` |
| Repository rulesets | `[]` (none) | `gh api …/rulesets` |

**Two consequences the earlier checkpoints did not carry, and which change the framing of this
report:**

1. **PR #32 is merged, not a draft.** The original review's "keep PR #32 a draft" and
   "BLOCKER-2 — no independent review" conditions are historical. They are recorded here as
   *closed by the requester*, not as findings that are still open.
2. **The branch protection state of `main` could not be read.** It is recorded as UNKNOWN.
   "403" is not evidence that protection is absent, and nothing in this report should be read
   as a claim that `main` is unprotected.

---

## 2. Findings and evidence

### 2.0 What was independently re-derived (no defect)

These are re-verified claims, reproduced from the current tree, not restatements.

| Claim | Result | Evidence |
|---|---|---|
| The 26 composite tenant foreign keys exist, are validated and correctly shaped | **PASS** | 26/26 present, all `convalidated`, definitions match `src/lib/tenant-constraints.js` exactly (audit harness §3.1) |
| `drizzle-kit push --force` really destroys them | **PASS (the bypass is real)** | exit 0; 0 composite FKs, 7 of 24 unique targets left, ledger table dropped |
| The runner fails closed on a damaged database | **PASS** | exit 1 with the ledger/catalog disagreement, the exact count, the missing constraint names, the anti-`drizzle-kit push` warning and both recovery commands |
| A `--baseline` cannot certify a damaged schema | **PASS** | refused with and without the token; refused **with both tokens** when the catalog lacks the constraints; no ledger written |
| `npm run db:schema-sync` refuses a managed database | **PASS** | exit 1, "Schema sync refused", points at `node run-migration.js`, never runs push |
| `--repair-tenant-integrity` is a one-way (truthful-only) repair | **PASS** | restores 24/24 unique targets, creates **no** composite FKs, clears the false 0018 ledger claim |
| The documented recovery works end to end | **PASS** | repair → baseline the real 18-file prefix `0000_wet_legion.sql … 0017_school_id_not_null.sql` → `0018` under its gate → 26/26 present, validated and correct; 19-row ledger; "🎉 Migration complete!" exit 0 |
| The operator runbook matches the executable recovery | **PASS** | `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md` §4.1–4.2 states exactly that order, including "if the ledger itself was dropped, record the verified prefix **without** 0018 first" |

> A note on method, because it changed a conclusion once: the very first recovery attempt failed
> with *"Migration history must be a sequential prefix of the registered migration list"* — that
> was **my own error** (guessed migration filenames), not a product defect. The registered list
> in `run-migration.js` is the only source of truth. A second early reading of "0 composite
> FKs" on a healthy database was a shell-quoting artefact in an ad-hoc `LIKE` filter, not a
> defect. Both were re-derived from `src/lib/tenant-constraints.js` and the runner's own
> inventory query before any finding was recorded.

### 2.1 BLOCKER-1 — Production preflight evidence is still absent *(unchanged, by design)*

**Severity: BLOCKER. Status: open. Closable only by a human operator, not by code.**

0018 installs 26 `NOT VALID` composite foreign keys and then validates them. Whether that is
safe depends on facts that exist only in production: the engine and version, the actual
migration history, the number of cross-school or orphan rows, the validation duration, the lock
behaviour, and the certificate chain. None of them can be produced from this repository, and
this audit did not attempt to obtain production access.

**Evidence required to close it** — exactly the instrument that already exists,
`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md`, executed by an authorized operator against a
**restored production copy**:

1. engine, version, and the applied-migration history (read-only);
2. the 26-relationship check output with the **count** of offending rows, and confirmation that
   the check is non-vacuous;
3. explicit confirmation that **no** row was reassigned, repaired, or deleted;
4. backup and restore verification;
5. the measured lock and validation duration, with a recovery plan;
6. the TLS certificate-chain and hostname verification result.

**This audit did not and must not be read as having produced any of it.** No production
credential was requested, and none was used.

### 2.2 MEDIUM-4 — The development seed creates users with no school membership *(new)*

**Severity: MEDIUM. Status: open. Not a tenant-isolation leak — it fails closed. It makes the
seeded environment unusable.**

`src/app/api/seed/route.ts` creates four `users` rows (`admin@cbism.edu`, `teacher@cbism.edu`,
`parent@cbism.edu`, `learner@cbism.edu`) and a full set of school-owned content — classes,
subjects, departments, `teacher_classes` (L193), `learner_classes` (L199), `parent_learners`
(L207), timetable entries, announcements, FAQs — each stamped with a `schoolId`. It **never
creates a `school_users` row**: the import block (L3–17) does not import `schoolUsers` at all,
and `grep -n "school_users\|schoolUsers" src/app/api/seed/route.ts` returns nothing.

Since migration 0013/0015, the school context of an account comes **only** from `school_users`.
`src/lib/tenant.ts:194` filters the membership list to `status = 'active'` rows whose school is
`status = 'active'`, and `resolveAuthContext` (`src/lib/tenant.ts:350-360`) resolves the school
from that list — a `users.role` value is a platform role, never a school role. A seeded account
with no membership therefore has **no** school context, and every tenant-scoped route rejects it.

**Reproduced locally** (disposable database, real route handler, real login route, real
assignment route — no mocking):

```
migration chain exit: 0
seed route status: 201
seed response: {"success":true,"data":{"message":"Database seeded successfully",
                 "users":{"admin":"admin@cbism.edu","teacher":"teacher@cbism.edu",
                          "parent":"parent@cbism.edu","learner":"learner@cbism.edu"}}}

school_users rows after seed: 0

teacher login status: 200
teacher login school:  null
teacher login schools: []
token issued: true

GET /api/assignments as the seeded teacher -> 403
body: {"success":false,"error":"You do not have an active school membership in an active school"}
```

**Why MEDIUM and not LOW:** the route returns `201 "Database seeded successfully"` and hands
back three demo credentials that cannot open a single tenant-scoped screen. Anyone following the
documented development setup concludes the tenancy model is broken. The direction of failure is
safe (403, not a leak), and the route is `404` in production (`src/app/api/seed/route.ts:33`),
which bounds the blast radius to development and CI fixtures.

**Exact next action (proposed, not applied — see §7):** add the four `school_users` rows in the
same transaction as the user inserts, with `status = 'active'` and the school role matching the
`users.role` the seed already assigns, then extend the seed to be idempotent on re-run. A
regression test belongs in `tests/tenant-integration-regression.test.ts` asserting that a seeded
non-platform account obtains a school context.

### 2.3 MEDIUM-5 — The 26 composite foreign keys do not cover the *user-side* links *(new)*

**Severity: MEDIUM. Status: open, and deliberately **not** fixed here — the remedy is a separate
gated migration, and expanding 0018's scope is out of scope for this audit.**

The 26 composite foreign keys in `src/lib/tenant-constraints.js` reference only **seven** parent
tables:

```
academic_years, assignments, classes, departments, quizzes, subjects, terms
```

`school_users` is **not** among them. The database therefore enforces that a content row
belongs to the same school as its *content* parent, but it does **not** enforce that the
membership-style links point at a user who is actually a member of that school. The
uncovered child columns are:

| child table | uncovered column | would-be parent |
|---|---|---|
| `parent_learners` | `parent_id` | `school_users(school_id, user_id)` |
| `parent_learners` | `learner_id` | `school_users(school_id, user_id)` |
| `learner_classes` | `learner_id` | `school_users(school_id, user_id)` |
| `teacher_classes` | `teacher_id` | `school_users(school_id, user_id)` |
| `classes` | `class_teacher_id` | `school_users(school_id, user_id)` |

**No live cross-tenant path exists today.** Every read that relies on these links joins
`school_users` with `status = 'active'` and the school's lifecycle status — for example
`parentApprovedContentPredicate` (`src/lib/assignment-access.ts:211-238`),
`parentAssignmentListPredicate` (`src/lib/assignment-access.ts:159-184`) and
`learnerEnrollmentPredicate` (`src/lib/assignment-access.ts:194-209`) all join
`school_users` on `school_id` with `status = 'active'` and join `schools` with
`status = 'active'`. Every write path validates the foreign id against the caller's school
before inserting (`isClassInSchool`, `isUserInSchool`, `getLearnerIdsInSchool`), and no route
accepts a `schoolId` from the request body, the query string, or the path — the school is
always `ctx.schoolId`, server-derived.

**Why it is still a MEDIUM:** the product's thesis is that the *database* enforces tenant
ownership, not only the application. A future writer that is not the application — a data
migration, a support script, an admin tool, a restored dump edited by hand — could create a
`parent_learners` row whose `school_id` does not match the parent's membership, and the
database would accept it. The read layer would still refuse to return it, so this is
defence-in-depth, not an exploitable hole. It is also exactly the kind of gap that the
composite-FK work was created to close, so leaving it undocumented would misrepresent the
state of the tenant boundary.

**Exact next action (proposed, not applied — see §7):** raise a **separate** migration
(`0019`) that adds the user-side composite foreign keys to `school_users(school_id, user_id)`.
No new unique index is required: `school_users_school_user_unique` already provides
`UNIQUE (school_id, user_id)`. Like 0018 it must be gated, must pre-flight for offending rows,
and must be applied under its own confirmation token — **not** bundled into 0018 or into any
database-safety PR.

### 2.4 MEDIUM-3 — The 26 missing child-side indexes *(re-measured; still open, still not fixed)*

**Severity: MEDIUM. Status: open, recorded, deliberately not fixed in this audit.**

The gap itself is unchanged and was re-derived independently: **0 of 26** composite foreign
keys have a conforming child-side index — an index whose leading column is `school_id` and
whose second column is the foreign key's own column (or which carries it as an `INCLUDE`
column). What exists on every affected child table is `<table>_school_idx` (on `school_id`
alone) and `<table>_school_id_id_unique` (on `(school_id, id)`) — neither covers the foreign
key's `(school_id, <column>)` pair.

**Re-measured impact.** The audit harness populated a disposable database and ran `EXPLAIN
(ANALYZE, BUFFERS)` on the exact referential-integrity probe PostgreSQL issues when a parent
row is deleted or updated:

```sql
select 1 from only public."<child>" x
 where x.school_id OPERATOR(pg_catalog.=) $1 and x."<col>" OPERATOR(pg_catalog.=) $2
 for key share of x;
```

| scenario | before | after applying the proposed indexes |
|---|---|---|
| **1 school, 20 000 rows/table, 2 000 parents** (the single-school shape this product actually has) | **23 of 26 probes use a sequential scan**; 20 973 buffers; **46.87 ms** total | **0 of 26** sequential scans; 4 639 buffers; **2.38 ms** total |
| 1 school, 20 000 rows/table, 20 parents (≈1 000 children per parent) | 23 of 26 sequential scans; 65 388 buffers; **100.29 ms** total | 3 of 26 (only the 20-row parent tables, where a scan is correct); **25.06 ms** total |
| **20 schools, 2 000 rows/table** (a genuinely multi-tenant shape) | 0 sequential scans; 437 buffers; 1.05 ms | 0 sequential scans; 443 buffers; 0.92 ms |

The honest reading: the gap is a **structural** one, and its runtime cost depends entirely on
the data distribution. With many tenants the existing `(school_id)` index is selective enough
and the probe is already cheap. With **one dominant school** — CBISM's own deployment shape,
and the shape the product is built for — the probe degrades to a sequential scan of the child
table, and the cost grows linearly with the size of that table. The append-heavy tables
(`submissions`, `attendance`, `timetable_entries`, `quiz_attempts`) are the ones that grow
without bound, and they are the ones whose parent `DELETE`/`UPDATE` would scan the whole table
while holding the parent row lock.

**Operational trade-offs, stated honestly:**

* `CREATE INDEX CONCURRENTLY` **cannot run inside the runner's per-file transaction**. An
  index migration therefore needs a **non-transactional path** in `run-migration.js` — a real
  change to the runner's contract, and a new failure mode (a failed CONCURRENTLY build leaves
  an invalid index that must be dropped and rebuilt). It must not be smuggled in as an ordinary
  migration file.
* Each index adds write amplification on `INSERT`/`UPDATE`/`DELETE` of the child table and
  consumes disk. 26 indexes across 14 tables is a modest but non-zero cost.
* `CONCURRENTLY` takes a `SHARE UPDATE EXCLUSIVE` lock (it does **not** block reads or writes),
  but it cannot run inside a transaction block and it takes two table scans.
* Building them changes query plans, so the change must be measured on a restored production
  copy before it is applied to production.

**The proposed statements are recorded, not applied**: `/home/user/proposed-index-migration.sql`
(26 × `CREATE INDEX CONCURRENTLY IF NOT EXISTS "<table>_school_id_<column>_idx" ON public."<table>"
USING btree (school_id, <column>);`). They are **not** in any migration in this repository, and
this report does not claim the performance issue is fixed.

### 2.5 LOW-6 — The seed route authorizes on the token claim, not the database role *(new)*

`src/app/api/seed/route.ts:43` checks `payload.role !== "super_admin"` — the **JWT claim**,
which is signed but can be up to 24 hours stale. `src/lib/tenant.ts:340` deliberately
re-reads `users.role` from the database on every request precisely because a claim can be
stale. The seed route is the one place that still trusts the claim. Impact is bounded: the
route is `404` in production (L33) and is a super-admin-only development tool, so the exposure
is "a demoted platform admin can still seed a development database until the token expires".
Recorded for consistency, not as a security incident.

### 2.6 LOW-7 — `includeInactive` is an unused widening option *(new)*

`src/lib/tenant.ts:189` gives `listSchoolMemberships` an `includeInactive` flag that, when set,
returns disabled memberships and non-active schools. Its own doc comment (L180-182) says it
"never grants tenant context", but **nothing enforces that** — the flag only widens the
*query*. It has **no caller** in the repository (`grep -rn "includeInactive" src/` returns only
the definition and the two comment lines). Dead code that widens access the moment somebody
wires it is worth removing or, at minimum, making the "never grants context" guarantee
structural rather than documentary.

### 2.7 LOW-8 — `src/lib/authorization.ts` is not school-scoped, and is a trap for the next caller *(new)*

The Phase-1 helpers query relationship tables **without a school filter**:

| helper | line | query |
|---|---|---|
| `isParentLinkedToLearner` | `src/lib/authorization.ts:27` | `parent_learners` by `parent_id` + `learner_id` |
| `getParentLinkedLearnerIds` | `src/lib/authorization.ts:36` | `parent_learners` by `parent_id` |
| `getTeacherAccessibleClassIds` | `src/lib/authorization.ts:44` | `teacher_classes` by `teacher_id`; `classes` by `class_teacher_id` |
| `canTeacherAccessClass` | `src/lib/authorization.ts:59` | `teacher_classes` / `classes` by teacher |
| `getTeacherAccessibleLearnerIds` | `src/lib/authorization.ts:86` | `learner_classes` by class id |

**No live cross-tenant path exists today.** Every current caller intersects the helper's
result with an explicit school scope — `src/app/api/attendance/route.ts:90-92` and
`src/app/api/enrollments/route.ts:99-105` intersect with `getLearnerIdsInSchool(ctx.schoolId, …)`,
and the base `attendance.school_id = ctx.schoolId` condition always remains in force. Every
caller also passes the **database-derived** role (`ctx.school.role`), never the token claim
(`src/app/api/attendance/route.ts:51`, `src/app/api/enrollments/route.ts:40`,
`src/app/api/grades/route.ts:33`, `src/app/api/learner/stats/route.ts:14`).

The finding is therefore about the module, not about a leak: a new route that calls
`canTeacherAccessClass` **without** re-intersecting the result with `ctx.schoolId` would be
cross-tenant, and nothing in the module's own documentation warns the author. The underlying
rows are only school-consistent because of MEDIUM-5 (or, after 0018, because of the composite
foreign keys) — not because of this module.

### 2.8 LOW-9 — The incompatible-constraint refusal (F-6) has no test in the repository *(new)*

`drizzle/0018_composite_school_foreign_keys.sql:121` refuses to proceed when a constraint of
the same name already exists with a different definition:

```
0018 found an incompatible constraint named assignments_school_class_fk on public.assignments
```

The behaviour is documented (F-6, this report L944-958 and L1238) but `grep -rn "incompatible"
tests/` returns **nothing** — it is unprotected against regression. This audit exercised it
explicitly (S5a of the failure matrix: exit 1, the constraint and its table named, and **no
ledger row written**), but that harness lives outside the repository.

**A related operational gap, unchanged:** the documented recovery (`--repair-tenant-integrity`
→ baseline → re-apply) **cannot clear** an incompatible same-named constraint, because the
repair is deliberately one-way and never drops a constraint. The operator must remove it by
hand. That is correct behaviour, but the runbook does not say so.

### 2.9 LOW-10 — The "apply a later migration while a gated one is skipped" guard is unreachable *(new)*

`run-migration.js:634-643` refuses to apply a migration that comes *after* a gated migration
that was skipped. With 19 registered migrations and 0018 last, no such pair exists, so the
branch is defensive code that cannot be exercised end to end. It is correct, harmless, and
should be kept — but it is **not** covered by a test, and it must be re-checked whenever a
migration is added after 0018.

### 2.10 A positive finding worth recording — the pre-apply check is not redundant *(new)*

`run-migration.js:601-603` (pre-apply, fail closed) and `run-migration.js:656-663` (post-apply,
verify) call the same `assertTenantConstraintIntegrity`. Mutation **M3** (removing only the
pre-apply call) still produced exit 1 — the post-apply check catches the same state — **but the
runner first printed "✅ All requested migrations are already recorded with matching checksums"**
on a database that enforced no tenant boundary at all. The pre-apply check is therefore not
redundant: it is what prevents a *false success line* from being printed. The regression suite
catches this (M3 killed the test "the runner fails closed when the ledger claims 0018 but the
constraints are gone"). Recorded because a future refactor could reasonably conclude the two
checks are duplicates and delete the wrong one.

---

## 3. Tests run and results

### 3.1 Locally reproduced evidence — disposable PostgreSQL only

| # | Command | Exit | Result |
|---|---|---|---|
| L1 | `NODE_PATH=/home/user/easylearn/node_modules node /home/user/audit-bypass.js` | **0** | **37/37 checks passed** — healthy build (26 composite FKs, all validated; 24/24 unique targets; 19-row ledger) → `drizzle-kit push --force` (exit 0; 0 composite FKs, 7 unique targets, ledger gone — the bypass is real) → runner fails closed → baseline refused with and without both tokens → `db:schema-sync` refused → `--repair-tenant-integrity` (24 targets restored, **no** composite FKs created, false 0018 claim removed) → full documented recovery → 26/26 present, validated and correct, 19-row ledger, "26/26 present, validated and correct", runner exit 0 |
| L2 | `NODE_PATH=/home/user/easylearn/node_modules node /home/user/audit-failures.js` | **0** | **47/47 checks passed** — S1 all 26 dropped · S2 partial 23/26 · S3 NOT VALIDATED · S4 wrong parent · S5 wrong child columns · S5a incompatible-constraint refusal (names the constraint and its table; **no ledger row written**) · S6a baseline without the token · S6b baseline with the token when a ledger exists · S6c baseline including 0018 needs the 0018 token · S6d baseline with **both** tokens still refused when the catalog lacks the constraints (no ledger row added) · S6e non-sequential prefix · S7 an ordinary run skips the gated migration, says so loudly, and applies nothing |
| L3 | `NODE_PATH=/home/user/easylearn/node_modules node /home/user/index-gap-analysis.js` | **0** | 0 of 26 composite FKs have a conforming child-side index; the 26 proposed `CREATE INDEX CONCURRENTLY` statements written to `/home/user/proposed-index-migration.sql` (**not applied to any migration**) |
| L4 | `SCHOOLS=1 PARENTS=2000 ROWS=20000 NODE_PATH=… node /home/user/index-impact.js` | **0** | RI-probe plans before/after — 23/26 sequential scans → 0/26; 20 973 → 4 639 buffers; 46.87 → 2.38 ms |
| L5 | `NODE_PATH=… node /home/user/index-impact.js` (20 schools, 2 000 rows) | **0** | 0/26 sequential scans before and after; 437 → 443 buffers; 1.05 → 0.92 ms — the honest multi-tenant counter-case |
| L6 | `TEST_DATABASE_URL=… EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true npx tsx tests/migration-tenant-constraint-integrity.test.ts` | **0** | **20 passed, 0 failed** |
| L7 | the seed-route probe (real seed handler → real login handler → real `GET /api/assignments`) | **0** | seed 201, `school_users` = 0, teacher login 200 with `school: null`, `GET /api/assignments` → **403** — the evidence for MEDIUM-4 |
| L8 | `bash /home/user/run-ci-audit.sh` (exact replication of `.github/workflows/ci.yml`) | **0** | **13/13 steps exit 0** — see §3.3 |

### 3.2 Mutation testing — is the regression suite actually meaningful?

Each safeguard was **removed**, the suite was re-run, the code was **restored**, and the
restoration was verified byte-for-byte with `sha256sum` plus a clean `git status`.

| # | Safeguard removed | Location | Tests killed | Suite exit |
|---|---|---|---|---|
| M1 | the post-apply verification of the 26 constraints | `run-migration.js:656-663` | **2** — "applying 0018 under its gate installs all 26 constraints and records it"; "a healthy database re-runs cleanly and verifies its constraints" | 1 |
| M2 | the baseline's catalog check (the check that stops a baseline certifying a schema without the constraints) | `run-migration.js:317` | **2** — "baseline refuses to record 0018 on a database without its constraints"; "baseline can still record a verified prefix that stops before 0018" | 1 |
| M3 | the pre-apply fail-closed check | `run-migration.js:601-603` | **1** — "the runner fails closed when the ledger claims 0018 but the constraints are gone" (it failed because the runner printed the false success line first) | 1 |
| M4 | the guarded schema sync's refusal to run push on a managed database | `db-schema-sync.js:140` | **1** — "the guarded schema sync refuses to run drizzle-kit push on a managed database" | 1 |
| M5 | the 0018 gate's confirmation-token check | `run-migration.js:622` | **2** — "an explicit run without the confirmation token is still refused"; "the repair restores the 0017 unique targets and clears the false ledger claim" | 1 |

**5 of 5 mutations were detected.** No mutation survived. The suite is not vacuous.

**Restoration proof.** After the last mutation the files were restored with
`git checkout -- run-migration.js db-schema-sync.js`; the digests returned to their pre-mutation
values (`run-migration.js` → `e05208c0436c5c56ebad8ce1ede36ff246bba7a337aace9b8471ea8c1d814604`,
`db-schema-sync.js` → `f23784eedb85f840836cd82f48c3c80892d3a909162502c519bc94de491a76d7`), `git
status --porcelain` was empty, and the suite was re-run green: **20 passed, 0 failed, exit 0**.

### 3.3 Local CI replication — exact commands and exit codes

`bash /home/user/run-ci-audit.sh`, with the workflow's own environment:
`TEST_DATABASE_URL=postgres://easylearn_test:easylearn_test@127.0.0.1:5432/postgres`,
`DATABASE_URL=postgres://test:test@127.0.0.1:1/testdb` (a deliberately dead endpoint, as in
CI), `JWT_SECRET=ci-only-not-a-production-secret-at-least-32-characters`.

| Step | Command | Exit | Duration |
|---|---|---|---|
| 01 | `npm ci` | **0** | 18 s |
| 02 | `npm audit --omit=dev` | **0** | 0 s |
| 03 | `test -n "$TEST_DATABASE_URL"` | **0** | 0 s |
| 04 | `npm test` | **0** | 2 s |
| 05 | `EASY_LEARN_REQUIRE_TLS_E2E=true npm run test:tls-e2e` | **0** | 1 s |
| 06 | `EASY_LEARN_REQUIRE_ASSIGNMENT_PREREQ=true EASY_LEARN_REQUIRE_SCRATCH_DB_LIFECYCLE=true npm run test:db` | **0** | 33 s |
| 07 | `npm run test:tenant-auth` | **0** | 9 s |
| 08 | `npm run test:mutation` | **0** | 21 s |
| 09 | `npm run test:integration` | **0** | 1 s |
| 10 | `EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true npm run test:tenant-integrity` | **0** | 10 s |
| 11 | `npm run typecheck` | **0** | 13 s |
| 12 | `npm run build` | **0** | 26 s |
| 13 | `npm run lint` | **0** | 17 s |

**501 PASS lines, 0 test failures.** The only two lines containing the string "FAIL" are test
*names* — "the learner role predicate FAILS CLOSED on a pre-0016 schema (no row, no leak)" and
"the parent role predicate FAILS CLOSED on a pre-0016 schema (no row, no leak)" — both
**passing** assertions. The TLS end-to-end suite really executed against the SSL-enabled
disposable server (7 end-to-end and 11 TLS assertions passed); `EASY_LEARN_REQUIRE_TLS_E2E=true`
would have turned a skip into a failure. **Zero scratch databases were left behind** (the
suite's own `finally` blocks dropped them).

One artefact was produced and reverted: `next build` regenerates `next-env.d.ts`. It was
restored with `git checkout -- next-env.d.ts`; the worktree is clean.

### 3.4 Evidence *not* produced by this audit — stated explicitly

* **No production database was contacted.** Not read, not written, not even connected to.
* **No production credential was requested or used.** The disposable server uses local-only
  credentials created for this audit.
* **Migration 0018 was not applied to any managed database.** It was applied only to disposable
  databases, and only under its confirmation token, exactly as the gate requires.
* **The proposed 26 child-side indexes were applied nowhere but a disposable measurement
  database.** They are not in any migration in this repository.
* **Branch protection on `main` remains UNKNOWN** (API `403`).
* **The `9da7333…` commit is not in `main`'s history** and was not reviewed as part of the
  merged state.
* **No independent human reviewer has looked at any of this.** This audit was performed by the
  same agent that wrote the remediation. It is *not* an independent review and must not be
  presented as one.

### 3.5 GitHub CI evidence (distinct from the local reproduction above)

| Run | Head SHA | Conclusion |
|---|---|---|
| `39176807988` | `016d2291` | success |
| `39176617079` | `851156ca` | success |
| `39173649856` | `90ec0436` (the PR #32 merge) | success |

These are GitHub's own verdicts. The local replication in §3.3 is an independent execution of
the same workflow on the same commit, and the two agree. The CI job **logs** are not fetchable
from this environment, so the per-step detail above is the *local* reproduction, not the content
of the GitHub runs.

---

## 4. Remaining blockers

| ID | Severity | Finding | Closable by code? |
|---|---|---|---|
| **BLOCKER-1** | BLOCKER | Production preflight evidence is absent (engine/version, migration history, offending-row counts, confirmation that nothing was reassigned, backup/restore verification, lock/duration measurement, TLS chain verification). | **No** — operator evidence on a restored production copy |
| **MEDIUM-4** | MEDIUM | The development seed creates no `school_users` rows, so the three demo accounts it advertises have no tenant access (reproduced: 403). | Yes |
| **MEDIUM-5** | MEDIUM | The 26 composite foreign keys do not cover the user-side links (`parent_learners.parent_id`/`learner_id`, `learner_classes.learner_id`, `teacher_classes.teacher_id`, `classes.class_teacher_id` → `school_users(school_id, user_id)`). | Yes — as a **separate, gated** migration |
| **MEDIUM-3** | MEDIUM | 26 of 26 composite foreign keys have no conforming child-side index; measured 23/26 sequential scans in the single-school shape (46.87 ms → 2.38 ms with the proposed indexes). | Yes — as a **separate, non-transactional** migration |
| **LOW-6** | LOW | The seed route authorizes on the token claim instead of the database role. | Yes |
| **LOW-7** | LOW | `includeInactive` is an unused widening option with no enforcement behind its "never grants context" promise. | Yes |
| **LOW-8** | LOW | `src/lib/authorization.ts` is not school-scoped; safe today only because every caller re-intersects with the school scope. | Yes |
| **LOW-9** | LOW | The incompatible-constraint refusal (F-6) has no test in the repository, and the runbook does not say the operator must drop such a constraint by hand. | Yes |
| **LOW-10** | LOW | The "apply a later migration while a gated one is skipped" ordering guard is unreachable and untested. | Yes (test only) |

**Already closed and not re-opened here:** HIGH-1 (the inert regression guard), MEDIUM-1 (the
suite could silently skip in CI), MEDIUM-2 (the inaccurate pre-0016 support claim), LOW-1
(ungrammatical operator message), LOW-2 (the submit route used the non-schema-aware predicate),
LOW-3 (the policy mirror granted a rule no route implements — the mirror now states ownership
only, matching `eq(assignments.teacherId, context.userId)`), LOW-5 (scratch databases left
behind — now always removed, verified in §3.3).

**Not findings, restated so they are not mistaken for ones:** CSRF protection, session
revocation and row-level security are absent from the codebase. They were out of scope for
PR #32, no change here weakens them, and no claim is made that they are addressed.

---

## 5. Exact next action for each blocker

**BLOCKER-1 — production preflight evidence.**
1. An authorized operator restores a **production copy** to an isolated host (never production
   itself) and confirms the copy is byte-identical.
2. The operator runs `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` against the copy and
   returns the output, including the offending-row counts and the explicit statement that no
   row was reassigned or repaired.
3. The operator measures the validation duration and captures `pg_locks` during it.
4. The operator verifies backup/restore and the TLS certificate chain.
5. Only then, and only under the 0018 gate, is 0018 applied to production.
6. **This audit cannot advance this blocker, and no agent should be asked to close it.** The
   account must not be a production credential, and no production setting may be changed.

**MEDIUM-4 — the seed's missing memberships.**
1. Insert the four `school_users` rows (`status = 'active'`, roles `school_admin`/`teacher`/
   `parent`/`learner` for the CBISM school) in the same transaction as the user inserts in
   `src/app/api/seed/route.ts`.
2. Make the seed idempotent on re-run (it currently returns early only when `users` is
   non-empty — L48-51).
3. Add a regression test asserting a seeded non-platform account obtains a school context and
   can list assignments.
4. Keep it in its own small PR; it is unrelated to database safety.

**MEDIUM-5 — the user-side composite foreign keys.**
1. Open a **separate** issue/PR for a `0019` migration; do **not** amend 0018.
2. Pre-flight on a restored production copy: count `parent_learners`, `learner_classes`,
   `teacher_classes` and `classes.class_teacher_id` rows whose `(school_id, user_id)` pair has
   no matching `school_users` row. Those rows are exactly what the constraint would reject.
3. Decide, with the operator, whether to remediate or to quarantine those rows — this is a
   **data** decision and must never be auto-repaired.
4. Add the constraint `NOT VALID` + `VALIDATE CONSTRAINT` under its own gate and its own
   confirmation token, exactly as 0018 does.
5. No new unique index is needed (`school_users_school_user_unique` already exists).

**MEDIUM-3 — the 26 child-side indexes.**
1. Add a **non-transactional** path to `run-migration.js` for `CREATE INDEX CONCURRENTLY`,
   with an explicit "this cannot run inside the per-file transaction" contract and a documented
   recovery for a failed build (drop the invalid index, rebuild).
2. Keep the 26 statements in `/home/user/proposed-index-migration.sql` as the starting point;
   review the index names and sizes.
3. Measure the write amplification and the storage cost on the restored production copy.
4. Apply them in a **separate PR**, never bundled with a database-safety change, and measure
   the query plans before and after on the copy.
5. Until then, the performance issue is **not** fixed, and this report does not claim it is.

**LOW-6 / LOW-7 / LOW-8 / LOW-9 / LOW-10.** All are small, independent, and can go into one
low-risk maintenance PR:
1. **LOW-6** — read `users.role` from the database in the seed route instead of the token claim.
2. **LOW-7** — remove `includeInactive`, or make "never grants tenant context" structural.
3. **LOW-8** — add a header warning to `src/lib/authorization.ts` that every caller **must**
   intersect the result with `ctx.schoolId`, and cite the four call sites that do.
4. **LOW-9** — add a repository test for the incompatible-constraint refusal, and add one line
   to `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md` §4.1 stating that such a constraint must
   be dropped by hand.
5. **LOW-10** — add a unit-level test for the ordering guard so it is not silently deleted when
   a migration is added after 0018.

---

## 6. Final verdict

**READY FOR FURTHER REVIEW.**

The schema-sync bypass remediation that PR #32 merged is **sound in the code**. This audit
re-derived every material claim by execution rather than by reading: the destructive scenario
was reproduced on a disposable database, the failure modes were exercised as a 47-check matrix,
the documented recovery was executed end to end, and the regression suite was mutation-tested
(5 of 5 safeguards removed, 5 of 5 detected, all restored byte-for-byte). The whole CI workflow
was replicated locally: **13 of 13 steps exit 0, 501 passing assertions, zero scratch databases
left behind.** No cross-tenant defect was found in the tenant-isolation, school-selection,
lifecycle, role-authorization, or answer-key protections: the school context is always
server-derived and revalidated against the database, the answer key is absent from the learner's
and parent's projection by construction, lifecycle and membership states fail closed, and every
write path validates the foreign id against the caller's school.

The findings this audit adds are **MEDIUM-4** (the development seed creates no memberships, so
the demo accounts it advertises get 403 — reproduced), **MEDIUM-5** (the 26 composite foreign
keys do not cover the user-side links to `school_users`, a defence-in-depth gap with no live
exploit), and the re-measured **MEDIUM-3** (26 of 26 child-side indexes missing; 23 of 26
referential-integrity probes degrade to a sequential scan in the single-school shape this product
actually has). None of the three is a tenant-isolation leak, and none of them may be fixed by
quietly widening 0018's scope: MEDIUM-5 and MEDIUM-3 each need their own, separately gated
migration.

**This is NOT a production-readiness statement, and it must not be read as one.**
`BLOCKER-1` is open and cannot be closed by any code change: the production preflight evidence
does not exist, and until an authorized operator produces it against a restored production copy,
**0018 must not be applied to production**. This audit performed no independent human review,
none of its work may be represented as one, and the branch-protection state of `main` could not
be read (API `403`) and remains UNKNOWN.

**Stop here. Do not merge, deploy, or apply 0018 on the strength of this report.**

---

# Appendix A — Remediation status (2026-10-19)

This appendix records what was changed **after** the audit above, on the branch
`arena/7d4511bc-easylearn`. The audit text above is unchanged: it is the evidence, and it
must not be edited to match the code. Everything below is a separate, later statement.

Nothing here is a production-readiness statement. `BLOCKER-1` is still open, 0018 is still
refused for production, and no production system, credential, setting or branch-protection
rule was touched.

## A.1 What was implemented, and the evidence for each

| ID | Status | Change | Evidence |
|---|---|---|---|
| MEDIUM-4 | **IMPLEMENTED** | `src/app/api/seed/route.ts` now creates the `school_users` rows for the teacher, parent and learner demo accounts. The platform `super_admin` deliberately gets **none** (`super_admin` is a platform role; migration 0015 excludes it; `resolveAuthContext` never grants a platform account a school context). The rows are written through `addSchoolMembership()` in `src/lib/tenant.ts`, the one module that owns `school_users` — a route must not touch the membership table itself, and the tenant-foundation boundary test now enforces that for this route too. | `tests/seed-membership.test.ts` — **7 assertions, 0 failures, exit 0**. The suite proves the three memberships exist with the right roles and `status = 'active'`, that the platform administrator has none, that the three demo logins return a real school context, that a tenant-scoped API is reachable, and that the role is read from the database and not from the token claim. Mutation-tested twice: removing the membership write fails **3** of the 7; restoring the claim-based authorisation fails **1**. The source was restored byte-for-byte after each mutation. |
| LOW-6 | **IMPLEMENTED** | The seed route now re-reads the caller's role **from the database** (`findAuthUser` + `isActive` + `role === 'super_admin'`) whenever the database is populated, because a signed claim can be up to 24 hours stale. The **empty-database bootstrap** case still trusts the signed claim: there is no account to read, and the only administrator the route creates is the one it is about to insert. That exception is stated in the code at the branch it applies to. | Same suite — the "role is not taken from the claim" assertion fails if the claim-trust is restored, and the "a real super_admin is still allowed" assertion fails if the database check is made too strict. |
| LOW-7 | **IMPLEMENTED (corrected — see A.2)** | The public `includeInactive` option is **gone**. `listSchoolMemberships(userId)` now takes no options and returns only active memberships in active schools. The widening read is a separate, explicitly-named export, `listAllSchoolMembershipsForInspection(userId)`, and it is still scoped to one user — a membership is never looked up by school alone. | `tests/membership-foundation.test.js` — **37 assertions, 0 failures, exit 0**, including two new guards: the active read must take no options and no membership read may offer a widening switch; every membership read, the inspection one included, must start its WHERE clause from the caller's own user id. Mutation-tested: re-adding the option fails the new guard (**1** failure, exit 1); the source was restored byte-for-byte. |
| LOW-8 | **IMPLEMENTED** | `src/lib/authorization.ts` now carries a header warning: the Phase 1 helpers filter a relationship table by a **person or a class**, never by a school, so a new caller that uses one of them without re-intersecting the result with the caller's own school would be cross-tenant. The four current call sites are named in the header, with the intersection each of them performs. | Source-level. The existing boundary test `Boundary: no tenant filtering added to authorization helpers` still passes, and still enforces that the helpers themselves stay tenant-free — the warning adds no filter and no school parameter. |
| LOW-9 | **IMPLEMENTED** | (a) The F-6 refusal — "0018 found an incompatible constraint named … on public.…" — now has repository coverage: the test replaces `assignments_school_class_fk` with an incompatible `(school_id, subject_id)` foreign key, proves the repair clears the false 0018 claim, proves 0018 then **refuses** and writes **no** ledger row, drops the constraint by hand, and proves 0018 then applies and reaches 26/26. (b) `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md` §4.1 now tells the operator to read the constraint's definition first and drop it **by hand**, with the exact read-only inspection query, and states plainly that the automated repair will not drop it. | `tests/migration-tenant-constraint-integrity.test.ts` — **24 assertions, 0 failures, exit 0** (was 20 before this phase). |
| LOW-10 | **IMPLEMENTED** | The unreachable "apply a migration after a skipped gated migration" guard is now a **pure, exported** function, `findOrderingViolation(toApply, skippedGated, orderedList)`, which the run loop calls. The order list is a parameter so the case can be exercised at all: with the real 19-file list, 0018 is last and nothing can follow it. | The same suite, now **24 assertions**. The new test proves: no violation for an empty apply list, no violation when no gate was skipped, no violation when the gated migration itself is applied, and a violation — naming both the blocked and the skipped migration — when a migration registered after the gate is applied while the gate is skipped. The suite also records the fact that 0018 is currently last, so the guard is defensive code. |

## A.2 Two corrections to the audit above

**1. LOW-7 was described as an "unused widening option". That was wrong.** The audit's
grep covered `src/` only. `includeInactive: true` was used by **two** call sites in
`tests/membership-auth-db.test.ts` (lines 462 and 757), which need to see a *historical*
membership to assert that a revoked, disabled or archived membership really is absent from
the active set. The remediation therefore did not delete the capability: it removed the
**public switch** and gave the widening read its own explicitly-named export, and the two
test call sites were updated. The hazard the finding described — a public boolean whose
safety rested on a doc comment — is gone either way, but the audit understated the blast
radius, and a reviewer reading only the audit would have been misled.

**2. The audit's independent harnesses lived outside the repository.** `audit-bypass.js`
(37 checks), `audit-failures.js` (47 checks), `index-gap-analysis.js`, `index-impact.js`,
`proposed-index-migration.sql` and `run-ci-audit.sh` were written to the sandbox home
directory, **not** into the repository. A reviewer could not re-run them from a clone, and
their results are not reproducible from the commit that cites them. That is a real weakness
in the evidence, and it is recorded here rather than glossed over.

The sandbox that hosted them was reset during the remediation phase and they are **gone**;
their results could therefore **not** be re-verified here and are not restated as if they
had been. What was done instead is to move the coverage they provided **into the
repository**, where it was actually missing:

* the "both confirmation tokens present and the catalog still lacks the constraints" case —
  the strongest form of the false-certification guard — was **not** covered and is now a
  test in `tests/migration-tenant-constraint-integrity.test.ts`;
* the **complete documented recovery** of §4.1 (damage → `--repair-tenant-integrity` →
  `--baseline` of the verified prefix → re-apply 0018 under its gate → the ordinary run
  verifies 26/26) had **no** end-to-end coverage — the repair test re-applied 0018
  directly, and the baseline test ran on a database whose ledger had never been destroyed —
  and is now a test as well;
* the ordering guard (LOW-10) is now exercised directly instead of being reasoned about;
* the CI-replication script was re-created and re-run (A.3).

The harnesses themselves are still outside the repository. **Proposed, not implemented:**
committing them under `tests/` or `scripts/`. They duplicate coverage the repository now
has, and adding them is a separate decision with its own review.

## A.3 Verification actually performed for this appendix

All of it on a **disposable PostgreSQL 16.14** on `127.0.0.1:5432` with TLS enabled
(`bash /home/user/setup-audit-pg.sh` recreates it from scratch). No production system,
credential, setting or branch-protection rule was touched.

| Suite | Result |
|---|---|
| `tests/seed-membership.test.ts` | **7 passed, 0 failed, exit 0** |
| `tests/migration-tenant-constraint-integrity.test.ts` | **24 passed, 0 failed, exit 0** |
| `tests/membership-auth-db.test.ts` | **48 passed, 0 failed, exit 0** |
| `tests/tenant-authorization-mutation.test.ts` | **7 passed, 0 failed, exit 0** |
| `tests/membership-foundation.test.js` | **37 passed, 0 failed, exit 0** |
| `npm test` (4 source-security suites) | **28 / 15 / 23 / 35 passed, 0 failed** |
| `npm run typecheck` | **exit 0** |
| Local replication of the CI workflow (13 steps) | **13 of 13 exit 0** |

Mutation evidence: the seed membership write removed → **3** seed assertions fail; the
claim-based authorisation restored → **1** seed assertion fails; the public
`includeInactive` option restored → **1** membership-foundation assertion fails. In each
case the source was restored byte-for-byte afterwards.

## A.4 Deliberately NOT changed, and why

* **MEDIUM-5** (the 26 composite foreign keys cover no *user-side* link to
  `school_users(school_id, user_id)`) — a new gated migration `0019` is required. **No
  migration was created, no schema was altered, and no CI gate was weakened.**
* **MEDIUM-3** (the 26 child-side `CREATE INDEX CONCURRENTLY` indexes) — a separate PR with
  its own non-transactional path. **Not implemented.** The measurement in §2.4 stands; the
  performance issue is **not** fixed.
* **`BLOCKER-1`** — the production preflight evidence does not exist. It cannot be closed
  by any code change, and no code in this phase changes that. **0018 must not be applied to
  production.**
* **Branch protection on `main`** — the read-only API call returns `403`; the state remains
  **UNKNOWN** and was not modified.
* **The seed route is still not transactional.** A failure part-way through the seed would
  leave a partially seeded database, which is the same shape MEDIUM-4 describes. Making the
  whole seed atomic is a larger refactor than this phase's scope, and it is **proposed
  here rather than silently made**. The membership write is the one place this phase
  introduced a new failure point, and it fails loudly with a 500 rather than silently
  leaving the demo accounts without a school.

## A.5 Status of the audit's own blocking items

| Item | Status |
|---|---|
| `BLOCKER-1` — production preflight evidence | **BLOCKED** (no authorized operator checkpoint against a restored production copy) |
| 0018 applied to production | **BLOCKED** |
| Restored-production-copy rehearsal | **BLOCKED** |
| Branch-protection confirmation on `main` | **BLOCKED** (API `403`, state UNKNOWN) |
| `0019` user-side FK migration | **PROPOSED ONLY** |
| 26 child-side indexes | **PROPOSED ONLY** |
| Independent human review of the tenant and migration work | **NOT PERFORMED** — this work is not an independent review and must not be represented as one |
