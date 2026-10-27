# Production schema recovery plan — for owner approval (NO production change made)

Status: **PREPARED, NOT EXECUTED.** Nothing in this document authorizes a
production write. Execution requires the owner's explicit approval of the
exact steps below, a verified backup, and the preflight evidence in §4.
Prepared 2026-10-27 from `main` @ `4134d23` plus the disposable rehearsal in
`tests/production-drift-remediation-rehearsal.test.ts`.

## 1. Observed production state (read-only, reported in PR #64)

From the read-only Neon catalog checks documented in
`SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md` (project `easylearn`,
branch `production`, database `neondb`, PostgreSQL 18.6):

| Object | Production | Expected by current source |
|---|---|---|
| `public.users.session_version` | **absent** | present (0019) |
| `public.easylearn_schema_migrations` | **absent** | present once the runner is used |
| 0018 composite tenant FKs | **0 / 26** | 26, validated |
| 0017 `UNIQUE (school_id, id)` targets | 24 / 24, valid + ready | 24 |
| `schools` table + `school_id` columns | present (26 columns) | present |
| 0013/0016/0017 effects | present | present |

These were **not re-verified by the agent**: no Neon/production credentials
exist in the agent environment. Step P0 below re-confirms them before any
decision.

## 2. Root-cause analysis (evidence-ranked, no cause claimed)

**H1 — migrations were applied outside `run-migration.js`; gated 0018 and
0019 were simply never run. (Best fit; requires no destructive event.)**
0013/0016/0017 effects exist, so *some* mechanism applied them, but the
ledger the runner always creates is absent — so it was not the runner (or
not only the runner). 0018 is gated by design (`CONFIRM_MIGRATION_0018` +
preflight), so its absence is the expected default state, not damage.
0019 is the newest migration. H1 explains every observation.

**H2 — `drizzle-kit push` damaged production. (Not supported as the sole
explanation.)** The repository proves `push` drops all 26 composite FKs,
the ledger, **and 17 of the 24** `UNIQUE (school_id, id)` targets
(`tests/migration-tenant-constraint-integrity.test.ts`). Production still
has 24/24 targets, which contradicts a post-0017 push unless a repair
already restored them. A push *before* 0017 followed by manual application
of 0017 cannot be excluded, but there is no evidence for it. **Do not
state H2 as the cause.**

**H3 — runtime lazy repair should already have added `session_version`.
(Narrowed by evidence 2026-10-27; final resolution needs one owner
check.)** GitHub's deployment record shows production runs current
`main` (`4134d23`, deployed 2026-10-27T18:02:46Z), so "old code
deployed" is refuted, and code inspection shows the repair path has
no silent skip (probe → idempotent DDL → re-probe; `verifyToken`
fails closed with 503 if still unavailable). Exactly three
possibilities remain: (1) the runtime `DATABASE_URL` targets a
different Neon branch/database than the inspected one (repair
already succeeded there); (2) `AUTO_SCHEMA_REPAIR=false` or the
runtime role cannot ALTER — in which case **every authenticated
request currently fails closed**; (3) no authenticated request has
occurred since deployment. `docs/PRODUCTION_PREFLIGHT_0019_0018.md`
§2 resolves which in ~5 minutes via the read-only `/api/health`
probe plus one login. **Do not start P2 until H3 is resolved** —
under possibility (1) the drift may not exist in the runtime
database at all.

Missing ledger ≠ proof migrations were not applied; equally, present
schema objects ≠ proof of *how* they got there. The plan therefore treats
the catalog (not history claims) as the source of truth.

## 3. Rehearsal evidence (disposable, executed 2026-10-27)

`tests/production-drift-remediation-rehearsal.test.ts` rebuilds the exact
observed drift shape on a throwaway PostgreSQL (0000..0017 applied as raw
SQL, no ledger, no 0018/0019) and runs the proposed remediation:

1. Plain `node run-migration.js` **refuses** (existing tables, no ledger).
2. `--baseline` without `CONFIRM_MIGRATION_BASELINE` **refuses**.
3. Baseline of the verified prefix `0000..0017` records 18 checksummed
   ledger rows, executes no SQL.
4. Ordinary run applies **only 0019** (`session_version` appears) and
   loudly skips gated 0018.
5. With a seeded cross-school mismatch, gated 0018 **aborts atomically**
   (0 FKs installed, ledger untouched).
6. After removing the offending row *in the rehearsal only*, gated 0018
   installs + validates **26/26** FKs; a cross-school insert is then
   rejected by the database itself.
7. Final ordinary run is idempotent and verifies ledger-vs-catalog
   integrity. **Result: 9/9 passed** (plus the pre-existing integrity
   suite, 24/24, which reproduces the `drizzle-kit push` damage and its
   repair on disposable databases).

Locking: 0018 uses `ADD CONSTRAINT … NOT VALID` (`SHARE ROW EXCLUSIVE`)
then `VALIDATE CONSTRAINT` (`SHARE UPDATE EXCLUSIVE`) — no table rewrite,
reads/writes continue (see the lock rehearsal in
`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md`). Duration scales with
child-table size; it **must be timed on a restored copy** before a
production window is sized.

## 4. Proposed production procedure (only after approval)

**P0 — Re-verify (read-only, owner/DBA).** Run the full checkpoint in
`docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` against production
**and a restored copy**; record: deployed commit SHA (Vercel), whether
authenticated flows work today, `AUTO_SCHEMA_REPAIR` value (name only,
never the DB credentials), all 26 mismatch counts (must be 0), NULL
`school_id` counts (must be 0), ledger presence, unique-target count.
**Stop conditions:** any nonzero mismatch/NULL count, unverifiable
backup, or unexplained deployment/auth state → stop, investigate, no
writes. Mismatched rows are never silently reassigned or deleted.

**P1 — Backup evidence.** Create/verify a Neon branch or snapshot of
`production` immediately before the window; record its ID and confirm it
appears in the console. Test-restore it to a scratch branch and run the
entire §3 sequence there first (this is the rehearsal that sizes the
window and proves rollback).

**P2 — Baseline (first write, low risk).** On production, in the window,
generate the exact 18-file verified prefix from the runner itself (no
hand-typed list) and baseline it:
`PREFIX=$(node -e "const {MIGRATIONS}=require('./run-migration.js');console.log(MIGRATIONS.slice(0,MIGRATIONS.indexOf('0019_session_revocation.sql')).join(','))")`
`CONFIRM_MIGRATION_BASELINE=I_HAVE_VERIFIED_THESE_MIGRATIONS node run-migration.js --baseline "$PREFIX"`
This creates the ledger and records the operator-verified prefix; it
executes no schema SQL. Verify: 18 rows, checksums match the files at
the deployed commit.

**P3 — Apply 0019.** `node run-migration.js` (ordinary run). Applies only
0019, announces the gated 0018 skip. Note the runner wraps 0019 in one
transaction and its `CREATE INDEX` is non-concurrent, so writes to
`users` pause while the index builds — time it on the restored copy
if `users` is large. Verify `users.session_version` exists,
`NOT NULL DEFAULT 0`, index present; logins/logouts work; session
revocation behaves (logout invalidates prior token). If §2 of the
preflight showed lazy repair already created the column, 0019 still
runs cleanly (idempotent) and simply becomes ledger-official.

**P4 — Apply gated 0018.** Only with P0 mismatch counts all zero:
`CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS node run-migration.js 0018_composite_school_foreign_keys.sql`
Verify 26/26 present + validated; runner's post-check prints
"26/26 present, validated and correct". If it aborts, it has changed
nothing — investigate the named relationship, do not force.

**P5 — Post-verification.** Re-run the checkpoint queries (ledger rows =
20 incl. checksums, FK inventory, mismatch counts still 0), ordinary
runner re-run (idempotent message), application smoke by owner
(login, cross-school negative probes against a test school if available).

## 5. Rollback

- **P2 rollback:** `DROP TABLE public.easylearn_schema_migrations;`
  (ledger only; schema untouched) — or restore the P1 branch.
- **P3 rollback:** 0019 is additive. Preferred: leave the column
  (harmless, defaulted) and roll back only if required:
  `DROP INDEX users_session_version_idx; ALTER TABLE users DROP COLUMN session_version;`
  Note: dropping it after current code is deployed re-breaks
  fail-closed auth — coordinate with the deployment rollback.
- **P4 rollback:** drop the 26 named constraints
  (`ALTER TABLE … DROP CONSTRAINT …` per
  `src/lib/tenant-constraints.js`), or restore the P1 branch. Data is
  never modified by 0018, so constraint rollback loses no data.
- **Full rollback:** promote/restore the P1 Neon branch per Neon's
  documented flow (owner-operated).

## 6. What must never happen

- No `drizzle-kit push` / `npm run db:schema-sync` against production
  (the guarded wrapper refuses non-empty databases; bypassing it is how
  H2-style damage occurs).
- No baseline beyond the *verified* prefix; never baseline 0018 to make
  the ledger agree — the runner itself refuses that without the catalog
  proof.
- No silent reassignment/deletion of mismatched rows; every mismatch is
  an owner-reviewed data decision.
- No production secret, env, storage, or deployment change bundled with
  this schema work.

## 7. Approval checklist (owner)

- [ ] P0 evidence reviewed (incl. deployed SHA + auth state answer to H3)
- [ ] P1 backup/restore rehearsal completed on a scratch branch
- [ ] Lock/duration timing from the restored copy fits the window
- [ ] Maintenance window + rollback owner named
- [ ] Explicit go for P2–P4 as written above
