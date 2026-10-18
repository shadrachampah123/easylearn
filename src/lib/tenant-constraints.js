"use strict";

/**
 * The composite tenant foreign keys introduced by migration
 * `0018_composite_school_foreign_keys.sql`.
 *
 * This module is the single machine-readable description of what migration 0018
 * installs. It exists so that the migration runner, the application runtime and the
 * regression tests all agree on one list instead of restating it in three places.
 *
 * Why it is enforced, not merely documented
 * ------------------------------------------
 * `drizzle-kit push` diffs the live database against `src/db/schema.ts`. That schema
 * cannot express a composite foreign key, so `push` treats migration 0018's 26
 * constraints as objects it does not know about and emits `ALTER TABLE ... DROP
 * CONSTRAINT` for every one of them. It also drops `public.easylearn_schema_migrations`
 * (CASCADE) and 17 of the 24 `UNIQUE (school_id, id)` indexes that 0018 depends on.
 * Nothing in that path asks for a confirmation token.
 *
 * If the migration ledger still says "0018 applied" after that, the database claims
 * tenant isolation it does not have. The runner therefore verifies the ledger against
 * the catalog on every invocation, and refuses to baseline 0018 unless these
 * constraints are verifiably present. See `run-migration.js` and
 * `docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md`.
 *
 * `tests/migration-tenant-constraint-integrity.test.ts` asserts that this list and the
 * SQL migration file never drift apart.
 */

/**
 * One composite tenant foreign key.
 *
 * @typedef {object} CompositeTenantForeignKey
 * @property {string} childTable     table holding the referencing column
 * @property {string} childColumn    the referencing column
 * @property {string} parentTable    table holding the referenced record
 * @property {string} constraintName  PostgreSQL constraint name
 * @property {string} deleteAction   `NO ACTION` / `SET NULL` / `CASCADE`
 * @property {string} deleteColumns  column list for the selective `SET NULL` form
 * @property {string} deleteCode     pg_constraint.confdeltype: a=NO ACTION, n=SET NULL, c=CASCADE
 */

/** @type {readonly CompositeTenantForeignKey[]} */
const COMPOSITE_TENANT_FOREIGN_KEYS = Object.freeze([
  { childTable: "terms", childColumn: "academic_year_id", parentTable: "academic_years", constraintName: "terms_school_academic_year_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "classes", childColumn: "academic_year_id", parentTable: "academic_years", constraintName: "classes_school_academic_year_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "subjects", childColumn: "department_id", parentTable: "departments", constraintName: "subjects_school_department_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "teacher_classes", childColumn: "class_id", parentTable: "classes", constraintName: "teacher_classes_school_class_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "teacher_classes", childColumn: "subject_id", parentTable: "subjects", constraintName: "teacher_classes_school_subject_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "teacher_classes", childColumn: "academic_year_id", parentTable: "academic_years", constraintName: "teacher_classes_school_academic_year_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "learner_classes", childColumn: "class_id", parentTable: "classes", constraintName: "learner_classes_school_class_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "learner_classes", childColumn: "academic_year_id", parentTable: "academic_years", constraintName: "learner_classes_school_academic_year_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "assignments", childColumn: "class_id", parentTable: "classes", constraintName: "assignments_school_class_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "assignments", childColumn: "subject_id", parentTable: "subjects", constraintName: "assignments_school_subject_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "assignments", childColumn: "term_id", parentTable: "terms", constraintName: "assignments_school_term_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "submissions", childColumn: "assignment_id", parentTable: "assignments", constraintName: "submissions_school_assignment_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "uploaded_files", childColumn: "assignment_id", parentTable: "assignments", constraintName: "uploaded_files_school_assignment_fk", deleteAction: "SET NULL", deleteColumns: " (assignment_id)", deleteCode: "n" },
  { childTable: "resources", childColumn: "class_id", parentTable: "classes", constraintName: "resources_school_class_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "resources", childColumn: "subject_id", parentTable: "subjects", constraintName: "resources_school_subject_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "resources", childColumn: "term_id", parentTable: "terms", constraintName: "resources_school_term_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "quizzes", childColumn: "class_id", parentTable: "classes", constraintName: "quizzes_school_class_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "quizzes", childColumn: "subject_id", parentTable: "subjects", constraintName: "quizzes_school_subject_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "quizzes", childColumn: "term_id", parentTable: "terms", constraintName: "quizzes_school_term_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "quiz_attempts", childColumn: "quiz_id", parentTable: "quizzes", constraintName: "quiz_attempts_school_quiz_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "announcements", childColumn: "class_id", parentTable: "classes", constraintName: "announcements_school_class_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "attendance", childColumn: "class_id", parentTable: "classes", constraintName: "attendance_school_class_fk", deleteAction: "NO ACTION", deleteColumns: "", deleteCode: "a" },
  { childTable: "timetable_entries", childColumn: "class_id", parentTable: "classes", constraintName: "timetable_entries_school_class_fk", deleteAction: "CASCADE", deleteColumns: "", deleteCode: "c" },
  { childTable: "timetable_entries", childColumn: "subject_id", parentTable: "subjects", constraintName: "timetable_entries_school_subject_fk", deleteAction: "SET NULL", deleteColumns: " (subject_id)", deleteCode: "n" },
  { childTable: "timetable_entries", childColumn: "term_id", parentTable: "terms", constraintName: "timetable_entries_school_term_fk", deleteAction: "SET NULL", deleteColumns: " (term_id)", deleteCode: "n" },
  { childTable: "timetable_entries", childColumn: "academic_year_id", parentTable: "academic_years", constraintName: "timetable_entries_school_academic_year_fk", deleteAction: "SET NULL", deleteColumns: " (academic_year_id)", deleteCode: "n" },
].map(Object.freeze));

/** Number of composite tenant foreign keys migration 0018 installs. */
const COMPOSITE_TENANT_FOREIGN_KEY_COUNT = COMPOSITE_TENANT_FOREIGN_KEYS.length;

/** The migration file that installs the constraints above. */
const COMPOSITE_TENANT_MIGRATION = "0018_composite_school_foreign_keys.sql";

/**
 * The 24 tables that migration 0017 gives a `UNIQUE (school_id, id)` target on.
 *
 * These are the unique keys migration 0018's composite foreign keys reference, and they
 * are what makes a composite foreign key to a school-scoped parent possible at all. A
 * schema sync that does not know about them drops them, which breaks 0018's
 * precondition and makes re-applying 0018 impossible.
 *
 * The names are kept here so the repair procedure can recreate a missing target with
 * the exact same definition 0017 used. `tests/migration-tenant-constraint-integrity.test.ts`
 * asserts that this list and migration 0017 never drift apart.
 */
const UNIQUE_SCHOOL_ID_TARGET_TABLES = Object.freeze([
  "academic_years",
  "announcements",
  "assignments",
  "attendance",
  "classes",
  "dashboard_card_overrides",
  "departments",
  "downloads",
  "faqs",
  "gallery_items",
  "learner_classes",
  "messages",
  "news",
  "notifications",
  "parent_learners",
  "quiz_attempts",
  "quizzes",
  "resources",
  "submissions",
  "subjects",
  "teacher_classes",
  "terms",
  "timetable_entries",
  "uploaded_files",
].map(Object.freeze));

/** The index name migration 0017 gives a table's `UNIQUE (school_id, id)` target. */
function uniqueTargetIndexName(table) {
  return `${table}_school_id_id_unique`;
}

/**
 * The idempotent DDL that recreates one missing `UNIQUE (school_id, id)` target.
 * Identical in shape to migration 0017's own statement, so re-creating it is a no-op
 * on a healthy database.
 */
function uniqueTargetIndexSql(table) {
  return `CREATE UNIQUE INDEX IF NOT EXISTS "${uniqueTargetIndexName(table)}" ON "${table}" USING btree ("school_id", "id");`;
}

/**
 * Read-only inventory of the 24 `UNIQUE (school_id, id)` targets: which exist, and
 * whether each is a valid, ready, unique btree over exactly `(school_id, id)`.
 */
const UNIQUE_TARGET_INVENTORY_SQL = `
WITH expected(table_name) AS (
  VALUES
${UNIQUE_SCHOOL_ID_TARGET_TABLES.map((table) => `    ('${table}')`).join(",\n")}
)
SELECT
  e.table_name,
  (c.oid IS NOT NULL) AS present,
  COALESCE(i.indisunique, false) AS is_unique,
  COALESCE(i.indisvalid, false) AS is_valid,
  COALESCE(i.indisready, false) AS is_ready,
  pg_get_indexdef(c.oid) AS definition
FROM expected e
LEFT JOIN pg_class c
  ON c.relname = e.table_name || '_school_id_id_unique'
 AND c.relnamespace = 'public'::regnamespace
LEFT JOIN pg_index i ON i.indexrelid = c.oid
ORDER BY e.table_name;
`;

/**
 * A single read-only catalog query that reports, for every expected constraint, whether
 * it exists and whether it matches the definition migration 0018 installs.
 *
 * The comparison mirrors the checks inside the migration itself (same constraint, same
 * parent relation, same child column pair, same parent column pair, same referential
 * actions) so the runner and the migration can never disagree about what "applied"
 * means. It is a pure SELECT: it never writes and never locks beyond a catalog read.
 */
const CONSTRAINT_INVENTORY_SQL = `
WITH expected(child_table, child_column, parent_table, constraint_name, delete_code) AS (
  VALUES
${COMPOSITE_TENANT_FOREIGN_KEYS.map(
  (key) =>
    `    ('${key.childTable}', '${key.childColumn}', '${key.parentTable}', '${key.constraintName}', '${key.deleteCode}')`,
).join(",\n")}
),
resolved AS (
  SELECT
    e.child_table,
    e.child_column,
    e.parent_table,
    e.constraint_name,
    e.delete_code,
    to_regclass(format('public.%I', e.child_table)) AS child_oid,
    to_regclass(format('public.%I', e.parent_table)) AS parent_oid,
    (SELECT attnum FROM pg_attribute
      WHERE attrelid = to_regclass(format('public.%I', e.child_table))
        AND attname = 'school_id' AND NOT attisdropped) AS child_school_att,
    (SELECT attnum FROM pg_attribute
      WHERE attrelid = to_regclass(format('public.%I', e.child_table))
        AND attname = e.child_column AND NOT attisdropped) AS child_ref_att,
    (SELECT attnum FROM pg_attribute
      WHERE attrelid = to_regclass(format('public.%I', e.parent_table))
        AND attname = 'school_id' AND NOT attisdropped) AS parent_school_att,
    (SELECT attnum FROM pg_attribute
      WHERE attrelid = to_regclass(format('public.%I', e.parent_table))
        AND attname = 'id' AND NOT attisdropped) AS parent_id_att
  FROM expected e
)
SELECT
  r.child_table,
  r.child_column,
  r.parent_table,
  r.constraint_name,
  (c.oid IS NOT NULL) AS present,
  COALESCE(c.convalidated, false) AS validated,
  pg_get_constraintdef(c.oid) AS definition,
  CASE
    WHEN c.oid IS NULL THEN 'missing'
    WHEN c.contype <> 'f' THEN 'not a foreign key'
    WHEN NOT c.convalidated THEN 'not validated'
    WHEN c.confrelid IS DISTINCT FROM r.parent_oid THEN 'references the wrong parent table'
    WHEN r.child_school_att IS NULL OR r.child_ref_att IS NULL THEN 'child column missing'
    WHEN c.conkey IS DISTINCT FROM ARRAY[r.child_school_att, r.child_ref_att]::smallint[]
      THEN 'wrong child columns'
    WHEN r.parent_school_att IS NULL OR r.parent_id_att IS NULL THEN 'parent column missing'
    WHEN c.confkey IS DISTINCT FROM ARRAY[r.parent_school_att, r.parent_id_att]::smallint[]
      THEN 'wrong parent columns'
    WHEN c.confdeltype IS DISTINCT FROM r.delete_code THEN 'wrong ON DELETE action'
    WHEN c.confupdtype IS DISTINCT FROM 'a' THEN 'unexpected ON UPDATE action'
    WHEN c.confmatchtype IS DISTINCT FROM 's' THEN 'unexpected MATCH type'
    ELSE NULL
  END AS problem
FROM resolved r
LEFT JOIN pg_constraint c
  ON c.conrelid = r.child_oid
 AND c.conname = r.constraint_name
ORDER BY r.child_table, r.child_column;
`;

/**
 * @typedef {object} ConstraintInventoryRow
 * @property {string} child_table
 * @property {string} child_column
 * @property {string} parent_table
 * @property {string} constraint_name
 * @property {boolean} present
 * @property {boolean} validated
 * @property {string | null} definition
 * @property {string | null} problem
 */

/**
 * @typedef {object} ConstraintInventory
 * @property {number} expected   how many constraints 0018 installs
 * @property {number} present    how many were found in the catalog
 * @property {number} valid      how many were found AND correct
 * @property {boolean} complete  true when every expected constraint is present and correct
 * @property {string[]} problems  human-readable description of every problem found
 */

/**
 * Turn catalog rows into a verdict. Kept pure and dependency-free so the same logic
 * runs in the migration runner, in the application and in the tests.
 *
 * @param {ConstraintInventoryRow[]} rows
 * @returns {ConstraintInventory}
 */
function summarizeConstraintInventory(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const problems = [];
  let present = 0;
  let valid = 0;

  for (const row of list) {
    if (row.present) present += 1;
    if (row.problem) {
      problems.push(
        row.problem === "missing"
          ? `missing constraint ${row.constraint_name} on public.${row.child_table}`
          : `constraint ${row.constraint_name} on public.${row.child_table} is ${row.problem}`
      );
      continue;
    }
    if (row.present && row.validated) valid += 1;
    else if (row.present) {
      problems.push(`constraint ${row.constraint_name} on public.${row.child_table} is not validated`);
    }
  }

  const expected = COMPOSITE_TENANT_FOREIGN_KEY_COUNT;
  /* A short result set means the catalog query itself did not cover every expectation. */
  if (list.length !== expected) {
    problems.push(
      `catalog query returned ${list.length} of ${expected} expected constraints`
    );
  }

  return {
    expected,
    present,
    valid,
    complete: problems.length === 0 && list.length === expected,
    problems,
  };
}

/** The constraint names migration 0018 installs. */
function compositeConstraintNames() {
  return COMPOSITE_TENANT_FOREIGN_KEYS.map((key) => key.constraintName);
}

/**
 * A one-line, operator-facing description of a broken constraint inventory. Used in
 * error messages so the failure names the exact objects that must be repaired.
 *
 * @param {ConstraintInventory} inventory
 * @param {number} [maxProblems]
 * @returns {string}
 */
function describeConstraintProblems(inventory, maxProblems = 6) {
  const shown = inventory.problems.slice(0, maxProblems);
  const remaining = inventory.problems.length - shown.length;
  const lines = shown.map((problem) => `  - ${problem}`);
  if (remaining > 0) lines.push(`  - ... and ${remaining} more`);
  return lines.join("\n");
}

module.exports = {
  COMPOSITE_TENANT_FOREIGN_KEYS,
  COMPOSITE_TENANT_FOREIGN_KEY_COUNT,
  COMPOSITE_TENANT_MIGRATION,
  CONSTRAINT_INVENTORY_SQL,
  UNIQUE_SCHOOL_ID_TARGET_TABLES,
  UNIQUE_TARGET_INVENTORY_SQL,
  compositeConstraintNames,
  describeConstraintProblems,
  summarizeConstraintInventory,
  uniqueTargetIndexName,
  uniqueTargetIndexSql,
};
