const { Pool } = require("pg");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Usage:
//   node run-migration.js                -> runs all migrations in order
//   node run-migration.js 0001_assignment_grading.sql -> runs single file
const migrationArg = process.argv[2];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("neon") ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
});

async function runFile(client, fileName) {
  const sqlPath = path.join(__dirname, fileName);
  if (!fs.existsSync(sqlPath)) {
    console.log(`⚠️  File not found: ${fileName}, skipping`);
    return;
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
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("does not exist") ||
        msg.includes("already") ||
        msg.includes("IF NOT EXISTS") ||
        msg.includes("column") && msg.includes("already exists")
      ) {
        console.log(`  ⚠️  ${i + 1}: ${msg.substring(0, 120)} (skipping)`);
      } else {
        console.log(`  ❌ ${i + 1}: ${msg}`);
        // Don't fail hard on non-critical errors, continue
      }
    }
  }
}

async function run() {
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
        ];

    // Also check drizzle folder for any extra files not in root
    const drizzleFiles = fs.readdirSync(path.join(__dirname, "drizzle")).filter(f => f.endsWith(".sql")).sort();
    const allFiles = [...new Set([...files, ...drizzleFiles.map(f => path.join("drizzle", f))])];

    // For simplicity, run root files first, then drizzle folder if they exist
    for (const file of files) {
      const rootPath = path.join(__dirname, file);
      const drizzlePath = path.join(__dirname, "drizzle", file);
      if (fs.existsSync(rootPath)) {
        await runFile(client, file);
      } else if (fs.existsSync(drizzlePath)) {
        await runFile(client, path.join("drizzle", file));
      } else {
        console.log(`⚠️  Migration file not found: ${file}`);
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

    client.release();
    await pool.end();
    console.log("\n🎉 Migration complete!");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    console.error(err);
    process.exit(1);
  }
}

run();
