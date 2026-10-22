/** Ensure the committed M6 mutation removes a guard rather than breaking SQL syntax.
 *
 * Provenance: authored by the independent reviewer of PR #45 and now a permanent test so
 * it keeps running in CI. Copied unchanged apart from this note.
 * This adds a check; it does not modify the existing mutation harness or assertions.
 * The SQL uses a temporary table on the explicitly local, disposable test server.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {test}=require('node:test');
const {Client}=require('pg');
const ts=require('typescript');

function getM6() {
  const filename=path.join(__dirname,'tenant-authorization-mutation.test.ts');
  const source=ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=source.statements.filter(ts.isVariableStatement)
    .flatMap(s=>Array.from(s.declarationList.declarations))
    .find(d=>d.name.getText(source)==='mutations');
  assert.ok(declaration && ts.isArrayLiteralExpression(declaration.initializer));
  const field=(node,key)=>node.properties.find(p=>p.name?.getText(source)===key)?.initializer?.text;
  const item=declaration.initializer.elements.find(e=>field(e,'id')==='M6');
  assert.ok(item,'M6 must remain present');
  return {find:field(item,'find'),replace:field(item,'replace')};
}
module.exports={getM6};

if (require.main===module) test('committed M6 replacement is executable SQL, not a syntax-error mutant',async()=>{
  assert.equal(process.env.EASY_LEARN_TEST_DATABASE,'true');
  const url=new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  const mutation=getM6();
  assert.ok(mutation.replace.includes('${fileRef}'));
  assert.ok(!mutation.replace.includes('${schoolId}'),'the intended guard must actually be removed');
  const client=new Client({connectionString:url.toString()});
  await client.connect();
  try {
    await client.query('CREATE TEMP TABLE uploaded_files (id uuid, school_id uuid)');
    const id=crypto.randomUUID();
    await client.query('INSERT INTO uploaded_files VALUES ($1,$2)',[id,crypto.randomUUID()]);
    const expression=mutation.replace.replaceAll('${fileRef}','$1::uuid');
    // Positive control: the same guard removal with a SQL comment is executable.
    const control=await client.query(`SELECT (${expression.replace('// MUTANT M6:','-- MUTANT M6:')}) AS matched`,[id]);
    assert.equal(control.rows[0].matched,true);
    const result=await client.query(`SELECT (${expression}) AS matched`,[id]);
    assert.equal(result.rows[0].matched,true);
  } finally {await client.end();}
});
