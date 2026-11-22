/**
 * Post-deployment H-2 review (2026-11-19) — the health endpoint must say *how far*
 * migration 0018 got, not only whether it finished.
 *
 * Production reported `composite_tenant_foreign_keys: false` for 0018. That single
 * boolean cannot distinguish three situations with completely different remedies:
 *
 *   - 0 of 26 constraints present  → the migration has never run. Apply it.
 *   - 25 of 26 present             → the schema is PARTIALLY migrated. Something has
 *                                    half-applied or someone dropped a constraint; do
 *                                    not blindly re-run, inspect first.
 *   - probe could not run          → unknown, not absent.
 *
 * The composite probe already computed `expected` / `present` / `valid`; they were
 * simply never reported. This suite pins that they are, against a disposable database,
 * and that the derived boolean is unchanged (the fix is additive).
 *
 * It also pins the read-only property: probing must never apply 0018, because that
 * migration changes the tenant boundary and is gated behind an administrator preflight.
 *
 * Run: EASY_LEARN_TEST_DATABASE=true npx tsx tests/health-migration-detail-db.test.ts
 */
import assert from "assert";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

const DB_NAME = `easylearn_migdetail_${crypto.randomBytes(4).toString("hex")}`;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error) => {
      console.error(`❌ FAIL: ${name}\n   ${(error as Error).message}`);
      failed++;
    });
}

async function main() {
  const { Client } = requireFromRepo("pg");
  let stopServer: (() => Promise<void>) | null = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const { startEmbeddedPostgres } = requireFromRepo("./tests/helpers/embedded-postgres.js");
    const port = 60401 + (crypto.randomBytes(2).readUInt16BE(0) % 500);
    const embedded = await startEmbeddedPostgres({
      dbName: DB_NAME,
      port,
      requireEnv: "EASY_LEARN_REQUIRE_HEALTH_MIGRATION_DETAIL",
    });
    if (!embedded) return; // SKIP printed by the helper
    adminUrl = embedded.adminUrl;
    stopServer = embedded.stop;
  }
  const scratchUrl = (() => {
    const url = new URL(adminUrl as string);
    url.pathname = `/${DB_NAME}`;
    return url.toString();
  })();

  /* Resolve TLS through the APPLICATION's policy rather than hand-rolling ssl options
     here, so this suite cannot drift from what the runtime enforces.
     `allowInsecureLocal` is the repository's documented, test-only escape hatch: it
     applies ONLY to a loopback host with no sslmode option, which is exactly the
     disposable cluster the shared helper starts. A remote or explicitly-configured URL
     still goes through full certificate + hostname verification. */
  const { createPostgresConnectionConfig } = requireFromRepo("./src/lib/postgres-tls.js");
  const connectionFor = (url: string) =>
    createPostgresConnectionConfig(url, { allowInsecureLocal: true });
  const admin = new Client(connectionFor(adminUrl as string));
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  await admin.end();

  const db = new Client(connectionFor(scratchUrl));
  await db.connect();

  try {
    process.env.DATABASE_URL = scratchUrl;
    process.env.EASY_LEARN_TEST_DATABASE = "true";

    /* A parent table with the 0017 unique target, and a child that references it.
       Deliberately minimal: 0018's preflight requires the UNIQUE (school_id, id)
       index on the parent, the columns on both sides, and PostgreSQL 18 (this
       suite's cluster is newer than the 15 the migration demands). */
    await db.query(`
      CREATE TABLE academic_years (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL
      )`);
    await db.query(`CREATE UNIQUE INDEX academic_years_school_id_id_unique ON academic_years (school_id, id)`);
    await db.query(`
      CREATE TABLE terms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id uuid NOT NULL,
        academic_year_id uuid
      )`);

    const { probeSchemaFeatures, resetSchemaFeatureCache } = await import("@/lib/schema-resilience");

    await test("an absent 0018 reports detail with present=0 and the full expected count", async () => {
      resetSchemaFeatureCache();
      const statuses = await probeSchemaFeatures(["composite_tenant_foreign_keys"]);
      const entry = statuses[0];
      assert.strictEqual(entry.present, false, "no composite FKs exist in this fixture");
      assert(entry.detail, "the composite probe must report progress detail");
      assert.strictEqual(entry.detail!.expected, 26, "0018 installs 26 composite foreign keys");
      assert.strictEqual(entry.detail!.present, 0, "none are present");
      assert.strictEqual(entry.detail!.valid, 0, "none are validated");
    });

    await test("probing 0018 never applies it (read-only, tenant boundary untouched)", async () => {
      const before = await db.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.terms'::regclass`,
      );
      resetSchemaFeatureCache();
      await probeSchemaFeatures(["composite_tenant_foreign_keys"]);
      const after = await db.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.terms'::regclass`,
      );
      assert.strictEqual(
        before.rows[0].n,
        after.rows[0].n,
        "the health probe must never add a constraint — 0018 is an administrator-approved migration",
      );
      assert.strictEqual(after.rows[0].n, 0, "the fixture starts with no foreign key on terms");
    });

    await test("a partially-applied 0018 reports present < expected and stays not-present", async () => {
      /* Simulate the state an operator most needs to be warned about: one of 0018's
         constraints exists, the rest do not. `present` must be a real count, not a
         boolean dressed up. */
      await db.query(`
        ALTER TABLE public.terms
          ADD CONSTRAINT terms_school_academic_year_fk
          FOREIGN KEY (school_id, academic_year_id)
          REFERENCES public.academic_years (school_id, id) ON DELETE NO ACTION`);
      resetSchemaFeatureCache();
      const statuses = await probeSchemaFeatures(["composite_tenant_foreign_keys"]);
      const entry = statuses[0];
      assert.strictEqual(entry.present, false, "1 of 26 is still not complete");
      assert.strictEqual(entry.detail!.present, 1, "exactly one constraint is now present");
      assert.strictEqual(entry.detail!.expected, 26);
      assert.strictEqual(entry.detail!.valid, 1, "it was created validated");
      assert(
        entry.detail!.present > 0 && entry.detail!.present < entry.detail!.expected,
        "this is the partial state the endpoint must be able to name",
      );
    });

    await test("features without a count do not invent a detail object", async () => {
      resetSchemaFeatureCache();
      const statuses = await probeSchemaFeatures(["dashboard_card_overrides"]);
      assert.strictEqual(statuses[0].detail, undefined, "a single-row probe has no progress to report");
    });
  } finally {
    await db.end().catch(() => undefined);
    let scratchCleanup: { ok: boolean; error: Error | null } = { ok: true, error: null };
    const cleanupClient = new Client(connectionFor(adminUrl as string));
    try {
      await cleanupClient.connect();
      const { dropScratchDatabase } = requireFromRepo("./tests/helpers/scratch-db.js");
      scratchCleanup = await dropScratchDatabase(cleanupClient, DB_NAME, { label: "health-migration-detail" });
    } catch (cleanupError) {
      scratchCleanup = { ok: false, error: cleanupError as Error };
    } finally {
      await cleanupClient.end().catch(() => undefined);
    }
    if (stopServer) await stopServer();
    const { assertCleanupSucceeded } = requireFromRepo("./tests/helpers/scratch-db.js");
    assertCleanupSucceeded(scratchCleanup, failed > 0 ? new Error(`${failed} test(s) failed`) : null);
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
