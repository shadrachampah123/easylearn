# Backup & Restore Verification — `easylearn-production-2026-10-29.dump`

Status date: 2026-10-30. Production recovery verdict: **NO-GO** (unchanged).
This document distinguishes three evidence classes honestly:

- **OWNER-REPORTED** — performed by the account owner outside the agent sandbox
  (the agent holds no Neon credentials, no `pg_dump` binary, and cannot reach
  Neon hosts; it cannot re-run these checks and does not present them as
  independently verified).
- **ARENA-VERIFIED** — checked by the agent from repository source or GitHub.
- **NOT VERIFIED** — outstanding; exact operator steps are given below.

## 1. Evidence received (OWNER-REPORTED, not Arena-verified)

| # | Item | Reported result |
|---|------|-----------------|
| 1 | Disposable Neon child branch `backup-restore-verification` created | Done |
| 2 | Backup file `easylearn-production-2026-10-29.dump` created | Done |
| 3 | Restored into separate `restore_test` DB on the disposable branch | Success |
| 4 | Schema columns | 351 columns / 38 tables, match exactly |
| 5 | Index definitions | All 117 match exactly |
| 6 | PK/FK/UNIQUE constraint reports | Match (query limitation on composite-UNIQUE column ordering — see §3 fix) |
| 7 | Row counts | **All 38 public tables match production** (completed 2026-10-30) |
| 8 | Production modified? | No |
| 9 | Sequences (definition, ownership, state) | Match (completed 2026-10-30) |
| 10 | Enum types | All 12 enum types and 58 enum values match (completed 2026-10-30) |
| 11 | Public functions (restored DB inventory) | Query returned none (completed 2026-10-30) |

**SHA-256 (owner-recorded 2026-10-30, not Arena-recomputed — the agent has no
copy of the file):**
`A9300EA7382DF3A1C4CE71FBC0A57448E7F3EDE2F945E4E0D0BE786E4381B669`
This proves the owner holds a recorded hash; bit-identity of every stored copy
still requires re-running `sha256sum` on each copy and comparing (§2 step 1).

## 2. Remaining verification — exact read-only operator steps

Run every query **twice**: once against production `neondb` (read-only;
`SELECT` only) and once against `restore_test` on the disposable branch.
Save both outputs as text and diff them. Any diff = FAIL for that item.
Do not paste credentials, connection strings, or row data into issues/PRs —
counts and catalog metadata only.

### Step 1 — Backup-file integrity (on the machine holding the .dump)

```bash
sha256sum easylearn-production-2026-10-29.dump          # record FULL hash in the ops log
pg_restore --list easylearn-production-2026-10-29.dump > dump-toc.txt   # must exit 0
wc -l dump-toc.txt                                      # note TOC entry count
```

Re-run `sha256sum` on every copy of the file (local + off-Neon storage); all
hashes must be identical. Store the hash with the backup record, not in Git.

### Step 2 — Exact row counts, ALL 38 public tables (both databases)

```sql
-- Run in psql; \gexec executes the generated count queries.
SELECT format('SELECT %L AS table_name, count(*) AS exact_rows FROM %I.%I;',
              tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- In psql: save the output of the above, or pipe:  ... \gexec
```

Expected: 38 rows, every `exact_rows` identical between the two databases.
Note: production counts are a moving target — take the production snapshot of
counts in the same minute as any re-dump, or accept small deltas on active
tables (`login_attempts`, `activity_logs`, `sessions`-like tables) and record
them as *explained deltas*, not PASS.

### Step 3 — Sequences (both databases)

```sql
SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY 1;
-- Then per sequence (values differ after live traffic; flag only missing AHEAD/BEHIND anomalies):
SELECT last_value, is_called FROM public.<sequence_name>;
```

A restored sequence **behind** production MAX(id) causes duplicate-key
failures after recovery — for each identity/serial column verify
`last_value >= (SELECT max(id) FROM <table>)` in `restore_test`.

### Step 4 — Catalog completeness (both databases; outputs must diff clean)

```sql
-- Enum types and labels (order matters)
SELECT n.nspname, t.typname, e.enumlabel, e.enumsortorder
FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname='public' ORDER BY 1,2,4;
-- Functions
SELECT p.oid::regprocedure::text, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' ORDER BY 1;
-- Triggers (non-internal)
SELECT event_object_table, trigger_name, action_timing, event_manipulation, action_statement
FROM information_schema.triggers WHERE trigger_schema='public'
ORDER BY 1,2,3;
-- RLS enablement + policies
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1;
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies WHERE schemaname='public' ORDER BY 1,2,3;
-- Extensions
SELECT extname, extversion FROM pg_extension ORDER BY 1;
-- Table/sequence grants (roles, not passwords)
SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' ORDER BY 1,2,3;
```

### Step 5 — Fix for the composite-UNIQUE ordering limitation

`information_schema` constraint queries do not preserve composite column
order. Compare canonical catalog definitions instead (both databases):

```sql
SELECT conrelid::regclass::text AS table_name, conname,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace='public'::regnamespace AND contype IN ('p','f','u')
ORDER BY 1,2;
```

`pg_get_constraintdef` emits columns in definition order, so a text diff of
this output resolves the ordering question exactly.

## 3. What the database backup does NOT cover (ARENA-VERIFIED from source)

A `pg_dump` of `neondb` contains schema + table data only. Verified against
`src/db/schema.ts` (`uploaded_files`) and `src/lib/object-storage.ts`:

| Asset | Covered by .dump? | Where it actually lives |
|-------|-------------------|-------------------------|
| `uploaded_files` metadata rows (names, keys, sizes) | ✅ Yes | PostgreSQL |
| File **bytes** with `storage_backend='object'` | ❌ **No** | Object-storage bucket (R2/S3); DB holds only the object key (`stored_name`) |
| File **bytes** with `storage_backend='local'` | ❌ **No** | Disk under `UPLOAD_DIR` on the app host |
| Env vars / secrets (JWT, DB URL, storage keys) | ❌ No | Vercel project settings |
| Neon branch/snapshot config, compute settings | ❌ No | Neon Console |
| Vercel deployment config | ❌ No | Vercel |

**Consequence:** restoring this dump alone yields a working schema whose
uploaded-file rows point at objects that may not exist. Recovery suitability
requires a matching object-storage backup (bucket listing/versioning or a
synced copy) taken at a consistent point, plus a count reconciliation:
`SELECT storage_backend, count(*) FROM uploaded_files GROUP BY 1;` (counts
only — never export file names/keys into public reports).

Also out of scope of a logical dump: point-in-time recovery (a dump is a
single instant; Neon branch PITR remains the finer-grained option), and any
data written to production **after** 2026-10-29 (the dump is already ageing).

## 4. Gaps in the procedure & corrective steps

1. **SHA-256 not recorded** → run §2 Step 1 now; store hash off-Neon with the file.
2. **28/38 table counts outstanding** → §2 Step 2 on both DBs; record explained deltas for live tables.
3. **Sequences/enums/functions/triggers/RLS/extensions/grants unverified** → §2 Steps 3–4; diff outputs.
4. **Composite-UNIQUE ordering unresolved** → §2 Step 5 canonical-definition diff.
5. **Object storage not backed up/verified** → enable bucket versioning or schedule a bucket sync; reconcile object count vs `uploaded_files` rows with `storage_backend='object'`. Never test restores against the production bucket.
6. **Single backup, single location, ageing** → keep ≥2 copies (one off-Neon, encrypted), record creation time + Neon branch it was taken from, and set a recurring schedule (Neon automatic snapshots are not configured — owner-reported 2026-10-27).
7. **Restore runbook untested end-to-end at app level** → after catalog checks pass, point a *Preview/disposable* deployment at `restore_test` and run login + one authenticated read smoke test. Schema equality does not prove the app works against the restore.
8. **Recovery-branch hygiene** → `backup-restore-verification` is disposable; keep it isolated, do not point production env vars at it, delete it only on owner instruction after sign-off (deletion is out of scope for verification).

## 5. Verdict

| Area | Status |
|------|--------|
| Restore mechanics (dump → `restore_test`) | PASS (owner-reported) |
| Columns / indexes | PASS (owner-reported) |
| Constraints | PASS with ordering caveat → Step 5 to close (owner-reported) |
| Row counts (all 38) | PASS (owner-reported 2026-10-30) |
| Sequences (definition/ownership/state) | PASS (owner-reported 2026-10-30) |
| Enums (12 types / 58 values) | PASS (owner-reported 2026-10-30) |
| Public functions | Restored inventory empty (owner-reported); production-side empty-inventory confirmation still required for a two-sided PASS |
| Triggers, RLS policies, extensions, grants | **NOT VERIFIED** |
| Backup-file SHA-256 | Hash recorded (owner-reported); per-copy recomputation **NOT VERIFIED**; Arena recomputation not possible |
| Object-storage (file bytes) coverage | **FAIL as a complete-recovery claim** — dump does not cover it; corrective step 5 required |
| Independent (Arena) verification of Neon-side items | **NOT POSSIBLE** — no Neon credentials/access in the agent sandbox; all Neon-side results above are owner-reported |

**GO/NO-GO: NO-GO.** The dump is a promising, partially verified schema/data
restore, but it is **not yet suitable as the sole recovery point**: integrity
hash, full row counts, catalog completeness, sequence safety, and
object-storage coverage are unproven. Production recovery stays NO-GO until
§2 is executed and diffed clean, §4 items 1–6 are closed with recorded
evidence, and an independent reviewer (human, or an agent with read-only Neon
access) confirms the outputs.

## 6. Consolidated outstanding-items list (2026-10-30)

**Verified (Arena, from source/GitHub):** dump coverage limits (§3 — file bytes,
secrets, Neon/Vercel config not covered); repo/PR/CI state. Nothing Neon-side
is Arena-verified: the sandbox holds no Neon credentials or file copy.

**Owner-reported PASS:** restore into `restore_test`; 351 columns/38 tables;
117/117 index definitions; PK/FK/UNIQUE reports; **all 38 table row counts**;
sequences (definition/ownership/state); **12 enum types / 58 values**;
SHA-256 recorded (`A9300EA7…81B669`); production unmodified.

**Partially verified:** public functions — restored inventory returned none;
a two-sided PASS still needs the production inventory shown empty with the
same query. Composite-UNIQUE column ordering still needs the §2 Step 5
canonical `pg_get_constraintdef` diff (the original query's limitation).

**NOT VERIFIED (outstanding):**
1. Triggers, RLS enablement/policies, extensions, grants — §2 Step 4 grouped queries, diffed.
2. Composite-UNIQUE ordering — §2 Step 5.
3. SHA-256 recomputation on every stored copy (incl. off-Neon) against the recorded hash.
4. Object-storage backup/coverage — bucket versioning/sync + count reconciliation vs `uploaded_files` by `storage_backend` (§4 item 5). The DB dump alone cannot restore file bytes.
5. App-level smoke test against `restore_test` (Preview deployment; login + authenticated read).
6. Backup retention/schedule — ≥2 encrypted copies (one off-Neon), recorded source branch/time; Neon auto-snapshots still unconfigured.
7. Independent confirmation by a reviewer with read-only Neon access (all Neon-side items above are single-source owner reports).

**Recommendation unchanged: NO-GO.** Items 1–4 are quick grouped-query checks;
item 4 (object storage) is the largest real recovery gap.
