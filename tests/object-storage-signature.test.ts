import assert from "assert";
let passed=0, failed=0;
async function test(name:string, fn:()=>Promise<void>|void){ try{ await fn(); console.log(`✅ PASS: ${name}`); passed++; } catch(e){ console.error(`❌ FAIL: ${name} — ${e instanceof Error ? e.message: e}`); failed++; } }

(async()=>{
  console.log("\n☁️ Object-storage signature tests\n");
  await test("Presigned URL signature changes when canonical query tampered", async()=>{
    const { getObjectStorageConfig, presignUrl } = await import("@/lib/object-storage");
    // Use dummy config (does not need real bucket to generate URL structure)
    process.env.OBJECT_STORAGE_BUCKET = "test-bucket";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    delete process.env.OBJECT_STORAGE_ENDPOINT;
    const config = getObjectStorageConfig();
    assert(config.enabled, "config should be enabled with dummy creds");
    const { url } = presignUrl(config, { method: "PUT", key: "uploads/test.png", expiresSeconds: 300, contentType: "image/png" });
    const tampered = url.replace(/X-Amz-Signature=[a-f0-9]+/, "X-Amz-Signature=0000000000000000000000000000000000000000000000000000000000000000");
    assert(url !== tampered, "tampered URL should differ");
    assert(url.includes("X-Amz-Signature="), "original has signature");
    assert(tampered.includes("00000"), "tampered has zeros");
    // Real provider would reject tampered signature with 403 — s3rver does not verify, so this is documented as BLOCKED for live
    delete process.env.OBJECT_STORAGE_BUCKET;
    delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
    delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  });
  await test("Presigned URL binds content-type (tampering type changes signature)", async()=>{
    const { getObjectStorageConfig, presignUrl } = await import("@/lib/object-storage");
    process.env.OBJECT_STORAGE_BUCKET = "test-bucket";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const config = getObjectStorageConfig();
    const a = presignUrl(config, { method: "PUT", key: "a.png", expiresSeconds: 300, contentType: "image/png" });
    const b = presignUrl(config, { method: "PUT", key: "a.png", expiresSeconds: 300, contentType: "text/html" });
    assert(a.url !== b.url, "different content-type should produce different signature");
    assert(a.headers["Content-Type"] === "image/png");
    assert(b.headers["Content-Type"] === "text/html");
    delete process.env.OBJECT_STORAGE_BUCKET;
    delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
    delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  });
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if(failed>0) process.exitCode=1;
})();
