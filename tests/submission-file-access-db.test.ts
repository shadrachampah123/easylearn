/**
 * Submission file access — parent / co-teacher / dual-school — DB test.
 *
 * Purpose "submission" files are private: only uploader, assignment owner, and school admin may read.
 * This is stricter than assignment materials (class-level). Tests parent linked to enrolled learner
 * (should be denied for submission), co-teacher not owner (denied), and dual-school isolation.
 *
 * Run: npx tsx tests/submission-file-access-db.test.ts
 */

import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { NextRequest } from "next/server";
import { createTestJwtSecret } from "./helpers/test-secret";

const REPO_ROOT = path.join(__dirname, "..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const { runMigrations: runMigrationChain } = requireFromRepo("./tests/helpers/migrations.js");
const DB_NAME = `easylearn_submission_${crypto.randomBytes(4).toString("hex")}`;
const JWT_SECRET = createTestJwtSecret();
const UPLOAD_DIR = path.join(os.tmpdir(), `${DB_NAME}-uploads`);
let passed=0, failed=0;
function test(n:string, fn:()=>Promise<void>|void) { return Promise.resolve().then(fn).then(()=>{console.log(`✅ PASS: ${n}`); passed++;}).catch(e=>{console.error(`❌ FAIL: ${n}\n   ${(e as Error).message}`); failed++;}); }
function assertEq(a:unknown,b:unknown,m?:string){ if(a!==b) throw new Error(`${m||"eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);}
const PDF_BYTES = Buffer.from("%PDF-1.4\n%%EOF\n","latin1");

async function main(){
  const { Client } = requireFromRepo("pg");
  const bcrypt = requireFromRepo("bcryptjs");
  let stopServer:any=null; let adminUrl=process.env.TEST_DATABASE_URL;
  if(!adminUrl){ let EP:any=null; try{ EP=requireFromRepo("embedded-postgres"); EP=EP.default??EP;}catch{console.log("⏭️  SKIP no DB"); return;}
    const port=57201+(crypto.randomBytes(2).readUInt16BE(0)%500); const pg=new EP({databaseDir:path.join(os.tmpdir(),`${DB_NAME}-data`), user:"easylearn", password:"easylearn", port, persistent:false});
    await pg.initialise(); await pg.start(); stopServer=()=>pg.stop(); adminUrl=`postgres://easylearn:easylearn@localhost:${port}/postgres`; console.log(`📦 Embedded PG ${port}`);
  }
  const scratchUrl=(()=>{ const u=new URL(adminUrl as string); u.pathname=`/${DB_NAME}`; return u.toString();})();
  const admin=new Client({connectionString:adminUrl}); await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`); await admin.query(`CREATE DATABASE "${DB_NAME}"`); const db=new Client({connectionString:scratchUrl}); await db.connect();
  try{
    process.env.DATABASE_URL=scratchUrl; process.env.JWT_SECRET=JWT_SECRET; process.env.EASY_LEARN_TEST_DATABASE="true"; process.env.UPLOAD_DIR=UPLOAD_DIR; fs.mkdirSync(UPLOAD_DIR,{recursive:true});
    const q=async(sql:string,vals:unknown[]=[])=> (await db.query(sql,vals)).rows;
    const one=async(sql:string,vals:unknown[]=[])=> (await q(sql,vals))[0];
    const run=runMigrationChain({databaseUrl:scratchUrl, env:{JWT_SECRET, EASY_LEARN_TEST_DATABASE:"true"}}); if(run.status!==0) throw new Error(`migrations ${run.status}`);
    const pwHash=await bcrypt.hash("Test-Pw-!",4);
    // Setup
    const schoolA=(await one(`INSERT INTO schools (name, short_name, slug) VALUES ('Sub School A','SSA','sub-a') RETURNING id`)).id;
    const schoolB=(await one(`INSERT INTO schools (name, short_name, slug) VALUES ('Sub School B','SSB','sub-b') RETURNING id`)).id;
    const subjectA=(await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Maths','MTH-SUB-A') RETURNING id`,[schoolA])).id;
    const subjectB=(await one(`INSERT INTO subjects (school_id, name, code) VALUES ($1,'Science','SCI-SUB-B') RETURNING id`,[schoolB])).id;
    const classA1=(await one(`INSERT INTO classes (school_id, name, level) VALUES ($1,'Class A1','primary') RETURNING id`,[schoolA])).id;
    const classA2=(await one(`INSERT INTO classes (school_id, name, level) VALUES ($1,'Class A2','primary') RETURNING id`,[schoolA])).id;
    const classB1=(await one(`INSERT INTO classes (school_id, name, level) VALUES ($1,'Class B1','primary') RETURNING id`,[schoolB])).id;
    type Fx={key:string,role:string,schools:string[]}
    const fixtures:Fx[]=[
      {key:"teacher-a",role:"teacher",schools:[schoolA]},
      {key:"teacher-a2",role:"teacher",schools:[schoolA]},
      {key:"learner-a",role:"learner",schools:[schoolA]},
      {key:"learner-a2",role:"learner",schools:[schoolA]},
      {key:"parent-a",role:"parent",schools:[schoolA]},
      {key:"co-teacher-a",role:"teacher",schools:[schoolA]},
      {key:"admin-a",role:"school_admin",schools:[schoolA]},
      {key:"learner-dual",role:"learner",schools:[schoolA,schoolB]},
    ];
    const ids:Record<string,string>={}; const memIds:Record<string,string>={};
    for(const fx of fixtures){
      const row=await one(`INSERT INTO users (email, username, password_hash, role, first_name, last_name, is_active) VALUES ($1,$2,$3,$4,'T','U',true) RETURNING id`,[`${fx.key}-${DB_NAME}@test.test`, fx.key, pwHash, fx.role]);
      ids[fx.key]=row.id;
      for(const sid of fx.schools){ const m=await one(`INSERT INTO school_users (school_id, user_id, role, status) VALUES ($1,$2,$3,'active') RETURNING id`,[sid,row.id,fx.role]); memIds[`${fx.key}:${sid}`]=m.id; }
    }
    // Teachers for classes
    await q(`UPDATE classes SET class_teacher_id=$1 WHERE id=$2`,[ids["teacher-a"], classA1]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1,$2,$3,$4)`,[schoolA, ids["teacher-a"], classA1, subjectA]);
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1,$2,$3,$4)`,[schoolA, ids["co-teacher-a"], classA1, subjectA]); // co-teacher same class
    await q(`INSERT INTO teacher_classes (school_id, teacher_id, class_id, subject_id) VALUES ($1,$2,$3,$4)`,[schoolA, ids["teacher-a2"], classA2, subjectA]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`,[schoolA, ids["learner-a"], classA1]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`,[schoolA, ids["learner-a2"], classA2]);
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`,[schoolA, ids["learner-dual"], classA1]);
    await q(`INSERT INTO parent_learners (school_id, parent_id, learner_id) VALUES ($1,$2,$3)`,[schoolA, ids["parent-a"], ids["learner-a"]]);
    // Secondary school for dual
    const classDualB=(await one(`INSERT INTO classes (school_id, name, level) VALUES ($1,'Class B1','primary') RETURNING id`,[schoolB])).id;
    await q(`INSERT INTO learner_classes (school_id, learner_id, class_id) VALUES ($1,$2,$3)`,[schoolB, ids["learner-dual"], classDualB]);

    const assignA1=(await one(`INSERT INTO assignments (school_id, title, class_id, subject_id, teacher_id, status, max_score, allow_file_uploads) VALUES ($1,'Assign A1',$2,$3,$4,'published',100,true) RETURNING id`,[schoolA, classA1, subjectA, ids["teacher-a"]])).id;
    const subjectBId=subjectB; // for B

    const auth=await import("@/lib/auth");
    const tokenFor=async(key:string,schoolId:string|null)=>{
      const mId=schoolId?memIds[`${key}:${schoolId}`]:undefined;
      return auth.createToken({userId:ids[key], role:fixtures.find(f=>f.key===key)!.role, email:`${key}@test`, ...(schoolId?{schoolId, membershipId:mId}:{})});
    };
    const tokens:Record<string,string>={
      "teacher-a@a": await tokenFor("teacher-a", schoolA),
      "teacher-a2@a": await tokenFor("teacher-a2", schoolA),
      "co-teacher-a@a": await tokenFor("co-teacher-a", schoolA),
      "learner-a@a": await tokenFor("learner-a", schoolA),
      "learner-a2@a": await tokenFor("learner-a2", schoolA),
      "parent-a@a": await tokenFor("parent-a", schoolA),
      "admin-a@a": await tokenFor("admin-a", schoolA),
      "learner-dual@a": await tokenFor("learner-dual", schoolA),
      "learner-dual@b": await tokenFor("learner-dual", schoolB),
    };
    const route=async(p:string)=> import(`@/app/api/${p}/route`);
    const call=async(pathName:string, opts:any={})=>{
      const url=new URL(`http://localhost:3000/api/${pathName}`);
      const method=opts.method ?? (opts.body||opts.multipart?"POST":"GET");
      const headers:Record<string,string>={};
      if(opts.token) headers.authorization=`Bearer ${opts.token}`;
      if(opts.body) headers["content-type"]="application/json";
      if(opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
      const req=new NextRequest(url,{method, headers, ...(opts.multipart?{body:opts.multipart}:{}), ...(opts.body?{body:JSON.stringify(opts.body)}:{})});
      const mod:any=await route(pathName);
      const h=mod[method]; if(!h) throw new Error(`no ${method} for ${pathName}`);
      const res=opts.params? await h(req,{params:Promise.resolve(opts.params)}): await h(req);
      let json:any=null; try{ json=await res.clone().json();}catch{}
      return {status:res.status, json, headers:res.headers};
    };
    const uploadVia=async(token:string,purpose:"assignment"|"submission",assignId:string|null,name="test.pdf")=>{
      const form=new FormData(); form.set("purpose",purpose); if(assignId) form.set("assignmentId",assignId);
      form.set("file", new File([PDF_BYTES], name,{type:"application/pdf"}));
      const r=await call("uploads",{token, multipart:form, method:"POST"});
      const data=r.json?.data as any[]; const fileId=Array.isArray(data)&&data[0]?.fileId?data[0].fileId:undefined;
      return {status:r.status, json:r.json, fileId};
    };

    // Create submission file by learner-a
    const upSub=await uploadVia(tokens["learner-a@a"],"submission",assignA1,"submission.pdf");
    assertEq(upSub.status,201,"learner-a upload submission"); const subFileId=upSub.fileId!;
    const rowSub=await one(`SELECT stored_name FROM uploaded_files WHERE id=$1`,[subFileId]); fs.writeFileSync(path.join(UPLOAD_DIR,rowSub.stored_name), PDF_BYTES);
    // Attach to submission via submit
    const subRes=await call("assignments/[id]/submit",{token:tokens["learner-a@a"], params:{id:assignA1}, body:{content:"my work", attachments:[{fileId:subFileId, name:"submission.pdf", type:"document", size:PDF_BYTES.length, url:`/api/files/${subFileId}`}]}});
    assertEq(subRes.status,200,"learner-a submit with file");

    // Tests
    await test("submission file: uploader can read (200)", async()=>{
      const r=await call("files/[id]",{token:tokens["learner-a@a"], params:{id:subFileId}});
      assertEq(r.status,200,"uploader must read own submission");
    });
    await test("submission file: assignment owner teacher can read (200)", async()=>{
      const r=await call("files/[id]",{token:tokens["teacher-a@a"], params:{id:subFileId}});
      assertEq(r.status,200,"owner teacher must read learner submission");
    });
    await test("submission file: co-teacher same class but not owner cannot read (403)", async()=>{
      const r=await call("files/[id]",{token:tokens["co-teacher-a@a"], params:{id:subFileId}});
      assertEq(r.status,403,"co-teacher not owner must be denied for submission");
    });
    await test("submission file: learner in other class cannot read (403)", async()=>{
      const r=await call("files/[id]",{token:tokens["learner-a2@a"], params:{id:subFileId}});
      assertEq(r.status,403,"learner in other class must be denied");
    });
    await test("submission file: parent linked to enrolled learner cannot read submission (403) — submissions are learner+teacher+admin only", async()=>{
      const r=await call("files/[id]",{token:tokens["parent-a@a"], params:{id:subFileId}});
      // Current code for submission files: only uploader, assignment teacher, admin. Parent not allowed.
      assertEq(r.status,403,"parent must be denied for submission file");
    });
    await test("submission file: admin can read any submission (200)", async()=>{
      const r=await call("files/[id]",{token:tokens["admin-a@a"], params:{id:subFileId}});
      assertEq(r.status,200,"admin must read submission");
    });
    await test("submission file: dual-school learner in B cannot read A submission (404)", async()=>{
      const r=await call("files/[id]",{token:tokens["learner-dual@b"], params:{id:subFileId}});
      assertEq(r.status,404,"cross-school must be 404");
    });
    await test("submission file: unauthenticated 401", async()=>{
      const r=await call("files/[id]",{token:null, params:{id:subFileId}});
      assertEq(r.status,401,"unauthenticated 401");
    });

    console.log(`\n📊 ${passed} passed, ${failed} failed\n`);
  } finally{
    await db.end().catch(()=>undefined); await admin.end().catch(()=>undefined); if(stopServer) await stopServer().catch(()=>undefined); fs.rmSync(UPLOAD_DIR,{recursive:true, force:true});
  }
  if(failed>0) process.exit(1);
}
main().catch(e=>{console.error(e); process.exit(1);});
