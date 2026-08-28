const { Pool } = require("pg");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Usage:
//   node run-migration.js                -> runs 0003_timetable.sql
//   node run-migration.js 0001_assignment_grading.sql
const migrationFile = process.argv[2] || "0003_timetable.sql";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
});

async function run() {
  try {
    // Test connection
    const client = await pool.connect();
    console.log("✅ Connected to Neon database!");

    // Check if the target table already exists
    const checkRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_name = 'timetable_entries'
      ORDER BY table_name;
    `);
    console.log("Existing tables:", checkRes.rows.map(r => r.table_name).join(", ") || "none");

    // Read the migration SQL
    const sqlPath = path.join(__dirname, migrationFile);
    const sql = fs.readFileSync(sqlPath, "utf8");

    // Split by statement-breakpoint and run each statement
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`\n📋 Running ${statements.length} SQL statements from ${migrationFile}...`);

    for (let i = 0; i < statements.length; i++) {
      try {
        await client.query(statements[i]);
        const firstLine = statements[i].split("\n")[0].substring(0, 80);
        console.log(`  ✅ Statement ${i + 1}: ${firstLine}...`);
      } catch (err) {
        // Check if it's an "already exists" error (harmless)
        if (err.message && err.message.includes("already exists")) {
          console.log(`  ⚠️  Statement ${i + 1}: Already exists (skipping)`);
        } else if (err.message && err.message.includes("does not exist")) {
          console.log(`  ⚠️  Statement ${i + 1}: Reference does not exist yet (may be OK)`);
        } else {
          console.log(`  ❌ Statement ${i + 1}: ${err.message}`);
        }
      }
    }

    // Verify the table was created
    const verifyRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_name = 'timetable_entries'
      ORDER BY table_name;
    `);
    console.log("\n✅ Verification - Tables now exist:");
    verifyRes.rows.forEach(r => console.log(`   - ${r.table_name}`));

    // Check the timetable columns
    const colCheck = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'timetable_entries'
      ORDER BY ordinal_position;
    `);
    console.log("\n✅ Verification - timetable_entries columns:");
    colCheck.rows.forEach(r => console.log(`   - ${r.column_name} (${r.data_type})`));

    client.release();
    await pool.end();
    console.log("\n🎉 Migration complete!");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  }
}

run();
