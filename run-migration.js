const { Pool } = require("pg");
require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

function usage() {
  console.log(`Usage:
  node run-migration.js [migration.sql]
  node run-migration.js --baseline migration1.sql,migration2.sql,...

Normal runs apply only unapplied migrations in order, recording their SHA-256 checksums.
A database with existing public tables but no history is never migrated automatically.
For an existing database, baseline only a verified, sequential prefix using --baseline and
CONFIRM_MIGRATION_BASELINE=${BASELINE_CONFIRMATION}. Baseline records operator-provided
history; it does not inspect or prove that those migrations were applied.`);
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
  if (args.length === 0) return { mode: "run", files: MIGRATIONS };
  if (args[0] === "--help" || args[0] === "-h") return { mode: "help", files: [] };
  if (args[0] === "--baseline") {
    if (args.length !== 2 || !args[1]) {
      throw new Error("--baseline requires a comma-separated migration prefix");
    }
    return { mode: "baseline", files: args[1].split(",") };
  }
  if (args.length !== 1) throw new Error("Pass one migration filename, or use --baseline");
  return { mode: "run", files: [args[0]] };
}

function assertSequentialPrefix(files) {
  if (files.length === 0) throw new Error("The migration prefix cannot be empty");
  const expected = MIGRATIONS.slice(0, files.length);
  if (files.length > MIGRATIONS.length || files.some((file, i) => file !== expected[i])) {
    throw new Error("Migration history must be a sequential prefix of the registered migration list");
  }
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

async function baseline(client, files) {
  assertSequentialPrefix(files);
  if (process.env.CONFIRM_MIGRATION_BASELINE !== BASELINE_CONFIRMATION) {
    throw new Error(`Baseline refused: set CONFIRM_MIGRATION_BASELINE=${BASELINE_CONFIRMATION} only after independently verifying the database migration history`);
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

async function applyMigration(client, fileName) {
  const { sql, checksum } = loadMigration(fileName);
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

  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("neon") ? { rejectUnauthorized: false } : undefined,
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

    const selected = options.files;
    const pending = selected.filter((fileName) => !history.has(fileName));
    if (pending.length === 0) {
      console.log("✅ All requested migrations are already recorded with matching checksums.");
    } else {
      const firstIndex = MIGRATIONS.indexOf(pending[0]);
      const priorMissing = MIGRATIONS.slice(0, firstIndex).find((fileName) => !history.has(fileName));
      if (priorMissing) throw new Error(`Cannot apply ${pending[0]} before ${priorMissing}`);
      for (const fileName of pending) await applyMigration(client, fileName);
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

main();
