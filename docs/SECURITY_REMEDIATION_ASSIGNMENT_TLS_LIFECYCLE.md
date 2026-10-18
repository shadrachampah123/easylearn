# Security remediation: PostgreSQL TLS, assignment content, and school lifecycle

## Scope

This remediation is additive and does not modify or merge PR #30. It does not add or run a production migration. Migration `0018` remains blocked.

## PostgreSQL TLS

`src/lib/postgres-tls.js` is the single connection-policy implementation used by:

- the application pool (`src/db/index.ts`),
- `run-migration.js`, and
- `drizzle.config.ts`.

The policy accepts both `postgres://` and `postgresql://` URLs and these environment names:
`DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, and `NEON_DATABASE_URL`.

Before the URL reaches `pg`, SSL query controls (`sslmode`, `ssl`, `sslcert`, `sslkey`, and
`sslrootcert`) are removed. Node TLS is passed explicitly with `rejectUnauthorized: true` and
`servername` set to the parsed database hostname. A configured CA may be supplied as PEM or a
readable path. `disable`, `allow`, `prefer`, and `verify-ca` are rejected; `require` cannot
weaken verification. Plaintext localhost is available only when a disposable test explicitly
sets `EASY_LEARN_TEST_DATABASE=true` and opts into the local test escape hatch.

`tests/postgres-tls.test.js` covers parser downgrade behavior, URL/environment formats, trusted
and untrusted certificates, hostname mismatch, and application/migration configuration parity.

## Assignment content authorization

`src/lib/assignment-access.ts` is the query-level authorization boundary. Assignment selection
must be scoped to the active school and one of these database predicates:

- teachers: assignment owner only;
- school administrators and head teachers: school-scoped oversight;
- learners: published assignment plus active enrollment in the assignment class;
- parents: published assignment plus an explicit `learnerId`, active parent and learner
  memberships, active parent–learner link, and active class enrollment;
- all other contexts: `false`.

Question, assignment detail, corrections, results, list, and submit routes use explicit
response selections. Learner and parent DTOs omit `correctAnswer` and `explanation`; staff DTOs
include them only after the staff assignment query succeeds. `tests/assignment-access-db.test.ts`
exercises the real handlers against two disposable schools, including ownership, oversight,
publication, enrollment, parent linkage, cross-school denial, and answer-key suppression.

## Active-school lifecycle and selection

`src/lib/tenant.ts` now considers only `schools.status = 'active'` for ordinary school context.
`provisioned`, `suspended`, and `archived` schools remain queryable by lifecycle/platform paths
but cannot satisfy `guardSchoolContext`. Membership and school status are re-read for every
request, so stale tokens lose ordinary access. A multi-school login has no implicit first-school
selection; `/api/auth/select-school` accepts only a freshly verified active membership and issues
a new signed school hint. The login page presents that server-returned membership list for
selection. `/api/auth/me` remains an identity response and reports a null school context when
there is no active selection.

Platform administrators remain outside school context and retain the platform gate. Historical
membership rows and non-active school rows remain available to explicitly opted-in lifecycle
inspection (`includeInactive`) and historical workflows.

`tests/membership-auth-db.test.ts` covers login, `/api/auth/me`, explicit selection, existing
sessions, dual memberships, all lifecycle states, platform access, historical membership
retention, and CBISM compatibility.

## Migration gate

No `0018` migration is included or registered. Before any production migration is proposed, the
following remain required: production version/history verification, data preflight, index and
query-plan review, lock-window assessment, DBA approval, and a tested backup/PITR recovery.

An independent security review is required before merge.
