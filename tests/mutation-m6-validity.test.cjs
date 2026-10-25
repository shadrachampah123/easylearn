/**
 * Regression test for PR #45 review finding R7:
 * 1. SQL mutations in `tests/tenant-authorization-mutation.test.ts` (M6 and M7) must
 *    remove the `school_id` guard using syntactically valid SQL (never SQLSTATE 42601).
 * 2. A SQL or JS/TS syntax error in the authorization suite output must never count
 *    as proof that an authorization mutation was detected.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { Client } = require("pg");
const ts = require("typescript");

const MUTATION_FILE = path.join(__dirname, "tenant-authorization-mutation.test.ts");

function extractMutations() {
  const sourceText = fs.readFileSync(MUTATION_FILE, "utf8");
  const sf = ts.createSourceFile(MUTATION_FILE, sourceText, ts.ScriptTarget.Latest, true);
  const decl = sf.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) => Array.from(s.declarationList.declarations))
    .find((d) => d.name.getText(sf) === "mutations");
  assert.ok(decl && ts.isArrayLiteralExpression(decl.initializer), "mutations array must exist");

  const getField = (obj, key) => {
    const prop = obj.properties.find((p) => p.name && p.name.getText(sf) === key);
    return prop && prop.initializer && "text" in prop.initializer ? prop.initializer.text : "";
  };

  return decl.initializer.elements.map((el) => ({
    id: getField(el, "id"),
    name: getField(el, "name"),
    find: getField(el, "find"),
    replace: getField(el, "replace"),
  }));
}

function loadMutationRunnerModule() {
  const sourceText = fs.readFileSync(MUTATION_FILE, "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: MUTATION_FILE,
  });
  const mod = new Module(MUTATION_FILE, module);
  mod.filename = MUTATION_FILE;
  mod.paths = Module._nodeModulePaths(__dirname);
  mod._compile(compiled.outputText, MUTATION_FILE);
  return mod.exports;
}

test("M6 and M7 mutate authorization SQL with valid PostgreSQL syntax rather than SQLSTATE 42601", async () => {
  assert.equal(process.env.EASY_LEARN_TEST_DATABASE, "true");
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl, "TEST_DATABASE_URL is required");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname));

  const all = extractMutations();
  const cases = [
    { id: "M6", table: "uploaded_files", placeholder: "${fileRef}" },
    { id: "M7", table: "quizzes", placeholder: "${quizRef}" },
  ];

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const item of cases) {
      const m = all.find((entry) => entry.id === item.id);
      assert.ok(m, `${item.id} mutation must remain present`);
      assert.ok(m.replace.includes(item.placeholder), `${item.id} must preserve ${item.placeholder}`);
      assert.ok(!m.replace.includes("${schoolId}"), `${item.id} must remove the school_id check`);

      await client.query(`CREATE TEMP TABLE ${item.table} (id uuid, school_id uuid)`);
      const rowId = crypto.randomUUID();
      await client.query(`INSERT INTO ${item.table} VALUES ($1, $2)`, [rowId, crypto.randomUUID()]);
      const sqlExpr = m.replace.replaceAll(item.placeholder, "$1::uuid");
      const res = await client.query(`SELECT (${sqlExpr}) AS matched`, [rowId]);
      assert.equal(res.rows[0].matched, true);
    }
  } finally {
    await client.end();
  }
});

test("mutation runner rejects SQL/JS syntax-error output instead of counting it as a killed mutant", () => {
  const mod = loadMutationRunnerModule();
  assert.equal(typeof mod.isValidMutationKill, "function");

  assert.equal(
    mod.isValidMutationKill({
      code: 1,
      output: "❌ FAIL: Files: downloading another school's file is 404\n📊 Results: 81 passed, 1 failed\n",
    }).killed,
    true
  );

  assert.equal(
    mod.isValidMutationKill({
      code: 1,
      output:
        'error: syntax error at or near "M6"\ncode: \'42601\'\n❌ FAIL: Files: downloading another school\'s file is 404\n📊 Results: 75 passed, 6 failed\n',
    }).killed,
    false
  );

  assert.equal(
    mod.isValidMutationKill({
      code: 1,
      output: "SyntaxError: Unexpected token\n❌ FAIL: broken import\n📊 Results: 0 passed, 1 failed\n",
    }).killed,
    false
  );
});
