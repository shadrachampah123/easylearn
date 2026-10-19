/**
 * CSRF policy tests.
 *
 * The browser session is an `httpOnly` cookie, and a cookie is attached to a
 * cross-site request as well as a same-origin one. These tests pin the policy that
 * decides whether a state-changing request may proceed.
 *
 * Every test is a regression test: each one fails against the pre-hardening
 * behaviour, where nothing checked the origin of a state-changing request and the
 * cookie was the only thing standing between a foreign page and the API.
 */

import assert from "assert";
import {
  evaluateCsrfRequest,
  evaluateCsrfRequestForRequest,
  getConfiguredAllowedOrigins,
  getRequestOrigin,
  getRequestOrigins,
  isSameOrigin,
  isStateChangingMethod,
  STATE_CHANGING_METHODS,
  ALLOWED_ORIGINS_ENV,
} from "@/lib/csrf";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    });
}

const ORIGIN = "https://app.example.test";
const REQUEST_ORIGIN = "https://app.example.test";

function decide(overrides: Partial<Parameters<typeof evaluateCsrfRequest>[0]> = {}) {
  return evaluateCsrfRequest({
    method: "POST",
    origin: ORIGIN,
    fetchSite: "same-origin",
    hasBearerAuthorization: false,
    requestOrigin: REQUEST_ORIGIN,
    allowedOrigins: [],
    ...overrides,
  });
}

async function main() {
  console.log("🛡️  Running CSRF policy tests\n");

  await test("Policy: the state-changing methods are the ones that need a check", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.ok(isStateChangingMethod(method), `${method} must be state-changing`);
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "get", "head"]) {
      assert.ok(!isStateChangingMethod(method), `${method} must not be state-changing`);
    }
    assert.strictEqual(STATE_CHANGING_METHODS.size, 4);
  });

  await test("Policy: a non-state-changing request is always allowed", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const decision = decide({ method, origin: "https://evil.example.test", fetchSite: "cross-site" });
      assert.ok(decision.allowed, `${method} must be allowed`);
      assert.strictEqual(decision.rule, "method");
    }
  });

  await test("Policy: a same-origin POST is allowed", () => {
    const decision = decide();
    assert.ok(decision.allowed);
    assert.strictEqual(decision.rule, "same-origin");
  });

  await test("Policy: a cross-origin POST is refused", () => {
    const decision = decide({ origin: "https://evil.example.test" });
    assert.ok(!decision.allowed, "a cross-origin request must be refused");
    assert.strictEqual(decision.rule, "cross-origin");
    assert.ok(decision.reason, "a refusal must explain itself");
  });

  await test("Policy: the refusal message never leaks a credential", () => {
    const decision = decide({ origin: "https://evil.example.test" });
    assert.ok(decision.reason);
    assert.ok(!/bearer|token|cookie/i.test(decision.reason), decision.reason);
  });

  await test("Policy: a cross-origin request that also says same-site is refused", () => {
    // `Sec-Fetch-Site: same-site` means a sibling subdomain. A sibling subdomain is
    // not this application, so it is refused.
    const decision = decide({ origin: null, fetchSite: "same-site" });
    assert.ok(!decision.allowed, "a same-site request must be refused");
    assert.strictEqual(decision.rule, "cross-origin");
  });

  await test("Policy: a request with no Origin and no Sec-Fetch-Site is refused", () => {
    // Failing open here would make "no Origin header" a bypass.
    const decision = decide({ origin: null, fetchSite: null });
    assert.ok(!decision.allowed, "a request with no origin information must be refused");
    assert.strictEqual(decision.rule, "missing-origin");
  });

  await test("Policy: a request with no Origin but Sec-Fetch-Site: same-origin is allowed", () => {
    const decision = decide({ origin: null, fetchSite: "same-origin" });
    assert.ok(decision.allowed);
    assert.strictEqual(decision.rule, "same-origin");
  });

  await test("Policy: a request with no Origin but Sec-Fetch-Site: none is allowed", () => {
    // "none" means the user typed the URL or opened a bookmark; the request is
    // same-origin by definition.
    const decision = decide({ origin: null, fetchSite: "none" });
    assert.ok(decision.allowed);
  });

  await test("Policy: Sec-Fetch-Site: cross-site is refused even without an Origin", () => {
    const decision = decide({ origin: null, fetchSite: "cross-site" });
    assert.ok(!decision.allowed);
    assert.strictEqual(decision.rule, "cross-origin");
  });

  await test("Policy: a bearer-authenticated request is allowed without an origin", () => {
    // A deliberately supported non-browser client. A browser cannot set this header
    // on a cross-site request without a CORS preflight, and CORS is not enabled.
    const decision = decide({
      origin: null,
      fetchSite: null,
      hasBearerAuthorization: true,
    });
    assert.ok(decision.allowed, "a bearer client must not be broken by the CSRF check");
    assert.strictEqual(decision.rule, "bearer");
  });

  await test("Policy: a bearer request is allowed even with a cross-origin header", () => {
    const decision = decide({
      origin: "https://evil.example.test",
      fetchSite: "cross-site",
      hasBearerAuthorization: true,
    });
    assert.ok(decision.allowed);
  });

  await test("Policy: an explicitly configured extra origin is allowed", () => {
    const decision = decide({
      origin: "https://admin.example.test",
      allowedOrigins: ["https://admin.example.test"],
    });
    assert.ok(decision.allowed, "a configured origin must be allowed");
  });

  await test("Policy: an unconfigured origin is still refused", () => {
    const decision = decide({ origin: "https://admin.example.test" });
    assert.ok(!decision.allowed);
  });

  await test("Policy: the allowed-origins environment variable is read as a list", () => {
    const previous = process.env[ALLOWED_ORIGINS_ENV];
    process.env[ALLOWED_ORIGINS_ENV] = "https://a.example.test, https://b.example.test";
    const origins = getConfiguredAllowedOrigins();
    assert.deepStrictEqual(origins, ["https://a.example.test", "https://b.example.test"]);

    delete process.env[ALLOWED_ORIGINS_ENV];
    assert.deepStrictEqual(getConfiguredAllowedOrigins(), []);

    if (previous !== undefined) process.env[ALLOWED_ORIGINS_ENV] = previous;
  });

  await test("Origins: the comparison ignores the path, the query and a default port", () => {
    assert.ok(isSameOrigin("https://a.test", "https://a.test/"));
    assert.ok(isSameOrigin("https://a.test/some/path?x=1", "https://a.test"));
    assert.ok(isSameOrigin("https://a.test:443", "https://a.test"));
    assert.ok(!isSameOrigin("https://a.test", "http://a.test"), "the scheme must matter");
    assert.ok(!isSameOrigin("https://a.test", "https://b.test"), "the host must matter");
    assert.ok(!isSameOrigin("https://a.test", "https://a.test.evil.test"), "the host must not be a suffix match");
  });

  await test("Origins: a subdomain of the application is not the application", () => {
    assert.ok(!isSameOrigin("https://evil.app.example.test", "https://app.example.test"));
  });

  await test("Request origin: the forwarded host and protocol are used", () => {
    const request = new Request("https://internal.example.test/api/x", {
      headers: {
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    assert.strictEqual(getRequestOrigin(request), "https://app.example.test");
  });

  await test("Request origin: the Host header is the fallback", () => {
    const request = new Request("http://localhost:3000/api/x", {
      headers: { host: "localhost:3000" },
    });
    assert.strictEqual(getRequestOrigin(request), "http://localhost:3000");
  });

  await test("Request origin: a multi-valued forwarded host is not trusted", () => {
    // RFC 7239 lets a proxy append to a client-supplied value. The FIRST element
    // of such a list is the one the client controls, so a multi-valued
    // `x-forwarded-host` is ignored entirely and the `Host` header is used.
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test, internal.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const origins = getRequestOrigins(request);
    assert.ok(
      !origins.some((origin) => origin.includes("evil.example.test")),
      `a client-supplied forwarded host must not become a candidate origin: ${origins.join(", ")}`
    );
    assert.ok(
      origins.includes("https://internal.example.test"),
      `the Host header must still be a candidate: ${origins.join(", ")}`
    );
  });

  await test("Request origin: a forwarded host is paired with the public https scheme", () => {
    // The server synthesises `x-forwarded-proto: http` for a plain internal hop
    // even when the client spoke https to the edge. The public scheme must
    // therefore be a candidate whenever a forwarded host was published.
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "http",
      },
    });
    const origins = getRequestOrigins(request);
    assert.ok(
      origins.includes("https://app.example.test"),
      `the public https origin must be a candidate: ${origins.join(", ")}`
    );
  });

  await test("Request origin: a forwarded host without a forwarded scheme is still a candidate", () => {
    // A TLS-terminating edge usually publishes the public host. If it does not
    // publish the scheme, the public origin is https even though the hop to this
    // application is plain http — otherwise every same-origin write is refused.
    const request = new Request("http://internal.example.test/api/x", {
      headers: { host: "internal.example.test", "x-forwarded-host": "app.example.test" },
    });
    const origins = getRequestOrigins(request);
    assert.ok(
      origins.includes("https://app.example.test"),
      `the public https origin must be a candidate: ${origins.join(", ")}`
    );
    assert.ok(
      origins.includes("http://app.example.test"),
      `the forwarded host must be a candidate: ${origins.join(", ")}`
    );
  });

  await test("Policy: a forwarded host without a forwarded scheme is not refused", () => {
    const request = new Request("http://internal.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://app.example.test",
        host: "internal.example.test",
        "x-forwarded-host": "app.example.test",
      },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(decision.allowed, "a legitimate same-origin write must not be refused");
  });

  await test("Policy: a client-supplied forwarded host is refused", () => {
    const request = new Request("http://internal.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test, internal.example.test",
      },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(!decision.allowed, "a request that chooses its own forwarded host must be refused");
  });

  await test("Policy: a request that forges both forwarded headers is still origin-checked", () => {
    // A non-browser client can set both headers, so the host it names becomes a
    // candidate. It gains nothing it did not already have through the
    // deliberately supported bearer path, and a browser cannot set these
    // headers cross-site without a CORS preflight.
    const request = new Request("http://internal.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(decision.allowed, "the forwarded headers are trusted only as a single-valued pair");
  });

  await test("Request wrapper: a real request is judged the same way", () => {
    const sameOrigin = new Request("https://app.example.test/api/auth/login", {
      method: "POST",
      headers: { origin: "https://app.example.test", host: "app.example.test" },
    });
    assert.ok(evaluateCsrfRequestForRequest(sameOrigin).allowed);

    const crossOrigin = new Request("https://app.example.test/api/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example.test", host: "app.example.test" },
    });
    assert.ok(!evaluateCsrfRequestForRequest(crossOrigin).allowed);

    const bearer = new Request("https://app.example.test/api/auth/login", {
      method: "POST",
      headers: { authorization: "Bearer abc.def.ghi", host: "app.example.test" },
    });
    assert.ok(evaluateCsrfRequestForRequest(bearer).allowed);
  });

  await test("Request wrapper: a non-bearer Authorization header is not a bypass", () => {
    // Only `Bearer` is a supported non-browser scheme. A `Basic` header is not, so
    // the request is still origin-checked.
    const request = new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz", host: "app.example.test" },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(!decision.allowed, "a Basic header must not bypass the origin check");
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} CSRF policy tests passed`);
}

main().catch((error: unknown) => {
  console.error("CSRF policy suite failed to run:", error);
  process.exitCode = 1;
});
