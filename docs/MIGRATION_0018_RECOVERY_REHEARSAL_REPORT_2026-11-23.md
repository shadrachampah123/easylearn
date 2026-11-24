# Migration 0018 recovery and rehearsal — consolidated report

**Run date:** 2026-11-23 (UTC)  
**Repository commit inspected:** `f0ee94d43b6d3fa2d643722bec6a274b9a13667e` (`2026-11-22T22:13:00Z`)  
**Working branch:** `arena/b160e05a-easylearn`  
**Authorized Neon target:** `tenancy-preflight-2026-11-23` / `br-wispy-feather-ayhplk4v`  
**Overall result:** **isolated-Neon verification and rehearsal BLOCKED by missing branch credentials.** The official migration chain and gated 0018 were nevertheless rehearsed successfully on a disposable local PostgreSQL 18.6 database. That rehearsal is not evidence about the Neon branch or Production.

## 1. Verified repository and target state

- The repository was a full Git history at this run (216 commits; not shallow). Working tree was clean before this report was added.
- The checked-out commit is `f0ee94d43b6d3fa2d643722bec6a274b9a13667e`, dated `2026-11-22T22:13:00Z`.
- `run-migration.js` is the official runner. It registers the sequence `0000`–`0017`, then `0019_session_revocation.sql`, then gated `0018_composite_school_foreign_keys.sql`. 0018 requires `CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS`.
- The runner refuses to replay an existing public schema without its ledger, validates ledger checksums against current migration files, takes a PostgreSQL advisory lock, applies each file transactionally, and verifies the 0018 catalog state. No `--baseline`, direct SQL migration, schema push, or runner safeguard bypass was used in this rehearsal.
- There are root and `drizzle/` copies of 17 migration files; all 17 pairs compared byte-for-byte identical. The runner resolves the root copy first. `0000`, `0010`, and `0019` are only in `drizzle/`. No duplicate-content discrepancy was found.
- `tests/helpers/migrations.js` confirms the official test convention: ordinary runner invocation first, then each gated migration explicitly with its registered confirmation token. The rehearsal followed that order.
- No branch credential was available: `DATABASE_URL`, Neon credential variables, `PG*` connection variables and Vercel token were unset; no `.env`, Neon/Vercel credential store, `neonctl`, or `psql` was present. No connection string was invented or printed. The isolated Neon branch identity therefore **could not be verified**, and no query or write was made against it.

## 2. What was executed

### Disposable local rehearsal (not Neon)

A throwaway embedded PostgreSQL **18.6** cluster on loopback was created for this rehearsal and stopped afterward. All database writes in this run were confined to its disposable test database.

1. Ran `node run-migration.js` with the test-only local-database flag on an empty database. Exit **0**. It applied the 19 ordinary migrations (0000–0017 and 0019) in registered order and visibly skipped gated 0018.
2. Ran `node run-migration.js 0018_composite_school_foreign_keys.sql` with the runner's exact 0018 confirmation token. Exit **0**. The runner reported `26/26 present, validated and correct`.
3. Reran the ordinary runner and explicitly reran gated 0018 with its token. Both exited **0**, applied **zero** migration files, and completed catalog/ledger verification. This verifies runner idempotency on the disposable database.
4. Queried the resulting PostgreSQL catalogs and scanned all 26 relationships for a non-null child reference without a parent matching both `school_id` and `id`.
5. Verified the migration ledger has 20 rows, exactly the 20 registered files; every recorded SHA-256 matches the corresponding current file **by filename**, and all checksums have the required lowercase-hex 64-character form. (The filename comparison is by name because the registered order intentionally puts 0019 before 0018, while the verification query was returned alphabetically.)
6. Verified migration 0019's `users.session_version` is `NOT NULL DEFAULT 0` and `users_session_version_idx` exists.

### Rehearsal results

| Check | Result |
|---|---|
| 0018 composite tenant FKs | **26/26 present, validated, and exact-definition checks passed** |
| 0017 unique `(school_id, id)` targets | **24/24 present, unique, valid, ready, exact expected index definitions** |
| Cross-school/orphan mismatches | **0 on each of the 26 relationship scans** |
| Migration ledger | **20/20 rows**, matching current registered files and SHA-256 checksums by filename |
| 0019 session revocation | `session_version` present, `NOT NULL DEFAULT 0`; expected index present |
| Runner idempotency | Ordinary and explicit 0018 reruns both exit 0; **no migration statements reapplied** |
| Database version | PostgreSQL 18.6, local disposable cluster |

The 26 zero counts came from an empty disposable replay, not from Neon. They are a rehearsal assertion, not a claim about any populated database.

## 3. 0018 elapsed time and observed locks

- The complete official gated-0018 invocation, including process startup, runner preflight, transaction, constraint creation/validation, ledger write, and verification, took **112.1 ms** on the empty local PostgreSQL 18.6 rehearsal database.
- A concurrent sampler queried `pg_locks` during that invocation at approximately 2 ms intervals; it obtained seven sample rounds. It observed child-table `SHARE ROW EXCLUSIVE` locks on 15 tables and `SHARE UPDATE EXCLUSIVE` locks on 13 tables, with 13 tables observed in both modes. This short run did **not** sample every phase/table. No child-table `ACCESS EXCLUSIVE` lock was observed.
- These observations are consistent with 0018's `ADD CONSTRAINT ... NOT VALID` and `VALIDATE CONSTRAINT` phases. The 112.1 ms result is not a Production or Neon timing estimate: the database was empty, local, and fast, and validation duration depends on actual child-table volume, indexes, and system load. It does not size a maintenance window. No live-target lock duration was measured.

## 4. Migration-history investigation and confidence

### Git evidence

- Git history attributes migration file additions to their actual commits after unshallowing; the earlier depth-1 view was discarded and is not used as evidence.
- The initial runner at `af8df59406b19b4a0f0504bd7a5c4f61e8546401` (`2026-08-28T03:11:20Z`) had no history table or checksum logic and swallowed statement failures while continuing.
- The runner's ledger/checksum implementation first appears in `af947b6401529c37ba57606b4453ed07daef2ade` (`2026-10-18T17:23:56Z`), after migrations 0000–0017 were created. Thus repository records cannot supply historical checksums for 0000–0017.
- Migration `0011_attendance_unique_constraint.sql` was substantively changed in `713f7f3c35c256e2496e37da7ebcdedbb054cee8` (`2026-09-11T21:50:06Z`): its revised content preserves duplicate attendance rows in a backup table and uses a different constraint procedure. A current-file hash cannot establish which version, if either, ran on a database.
- 0018 was amended later to include its PostgreSQL 15+ gate and selective `SET NULL` behavior. Historical execution cannot be inferred from today's file or catalog shape.

**Conclusion:** confidence is **high** that Git does not contain a trustworthy historical execution ledger/checksum record for 0000–0017. Whether those migrations were actually applied, and which historical file revisions ran on the named Neon branch, is **not established**. Recomputing today's hashes and baselining the branch would invent history and is not an acceptable resolution.

### GitHub Actions, deployments, release history, and operator records

- GitHub reports 145 workflow runs and one workflow, `CI`. The workflow config uses only an ephemeral PostgreSQL service container (`postgres:16`) with disposable test credentials, and runs suites designed to create/drop scratch databases. It contains no persistent Neon/Production migration step and no deployment migration command. CI success is not proof of Production migration execution.
- GitHub's latest Production deployment record at inspection was deployment `7985860279`, status success, created `2026-11-22T22:13:29Z`, pointing to commit `f0ee94d43b6d3fa2d643722bec6a274b9a13667e`. This deployment metadata does not record database migration execution. GitHub releases query returned no releases.
- Existing operator records preserve prior read-only Production observations, but explicitly say the agent could not re-run them without Neon credentials. `SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md` and `docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md` record reported Production state: no `easylearn_schema_migrations` ledger, 0/26 0018 FKs, and 24/24 0017 targets present; `users.session_version` was reported absent. These are historical operator-reported observations, **not current branch results and not independently re-verified in this run**.
- The recovery plan's disposable rehearsal (2026-10-27) reports 9/9 tests covering refusal, baseline safeguards, 0019, gated 0018 atomic abort and success, and idempotency. That is test evidence, not an execution log for Neon or Production.
- No trustworthy operator execution record, database audit log, or deployment artifact showing application of 0000–0017 to the named isolated branch was available in the repository/GitHub sources inspected.

**Exact historical checksums for 0000–0017:** not established. The hashes verified in §2 belong only to the fresh local replay at this commit; they must not be represented as historical Neon checksums.

## 5. Remaining blocker and safe next action

### Blocked items

The Neon target has not yet been inspected. Consequently, its branch identity, server version, ledger contents, migration prefix/checksums, 26-FK inventory, 24 unique targets, mismatch counts, 0019 state, and readiness for an official-runner write are all **unverified**. The local rehearsal cannot substitute for any of those checks.

### Exact next action requiring owner intervention

Make a connection credential for **only** Neon branch ID `br-wispy-feather-ayhplk4v` available to this session through secure environment injection (not chat), and make the Neon console/API mapping from that endpoint to branch name `tenancy-preflight-2026-11-23` verifiable before execution. No production credential is needed or wanted. Once available, the next agent action is strictly read-only: verify the endpoint-to-branch mapping and query database/server identity plus ledger and catalog state. Only if that confirms the authorized branch and the actual ledger/state satisfies the runner's safeguards may the official runner be invoked with the 0018 gate. If the branch is populated without a trustworthy ledger, stop and report its exact sanitized state; do not baseline, repair, or apply a speculative prefix.

## 6. Production safety statement

**Production was not modified, migrated, baselined, schema-synced, or deployed by this task.** No Production database connection was made. The only migration writes in this run were to a disposable local PostgreSQL test database. No `drizzle-kit push` was run. No production credentials, environment variables, permissions, or data were changed.

## Evidence files

- `run-migration.js` — registered migration order, checksum ledger, gating, transaction and verification behavior.
- `tests/helpers/migrations.js` — sanctioned test invocation order and gate-token handling.
- `src/lib/tenant-constraints.js` — canonical 26-FK and 24-target inventories and catalog verification SQL.
- `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` — Production inspection and disposable lock-rehearsal procedure.
- `docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md` — existing recovery plan and prior disposable rehearsal evidence.
- `docs/PRODUCTION_PREFLIGHT_0019_0018.md` — prior preflight evidence labels and procedures.
- `SECURITY_AUDIT_ISSUE54_FOLLOWUP_2026-10-27.md` — historical operator-reported catalog findings and explicit access limitations.
- `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md`, `docs/PRODUCTION_MIGRATION_SAFETY_REVIEW_PR32.md` — runner safeguards and prior migration safety review.
