/**
 * Tenant constraint integrity — regression suite for the schema-sync bypass.
 *
 * The bypass this suite locks down
 * -------------------------------
 * `drizzle-kit push` diffs the live database against `src/db/schema.ts`. That schema
 * cannot express a composite foreign key, so push treats the 26 tenant constraints that
 * migration 0018 installs as unknown objects and drops them. It also drops
 * `public.easylearn_schema_migrations` (CASCADE) and 17 of the 24 `UNIQUE (school_id, id)`
 * targets that migration 0017 creates — with no confirmation token, no transaction, no
 * ledger and no lock.
 *
 * Worse, the damage was invisible: the migration runner read its own ledger, saw 0018
 * recorded, and reported "✅ All requested migrations are already recorded with matching
 * checksums" on a database that enforced no tenant boundary at all. A `--baseline` could
 * then record the same false claim.
 *
 * What this suite proves
 * ----------------------
 *   1. The shared constraint inventory matches migration 0018 exactly, and the shared
 *      unique-target list matches migration 0017 exactly (so the safeguards can never
 *      drift away from the migrations they describe).
 *   2. The original destructive scenario is REPRODUCED on a disposable database, and the
 *      supported workflow then refuses to certify the damaged state.
 *   3. 0018's constraints cannot disappear while the ledger still certifies it as applied.
 *   4. Baseline mode cannot certify an invalid schema.
 *   5. Missing, unvalidated or wrongly-shaped constraints produce a clear, fail-closed
 *      error that names the exact object.
 *   6. Legitimate development, test and migration workflows still function: the ordinary
 *      run still skips 0018, the gate still demands its token, the guarded schema sync
 *      still works on a brand-new empty database, and a damaged database can be
 *      recovered through the documented repair procedure.
 *
 * Providers: TEST_DATABASE_URL → embedded-postgres → SKIP (exit 0).
 * Set `EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true` to turn a skip into a failure — CI
 * does exactly that, so the job proves these assertions really ran.
 * Every database used here is disposable. No production database is ever contacted.
 */

import assert from "assert";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import type { Client as PgClient } from "pg";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const {
  COMPOSITE_TENANT_FOREIGN_KEYS,
  COMPOSITE_TENANT_FOREIGN_KEY_COUNT,
  CONSTRAINT_INVENTORY_SQL,
  UNIQUE_SCHOOL_ID_TARGET_TABLES,
  summarizeConstraintInventory,
} = requireFromRepo("./src/lib/tenant-constraints.js");
const { GATED_MIGRATIONS, MIGRATIONS, REPAIR_CONFIRMATION } = requireFromRepo(
  "./run-migration.js"
);

const DB_NAME = `easylearn_tci_test_${crypto.randomBytes(4).toString("hex")}`;
const GATE_FILE = "0018_composite_school_foreign_keys.sql";
const GATE = GATED_MIGRATIONS[GATE_FILE];

let passed = 0;
let failed = 0;
let skipped = false;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${(error as Error).message}`);
      failed++;
    });
}

function assertEq(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(
      `${message || "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertIncludes(haystack: string, needle: string, message?: string) {
  if (!String(haystack).includes(needle)) {
    throw new Error(
      `${message || "assertIncludes"}: expected output to contain ${JSON.stringify(needle)}\n--- output ---\n${haystack}`
    );
  }
}

function assertNotIncludes(haystack: string, needle: string, message?: string) {
  if (String(haystack).includes(needle)) {
    throw new Error(
      `${message || "assertNotIncludes"}: expected output NOT to contain ${JSON.stringify(needle)}\n--- output ---\n${haystack}`
    );
  }
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** Run the migration runner (or any node script) against a disposable database. */
function runNode(args: string[], databaseUrl: string, extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      EASY_LEARN_TEST_DATABASE: "true",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return { status: result.status ?? 1, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/** Reproduce the original destructive action on a disposable database. */
function runDrizzleKitPushForce(databaseUrl: string): RunResult {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npx, ["drizzle-kit", "push", "--force"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, EASY_LEARN_TEST_DATABASE: "true" },
    encoding: "utf8",
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return { status: result.status ?? 1, stdout, stderr, output: `${stdout}\n${stderr}` };
}

async function main() {
  const { Client } = requireFromRepo("pg");

  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;

  /* Locally the suite skips gracefully when no PostgreSQL is available. In CI
     (EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true) a skip is a FAILURE: the CI job must
     actually execute the schema-sync bypass regression, not quietly pass without it.
     Without this, a renamed environment variable or a broken database fallback would
     disarm the whole suite while the job still reported success. */
  const requireExecution = process.env.EASY_LEARN_REQUIRE_TENANT_INTEGRITY === "true";
  const skip = (message: string) => {
    console.log(message);
    skipped = true;
    if (requireExecution) {
      console.error(
        "❌ FAIL: EASY_LEARN_REQUIRE_TENANT_INTEGRITY=true — the tenant constraint " +
          "integrity suite must run, not skip."
      );
    }
  };

  if (!adminUrl) {
    let EmbeddedPostgres: any = null;
    try {
      EmbeddedPostgres = requireFromRepo("embedded-postgres");
      EmbeddedPostgres = EmbeddedPostgres.default ?? EmbeddedPostgres;
    } catch {
      skip("⏭️  SKIP: no TEST_DATABASE_URL and embedded-postgres is not installed.");
      console.log("   Install with `npm i --no-save embedded-postgres` and re-run.");
      /* Nothing has been opened yet, so exiting here is safe. Locally a skip is
         acceptable; in CI it is a failure. */
      process.exit(skipped && requireExecution ? 1 : 0);
    }
    const port = 55929 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(os.tmpdir(), `${DB_NAME}-data`),
      user: "easylearn",
      password: "easylearn",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    stopServer = () => pg.stop();
    adminUrl = `postgres://easylearn:easylearn@localhost:${port}/postgres`;
    console.log(`📦 Embedded PostgreSQL started on port ${port}`);
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  const urlFor = (name: string) => {
    const url = new URL(adminUrl as string);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const createDb = async (name: string) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
    return urlFor(name);
  };
  const dropDb = async (name: string) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  };

  const healthyName = `${DB_NAME}_healthy`;
  const damagedName = `${DB_NAME}_damaged`;
  const baselineName = `${DB_NAME}_baseline`;
  const emptyName = `${DB_NAME}_empty`;

  /* Every client opened here is disposable and closed in the finally block. */
  const openClients: PgClient[] = [];

  try {
    /* ─────────────────────────────────────────────────────────────────────────
       1. The safeguards describe the migrations they protect.
       ───────────────────────────────────────────────────────────────────────── */

    await test("the shared constraint inventory matches migration 0018 exactly", () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, GATE_FILE), "utf8");
      const fromSql = [
        ...source.matchAll(
          /\('([a-z_]+)', '([a-z_]+)', '([a-z_]+)', '([a-z_]+)', '(NO ACTION|SET NULL|CASCADE)'/g
        ),
      ].map((match) => ({
        childTable: match[1],
        childColumn: match[2],
        parentTable: match[3],
        constraintName: match[4],
        deleteAction: match[5],
      }));
      const fromModule = COMPOSITE_TENANT_FOREIGN_KEYS.map((key: any) => ({
        childTable: key.childTable,
        childColumn: key.childColumn,
        parentTable: key.parentTable,
        constraintName: key.constraintName,
        deleteAction: key.deleteAction,
      }));
      assertEq(fromSql.length, 26, "migration 0018 must install 26 composite foreign keys");
      assertEq(
        JSON.stringify(fromSql),
        JSON.stringify(fromModule),
        "the shared inventory and migration 0018 must describe the same constraints"
      );
      assertEq(
        COMPOSITE_TENANT_FOREIGN_KEY_COUNT,
        26,
        "the shared inventory must hold all 26 constraints"
      );
    });

    await test("the shared unique-target list matches migration 0017 exactly", () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, "0017_school_id_not_null.sql"), "utf8");
      const fromSql = [
        ...source.matchAll(
          /CREATE UNIQUE INDEX IF NOT EXISTS "[a-z_]+"\s*\n\s*ON "([a-z_]+)" USING btree \("school_id", "id"\)/g
        ),
      ]
        .map((match) => match[1])
        .sort();
      const fromModule = [...UNIQUE_SCHOOL_ID_TARGET_TABLES].sort();
      assertEq(fromSql.length, 24, "migration 0017 must create 24 UNIQUE (school_id, id) targets");
      assertEq(
        JSON.stringify(fromSql),
        JSON.stringify(fromModule),
        "the repair list and migration 0017 must describe the same unique targets"
      );
    });

    await test("the application never auto-creates or auto-drops the tenant constraints", () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, "src/lib/schema-resilience.ts"), "utf8");
      assertIncludes(
        source,
        "composite_tenant_foreign_keys: []",
        "the composite tenant foreign keys must have no auto-repair DDL"
      );
      assertNotIncludes(
        source,
        "DROP CONSTRAINT",
        "the schema resilience layer must never drop a constraint"
      );
      assertNotIncludes(
        source,
        "DROP TABLE",
        "the schema resilience layer must never drop a table"
      );
    });

    await test("the health endpoint never promises on-demand creation of the tenant constraints", () => {
      const health = fs.readFileSync(path.join(REPO_ROOT, "src/app/api/health/route.ts"), "utf8");
      assertIncludes(
        health,
        "item.autoRepairable",
        "the health warning must distinguish features the app may create from those it may not"
      );
      assertIncludes(
        health,
        "EasyLearn never creates this automatically",
        "the health warning must say that the tenant constraints are not created on demand"
      );
    });

    await test("no operator-facing message recommends `drizzle-kit push`", () => {
      const files = [
        "src/lib/schema-resilience.ts",
        "src/app/api/parent-learners/route.ts",
        "src/app/api/parent-learners/[id]/route.ts",
      ];
      for (const file of files) {
        const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
        /* A TypeScript template literal escapes its backticks, so the source text
           contains  \`  and not  `.  A pattern that expects a bare backtick therefore
           never matches the very file that used to carry the recommendation
           (src/lib/schema-resilience.ts).  Normalise the escapes first. */
        const normalised = source.replace(/\\`/g, "`");
        const recommendation = /Apply [^`]*`npx drizzle-kit push`|Run `npx drizzle-kit push`/;
        assert(
          !recommendation.test(normalised),
          `${file} must not recommend \`drizzle-kit push\` to an operator`
        );

        /* The pattern above only catches two phrasings.  Assert the stronger
           property directly: every remaining mention of \`drizzle-kit push\` in these
           operator-facing files must be part of an explicit prohibition.  This is
           what makes the guard effective against a re-introduction in any wording. */
        for (const rawLine of normalised.split("\n")) {
          const line = rawLine.trim();
          if (!line.includes("drizzle-kit push")) continue;
          assert(
            /do not run|never|must not|not to/i.test(line),
            `${file} mentions "drizzle-kit push" without an explicit prohibition: ${line}`
          );
        }
      }
    });

    /* ─────────────────────────────────────────────────────────────────────────
       2. A healthy database: the ordinary workflows still behave.
       ───────────────────────────────────────────────────────────────────────── */

    const healthyUrl = await createDb(healthyName);
    const healthy = new Client({ connectionString: healthyUrl });
    openClients.push(healthy);
    await healthy.connect();
    const countComposite = async (client: PgClient) =>
      Number(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM pg_constraint
              WHERE contype = 'f' AND pg_get_constraintdef(oid) LIKE '%(school_id,%'`
          )
        ).rows[0].count
      );
    const countUniqueTargets = async (client: PgClient) =>
      Number(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname LIKE '%\_school\_id\_id\_unique'`
          )
        ).rows[0].count
      );
    const ledgerRow = async (client: PgClient, filename: string) =>
      Number(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM public.easylearn_schema_migrations WHERE filename = $1`,
            [filename]
          )
        ).rows[0].count
      );

    await test("the ordinary run applies the chain and still skips the gated 0018", async () => {
      const run = runNode(["run-migration.js"], healthyUrl);
      assertEq(run.status, 0, `the ordinary run must succeed: ${run.output}`);
      assertIncludes(run.output, "GATED MIGRATION NOT APPLIED", "the skip must be announced");
      assertEq(
        await countComposite(healthy),
        0,
        "the ordinary run must not install the composite tenant foreign keys"
      );
      assertEq(
        await ledgerRow(healthy, GATE_FILE),
        0,
        "the ordinary run must not record 0018 as applied"
      );
    });

    await test("an explicit run without the confirmation token is still refused", async () => {
      const run = runNode(["run-migration.js", GATE_FILE], healthyUrl);
      assertEq(run.status, 1, "the explicit run without the token must be refused");
      assertIncludes(run.output, "Refusing to apply", "the refusal must be explicit");
      assertEq(await countComposite(healthy), 0, "nothing may have been applied");
    });

    await test("applying 0018 under its gate installs all 26 constraints and records it", async () => {
      const run = runNode(["run-migration.js", GATE_FILE], healthyUrl, {
        [GATE.env]: GATE.token,
      });
      assertEq(run.status, 0, `0018 must apply: ${run.output}`);
      assertEq(await countComposite(healthy), 26, "0018 must install 26 constraints");
      assertEq(await ledgerRow(healthy, GATE_FILE), 1, "0018 must be recorded in the ledger");
      assertIncludes(
        run.output,
        "composite tenant foreign keys: 26/26 present, validated and correct",
        "the runner must verify the constraints it just applied"
      );
    });

    await test("a healthy database re-runs cleanly and verifies its constraints", async () => {
      const run = runNode(["run-migration.js"], healthyUrl);
      assertEq(run.status, 0, `the re-run must succeed: ${run.output}`);
      assertIncludes(run.output, "already recorded with matching checksums");
      assertIncludes(run.output, "26/26 present, validated and correct");
    });

    /* ─────────────────────────────────────────────────────────────────────────
       3. The original destructive scenario, reproduced and then contained.
       ───────────────────────────────────────────────────────────────────────── */

    const damagedUrl = await createDb(damagedName);
    const damaged = new Client({ connectionString: damagedUrl });
    openClients.push(damaged);
    await damaged.connect();

    await test("REPRODUCTION: drizzle-kit push --force destroys the tenant constraints", async () => {
      const chain = runNode(["run-migration.js"], damagedUrl);
      assertEq(chain.status, 0, `the chain must apply: ${chain.output}`);
      const gate = runNode(["run-migration.js", GATE_FILE], damagedUrl, { [GATE.env]: GATE.token });
      assertEq(gate.status, 0, `0018 must apply: ${gate.output}`);
      assertEq(await countComposite(damaged), 26, "the database starts with 26 constraints");

      const push = runDrizzleKitPushForce(damagedUrl);
      assertEq(push.status, 0, `drizzle-kit push must succeed on the disposable database: ${push.output}`);

      /* This is the bypass. Record the damage the test suite exists to contain. */
      const compositeAfter = await countComposite(damaged);
      const uniqueAfter = await countUniqueTargets(damaged);
      const ledgerAfter = await readPresent(damaged, "SELECT to_regclass('public.easylearn_schema_migrations') IS NOT NULL AS present");
      assert(
        compositeAfter < 26,
        `drizzle-kit push must drop the composite tenant foreign keys (left ${compositeAfter})`
      );
      assert(
        uniqueAfter < 24,
        `drizzle-kit push must drop some UNIQUE (school_id, id) targets (left ${uniqueAfter})`
      );
      assertEq(
        ledgerAfter,
        false,
        "drizzle-kit push must drop the migration ledger as well"
      );
    });

    await test("the runner refuses to certify a database damaged by a schema sync", async () => {
      const run = runNode(["run-migration.js"], damagedUrl);
      assertEq(run.status, 1, "the runner must fail closed on a damaged database");
      assertNotIncludes(
        run.output,
        "already recorded with matching checksums",
        "the runner must NOT report success on a database whose ledger was dropped"
      );
      assertIncludes(run.output, "Refusing to replay migrations");
    });

    /* The ledger survived in this scenario, so the catalog cross-check is what has to
       catch it. Recreate that exact state: ledger intact, constraints gone. */
    await test("the runner fails closed when the ledger claims 0018 but the constraints are gone", async () => {
      const url = await createDb(`${DB_NAME}_ledger_lies`);
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        const chain = runNode(["run-migration.js"], url);
        assertEq(chain.status, 0, `the chain must apply: ${chain.output}`);
        const gate = runNode(["run-migration.js", GATE_FILE], url, { [GATE.env]: GATE.token });
        assertEq(gate.status, 0, `0018 must apply: ${gate.output}`);
        assertEq(
          await ledgerRow(client, GATE_FILE),
          1,
          "the ledger must record 0018 before the damage"
        );

        /* Simulate the schema sync: the constraints disappear, the ledger stays. */
        await client.query("ALTER TABLE public.assignments DROP CONSTRAINT assignments_school_class_fk");
        assertEq(
          await countComposite(client),
          25,
          "exactly one constraint is missing"
        );

        const run = runNode(["run-migration.js"], url);
        assertEq(run.status, 1, "the runner must fail closed");
        assertNotIncludes(run.output, "already recorded with matching checksums");
        assertIncludes(
          run.output,
          "does not have the 26 composite tenant foreign keys it installs",
          "the error must explain the ledger/catalog disagreement"
        );
        assertIncludes(
          run.output,
          "missing constraint assignments_school_class_fk on public.assignments",
          "the error must name the exact missing object"
        );
        assertIncludes(
          run.output,
          "--repair-tenant-integrity",
          "the error must point at the documented recovery procedure"
        );
      } finally {
        await client.end().catch(() => {});
        await dropDb(`${DB_NAME}_ledger_lies`);
      }
    });

    await test("an unvalidated constraint is rejected, not silently accepted", async () => {
      const url = await createDb(`${DB_NAME}_not_valid`);
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        runNode(["run-migration.js"], url);
        runNode(["run-migration.js", GATE_FILE], url, { [GATE.env]: GATE.token });
        await client.query(
          "ALTER TABLE public.assignments DROP CONSTRAINT assignments_school_class_fk"
        );
        await client.query(
          `ALTER TABLE public.assignments ADD CONSTRAINT assignments_school_class_fk
             FOREIGN KEY (school_id, class_id) REFERENCES public.classes(school_id, id) NOT VALID`
        );

        const run = runNode(["run-migration.js"], url);
        assertEq(run.status, 1, "the runner must fail closed on an unvalidated constraint");
        assertIncludes(
          run.output,
          "is not validated",
          "the error must say the constraint is not validated"
        );
      } finally {
        await client.end().catch(() => {});
        await dropDb(`${DB_NAME}_not_valid`);
      }
    });

    await test("a wrongly-shaped constraint is rejected, not silently accepted", async () => {
      const url = await createDb(`${DB_NAME}_wrong_shape`);
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        runNode(["run-migration.js"], url);
        runNode(["run-migration.js", GATE_FILE], url, { [GATE.env]: GATE.token });
        await client.query(
          "ALTER TABLE public.assignments DROP CONSTRAINT assignments_school_class_fk"
        );
        await client.query(
          `ALTER TABLE public.assignments ADD CONSTRAINT assignments_school_class_fk
             FOREIGN KEY (class_id) REFERENCES public.classes(id)`
        );

        const run = runNode(["run-migration.js"], url);
        assertEq(run.status, 1, "the runner must fail closed on a wrongly-shaped constraint");
        assertIncludes(
          run.output,
          "is wrong child columns",
          "the error must say the constraint references the wrong columns"
        );
      } finally {
        await client.end().catch(() => {});
        await dropDb(`${DB_NAME}_wrong_shape`);
      }
    });

    /* ─────────────────────────────────────────────────────────────────────────
       4. Baseline must not certify an invalid schema.
       ───────────────────────────────────────────────────────────────────────── */

    const baselineUrl = await createDb(baselineName);
    const baseline = new Client({ connectionString: baselineUrl });
    openClients.push(baseline);
    await baseline.connect();

    /* The baseline procedure exists for a database that already holds application objects
       but no history ledger — exactly what `drizzle-kit push` leaves behind. */
    await test("baseline refuses to record 0018 on a database without its constraints", async () => {
      const push = runDrizzleKitPushForce(baselineUrl);
      assertEq(push.status, 0, `the schema must be created: ${push.output}`);
      assertEq(
        await readPresent(
          baseline,
          "SELECT to_regclass('public.easylearn_schema_migrations') IS NOT NULL AS present"
        ),
        false,
        "this database must have no ledger, which is what the baseline procedure is for"
      );

      const prefixIncluding = MIGRATIONS.join(",");
      const run = runNode(["run-migration.js", "--baseline", prefixIncluding], baselineUrl, {
        CONFIRM_MIGRATION_BASELINE: "I_HAVE_VERIFIED_THESE_MIGRATIONS",
        [GATE.env]: GATE.token,
      });
      assertEq(run.status, 1, "the baseline must be refused");
      assertIncludes(run.output, "Baseline refused", "the refusal must be explicit");
      assertIncludes(
        run.output,
        "does not have the 26 composite tenant foreign keys it installs",
        "the refusal must explain that the schema does not have the constraints"
      );
      assertEq(
        await readPresent(
          baseline,
          "SELECT to_regclass('public.easylearn_schema_migrations') IS NOT NULL AS present"
        ),
        false,
        "the refused baseline must not create a ledger"
      );
    });

    await test("baseline can still record a verified prefix that stops before 0018", async () => {
      const prefix = MIGRATIONS.slice(0, MIGRATIONS.indexOf(GATE_FILE)).join(",");
      const run = runNode(["run-migration.js", "--baseline", prefix], baselineUrl, {
        CONFIRM_MIGRATION_BASELINE: "I_HAVE_VERIFIED_THESE_MIGRATIONS",
      });
      assertEq(run.status, 0, `the baseline must succeed: ${run.output}`);
      assertIncludes(run.output, "Recorded operator-asserted baseline");
      assertEq(
        await ledgerRow(baseline, GATE_FILE),
        0,
        "the baseline must not record 0018"
      );
      assertEq(
        await ledgerRow(baseline, MIGRATIONS[MIGRATIONS.indexOf(GATE_FILE) - 1]),
        1,
        "the baseline must record the verified prefix"
      );
    });

    /* ─────────────────────────────────────────────────────────────────────────
       5. The documented recovery procedure actually recovers.
       ───────────────────────────────────────────────────────────────────────── */

    await test("the repair restores the 0017 unique targets and clears the false ledger claim", async () => {
      const url = await createDb(`${DB_NAME}_repair`);
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        runNode(["run-migration.js"], url);
        runNode(["run-migration.js", GATE_FILE], url, { [GATE.env]: GATE.token });

        /* Damage it the way a schema sync would: constraints and unique targets gone,
           ledger still claiming 0018 is applied. */
        await client.query(
          `DO $$ DECLARE r record; BEGIN
             FOR r IN SELECT conname, conrelid FROM pg_constraint
                      WHERE contype='f' AND pg_get_constraintdef(oid) LIKE '%(school_id,%' LOOP
               EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.conrelid::regclass, r.conname);
             END LOOP;
           END $$;`
        );
        await client.query("DROP INDEX IF EXISTS public.quizzes_school_id_id_unique");
        await client.query("DROP INDEX IF EXISTS public.terms_school_id_id_unique");
        assertEq(await countComposite(client), 0, "the constraints are gone before the repair");
        assertEq(await ledgerRow(client, GATE_FILE), 1, "the ledger still claims 0018");

        const refused = runNode(["run-migration.js", "--repair-tenant-integrity"], url);
        assertEq(refused.status, 1, "the repair must be refused without its confirmation token");
        assertIncludes(refused.output, "Repair refused");

        const repaired = runNode(["run-migration.js", "--repair-tenant-integrity"], url, {
          CONFIRM_REPAIR_TENANT_INTEGRITY: REPAIR_CONFIRMATION,
        });
        assertEq(repaired.status, 0, `the repair must succeed: ${repaired.output}`);
        assertEq(
          await countUniqueTargets(client),
          24,
          "the repair must restore every UNIQUE (school_id, id) target"
        );
        assertEq(
          await ledgerRow(client, GATE_FILE),
          0,
          "the repair must clear the false ledger claim so 0018 is pending again"
        );

        /* And the gate still governs the re-application. */
        const withoutToken = runNode(["run-migration.js", GATE_FILE], url);
        assertEq(withoutToken.status, 1, "0018 must still need its token after the repair");

        const withToken = runNode(["run-migration.js", GATE_FILE], url, { [GATE.env]: GATE.token });
        assertEq(withToken.status, 0, `0018 must apply again: ${withToken.output}`);
        assertEq(await countComposite(client), 26, "the constraints must be back");
        assertEq(await ledgerRow(client, GATE_FILE), 1, "the ledger must record 0018 again");
      } finally {
        await client.end().catch(() => {});
        await dropDb(`${DB_NAME}_repair`);
      }
    });

    /* ─────────────────────────────────────────────────────────────────────────
       6. Legitimate workflows still function.
       ───────────────────────────────────────────────────────────────────────── */

    await test("the guarded schema sync refuses to run drizzle-kit push on a managed database", async () => {
      const run = runNode(["db-schema-sync.js"], healthyUrl);
      assertEq(run.status, 1, "the guarded sync must refuse a database that is in use");
      assertIncludes(run.output, "Schema sync refused");
      assertIncludes(run.output, "easylearn_schema_migrations");
      assertIncludes(run.output, "node run-migration.js");
      assertNotIncludes(
        run.output,
        "drizzle-kit push --force",
        "the refusal must not run the destructive command"
      );
    });

    await test("the guarded schema sync still works on a brand-new empty database", async () => {
      const url = await createDb(emptyName);
      const run = runNode(["db-schema-sync.js"], url);
      assertEq(run.status, 0, `the guarded sync must work on an empty database: ${run.output}`);
      assertIncludes(run.output, "The target database is empty");
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        const tables = Number(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r'`
            )
          ).rows[0].count
        );
        assert(tables > 0, "the legitimate development workflow must still create the schema");
      } finally {
        await client.end().catch(() => {});
      }
    });

    await test("the shared inventory query agrees with the database", async () => {
      const rows = (await healthy.query(CONSTRAINT_INVENTORY_SQL)).rows;
      const inventory = summarizeConstraintInventory(rows);
      assertEq(inventory.expected, 26);
      assertEq(inventory.valid, 26, `every constraint must be correct: ${inventory.problems.join("; ")}`);
      assertEq(inventory.complete, true);
      assertEq(inventory.problems.length, 0);
    });

    console.log(`\n📊 Tenant constraint integrity results: ${passed} passed, ${failed} failed\n`);
  } finally {
    for (const client of openClients) await client.end().catch(() => {});
    for (const name of [healthyName, damagedName, baselineName, emptyName]) {
      await dropDb(name);
    }
    await admin.end().catch(() => {});
    if (stopServer) await stopServer().catch(() => {});
  }

  /* A skip is only acceptable outside CI.  In CI the suite must have executed, so a
     skip is a failure — otherwise the job would report success on a suite that never
     ran a single assertion. */
  process.exit(failed > 0 || (skipped && requireExecution) ? 1 : 0);
}

/** Convenience: read a single boolean from a disposable client. */
async function readPresent(client: PgClient, sql: string): Promise<any> {
  const result = await client.query(sql);
  return result.rows[0]?.present;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
