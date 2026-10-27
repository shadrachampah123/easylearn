# Issue #54 Security Verification Follow-up — 2026-10-27

## Scope and evidence

This follow-up supplements the earlier Issue #54 report and historical `security/audit-pr40-49-final` report. The documentation-only PR #63 was merged as `7da7de9c60eea1197d2a834f0b4b291492306b94`; its CI passed on the PR head. No production database writes, migrations, secrets, object storage, or Neon resources were changed during this follow-up.

## Current verification matrix

| Area | Current evidence | Status |
|---|---|---|
| CI/source verification | PR #62 passed the GitHub CI suite on `c93c60a4bcea1a88a39f20a19e7e18d8a117338f`; documentation PR #63 CI also passed. Source includes security, tenant/membership, migration, TLS, typecheck, production build and lint coverage. | CI pass on tested commits; does not establish live production schema/route health |
| Migration runner and migration file | `run-migration.js` registers `0019_session_revocation.sql` before gated `0018_composite_school_foreign_keys.sql`. Migration 0019 adds `users.session_version` and its index if missing. | Source verified only |
| **Production schema: session revocation** | Read-only Neon catalog query against project `easylearn`, primary/default branch `production`, database `neondb`: `public.users` exists, but `users.session_version` is absent. | **BLOCKER — production schema does not match current source expectation** |
| **Production migration ledger** | `public.easylearn_schema_migrations` does not exist. Read-only inventory found no public base table with a migration/drizzle-related name. | **BLOCKER — migration history cannot be verified from the expected ledger** |
| Production remediation | No migration, repair, baseline, or schema change was attempted. The discrepancy must be reconciled by the owner/DBA against a verified backup and the approved runbook before any writes. | Required; NO-GO |
| Live R2/S3 upload/download | `tests/object-storage-real-provider-harness.test.ts` exists and has a production-bucket guard. No disposable non-production provider credentials/bucket were available for a live test. | Infrastructure-blocked / unverified |
| Browser verification | Chromium, Firefox and WebKit live browser probes have not been run in this environment. | Infrastructure-blocked / unverified |
| Live HTTP smoke test | Earlier attempts could not resolve the preview host because of environment DNS failure. Vercel deployment metadata is not proof that routes respond. | Unverified |
| Legacy NULL school attribution and video Range 206 | Automated/disposable coverage exists in the prior follow-up; staging/live confirmation remains outstanding. | Partially covered |
| Neon deleted Preview branch recovery | Current branch listing (including deleted branches) showed the production branch and active preview branches, but no deleted audit/historical preview branch. The only listed snapshot is a manual production snapshot from 2026-09-12. No snapshot schedule is configured for production or the current Issue #54 preview branch. No restore was attempted because the available snapshot is production-origin and does not prove it contains the deleted preview state. | Recovery unverified; no changes made |
| Independent review | The project owner explicitly waived an independent reviewer for merging the documentation-only report. No independent review is claimed; this waiver does not approve production security sign-off. | Waiver applies to documentation-only report only |

## Safe next actions

1. **Stop before any production write.** Owner/DBA should investigate why the production `users.session_version` column and `easylearn_schema_migrations` ledger are absent. Reconcile against a verified backup and `docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md` / `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md`. Do not run `drizzle-kit push`, migration, baseline, or repair until the actual schema and migration history have been independently established and an approved remediation is reviewed.
2. With non-production credentials and a disposable bucket only, run:
   `OBJECT_STORAGE_LIVE_TEST=true npx tsx tests/object-storage-real-provider-harness.test.ts`
   Capture presign → upload → download, expiry, content type, tampered signature, range limits, cross-school access and deletion-safeguard results. Never use production bucket `easylearn-uploads`.
3. Run browser probes in browser-capable CI/QA with Chromium, Firefox and WebKit.
4. Retry a non-destructive HTTP smoke test against the intended deployment from an environment with working DNS and deployment access.
5. For Neon recovery, ask Neon support/console for the deleted branch's recovery/retention state. Do not restore the production snapshot as if it were the deleted preview branch.
6. Keep Issue #54 open until production schema/history are reconciled and remaining infrastructure checks are complete or explicitly risk-accepted.

## Go / no-go

**NO-GO for production security sign-off.** The key new finding is a production catalog mismatch: the `users.session_version` column and expected migration ledger are absent even though current source relies on the session-revocation migration path. CI passing does not resolve this. Live storage, browser behavior, HTTP route health, and deleted Preview recovery remain unverified. No production or Neon resources were changed.
