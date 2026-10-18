# Operations: PostgreSQL TLS and the migration runner

**Status:** normative for operators. **Applies to:** the application pool
(`src/db/index.ts`), the migration runner (`run-migration.js`), and the Drizzle config
(`drizzle.config.ts`).

> **Safety rules that this document does not override.**
> Do not run any migration against production without separate, explicit approval.
> Do not connect to production to "check" anything. The read-only checkpoint procedure in
> `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` is a *read-only* procedure and is not a
> migration authorization. Nothing in this repository applies a migration to production on
> its own.

> ## ⛔ Never run `drizzle-kit push` against a database EasyLearn manages
>
> `npx drizzle-kit push` (and `--force`) diffs the live database against
> `src/db/schema.ts`. **That schema cannot express a composite foreign key**, so push
> treats the 26 tenant constraints that migration `0018` installs as objects it does not
> know about and emits `ALTER TABLE … DROP CONSTRAINT` for every one of them. On a
> disposable copy this was measured:
>
> | Object | Before `push --force` | After |
> |---|---|---|
> | Composite tenant foreign keys (0018) | 26 | **0** |
> | `public.easylearn_schema_migrations` | present | **dropped** (`CASCADE`) |
> | `*_school_id_id_unique` targets (0017) | 24 | **7** |
>
> None of that asks for a confirmation token, runs in a transaction, or leaves a record.
>
> **The supported way to change the schema is `node run-migration.js`.** It is
> transactional, checksummed, gated where it needs to be, and it verifies the ledger
> against the catalog. `node db-schema-sync.js` (also `npm run db:schema-sync`) is the
> only sanctioned use of `drizzle-kit push`: it runs push **only** on a brand-new, empty
> database and refuses to touch one that is already in use.
>
> If a database was already damaged by an unauthorized schema sync, recover it with
> §4.1 — do not "fix" it by running push again.

---

## 1. Certificate requirements

Every PostgreSQL connection EasyLearn makes — application and migration alike — goes
through `createPostgresConnectionConfig()` in `src/lib/postgres-tls.js`. There is exactly
one policy, and it is **verified TLS**: the server certificate must chain to a trusted
certificate authority **and** the hostname must match the certificate.

### 1.1 What a valid configuration looks like

| Setting | Requirement |
|---|---|
| Scheme | `postgres://` or `postgresql://` |
| `sslmode` | `verify-full` (or omitted, which is treated as `verify-full`) |
| Certificate authority | Supplied **and** trusted. Provide it in one of: the `DATABASE_CA_CERT` environment variable, the `PGSSLROOTCERT` environment variable, or a `sslrootcert=` query parameter on the URL. The environment variables may hold the PEM text or a path to a PEM file. |
| Hostname | Must appear in the certificate's Subject Alternative Name. A certificate issued for `db.example.com` does **not** authorize `db.example.com.` resolved to another name, nor an IP address, unless the certificate carries a matching `IP Address:` SAN. |
| Password / user | Unchanged from the provider's credentials. |

Example:

```bash
export DATABASE_URL="postgresql://easylearn:***@db.example.com:5432/easylearn?sslmode=verify-full"
export DATABASE_CA_CERT="/etc/ssl/certs/db-example-com-ca.pem"
```

### 1.2 What is refused, and why

| Input | Result | Reason |
|---|---|---|
| `sslmode=disable` | **Refused** at configuration time | No encryption at all. |
| `sslmode=allow` | **Refused** at configuration time | Encryption without verification. |
| `sslmode=prefer` | **Refused** at configuration time | Plaintext is allowed when the server refuses TLS. |
| `sslmode=verify-ca` | **Refused** at configuration time | `verify-ca` authenticates the certificate but does **not** guarantee hostname validation, so a valid certificate for the wrong host would be accepted. Use `verify-full`. |
| `sslmode=require` | **Accepted, and upgraded** | `pg-connection-string` — the parser `pg` uses — turns `sslmode=require` into `{ rejectUnauthorized: false }`, i.e. encryption with **no** verification. EasyLearn removes every SSL query option from the URL before `pg` parses it and supplies its own TLS options with `rejectUnauthorized: true`. The result is stricter than `require`, never weaker. |
| A CA that is missing or untrusted | **Connection fails** | The handshake cannot complete. This is fail-closed: the application refuses to start rather than connecting unverified. |
| A certificate for the wrong host | **Connection fails** | `ERR_TLS_CERT_ALTNAME_INVALID`. |
| A non-`postgres://` URL, or a URL without a hostname | **Refused** at configuration time | Not a usable PostgreSQL connection string. |

### 1.3 The one escape hatch — and its limits

`EASY_LEARN_TEST_DATABASE=true` allows a **local** URL (`localhost`, `127.0.0.1`,
`::1`) with **no** SSL query option to be used in plaintext. It exists so the disposable
test suites can talk to a throwaway cluster without certificates.

Its limits are strict and are covered by tests:

* it only applies to a local URL — a remote host is never downgraded;
* it only applies when the URL carries **no** `sslmode`/`ssl`/`sslcert`/`sslkey`/`sslrootcert`
  option — the moment a TLS policy is requested, the verified path is used, even for
  `127.0.0.1`;
* it is never set by application or migration code. Only the test suites set it.

**Do not set `EASY_LEARN_TEST_DATABASE` in a production or staging environment.** It is a
test-only flag; setting it disables certificate verification for local connections and
unlocks the migration gates' test path.

---

## 2. Fail-closed behaviour

EasyLearn prefers to stop rather than to continue in a state it cannot verify.

| Situation | Behaviour |
|---|---|
| The CA cannot be read or is not a PEM certificate | The connection attempt fails with an explicit error. The application does not fall back to an unverified connection. |
| The server certificate is not trusted | The handshake fails (`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, …). |
| The server certificate is trusted but issued for another host | The handshake fails (`ERR_TLS_CERT_ALTNAME_INVALID`). |
| The database URL is missing | `run-migration.js` exits non-zero: "A PostgreSQL connection string is required". The application pool fails to start. |
| The target database has public tables but no `easylearn_schema_migrations` ledger | The runner **refuses to replay** the chain and exits non-zero. It points at the explicit `--baseline` procedure. |
| An applied migration's file no longer matches its recorded SHA-256 checksum | The runner exits non-zero: "Checksum mismatch". Drift is never silently accepted. |
| The ledger has a gap (a later migration recorded, an earlier one missing) | The runner exits non-zero: "refusing to guess migration order". |
| The ledger contains a filename that is not in the registered list | The runner exits non-zero. |
| A migration file is missing from the repository | The runner exits non-zero before touching the database. |
| A migration statement fails | The whole file is rolled back, no history row is written, and the runner exits non-zero. |
| Two runners run at the same time | A PostgreSQL advisory lock serializes them. |
| A **gated** migration is pending | It is **skipped**, loudly, and never applied automatically — see §3. |

---

## 3. Gated migrations

A gated migration is one that must not be applied as part of an ordinary "apply
everything" run. It is applied **only** when the operator

1. names that file explicitly on the command line, **and**
2. supplies the confirmation token for that file.

```bash
# Refused: the file is named but the preflight has not been confirmed.
node run-migration.js 0018_composite_school_foreign_keys.sql
# → "Refusing to apply 0018_composite_school_foreign_keys.sql."   (exit 1)

# Applied, after the preflight has been reviewed.
CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS \
  node run-migration.js 0018_composite_school_foreign_keys.sql
```

An ordinary run applies every other pending migration and prints:

```
⚠️  GATED MIGRATION NOT APPLIED: 0018_composite_school_foreign_keys.sql
   …
   It was skipped on purpose. To apply it after the preflight has been reviewed:
     CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS node run-migration.js 0018_composite_school_foreign_keys.sql
```

The default run still **exits 0** when it skips a gated migration. That is deliberate: the
gate exists to stop an unreviewed schema change, not to block unrelated deployments.
The skip is printed prominently and the migration is visibly absent from the ledger.

### 3.1 `0018_composite_school_foreign_keys.sql`

* **What it adds:** 26 validated composite foreign keys between school-owned records, so
  a parent row and a child row must share a `school_id`.
* **What it does *not* do:** it never repairs, reassigns or deletes a row. If a legacy
  cross-school or orphan reference exists, the migration **aborts atomically** and reports
  the offending relationship. Nothing is changed.
* **Requirements:** PostgreSQL **15+** (the selective column-list `SET NULL` syntax).
* **Preconditions to check before applying:**
  1. the target database's PostgreSQL version is ≥ 15;
  2. the read-only preflight in `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` has been
     run against a **restored copy** of the target database and its report has been
     reviewed;
  3. the table/lock impact has been assessed (see the lock table below);
  4. a backup and a rollback plan exist.
* **Lock levels actually taken** (measured on PostgreSQL 16.2 by sampling `pg_locks`
  during each phase — these are the *real* levels, not an upper bound):

  | Phase | Statement | Lock on the child table | Lock on the parent table | Effect |
  |---|---|---|---|---|
  | add | `ADD CONSTRAINT … NOT VALID` | `SHARE ROW EXCLUSIVE` | `SHARE ROW EXCLUSIVE` | blocks concurrent DDL and other `SHARE ROW EXCLUSIVE` work; **reads and writes continue** |
  | validate | `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE` | `ROW SHARE` | blocks DDL; **reads and writes continue** |

  The migration takes **no `ACCESS EXCLUSIVE` lock**: it never rewrites a table, because
  `NOT VALID` skips the existing-row scan and the scan happens under the weaker
  `SHARE UPDATE EXCLUSIVE` lock during `VALIDATE CONSTRAINT`. The real cost is therefore
  **duration, not blocking** — the validation scan reads the child tables, so the time it
  takes scales with the size of those tables. Measure it on the restored copy (§4.1) and
  schedule the window accordingly.
* **After applying:** confirm the ledger row exists and that the constraints are present.
  The runner does this itself: it prints
  `✅ Verification - composite tenant foreign keys: 26/26 present, validated and correct`
  and exits non-zero if the ledger and the catalog disagree.

The 0018 preflight is also available in the disposable test suite
(`tests/migration-0017-school-id-not-null.test.ts` asserts that the preflight detects
cross-school references, that the migration aborts without modifying data, and that the
gate behaves as described above).

### 3.2 `--baseline` (recording history, not applying SQL)

`--baseline` records an operator-asserted migration prefix in the ledger. It **does not
inspect or prove** that those migrations were applied, and it runs no migration SQL. It
requires `CONFIRM_MIGRATION_BASELINE=I_HAVE_VERIFIED_THESE_MIGRATIONS` and only accepts a
sequential prefix of the registered migration list. It is the only supported way to adopt
an existing database that has no ledger.

A baseline that includes a **gated** migration additionally requires that migration's own
confirmation token:

```bash
CONFIRM_MIGRATION_BASELINE=I_HAVE_VERIFIED_THESE_MIGRATIONS \
CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS \
  node run-migration.js --baseline 0000_wet_legion.sql,…,0018_composite_school_foreign_keys.sql
```

Without it the baseline is refused. This closes the only route by which the ledger could
otherwise claim that a gated migration had been applied when it had not.

**A token is necessary but not sufficient.** A baseline that includes
`0018_composite_school_foreign_keys.sql` is additionally refused unless the database
**actually has** the 26 composite tenant foreign keys that migration installs, each
present, validated, and referencing the right parent and columns:

```
❌ Migration failed: Baseline refused: the prefix includes 0018_composite_school_foreign_keys.sql,
   but this database does not have the 26 composite tenant foreign keys it installs (0 of 26 are present and correct).
  - missing constraint announcements_school_class_fk on public.announcements
  ...
```

A baseline may record an assertion about migration **history**; it may not certify a schema
that does not have the objects the migration installs. This is what stops a damaged
database from being "blessed" back into a state the ledger calls correct.

**Record a prefix that stops before the gated migration** and apply 0018 properly instead:

```bash
CONFIRM_MIGRATION_BASELINE=I_HAVE_VERIFIED_THESE_MIGRATIONS \
  node run-migration.js --baseline 0000_wet_legion.sql,…,0017_school_id_not_null.sql
CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS \
  node run-migration.js 0018_composite_school_foreign_keys.sql
```

### 3.3 The runner verifies the ledger against the catalog

On every invocation the runner cross-checks the ledger against PostgreSQL. If the ledger
records `0018` but the catalog does not have the 26 constraints, the runner **fails
closed** and names the exact objects:

```
❌ Migration failed: Migration history records 0018_composite_school_foreign_keys.sql as applied,
   but the database does not have the 26 composite tenant foreign keys it installs (25 of 26 are present and correct).
  - missing constraint assignments_school_class_fk on public.assignments
```

This is what makes a schema-sync bypass **visible**: the ledger can no longer certify a
database that no longer enforces tenant ownership. The same check runs after applying a
migration, so a migration that recorded itself without leaving the expected objects
behind cannot pass silently.

---

## 4. Operator runbook

**Before any production migration:**

1. Take a backup and know how to roll back.
2. Confirm the PostgreSQL version satisfies the migration's requirement.
3. Run the read-only checkpoint procedure against a **restored copy** and review the
   report. It is read-only and is not an authorization to migrate.
4. Check whether the migration is gated. If it is, follow §3 — it will not apply
   automatically.
5. Apply with an explicit file name:
   `node run-migration.js <file>.sql`
6. Read the runner's output. A non-zero exit means nothing was applied for that file.

**Connection setup:**

1. Export the verified connection string (`sslmode=verify-full`).
2. Export the CA (`DATABASE_CA_CERT` or `PGSSLROOTCERT`).
3. Do **not** set `EASY_LEARN_TEST_DATABASE`.
4. If the application fails to connect, read the error: an untrusted CA and a hostname
   mismatch are different messages. Do not "fix" it by weakening `sslmode`.

### 4.1 Recovery after an unauthorized schema sync

If `drizzle-kit push` (or any other tool) has dropped the composite tenant foreign keys,
the migration ledger and the 0017 `UNIQUE (school_id, id)` targets, the tenant boundary is
**not enforced** until it is repaired. Treat the database as untrusted for cross-tenant
writes in the meantime.

**Preferred: restore from backup.** That is the only recovery that restores the exact
state. Restore, then re-run the read-only checkpoint to confirm, then continue.

**Otherwise, repair in place** — on a restored copy first, never first on production:

```bash
# 1. Confirm the damage (read-only). Prints what is missing.
node run-migration.js --repair-tenant-integrity

# 2. Run it for real.
CONFIRM_REPAIR_TENANT_INTEGRITY=I_HAVE_VERIFIED_THE_DATABASE_NEEDS_REPAIR \
  node run-migration.js --repair-tenant-integrity
```

The repair does exactly two things, both of which can only make the database *more*
truthful:

1. it recreates any missing `UNIQUE (school_id, id)` target using migration 0017's exact
   idempotent statement (it never touches application rows);
2. it removes the ledger row for `0018` **only** when the composite constraints are
   demonstrably absent, so the ledger stops claiming something the database does not have.

It never creates the composite foreign keys — that stays behind the 0018 gate. Finish the
recovery by re-applying 0018 under its normal confirmation, and then re-run the checkpoint:

```bash
CONFIRM_MIGRATION_0018=I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS \
  node run-migration.js 0018_composite_school_foreign_keys.sql
```

If the ledger itself was dropped, record the verified prefix **without** 0018 first
(§3.2) — a baseline that includes 0018 is refused until the constraints are really there.

**Never** respond to a schema gap by running `drizzle-kit push`. It is the thing that
caused the damage.

### 4.2 Setting up a brand-new database

`npm run db:schema-sync` (i.e. `node db-schema-sync.js`) runs `drizzle-kit push` **only**
when the target database is empty. On a database that already holds objects, the ledger or
any tenant constraint, it refuses and points at `node run-migration.js`.

```bash
# A brand-new, empty database:
DATABASE_URL="postgres://…" npm run db:schema-sync
# → runs drizzle-kit push, then tells you to record the history with --baseline
```

An existing database is migrated with `node run-migration.js` — never with push.

---

## 5. How this is verified

| Check | Where |
|---|---|
| TLS policy (10 assertions, including real `tls` handshakes) | `tests/postgres-tls.test.js` |
| **End-to-end against a real TLS-enabled PostgreSQL 16** (trusted, untrusted, hostname mismatch, `sslmode=require` not downgraded, the local escape hatch not weakening TLS) | `tests/postgres-tls-e2e.test.js` |
| The end-to-end TLS suite actually **ran** (a skip fails the job) | `.github/workflows/ci.yml` sets `EASY_LEARN_REQUIRE_TLS_E2E=true` |
| `pg-connection-string` declared and pinned as a direct production dependency | `tests/postgres-tls.test.js` |
| Migration gate: default run skips, unconfirmed explicit run is refused, confirmed run applies | `tests/migration-0017-school-id-not-null.test.ts` |
| Runner fail-closed behaviour (no ledger, checksum drift, gaps, missing files, per-file rollback, advisory lock, baseline confirmation) | `tests/migration-0017-school-id-not-null.test.ts`, `tests/tenant-db.test.js` |
| **Tenant constraint integrity**: the shared inventory matches migrations 0017/0018; `drizzle-kit push --force` is reproduced and then contained; the ledger cannot certify missing/unvalidated/wrongly-shaped constraints; baseline cannot certify an invalid schema; the guarded schema sync refuses a managed database and still works on an empty one; the repair restores the unique targets and recovers the database | `tests/migration-tenant-constraint-integrity.test.ts` |
