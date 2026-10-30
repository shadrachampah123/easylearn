# Production preflight — migrations 0019 + 0018 (READ-ONLY)

Purpose: give the owner/DBA one procedure that (a) resolves open question
**H3** (why `users.session_version` is still missing despite runtime
lazy-repair), (b) re-verifies the production drift reported in PR #64, and
(c) measures the exact expected impact of applying 0019 then gated 0018.
**Every step is read-only.** The first write of any kind happens only
under `docs/PRODUCTION_SCHEMA_RECOVERY_PLAN.md` after explicit approval.

## 0. Evidence labels used here

- **Independently verified** — produced by the agent in a disposable
  environment or from GitHub-visible records this session.
- **Owner-reported** — from the PR #64 read-only catalog checks; not
  re-runnable by the agent (no Neon/Vercel credentials in the agent
  environment; `*.vercel.app` is unreachable from it).

## 1. What is already established (independently verified)

- GitHub Deployments record the latest **Production** deployment as
  commit `4134d23` (current `main`, 2026-10-27T18:02:46Z) with a success
  status — production runs current code, including fail-closed session
  revocation and lazy repair. "Old code deployed" is **refuted**.
- The lazy-repair path (`src/lib/schema-resilience.ts`
  `ensureSchemaFeature("session_revocation")`) probes
  `information_schema` for `users.session_version`; if missing and
  `AUTO_SCHEMA_REPAIR` is not off, it runs
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version …` +
  `CREATE INDEX IF NOT EXISTS …`, re-probes, and `verifyToken`
  (`src/lib/auth.ts`) **fails closed with 503** if the column remains
  unavailable. No code path silently skips the repair.
- Therefore exactly one of these is true in production (H3):
  1. The runtime `DATABASE_URL` targets a **different Neon
     branch/database** than the inspected `production`/`neondb` —
     repair already succeeded there; the inspected branch is drifted
     but is not (or not only) the application's database.
  2. `AUTO_SCHEMA_REPAIR=false` (or the runtime role cannot ALTER) —
     repair cannot run, so **every authenticated request currently
     fails closed (503)** after login; public pages still work.
  3. No authenticated request has hit the runtime since the
     fail-closed code deployed (repair is lazy, on first token
     verification).

## 2. Step A — resolve H3 (owner-observed evidence 2026-10-27 21:41 UTC + remaining check)

**Owner-observed:** `GET https://easylearn-six.vercel.app/api/health`
→ HTTP 200: `databaseUrlConfigured`, `jwtSecretConfigured`,
`databaseConnected`, `schemaReady` all true;
`optional_user_columns: true`; `composite_tenant_foreign_keys: false`
with the warning that 0018 "has not been applied" and is never applied
automatically.

**What this establishes (verified against the endpoint's code):**
- The runtime deployment is configured, connected, and its core
  `users` table shape is compatible (`schemaReady` checks 9 core
  columns — **not** `session_version`).
- The **runtime database itself lacks the 0018 composite FKs**
  (the composite probe runs against the runtime DB). The 0018 drift
  is therefore real in the application's own database, not only in
  an inspected side branch.
- `composite_tenant_foreign_keys: false` + its warning also proves
  `probeSchemaFeatures` executed against production successfully.

**What it does NOT establish — correction of this document's earlier
claim:** the deployed `/api/health` does **not** probe
`session_version` at all. `probeSchemaFeatures()`' default list
omitted `session_revocation`, and `optional_user_columns: true`
only proves `users(username, must_change_password)` exist (0006) — a
broader, older check. So the health response says **nothing** about
whether the runtime DB has `session_version`, and its static
"Login and registration services are ready" message is not evidence
that authentication succeeds. (Fix in flight: `session_revocation`
has been added to the health probe's default list with a DB-backed
regression test; once that is merged and deployed, this endpoint
*will* report it.)

**Remaining H3 verification (owner, ~5 minutes):**
1. Log in normally, then load any authenticated page (or request
   `/api/auth/me` with the session cookie). Record the outcome:
   - **Login + authenticated page works** → `verifyToken` passed,
     so the runtime DB has `session_version` *now* (it either always
     did, or lazy repair created it during that request — repair is
     enabled unless `AUTO_SCHEMA_REPAIR=false`). Next: re-run the
     §3 catalog check on the previously inspected Neon branch. If it
     still lacks the column there, the runtime DB differs from that
     branch (H3-1) — identify the runtime branch by name before any
     remediation planning. If it now has the column, H3-3/repair is
     confirmed and 0019 becomes a ledger-formality (still apply via
     the runner for history integrity).
   - **Login returns a session but authenticated pages/APIs 503** →
     H3-2: repair is off or DDL is denied; auth is currently failing
     closed. Confirm in Vercel function logs:
     `[auth] session-revocation column unavailable`. This raises the
     priority of P3 (0019) — it is the fix — but P0–P2 discipline
     still applies.
   - **Cannot log in at all** → record the exact error/status; do
     not conflate with H3-2 (login itself does not verify tokens).
2. Report: login outcome, one authenticated request outcome,
   `/api/auth/me` status if used, and the re-checked branch catalog
   result for `users.session_version` only. No credentials, cookies,
   or tokens in the report.

## 3. Step B — re-verify drift (read-only, runtime database)

Run `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` in full against
the runtime database. Required zero/nonzero expectations before any
write is even proposed:

- 24/24 0017 `UNIQUE (school_id, id)` targets present, valid, ready.
- All 26 cross-school/orphan mismatch counts = **0**; all required
  NULL `school_id` counts = **0**. Any nonzero → stop; each row is an
  owner-reviewed data decision (never silently reassigned/deleted).
- Ledger presence (absent is acceptable at this stage; it is created
  by the approved baseline step, not here).
- `users.session_version` presence (for the record; §2 may already
  have triggered its creation if repair is enabled — note the
  timestamp and which mechanism created it, because that also tells
  you whether the ledger must record 0019 as pending or applied-by-
  repair; the runner tolerates either since 0019 is idempotent).

## 4. Step C — exact expected impact (from the migration files)

**0019 (`drizzle/0019_session_revocation.sql`, 2 statements, one
transaction via the runner):**
`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer
NOT NULL DEFAULT 0` (metadata-fast on PostgreSQL 11+; brief
`ACCESS EXCLUSIVE` on `users`) + `CREATE INDEX IF NOT EXISTS
users_session_version_idx` (**non-concurrent** — blocks writes to
`users` while it builds; duration ∝ `users` size). Idempotent; no data
change beyond the new defaulted column. Rehearse timing on the
restored copy if `users` is large.

**0018 (`drizzle/0018_composite_school_foreign_keys.sql`, one `DO`
block, one transaction via the runner):** for each of the 26
relationships it (i) verifies the parent `UNIQUE (school_id, id)`
index exists, (ii) counts cross-school/orphan violations and **raises
— aborting the entire migration with nothing retained** — if any are
found, (iii) `ADD CONSTRAINT … NOT VALID` (`SHARE ROW EXCLUSIVE`;
reads/writes continue), (iv) `VALIDATE CONSTRAINT` (`SHARE UPDATE
EXCLUSIVE`; full scan of the child table — duration ∝ child size and
supporting index presence, see the child-index inventory in the
checkpoint). No table rewrites, no data modification. The runner
additionally verifies all 26 definitions (columns, order, delete
actions incl. the selective `SET NULL` column lists) after applying.

**Combined expected end state:** ledger with 20 checksummed rows
(18 baselined + 0019 + 0018), `session_version` present, 26/26 FKs
validated, ordinary runner re-run reporting "already recorded with
matching checksums" + "26/26 present, validated and correct".

## 5. Rollback limitations (know before approving)

- Neon branch restore is the only *complete* rollback; constraint/
  column drops are surgical alternatives (see recovery plan §5).
  Restoring a branch discards **all** writes made after the snapshot,
  not just migration effects — the window must be scheduled so that
  is acceptable, or surgical rollback must be pre-approved instead.
- If §2/H3-2 is live (auth failing closed), applying 0019 fixes auth;
  rolling back the *column* afterward would re-break it. Deployment
  rollback and schema rollback must be decided together.
- The pre-existing 2026-09-12 manual production snapshot (owner-
  reported) is **not** a usable rollback point for this work: it
  predates the drift window and is unverified. A fresh, verified
  branch/snapshot (recovery plan P1) is required.

## 6. Deliverable from this preflight

One sanitized operator report (per the checkpoint's "Required operator
report"): H3 outcome with evidence, deployed SHA, drift inventory,
mismatch/NULL counts, child-index inventory, measured 0018 validation
timing from the restored copy, and the resulting go/no-go for the
recovery plan's P2–P4. Until that report exists and is approved,
**production sign-off remains NO-GO** and no production write is
authorized.
