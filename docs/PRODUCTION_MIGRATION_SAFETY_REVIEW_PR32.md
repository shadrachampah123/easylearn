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

#### MEDIUM-2 — The "works on a pre-0016 database" claim is not true for the assignment routes *(NOT fixed — needs a decision)*

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

#### LOW-2 — The assignment submit route is the only one using the non-schema-aware predicate

`src/app/api/assignments/[id]/submit/route.ts:19,56` uses the synchronous
`assignmentAccessPredicate`, while every sibling route uses the asynchronous
`resolveAssignmentAccessPredicate`. On a fully migrated (0016+) database the two produce
equivalent isolation, and on a pre-0016 database **both** fail (see MEDIUM-2), so there is no
practical divergence today. It is an inconsistency that will become one if the fallback is
ever made genuinely 0013-compatible.

#### LOW-3 — The policy mirror documents a teacher-access rule no route implements

`src/lib/assignment-policy.ts:22,35` grants a teacher `manage-full` on
`explicitlyAuthorized: true`, and `tests/assignment-authorization.test.ts:24` asserts it.
There is **no co-teacher concept anywhere in the schema** (`co_teacher` / `coTeacher` /
`co-teacher`: 0 hits) and **no route ever passes `explicitlyAuthorized`**. The SQL predicate
implements ownership only (`eq(assignments.teacherId, context.userId)`,
`src/lib/assignment-access.ts:29`). The divergence is in the safe direction (SQL is stricter
than the mirror), but a reviewer reading the mirror would conclude a co-teacher is supported
when such a teacher is in fact denied.

#### LOW-4 — The relational "reachable schools" helpers do not check the school lifecycle

`sqlUserInSchool`, `sqlUserRoleInSchool`, `sqlUserHasRoleInSchool` and `sqlSchoolsOfUser`
(`src/lib/tenant.ts:625-673`) all join `schools` and require `s."status" = 'active'`. The
content-ownership helpers — `sqlSchoolsOfClass` (`:677`), `sqlSchoolsOfTeacherClass`,
`sqlSchoolsOfLearnerClass`, `sqlSchoolsOfAssignment`, `sqlSchoolsOfQuiz`
(`src/lib/tenant.ts:677-800`) — check only `su."status" = 'active'` and never the school's
lifecycle status.

**Not exploitable, and here is why.** These helpers feed `sqlOwnedBySchool`
(`src/lib/tenant.ts:803-810`), which requires the row to be reachable from **exactly** the
requested school: `exists(school_id = schoolId) and not exists(school_id <> schoolId)`. A
larger reachable set can only ever make that check *stricter*. And the requested `schoolId`
can only ever be an active school, because `resolveAuthContext` → `listActiveSchoolMemberships`
(`src/lib/tenant.ts:187-201`) filters on both `school_users.status = 'active'` **and**
`schools.status = 'active'`, and `selectSchoolForContext` (`:403-417`) can only choose from
that filtered list. It is a defence-in-depth inconsistency, not a tenant-isolation hole.

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
| **BLOCKER-2** | **BLOCKER** | PR #32 has **no independent review** of this remediation. | A second reviewer checks §"Findings and evidence" above, the two commits `9da7333` and `69a6e5b`, and the mutation matrix, and records a review. Only then may the draft status be reconsidered. | reviewer |
| **MEDIUM-2** | MEDIUM | The "works on a pre-0016 database" claim in `src/lib/assignment-access.ts:60,78-82`, `src/app/api/assignments/route.ts:40` and `docs/PR30_PR31_INTEGRATION_RESOLUTION.md:46` is false for the assignment routes. | Decide **(a)** correct the three comments and the resolution log to state that the schema-aware scope covers the school-scope half only and that the learner/parent role predicates require migration 0016, or **(b)** implement a genuinely 0013/0015-compatible role predicate. Either way it is a documentation-vs-code decision the reviewer must make. | reviewer + author |
| **MEDIUM-3** | MEDIUM | 0 of 26 composite tenant foreign keys has a supporting child-side index (F-22). | Raise a **separate** migration (e.g. `0019_child_side_indexes.sql`) with its own gate, checkpoint block and rehearsal. Decide `CREATE INDEX CONCURRENTLY` (needs a runner change: it cannot run inside the runner's `BEGIN`/`COMMIT`) vs. transactional, and decide before/after 0018. **Do not fold it into this branch.** | author, separate PR |
| **HIGH-1** | HIGH → **FIXED** | The push-recommendation guard was inert. | **Closed** in `69a6e5b`: escape-normalised matching plus a per-line explicit-prohibition assertion. Re-introduction now fails the suite (19/1, exit 1). | — |
| **MEDIUM-1** | MEDIUM → **FIXED** | The suite could skip in CI with exit 0. | **Closed** in `69a6e5b`: `EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true` turns a skip into exit 1, and CI sets it. | — |
| **LOW-1** | LOW | Ungrammatical operator error message. | Change the template in `src/lib/tenant-constraints.js` to `… is ${row.problem}` → `… ${row.problem}` for the "references the wrong parent table" case (or reword the SQL problem values). One-line change; can be folded into the next commit that touches that file. | author |
| **LOW-2** | LOW | The submit route uses the non-schema-aware predicate. | Switch `src/app/api/assignments/[id]/submit/route.ts:19,56` to `resolveAssignmentAccessPredicate` for consistency. No behavioural change on a migrated database. | author |
| **LOW-3** | LOW | The policy mirror grants a rule no route implements. | Either remove `explicitlyAuthorized` from `src/lib/assignment-policy.ts` and the corresponding assertion in `tests/assignment-authorization.test.ts:24`, or state in the file that it is a reserved future rule. | author |
| **LOW-4** | LOW | The relational "reachable schools" helpers do not check the school lifecycle. | Add `join schools s on s.id = … and s.status = 'active'` to `sqlSchoolsOfClass` and the other `sqlSchoolsOf*` helpers for defence in depth. Not exploitable today (see the finding). | author |
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
* **BLOCKER-2** — this remediation has had no independent human review yet.
* **MEDIUM-2** — one documented support guarantee is inaccurate and needs a reviewer decision.
* **MEDIUM-3** — the child-side index gap is real and measured, and its remediation is a
  separate migration with its own gate and preflight.

This re-audit changed only the regression suite and the CI wiring (`69a6e5b`). It did not
change the migration, the runner, the schema, the application authorization code, the
production environment, or PR #32's draft status, and it did not merge anything.

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
