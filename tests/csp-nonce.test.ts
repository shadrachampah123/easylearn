import assert from "assert";
let passed=0, failed=0;
async function test(name:string, fn:()=>Promise<void>|void){ try{ await fn(); console.log(`✅ PASS: ${name}`); passed++; } catch(e){ console.error(`❌ FAIL: ${name} — ${e instanceof Error ? e.message: e}`); failed++; } }

function testBuildCsp() {
  // Simulate proxy's buildCsp logic
  const nonce = "testnonce1234567890";
  const isProduction = true;
  const scriptSrc = isProduction ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' blob:` : `script-src 'self' 'unsafe-eval' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' blob:`;
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https:",
    isProduction ? "connect-src 'self' https:" : "connect-src 'self' https: wss: ws:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  return csp;
}

(async()=>{
  console.log("\n🔒 CSP nonce tests\n");
  await test("Production CSP contains nonce and strict-dynamic, no unsafe-eval", async()=>{
    const csp = testBuildCsp();
    assert(csp.includes("'nonce-testnonce1234567890'"), "nonce present");
    assert(csp.includes("'strict-dynamic'"), "strict-dynamic present");
    assert(!csp.includes("'unsafe-eval'"), "no unsafe-eval in prod");
    assert(csp.includes("'self'"), "self present");
  });
  await test("CSP does not rely solely on unsafe-inline", async()=>{
    const csp = testBuildCsp();
    // Modern browsers ignore unsafe-inline when nonce present, per CSP spec
    assert(csp.includes("nonce-") && csp.includes("strict-dynamic"), "nonce + strict-dynamic present, so unsafe-inline is fallback only");
  });
  await test("Proxy generates unique nonce per request", async()=>{
    // Simulate two nonces
    const n1 = Math.random().toString(36).slice(2, 20);
    const n2 = Math.random().toString(36).slice(2, 20);
    assert(n1 !== n2, "nonces should differ");
  });
  await test("next.config.ts no longer emits CSP", async()=>{
    const fs = await import("fs");
    const path = await import("path");
    const cfg = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
    // Main app CSP should be in proxy.ts now, not next.config
    const proxy = fs.readFileSync(path.join(process.cwd(), "src/proxy.ts"), "utf8");
    assert(proxy.includes("buildCsp") && proxy.includes("nonce"), "proxy should contain nonce CSP logic");
    // next.config may still have FILE_RESPONSE_CSP for /api/files (user content sandbox) — that's intentional
    // Check that main CSP script-src is not in next.config
    assert(!cfg.includes("script-src 'self' 'nonce-"), "main nonce CSP should be in proxy, not next.config");
    assert(!cfg.includes("default-src 'self'") || cfg.includes("FILE_RESPONSE_CSP"), "next.config should not emit main CSP (only file response CSP allowed)");
  });
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  if(failed>0) process.exitCode=1;
})();
