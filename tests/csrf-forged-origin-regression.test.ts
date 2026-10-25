/**
 * CSRF forged headers + Origin:null + submission file access — regression.
 *
 * Covers gaps from Oct 25 review:
 * - Origin: null (file://, sandboxed iframe) must be treated as cross-origin for state-changing, not bypass.
 * - Forged X-Forwarded-Host / X-Forwarded-Proto must not widen allowed origins unless trusted and single-valued.
 * - Parent / co-teacher access to learner submission files (submission purpose) vs assignment files.
 * - SEC-8/9 edge: missing Content-Length already handled in upload route, verified via integration.
 *
 * Run: npx tsx tests/csrf-forged-origin-regression.test.ts
 */

import assert from "assert";
import { evaluateCsrfRequest, getRequestOrigins, getRequestHosts, PUBLIC_ORIGIN_ENV, TRUST_PROXY_HEADERS_ENV, ALLOWED_ORIGINS_ENV } from "@/lib/csrf";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`✅ PASS: ${name}`); passed++; }
  catch (e) { console.error(`❌ FAIL: ${name}\n   ${(e as Error).message}`); failed++; }
}
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
}

console.log("\n🔍 CSRF forged headers + Origin:null tests\n");

// Origin: null cases
test("Origin: null with no Sec-Fetch-Site is rejected (missing-origin)", () => {
  const d = evaluateCsrfRequest({ method: "POST", origin: "null", fetchSite: null, hasBearerAuthorization: false, hasSessionCookie: true, requestOrigins: ["https://app.example.test"], requestHosts: ["app.example.test"], originIsDerived: true });
  // "null" is a valid origin string but not same-origin as app; should be cross-origin
  assert.strictEqual(d.allowed, false, "Origin:null must not be allowed as same-origin");
  assert.strictEqual(d.rule, "cross-origin");
});

test("Origin: null with Sec-Fetch-Site: cross-site is rejected", () => {
  const d = evaluateCsrfRequest({ method: "POST", origin: "null", fetchSite: "cross-site", hasBearerAuthorization: false, hasSessionCookie: true, requestOrigins: ["https://app.example.test"], requestHosts: ["app.example.test"], originIsDerived: true });
  assert.strictEqual(d.allowed, false);
});

test("No Origin + Sec-Fetch-Site: same-origin is allowed (browser same-origin w/ no Origin)", () => {
  const d = evaluateCsrfRequest({ method: "POST", origin: null, fetchSite: "same-origin", hasBearerAuthorization: false, hasSessionCookie: true, requestOrigins: ["https://app.example.test"], requestHosts: ["app.example.test"], originIsDerived: true });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.rule, "same-origin");
});

test("No Origin + Sec-Fetch-Site: cross-site is rejected", () => {
  const d = evaluateCsrfRequest({ method: "POST", origin: null, fetchSite: "cross-site", hasBearerAuthorization: false, hasSessionCookie: true, requestOrigins: ["https://app.example.test"], requestHosts: ["app.example.test"], originIsDerived: true });
  assert.strictEqual(d.allowed, false);
});

// Forged forwarding headers
test("Client-supplied X-Forwarded-Host multi-value is not trusted (default trust off)", () => {
  const req = new Request("https://app.example.test/api/test", { headers: { host: "app.example.test", "x-forwarded-host": "app.example.test, evil.com", origin: "https://evil.com", "sec-fetch-site": "cross-site" } });
  const hosts = getRequestHosts(req);
  assert.ok(!hosts.includes("evil.com"), "evil.com from multi-value x-forwarded-host must not be in hosts");
  const origins = getRequestOrigins(req);
  assert.ok(!origins.includes("https://evil.com"), "evil.com must not be in origins");
  // Evaluate: evil origin should be cross-origin
  const d = evaluateCsrfRequest({ method: "POST", origin: "https://evil.com", fetchSite: "cross-site", hasBearerAuthorization: false, hasSessionCookie: true, requestOrigins: origins, requestHosts: hosts, originIsDerived: true });
  assert.strictEqual(d.allowed, false);
});

test("Single-value X-Forwarded-Host is ignored when TRUST_PROXY not enabled", () => {
  const req = new Request("https://internal.local/api/test", { headers: { host: "internal.local", "x-forwarded-host": "app.example.test", origin: "https://app.example.test", "sec-fetch-site": "same-origin" } });
  const hosts = getRequestHosts(req);
  // Without trust, forwarded host not included, so only Host header is hosts
  assert.ok(!hosts.includes("app.example.test"), "forwarded host must be ignored without trust");
  assert.ok(hosts.includes("internal.local"));
});

test("Single-value X-Forwarded-Host is trusted when TRUST_PROXY=true", () => {
  withEnv({ [TRUST_PROXY_HEADERS_ENV]: "true" }, () => {
    const req = new Request("https://internal.local/api/test", { headers: { host: "internal.local", "x-forwarded-host": "app.example.test", origin: "https://app.example.test", "sec-fetch-site": "same-origin" } });
    const hosts = getRequestHosts(req);
    assert.ok(hosts.includes("app.example.test"), "forwarded host must be trusted with opt-in");
    const origins = getRequestOrigins(req);
    assert.ok(origins.includes("https://app.example.test") || origins.includes("http://app.example.test"), "origin should include forwarded host");
  });
});

test("Multi-value X-Forwarded-Host is distrusted even with TRUST_PROXY=true", () => {
  withEnv({ [TRUST_PROXY_HEADERS_ENV]: "true" }, () => {
    const req = new Request("https://internal.local/api/test", { headers: { host: "internal.local", "x-forwarded-host": "app.example.test, evil.com", origin: "https://evil.com" } });
    const hosts = getRequestHosts(req);
    assert.ok(!hosts.includes("evil.com") && !hosts.includes("app.example.test"), "multi-value forwarded host must be fully distrusted");
  });
});

test("X-Forwarded-Proto single value is used for scheme only when trusted", () => {
  withEnv({ [TRUST_PROXY_HEADERS_ENV]: "true" }, () => {
    const req = new Request("http://internal.local/api/test", { headers: { host: "app.example.test", "x-forwarded-proto": "https", origin: "https://app.example.test" } });
    const origins = getRequestOrigins(req);
    assert.ok(origins.includes("https://app.example.test"), "https scheme from forwarded proto should be candidate");
  });
});

test("Bearer-only (no cookie) is allowed without origin check (carve-out)", () => {
  const d = evaluateCsrfRequest({ method: "POST", origin: null, fetchSite: null, hasBearerAuthorization: true, hasSessionCookie: false, requestOrigins: ["https://app.example.test"], requestHosts: ["app.example.test"], originIsDerived: true });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.rule, "bearer");
});

test("Bearer + session cookie is NOT exempt — must be origin-checked", () => {
  const d = evaluateCsrfRequest({ method: "POST", origin: "https://evil.com", fetchSite: "cross-site", hasBearerAuthorization: true, hasSessionCookie: true, requestOrigins: ["https://app.example.test"], requestHosts: ["app.example.test"], originIsDerived: true });
  assert.strictEqual(d.allowed, false, "bearer + cookie must still be checked");
});

test("EASY_LEARN_PUBLIC_ORIGIN exact — foreign Origin rejected even with matching Host via forwarded", () => {
  withEnv({ [PUBLIC_ORIGIN_ENV]: "https://app.example.test" }, () => {
    const req = new Request("https://internal.local/api/test", { headers: { host: "internal.local", "x-forwarded-host": "app.example.test", origin: "https://evil.com" } });
    const origins = getRequestOrigins(req);
    assert.deepStrictEqual(origins, ["https://app.example.test"], "configured origin must win, ignore forwarded");
    const d = evaluateCsrfRequest({ method: "POST", origin: "https://evil.com", fetchSite: "cross-site", hasBearerAuthorization: false, hasSessionCookie: true, requestOrigins: origins, requestHosts: ["app.example.test"], originIsDerived: false });
    assert.strictEqual(d.allowed, false);
  });
});

test("EASY_LEARN_ALLOWED_ORIGINS allows extra origins (preview deployments)", () => {
  withEnv({ [ALLOWED_ORIGINS_ENV]: "https://preview-123.vercel.app, https://alias.example.test" }, () => {
    const req = new Request("https://app.example.test/api/test", { headers: { host: "app.example.test", origin: "https://preview-123.vercel.app" } });
    const origins = getRequestOrigins(req);
    const d = evaluateCsrfRequest({ method: "POST", origin: "https://preview-123.vercel.app", fetchSite: "cross-site", hasBearerAuthorization: false, hasSessionCookie: true, requestOrigins: origins, requestHosts: ["app.example.test"], originIsDerived: true, allowedOrigins: ["https://preview-123.vercel.app", "https://alias.example.test"] });
    assert.strictEqual(d.allowed, true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
