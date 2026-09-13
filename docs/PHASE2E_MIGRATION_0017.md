# Phase 2E — Migration 0017: `school_id` NOT NULL enforcement

**Status:** implemented on this branch (migration + schema + tests only).  
**Does not:** run against production, merge, or deploy.

## Contract

| Concern | Rule |
| --- | --- |
| Next migration number | `0017` (after `0016_school_id_columns.sql`) |
| Files | `0017_school_id_not_null.sql` (root + `drizzle/`, identical) + registered in `run-migration.js` |
| Preserve existing values | Backfills only `WHERE school_id IS NULL` |
| Deterministic backfill | Derive from parent/relationship (`terms`←`academic_years`, `assignments`←`classes`, …) or sole active membership |
| Single-school residual | Only when `count(schools) = 1` (live audit: CBISM alone). Stamps remaining **required** NULLs to that school |
| Multi-school safety | If `count(schools) ≠ 1`, residual stamp is skipped. If any required table still has NULL, migration **RAISE EXCEPTION** — never guesses a school |
| `activity_logs` | **Stays nullable forever** (NULL = platform event, plan §5/§14). Optional sole-membership stamp only |
| NOT NULL | Applied to 24 A-class tables after NULL-free proof. `school_users` already NOT NULL (0013) |
| FKs / indexes | Existing 0016 FKs and `*_school_idx` indexes preserved. No drops |
| Cross-school integrity | `UNIQUE (school_id, id)` targets added for later composite FKs (plan §13). Composite FKs themselves are a later step |
| App behaviour | Unchanged beyond schema nullability matching the DB |

## Live audit reconciliation

| Audit finding | How 0017 handles it |
| --- | --- |
| 26 school-scoped tables have `school_id` | Unchanged surface; 0017 only tightens nullability |
| `school_users.school_id` already NOT NULL | Untouched |
| Validated FKs on all 26 | Preserved |
| School-scoped indexes present | Preserved; UNIQUE `(school_id, id)` added |
| One active school (CBISM) | Single-school residual stamp is safe and deterministic |
| Zero orphan `school_id` refs | No rewrite of non-NULL values |
| ~3 legacy NULL rows | Relational backfill first; if still NULL and single school → stamp; if multi-school and still NULL → **abort** |

## How remaining NULLs are resolved

1. **Parent-derived** (always safe when parent has `school_id`): terms, subjects, classes, teacher/learner_classes, assignments, submissions, uploaded_files (via assignment), resources (via class), quizzes, quiz_attempts, announcements (via class), attendance, timetable_entries.
2. **Sole membership** (exactly one non-disabled `school_users` row for the anchor user): uploaded_files (uploader), resources (teacher), announcements (author), notifications, dashboard overrides (creator), news (author), activity_logs (actor, optional).
3. **Shared sole school** (parent↔learner or sender↔receiver share exactly one school): parent_learners, messages.
4. **Single-school residual** (only if exactly one `schools` row): any still-NULL required A-table row → that school. **Not** applied to `activity_logs`.
5. **Unresolvable** under multi-school → migration fails closed.

## Rollback

- Drop UNIQUE indexes `*_school_id_id_unique`.
- `ALTER COLUMN school_id DROP NOT NULL` on the 24 tables.
- Data values remain intact (no destructive rewrite).

## Validation

```bash
npm run test:migration-0017   # dedicated 0017 suite
npm run test:db               # includes 0017 + prior DB suites
npm test && npm run typecheck
```
