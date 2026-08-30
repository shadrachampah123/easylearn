const { Pool } = require("pg");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Usage:
//   node run-migration.js                -> runs all migrations in order (0000 ... 0006)
//   node run-migration.js 0001_assignment_grading.sql -> runs single file
// The migration .sql files are idempotent (IF NOT EXISTS / guarded DO blocks), so it is
// always safe to re-run this after a deploy. Exit code is non-zero when a statement failed
// for a real reason, so CI and humans cannot miss a half-applied migration again.
const migrationArg = process.argv[2];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("neon") ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
});

/** Errors that mean "the object is already in the state we want". */
function isIdempotentSkip(statement, message) {
  const msg = String(message).toLowerCase();
  const statementText = String(statement).toLowerCase();

  // Re-running on a database that already has the object is expected.
  if (msg.includes("already exists") || msg.includes("duplicate")) return true;

  // A missing object is only tolerated for guarded DROPs - for CREATE/ALTER it means the
  // migration genuinely could not be applied, which is what used to get silently hidden.
  if (msg.includes("does not exist")) {
    return statementText.includes("drop ") && statementText.includes("if exists");
  }
  return false;
}

async function runFile(client, fileName) {
  const failures = [];
  const sqlPath = path.join(__dirname, fileName);
  if (!fs.existsSync(sqlPath)) {
    console.log(`⚠️  File not found: ${fileName}, skipping`);
    return failures;
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`\n📋 Running ${statements.length} statements from ${fileName}...`);

  for (let i = 0; i < statements.length; i++) {
    try {
      await client.query(statements[i]);
      const firstLine = statements[i].split("\n")[0].substring(0, 100);
      console.log(`  ✅ ${i + 1}: ${firstLine}...`);
    } catch (err) {
      const msg = err.message || "";
      if (isIdempotentSkip(statements[i], msg)) {
        console.log(`  ⚠️  ${i + 1}: ${msg.substring(0, 120)} (skipping)`);
      } else {
        console.log(`  ❌ ${i + 1}: ${msg}`);
        failures.push(`${fileName} #${i + 1}: ${msg.substring(0, 200)}`);
      }
    }
  }

  return failures;
}

async function run() {
  const failures = [];
  try {
    const client = await pool.connect();
    console.log("✅ Connected to database!");

    const files = migrationArg
      ? [migrationArg]
      : [
          "0000_wet_legion.sql",
          "0001_assignment_grading.sql",
          "0002_optional_email.sql",
          "0003_timetable.sql",
          "0004_dashboard_overrides.sql",
          "0005_activity_enhancements.sql",
          "0006_user_identity_columns.sql",
          "0007_quiz_images.sql",
        ];

    // Also check drizzle folder for any extra files not in root
    const drizzleFiles = fs.readdirSync(path.join(__dirname, "drizzle")).filter(f => f.endsWith(".sql")).sort();
    const allFiles = [...new Set([...files, ...drizzleFiles.map(f => path.join("drizzle", f))])];

    // For simplicity, run root files first, then drizzle folder if they exist
    for (const file of files) {
      const rootPath = path.join(__dirname, file);
      const drizzlePath = path.join(__dirname, "drizzle", file);
      if (fs.existsSync(rootPath)) {
        failures.push(...(await runFile(client, file)));
      } else if (fs.existsSync(drizzlePath)) {
        failures.push(...(await runFile(client, path.join("drizzle", file))));
      } else {
        console.log(`⚠️  Migration file not found: ${file}`);
        failures.push(`${file}: file not found`);
      }
    }

    // Verify key tables
    const verifyRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema='public' AND table_name IN ('timetable_entries','dashboard_card_overrides','activity_logs')
      ORDER BY table_name;
    `);
    console.log("\n✅ Verification - Key tables:");
    verifyRes.rows.forEach(r => console.log(`   - ${r.table_name}`));

    const columnRes = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='users'
        AND column_name IN ('username','must_change_password')
      ORDER BY column_name;
    `);
    console.log(
      "\n✅ Verification - users identity columns:",
      columnRes.rows.map(r => r.column_name).join(", ") || "MISSING (0006 not applied)"
    );

    const activityRes = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='activity_logs'
        AND column_name IN ('entity_type','entity_id','description')
      ORDER BY column_name;
    `);
    console.log(
      "✅ Verification - activity_logs enrichment:",
      activityRes.rows.map(r => r.column_name).join(", ") || "MISSING (0005 not applied)"
    );

    client.release();
    await pool.end();

    if (failures.length > 0) {
      console.log(`\n❌ ${failures.length} statement(s) failed:`);
      failures.forEach(f => console.log(`   - ${f}`));
      console.log("\nFix the SQL above and re-run this script - it is safe to repeat.");
      process.exit(1);
    }

    console.log("\n🎉 Migration complete!");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

run();
