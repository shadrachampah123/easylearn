#!/usr/bin/env node
"use strict";

/**
 * Guarded schema sync.
 *
 * `drizzle-kit push` diffs the live database against `src/db/schema.ts`. That schema
 * cannot express a composite foreign key, so `push` treats the tenant constraints that
 * migration 0018 installs as unknown objects and drops them. It also drops
 * `public.easylearn_schema_migrations` (CASCADE) and the `UNIQUE (school_id, id)` targets
 * that migration 0017 creates. None of that asks for a confirmation.
 *
 * This wrapper makes the destructive path explicit and safe:
 *
 *   - On a BRAND-NEW, EMPTY database it runs `drizzle-kit push` exactly as before. The
 *     legitimate development workflow keeps working.
 *   - On a database that already holds application objects — and in particular on any
 *     database this repository's migration runner has managed — it refuses and points at
 *     `node run-migration.js`, which is the only supported way to change the schema.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node db-schema-sync.js
 *   DATABASE_URL="postgres://..." npm run db:schema-sync
 *
 * See docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md.
 */

const { spawn } = require("child_process");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();
const {
  createPostgresConnectionConfig,
  getDatabaseUrlFromEnvironment,
} = require("./src/lib/postgres-tls.js");
const {
  COMPOSITE_TENANT_FOREIGN_KEYS,
  COMPOSITE_TENANT_FOREIGN_KEY_COUNT,
  CONSTRAINT_INVENTORY_SQL,
  UNIQUE_SCHOOL_ID_TARGET_TABLES,
} = require("./src/lib/tenant-constraints.js");

const REPO_ROOT = __dirname;

/** Tables and other relations that mean "this database is already in use". */
async function describeTargetDatabase(client) {
  const objects = await client.query(`
    SELECT count(*)::int AS relation_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND c.relname <> 'easylearn_schema_migrations'
  `);
  const ledger = await client.query(
    "SELECT to_regclass('public.easylearn_schema_migrations') IS NOT NULL AS present"
  );
  const constraints = await client.query(CONSTRAINT_INVENTORY_SQL);
  const presentConstraints = constraints.rows.filter((row) => row.present).length;

  return {
    relationCount: Number(objects.rows[0]?.relation_count ?? 0),
    hasLedger: Boolean(ledger.rows[0]?.present),
    presentConstraints,
  };
}

function refuse(state) {
  const reasons = [];
  if (state.hasLedger) {
    reasons.push(
      "it has the EasyLearn migration ledger `public.easylearn_schema_migrations`"
    );
  }
  if (state.presentConstraints > 0) {
    reasons.push(
      `it has ${state.presentConstraints} of the ${COMPOSITE_TENANT_FOREIGN_KEY_COUNT} composite tenant foreign keys`
    );
  }
  if (state.relationCount > 0) {
    reasons.push(`it already has ${state.relationCount} relation(s) in the public schema`);
  }

  console.error("❌ Schema sync refused. The target database is not empty:");
  for (const reason of reasons) console.error(`   - ${reason}`);
  console.error(
    "\n   `drizzle-kit push` cannot express a composite foreign key, so on a database that is\n" +
      "   already in use it DROPS the tenant foreign keys, the migration ledger and the\n" +
      "   UNIQUE (school_id, id) targets, without asking for any confirmation.\n"
  );
  console.error("   Use the migration runner instead — it is transactional, checksummed, gated\n" +
    "   and it verifies the ledger against the catalog:\n");
  console.error("     node run-migration.js            # apply every pending migration in order");
  console.error("     node run-migration.js --help     # gated migrations, baseline and repair");
  console.error(
    "\n   If this database was already damaged by an unauthorized schema sync, recover with:\n" +
      "     CONFIRM_REPAIR_TENANT_INTEGRITY=I_HAVE_VERIFIED_THE_DATABASE_NEEDS_REPAIR \\\n" +
      "       node run-migration.js --repair-tenant-integrity\n"
  );
  console.error(
    "   See docs/OPERATIONS_DATABASE_TLS_AND_MIGRATIONS.md and\n" +
      "   docs/PRODUCTION_TENANCY_READ_ONLY_CHECKPOINT.md."
  );
  process.exitCode = 1;
}

function runDrizzleKitPush() {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, ["drizzle-kit", "push"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (error) => {
    console.error("❌ Could not start `drizzle-kit push`:", error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code === null ? 1 : code;
  });
  return child;
}

async function main() {
  const databaseUrl = getDatabaseUrlFromEnvironment(process.env);
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }

  const config = createPostgresConnectionConfig(databaseUrl, {
    allowInsecureLocal: process.env.EASY_LEARN_TEST_DATABASE === "true",
  });
  const pool = new Pool({ ...config, connectionTimeoutMillis: 30000, max: 1 });
  let client;
  try {
    client = await pool.connect();
    const state = await describeTargetDatabase(client);
    if (state.relationCount > 0 || state.hasLedger || state.presentConstraints > 0) {
      refuse(state);
      return;
    }
    console.log(
      "✅ The target database is empty; `drizzle-kit push` is safe to run on it.\n" +
        "   After it finishes, record the migration history with `node run-migration.js --baseline`."
    );
  } catch (error) {
    console.error("❌ Schema sync failed:", error.message);
    process.exitCode = 1;
    return;
  } finally {
    if (client) client.release();
    await pool.end().catch(() => {});
  }

  runDrizzleKitPush();
}

if (require.main === module) {
  main();
}

module.exports = { describeTargetDatabase, refuse, runDrizzleKitPush };
