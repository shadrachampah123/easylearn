/**
 * Regression for PR #45's quiz-access test runner swallowing a setup failure.
 *
 * Provenance: authored by the independent reviewer of PR #45 and now a permanent test so
 * it keeps running in CI. Copied unchanged apart from this note.
 * Fault injection is confined to a child process: only its migration subprocess
 * reports a controlled error. No application/test source or SQL is replaced.
 * Requires a disposable localhost server because the original suite creates and drops
 * its scratch database before/after the injected migration failure.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

test("quiz-access runner must exit nonzero when its migrations fail before assertions",()=>{
  assert.equal(process.env.EASY_LEARN_TEST_DATABASE,"true");
  const adminUrl=new URL(process.env.TEST_DATABASE_URL);
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(adminUrl.hostname));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"pr45-harness-review-"));
  const preload=path.join(directory,"fail-migration.cjs");
  fs.writeFileSync(preload,`
    const cp=require('node:child_process');
    const original=cp.spawnSync;
    cp.spawnSync=function(command,args,options) {
      if (Array.isArray(args) && args[0]==='run-migration.js') {
        return {status:42,stdout:'',stderr:'PR45 controlled migration failure',pid:0,signal:null};
      }
      return original.apply(this,arguments);
    };
  `);
  try {
    const result=spawnSync(process.execPath,["--require",preload,"--import","tsx","tests/quiz-access-db.test.ts"],{
      cwd:path.resolve(__dirname,".."),env:process.env,encoding:"utf8",timeout:30000,
    });
    const output=`${result.stdout || ""}${result.stderr || ""}`;
    assert.ok(!result.error,result.error?.message);
    assert.match(output,/PR45 controlled migration failure/);
    assert.ok(!/quiz access: \d+ passed/.test(output),"no assertions should have executed after failed setup");
    console.log(`Observed child exit=${result.status} after controlled migration failure; zero test assertions executed.`);
    assert.notEqual(result.status,0,"setup errors must fail CI, not just print an error and exit 0");
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
