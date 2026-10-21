const { Pool } = require("pg");
require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  createPostgresConnectionConfig,
  getDatabaseUrlFromEnvironment,
} = require("./src/lib/postgres-tls.js");
const {
  COMPOSITE_TENANT_FOREIGN_KEYS,
  COMPOSITE_TENANT_FOREIGN_KEY_COUNT,
  COMPOSITE_TENANT_MIGRATION,
  CONSTRAINT_INVENTORY_SQL,
  UNIQUE_SCHOOL_ID_TARGET_TABLES,
  UNIQUE_TARGET_INVENTORY_SQL,
  describeConstraintProblems,
  summarizeConstraintInventory,
  uniqueTargetIndexSql,
} = require("./src/lib/tenant-constraints.js");

const MIGRATIONS = [
  "0000_wet_legion.sql",
  "0001_assignment_grading.sql",
  "0002_optional_email.sql",
  "0003_timetable.sql",
  "0004_dashboard_overrides.sql",
  "0005_activity_enhancements.sql",
  "0006_user_identity_columns.sql",
  "0007_quiz_images.sql",
  "0008_easyai_grading.sql",
  "0009_file_uploads.sql",
  "0010_object_storage.sql",
  "0011_attendance_unique_constraint.sql",
  "0012_login_attempts.sql",
  "0013_multi_school_foundation.sql",
  "0014_drop_single_school_guard.sql",
  "0015_cbism_school_and_membership_backfill.sql",
  "0016_school_id_columns.sql",
  "0017_school_id_not_null.sql",
  "0018_composite_school_foreign_keys.sql",
];

const HISTORY_TABLE = "easylearn_schema_migrations";
const HISTORY_SQL = `
  CREATE TABLE IF NOT EXISTS public.${HISTORY_TABLE} (
    filename text PRIMARY KEY,
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;
const BASELINE_CONFIRMATION = "I_HAVE_VERIFIED_THESE_MIGRATIONS";
const REPAIR_CONFIRMATION = "I_HAVE_VERIFIED_THE_DATABASE_NEEDS_REPAIR";

/* ── Gated migrations ──
   Some migrations must never be applied as part of an ordinary "apply everything" run.
   They change the database in a way that requires an independent, reviewed preflight
   against a restored copy of the target database first, and they abort atomically
   rather than repairing data.

   A gated migration is applied ONLY when the operator
     1. names that file explicitly on the command line, and
     2. supplies the confirmation token for that file.
   A default run skips it and says so loudly. It never fails the run, because that would
   pressure operators into setting the token to unblock an unrelated deployment. */
const GATED_MIGRATIONS = {
  "0018_composite_school_foreign_keys.sql": {
    env: "CONFIRM_MIGRATION_0018",
    token: "I_HAVE_VERIFIED_THE_COMPOSITE_TENANT_FOREIGN_KEYS",
    reason:
      "0018 adds 26 composite tenant foreign keys between school-owned records. It aborts " +
      "atomically on any legacy cross-school or orphan reference and never repairs, " +
      "reassigns or deletes rows. The selective column-list SET NULL syntax requires " +
      "PostgreSQL 15+. Before applying it, run the read-only preflight in " +
      "docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md against a restored copy of the " +
      "target database, confirm the PostgreSQL version and the table/lock impact, and " +
      "review the result.",
  },
};

// Every PostgreSQL connection made by the migration runner goes through the same verified
// TLS policy as the application pool: certificate AND hostname validation, with the
// `pg-connection-string` sslmode downgrade neutralized. The only escape hatch is the
// explicit disposable-test opt-in, which is never set for a production invocation.
const databaseUrl = getDatabaseUrlFromEnvironment(process.env);

function buildPoolConfig() {
  if (!databaseUrl) {
    throw new Error("A PostgreSQL connection string is required to run EasyLearn migrations");
  }

  return createPostgresConnectionConfig(databaseUrl, {
    // CI/disposable database suites explicitly set this flag. It must never be set for a
    // production migration invocation; the default is verified certificate + hostname TLS.
    allowInsecureLocal: process.env.EASY_LEARN_TEST_DATABASE === "true",
  });
}

function usage() {
  console.log(`Usage:
  node run-migration.js [migration.sql]
  node run-migration.js --baseline migration1.sql,migration2.sql,...

Normal runs apply only unapplied migrations in order, recording their SHA-256 checksums.
A database with existing public tables but no history is never migrated automatically.
For an existing database, baseline only a verified, sequential prefix using --baseline and
CONFIRM_MIGRATION_BASELINE=${BASELINE_CONFIRMATION}. Baseline records operator-provided
history; it does not inspect or prove that those migrations were applied.

Gated migrations are never applied by a default run. They need an explicit file name and
their own confirmation token:
${Object.entries(GATED_MIGRATIONS)
  .map(
    ([fileName, gate]) =>
      `  ${fileName}\n    ${gate.env}=${gate.token} node run-migration.js ${fileName}`
  )
  .join("\n")}

Recovery after an unauthorized schema sync (for example \`drizzle-kit push\`, which drops
the composite tenant foreign keys, the ledger and some 0017 unique targets):
  node run-migration.js --repair-tenant-integrity
    CONFIRM_REPAIR_TENANT_INTEGRITY=${REPAIR_CONFIRMATION} node run-migration.js --repair-tenant-integrity
  It restores the missing 0017 UNIQUE targets and clears a false ledger claim. It never
  creates the composite foreign keys: re-apply ${COMPOSITE_TENANT_MIGRATION} under its gate.

Never run \`drizzle-kit push\` against a database this repository manages. It cannot express
a composite foreign key and therefore drops the ${COMPOSITE_TENANT_FOREIGN_KEY_COUNT} tenant
constraints that ${COMPOSITE_TENANT_MIGRATION} installs. See
docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md.`);
}

function migrationPath(fileName) {
  if (!MIGRATIONS.includes(fileName)) {
    throw new Error(`Unknown migration: ${fileName}`);
  }
  const rootPath = path.join(__dirname, fileName);
  const drizzlePath = path.join(__dirname, "drizzle", fileName);
  const selectedPath = fs.existsSync(rootPath) ? rootPath : drizzlePath;
  if (!fs.existsSync(selectedPath)) throw new Error(`Migration file is missing: ${fileName}`);
  return selectedPath;
}

function loadMigration(fileName) {
  const sql = fs.readFileSync(migrationPath(fileName), "utf8");
  if (!sql.trim()) throw new Error(`Migration file is empty: ${fileName}`);
  return {
    sql,
    checksum: crypto.createHash("sha256").update(sql, "utf8").digest("hex"),
  };
}

function parseArgs(args) {
  if (args.length === 0) return { mode: "run", files: MIGRATIONS, explicit: false };
  if (args[0] === "--help" || args[0] === "-h") return { mode: "help", files: [], explicit: false };
  if (args[0] === "--repair-tenant-integrity") {
    if (args.length !== 1) throw new Error("--repair-tenant-integrity takes no arguments");
    return { mode: "repair-tenant-integrity", files: [], explicit: false };
  }
  if (args[0] === "--baseline") {
    if (args.length !== 2 || !args[1]) {
      throw new Error("--baseline requires a comma-separated migration prefix");
    }
    return { mode: "baseline", files: args[1].split(","), explicit: false };
  }
  if (args.length !== 1) throw new Error("Pass one migration filename, or use --baseline");
  /* A single, explicitly named file. Only this form may apply a gated migration. */
  return { mode: "run", files: [args[0]], explicit: true };
}

function assertSequentialPrefix(files) {
  if (files.length === 0) throw new Error("The migration prefix cannot be empty");
  const expected = MIGRATIONS.slice(0, files.length);
  if (files.length > MIGRATIONS.length || files.some((file, i) => file !== expected[i])) {
    throw new Error("Migration history must be a sequential prefix of the registered migration list");
  }
}

/**
 * The order must stay exact: nothing may be applied after a gated migration that was
 * skipped, because the skipped migration may change the shape of the later ones.
 *
 * This is a PURE function, extracted from the run loop so it can be tested directly.
 * With the migration list as it stands (0018 is the last registered migration) no
 * end-to-end run can reach the guard — an untested branch is a branch that eventually gets
 * deleted, and this one becomes load-bearing the moment a migration is registered after
 * 0018. See tests/migration-tenant-constraint-integrity.test.ts.
 *
 * @param {string[]} toApply      the migrations that are about to be applied
 * @param {string[]} skippedGated  the gated migrations that were skipped on purpose
 * @param {string[]} [orderedList] the registered order; the real runner always uses
 *                                 MIGRATIONS, and a test may pass a synthetic list that
 *                                 contains a migration registered after the gated one
 * @returns {{blocked: string, skipped: string}|null} the violation, or null when the order is fine
 */
function findOrderingViolation(toApply, skippedGated, orderedList = MIGRATIONS) {
  if (!Array.isArray(skippedGated) || skippedGated.length === 0) return null;
  const order = Array.isArray(orderedList) ? orderedList : MIGRATIONS;
  const skippedIndex = Math.min(...skippedGated.map((fileName) => order.indexOf(fileName)));
  const afterSkipped = toApply.filter((fileName) => order.indexOf(fileName) > skippedIndex);
  if (afterSkipped.length === 0) return null;
  return { blocked: afterSkipped[0], skipped: skippedGated[0] };
}

async function hasPublicApplicationObjects(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND c.relname <> $1
    ) AS has_objects
  `, [HISTORY_TABLE]);
  return result.rows[0].has_objects;
}

async function historyExists(client) {
  const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${HISTORY_TABLE}`]);
  return result.rows[0].present;
}

async function ensureHistoryTable(client) {
  await client.query(HISTORY_SQL);
  // Fail closed if an unrelated or manually-created table occupies our ledger name.
  await client.query(`SELECT filename, checksum, applied_at FROM public.${HISTORY_TABLE} LIMIT 0`);
}

async function readHistory(client) {
  const result = await client.query(
    `SELECT filename, checksum FROM public.${HISTORY_TABLE} ORDER BY filename`
  );
  return new Map(result.rows.map((row) => [row.filename, row.checksum]));
}

function assertHistoryMatchesFiles(history) {
  let sawPending = false;
  for (const fileName of MIGRATIONS) {
    const recordedChecksum = history.get(fileName);
    if (recordedChecksum === undefined) {
      sawPending = true;
      continue;
    }
    if (sawPending) {
      throw new Error(`Migration history has a gap before ${fileName}; refusing to guess migration order`);
    }
    const { checksum } = loadMigration(fileName);
    if (recordedChecksum !== checksum) {
      throw new Error(`Checksum mismatch for applied migration ${fileName}; restore the reviewed SQL or reconcile history explicitly`);
    }
  }
  for (const fileName of history.keys()) {
    if (!MIGRATIONS.includes(fileName)) throw new Error(`Unrecognized migration recorded in history: ${fileName}`);
  }
}

/* ── Tenant constraint integrity ──
   The migration ledger records what the runner did. It does not, on its own, prove that
   the database still has the objects that migration installed.

   That distinction matters here. `drizzle-kit push` diffs the live database against
   src/db/schema.ts, which cannot express a composite foreign key, so it treats all
   ${COMPOSITE_TENANT_FOREIGN_KEY_COUNT} constraints of ${COMPOSITE_TENANT_MIGRATION} as
   unknown objects and drops them — together with the ledger table and 17 of the 24
   UNIQUE (school_id, id) targets. If the ledger survived that, the database would
   claim tenant isolation it does not enforce.

   So the runner verifies the ledger against the catalog on every invocation, and the
   baseline procedure refuses to certify ${COMPOSITE_TENANT_MIGRATION} unless those
   constraints are verifiably present. */

async function readConstraintInventory(client) {
  const result = await client.query(CONSTRAINT_INVENTORY_SQL);
  return summarizeConstraintInventory(result.rows);
}

async function readUniqueTargetInventory(client) {
  const result = await client.query(UNIQUE_TARGET_INVENTORY_SQL);
  return result.rows;
}

function missingUniqueTargets(rows) {
  return rows
    .filter((row) => !row.present || !row.is_unique || !row.is_valid || !row.is_ready)
    .map((row) => row.table_name);
}

/**
 * Fail closed when the ledger says a gated tenant migration ran but the catalog says
 * otherwise. The message names the exact objects that must be repaired and the exact
 * recovery command, so the operator never has to guess.
 */
function assertTenantConstraintIntegrity(inventory, history) {
  if (!history.has(COMPOSITE_TENANT_MIGRATION)) return;
  if (inventory.complete) return;

  const gate = GATED_MIGRATIONS[COMPOSITE_TENANT_MIGRATION];
  const reapply = gate
    ? `${gate.env}=${gate.token} node run-migration.js ${COMPOSITE_TENANT_MIGRATION}`
    : `node run-migration.js ${COMPOSITE_TENANT_MIGRATION}`;

  throw new Error(
    `Migration history records ${COMPOSITE_TENANT_MIGRATION} as applied, but the database does ` +
      `not have the ${inventory.expected} composite tenant foreign keys it installs ` +
      `(${inventory.valid} of ${inventory.expected} are present and correct).\n` +
      `${describeConstraintProblems(inventory)}\n` +
      "   The ledger and the catalog disagree, so the tenant boundary is NOT enforced. " +
      "A schema-sync tool (for example `drizzle-kit push`) causes this, because " +
      "src/db/schema.ts cannot express a composite foreign key and push therefore drops " +
      "constraints it does not know about.\n" +
      "   Do NOT run `drizzle-kit push` against this database. Recover with:\n" +
      "     node run-migration.js --repair-tenant-integrity   # restore the 0017 UNIQUE targets, clear the false ledger claim\n" +
      `     ${reapply}\n` +
      "   See docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md for the full recovery procedure."
  );
}

async function baseline(client, files) {
  assertSequentialPrefix(files);
  if (process.env.CONFIRM_MIGRATION_BASELINE !== BASELINE_CONFIRMATION) {
    throw new Error(`Baseline refused: set CONFIRM_MIGRATION_BASELINE=${BASELINE_CONFIRMATION} only after independently verifying the database migration history`);
  }
  /* A baseline records an operator-asserted history. It must not be usable to record a
     GATED migration as applied without the same explicit confirmation that the gated
     path requires — otherwise the ledger would claim a migration ran that never did. */
  for (const fileName of files) {
    const gate = GATED_MIGRATIONS[fileName];
    if (!gate) continue;
    if (process.env[gate.env] !== gate.token) {
      throw new Error(
        `Baseline refused: the prefix includes the gated migration ${fileName}.\n` +
          `   ${gate.reason}\n` +
          `   Set ${gate.env}=${gate.token} to confirm that the preflight has been reviewed ` +
          "and that the migration really was applied to this database."
      );
    }
  }
  /* A confirmation token says the operator reviewed the preflight. It must not be usable
     to certify a schema that does not actually have the migration's constraints: a
     baseline that claims ${COMPOSITE_TENANT_MIGRATION} is applied while the composite
     tenant foreign keys are absent is exactly the false state this check exists to
     prevent. The catalog, not the token, decides. */
  if (files.includes(COMPOSITE_TENANT_MIGRATION)) {
    const inventory = await readConstraintInventory(client);
    if (!inventory.complete) {
      const gate = GATED_MIGRATIONS[COMPOSITE_TENANT_MIGRATION];
      const applyCommand = gate
        ? `${gate.env}=${gate.token} node run-migration.js ${COMPOSITE_TENANT_MIGRATION}`
        : `node run-migration.js ${COMPOSITE_TENANT_MIGRATION}`;
      throw new Error(
        `Baseline refused: the prefix includes ${COMPOSITE_TENANT_MIGRATION}, but this database ` +
          `does not have the ${inventory.expected} composite tenant foreign keys it installs ` +
          `(${inventory.valid} of ${inventory.expected} are present and correct).\n` +
          `${describeConstraintProblems(inventory)}\n` +
          "   A baseline may record an assertion about migration HISTORY, but it may not " +
          "certify a schema that does not have the objects the migration installs.\n" +
          `   Apply ${COMPOSITE_TENANT_MIGRATION} first (${applyCommand}), or baseline a ` +
          "prefix that stops before it."
      );
    }
  }
  if (await historyExists(client)) {
    throw new Error(`Baseline refused: public.${HISTORY_TABLE} already exists`);
  }
  if (!(await hasPublicApplicationObjects(client))) {
    throw new Error("Baseline refused: the public schema is empty; run the normal migration command instead");
  }

  const entries = files.map((filename) => ({ filename, checksum: loadMigration(filename).checksum }));
  await client.query("BEGIN");
  try {
    await ensureHistoryTable(client);
    for (const entry of entries) {
      await client.query(
        `INSERT INTO public.${HISTORY_TABLE} (filename, checksum) VALUES ($1, $2)`,
        [entry.filename, entry.checksum]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  console.log(`\n⚠️  Recorded operator-asserted baseline for ${entries.length} migration(s); no migration SQL was executed.`);
  console.log("   This ledger records the supplied assertion and is not evidence that the database was inspected.");
}

/**
 * Controlled recovery for the damage an unauthorized schema sync causes.
 *
 * It can only ever make the database MORE truthful:
 *   1. it recreates a `UNIQUE (school_id, id)` target that migration 0017 defines and that
 *      a schema sync dropped, using 0017's exact idempotent statement, and
 *   2. it removes a ledger row for ${COMPOSITE_TENANT_MIGRATION} when the composite tenant
 *      foreign keys that migration installs are demonstrably absent, so the ledger stops
 *      claiming something the database does not have.
 *
 * It never creates the composite foreign keys themselves. That stays behind the 0018
 * gate, so the reviewed preflight is still required.
 */
async function repairTenantIntegrity(client) {
  if (process.env.CONFIRM_REPAIR_TENANT_INTEGRITY !== REPAIR_CONFIRMATION) {
    throw new Error(
      `Repair refused: set CONFIRM_REPAIR_TENANT_INTEGRITY=${REPAIR_CONFIRMATION} to confirm ` +
        "that this database was damaged by an unauthorized schema sync and that the repair " +
        "should run."
    );
  }

  const inventory = await readConstraintInventory(client);
  const targetRows = await readUniqueTargetInventory(client);
  const missingTargets = missingUniqueTargets(targetRows);

  console.log("\n🔎 Tenant integrity before repair:");
  console.log(
    `   composite tenant foreign keys: ${inventory.valid}/${inventory.expected} present and correct`
  );
  console.log(
    `   UNIQUE (school_id, id) targets: ${UNIQUE_SCHOOL_ID_TARGET_TABLES.length - missingTargets.length}/` +
      `${UNIQUE_SCHOOL_ID_TARGET_TABLES.length} present`
  );
  if (inventory.problems.length > 0) {
    console.log(describeConstraintProblems(inventory, 10));
  }

  const history = await historyExists(client) ? await readHistory(client) : new Map();
  const ledgerClaimsTenantMigration = history.has(COMPOSITE_TENANT_MIGRATION);

  await client.query("BEGIN");
  try {
    for (const table of missingTargets) {
      await client.query(uniqueTargetIndexSql(table));
      console.log(`   ✅ restored UNIQUE (school_id, id) target on public.${table}`);
    }
    if (ledgerClaimsTenantMigration && !inventory.complete) {
      /* The ledger claims a migration whose constraints are not there. Dropping the row
         makes the claim true again — 0018 becomes pending and is re-applied under its
         own gate, with its own preflight. */
      await client.query(
        `DELETE FROM public.${HISTORY_TABLE} WHERE filename = $1`,
        [COMPOSITE_TENANT_MIGRATION]
      );
      console.log(
        `   ✅ removed the false ledger claim for ${COMPOSITE_TENANT_MIGRATION} ` +
          "(the migration is pending again)"
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  console.log("\n✅ Tenant integrity repair finished.");
  if (!inventory.complete) {
    const gate = GATED_MIGRATIONS[COMPOSITE_TENANT_MIGRATION];
    const reapply = gate
      ? `${gate.env}=${gate.token} node run-migration.js ${COMPOSITE_TENANT_MIGRATION}`
      : `node run-migration.js ${COMPOSITE_TENANT_MIGRATION}`;
    console.log(
      `   The composite tenant foreign keys are still missing. Re-apply them under the normal gate:\n` +
        `     ${reapply}`
    );
  } else {
    console.log("   The composite tenant foreign keys are intact; the ledger was left unchanged.");
  }
  console.log(
    "   Re-run the read-only checkpoint in docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md " +
      "to confirm the repaired state."
  );
}

async function applyMigration(client, fileName) {  const { sql, checksum } = loadMigration(fileName);
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  console.log(`\n📋 Applying ${fileName} (${statements.length} statement block(s))...`);
  await client.query("BEGIN");
  try {
    for (let i = 0; i < statements.length; i++) {
      await client.query(statements[i]);
      const firstLine = statements[i].split("\n")[0].slice(0, 100);
      console.log(`  ✅ ${i + 1}: ${firstLine}...`);
    }
    await client.query(
      `INSERT INTO public.${HISTORY_TABLE} (filename, checksum) VALUES ($1, $2)`,
      [fileName, checksum]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(`${fileName} rolled back: ${error.message}`);
  }
}

async function verify(client) {
  const verifyRes = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN ('timetable_entries','dashboard_card_overrides','activity_logs','schools','school_users')
    ORDER BY table_name;
  `);
  console.log("\n✅ Verification - Key tables:");
  verifyRes.rows.forEach((row) => console.log(`   - ${row.table_name}`));

  const columnRes = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
      AND column_name IN ('username','must_change_password')
    ORDER BY column_name;
  `);
  console.log(
    "\n✅ Verification - users identity columns:",
    columnRes.rows.map((row) => row.column_name).join(", ") || "MISSING (0006 not applied)"
  );

  const activityRes = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='activity_logs'
      AND column_name IN ('entity_type','entity_id','description')
    ORDER BY column_name;
  `);
  console.log(
    "✅ Verification - activity_logs enrichment:",
    activityRes.rows.map((row) => row.column_name).join(", ") || "MISSING (0005 not applied)"
  );

  try {
    const tenantRes = await client.query(`
      SELECT
        (SELECT count(*)::int FROM schools WHERE slug = 'cbism') AS cbism_schools,
        (SELECT count(*)::int FROM users WHERE role <> 'super_admin') AS eligible_users,
        (SELECT count(*)::int FROM users WHERE role = 'super_admin') AS excluded_super_admins,
        (SELECT count(*)::int FROM school_users su
           JOIN schools s ON s.id = su.school_id
          WHERE s.slug = 'cbism') AS cbism_memberships,
        (SELECT count(*)::int FROM school_users su
           JOIN schools s ON s.id = su.school_id
          WHERE s.slug = 'cbism' AND su.status = 'active') AS cbism_active_memberships;
    `);
    const tenant = tenantRes.rows[0] || {};
    console.log(
      "\n✅ Verification - Phase 2B tenant membership:",
      `cbism schools=${tenant.cbism_schools}`,
      `eligible users=${tenant.eligible_users}`,
      `memberships=${tenant.cbism_memberships} (active ${tenant.cbism_active_memberships})`,
      `super_admins excluded=${tenant.excluded_super_admins}`
    );
    if (tenant.cbism_schools > 1) {
      console.log("   ⚠️  more than one 'cbism' school row - investigate before Phase 2C");
    } else if (tenant.cbism_schools === 0) {
      console.log("   ⚠️  no 'cbism' school row (0015 not applied)");
    } else if (tenant.cbism_memberships < tenant.eligible_users) {
      console.log(`   ⚠️  ${tenant.eligible_users - tenant.cbism_memberships} eligible user(s) have no CBISM membership`);
    }
  } catch (error) {
    console.log(`ℹ️  Verification - Phase 2B tenant membership: skipped (${error.message.slice(0, 120)})`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.mode === "help") {
      usage();
      return;
    }
    if (options.mode === "baseline") assertSequentialPrefix(options.files);
    else options.files.forEach(migrationPath);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    usage();
    process.exitCode = 1;
    return;
  }

  if (!databaseUrl) {
    console.error("❌ DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    ...buildPoolConfig(),
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    max: 1,
  });
  let client;
  let lockHeld = false;
  try {
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock($1, $2)", [1163416649, 1296125510]);
    lockHeld = true;
    client.on("notice", (notice) => {
      if (notice && notice.message) console.log(`  ℹ️  ${notice.message}`);
    });
    console.log("✅ Connected to database; migration lock acquired.");

    if (options.mode === "baseline") {
      await baseline(client, options.files);
      return;
    }

    if (options.mode === "repair-tenant-integrity") {
      await repairTenantIntegrity(client);
      return;
    }

    const hadHistory = await historyExists(client);
    if (!hadHistory && await hasPublicApplicationObjects(client)) {
      throw new Error(
        `Existing public tables were found without ${HISTORY_TABLE}. Refusing to replay migrations. ` +
        "Verify the applied migration prefix independently, then use the explicit --baseline procedure in the operator documentation."
      );
    }
    await ensureHistoryTable(client);
    const history = await readHistory(client);
    assertHistoryMatchesFiles(history);

    /* Fail closed before doing any more work if the ledger already disagrees with the
       catalog about the tenant constraints. Continuing would apply further migrations on
       top of a database that no longer enforces tenant ownership. */
    if (history.has(COMPOSITE_TENANT_MIGRATION)) {
      assertTenantConstraintIntegrity(await readConstraintInventory(client), history);
    }

    const selected = options.files;
    const pending = selected.filter((fileName) => !history.has(fileName));

    /* Split the pending set: ordinary migrations, and gated ones that need an explicit
       name plus a confirmation token before they may touch the database. */
    const toApply = [];
    const skippedGated = [];
    for (const fileName of pending) {
      const gate = GATED_MIGRATIONS[fileName];
      if (!gate) {
        toApply.push(fileName);
        continue;
      }
      if (!options.explicit) {
        skippedGated.push(fileName);
        continue;
      }
      if (process.env[gate.env] !== gate.token) {
        throw new Error(
          `Refusing to apply ${fileName}.\n` +
            `   ${gate.reason}\n` +
            `   Set ${gate.env}=${gate.token} to confirm that the preflight has been reviewed.`
        );
      }
      toApply.push(fileName);
    }

    /* The order must stay exact: nothing may be applied after a gated migration that was
       skipped, because the skipped migration may change the shape of the later ones. */
    const orderingViolation = findOrderingViolation(toApply, skippedGated);
    if (orderingViolation) {
      throw new Error(
        `Cannot apply ${orderingViolation.blocked} because the gated migration ${orderingViolation.skipped} was skipped; ` +
          "apply the gated migration first, in order."
      );
    }

    if (pending.length === 0) {
      console.log("✅ All requested migrations are already recorded with matching checksums.");
    } else {
      const firstIndex = MIGRATIONS.indexOf(toApply[0] ?? pending[0]);
      const priorMissing = MIGRATIONS.slice(0, firstIndex).find((fileName) => !history.has(fileName));
      if (priorMissing) throw new Error(`Cannot apply ${toApply[0] ?? pending[0]} before ${priorMissing}`);
      for (const fileName of toApply) await applyMigration(client, fileName);
    }

    /* Re-verify the ledger against the catalog after applying. A migration that recorded
       itself but did not leave the expected objects behind must not pass silently. */
    const finalHistory = await readHistory(client);
    if (finalHistory.has(COMPOSITE_TENANT_MIGRATION)) {
      const inventory = await readConstraintInventory(client);
      assertTenantConstraintIntegrity(inventory, finalHistory);
      console.log(
        `\n✅ Verification - composite tenant foreign keys: ${inventory.valid}/${inventory.expected} present, validated and correct.`
      );
    }

    for (const fileName of skippedGated) {
      const gate = GATED_MIGRATIONS[fileName];
      console.log(`\n⚠️  GATED MIGRATION NOT APPLIED: ${fileName}`);
      console.log(`   ${gate.reason}`);
      console.log("   It was skipped on purpose. To apply it after the preflight has been reviewed:");
      console.log(`     ${gate.env}=${gate.token} node run-migration.js ${fileName}`);
    }

    await verify(client);
    console.log("\n🎉 Migration complete!");
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (client) {
      if (lockHeld) await client.query("SELECT pg_advisory_unlock($1, $2)", [1163416649, 1296125510]).catch(() => {});
      client.release();
    }
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

/* Exported for the disposable test suites and for operator tooling. The metadata is
   static; requiring this module does NOT run a migration. */
module.exports = {
  BASELINE_CONFIRMATION,
  GATED_MIGRATIONS,
  HISTORY_TABLE,
  MIGRATIONS,
  REPAIR_CONFIRMATION,
  findOrderingViolation,
};
