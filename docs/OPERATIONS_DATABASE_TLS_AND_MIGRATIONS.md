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
  3. the table/lock impact has been assessed (the migration takes `ACCESS EXCLUSIVE`
     locks while validating each constraint);
  4. a backup and a rollback plan exist.
* **After applying:** confirm the ledger row exists and that the constraints are present.

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

---

## 5. How this is verified

| Check | Where |
|---|---|
| TLS policy (10 assertions, including real `tls` handshakes) | `tests/postgres-tls.test.js` |
| **End-to-end against a real TLS-enabled PostgreSQL 16** (trusted, untrusted, hostname mismatch, `sslmode=require` not downgraded, the local escape hatch not weakening TLS) | `tests/postgres-tls-e2e.test.js` |
| `pg-connection-string` declared and pinned as a direct production dependency | `tests/postgres-tls.test.js` |
| Migration gate: default run skips, unconfirmed explicit run is refused, confirmed run applies | `tests/migration-0017-school-id-not-null.test.ts` |
| Runner fail-closed behaviour (no ledger, checksum drift, gaps, missing files, per-file rollback, advisory lock, baseline confirmation) | `tests/migration-0017-school-id-not-null.test.ts`, `tests/tenant-db.test.js` |
