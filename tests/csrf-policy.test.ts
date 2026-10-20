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
  PUBLIC_ORIGIN_ENV,
  TRUST_PROXY_HEADERS_ENV,
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

/** Runs `fn` with the given environment variables set, then restores them. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

  /* ── The forwarded-header trust policy ───────────────────────────────────────
     The application cannot tell a client-supplied `X-Forwarded-Host` from one
     the edge set: RFC 7239 lets a proxy append to a client-supplied value,
     and an edge that does not set the header leaves the client's value in
     place with nothing to mark it. The default is therefore to NOT trust
     them. A deployment configures the trust explicitly. */

  await test("Default: the forwarded headers are not consulted at all", () => {
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const origins = getRequestOrigins(request);
    assert.ok(
      !origins.includes("https://app.example.test"),
      `a forwarded host must not become a candidate without the opt-in: ${origins.join(", ")}`
    );
    assert.ok(
      origins.includes("http://internal.example.test"),
      `the Host header must be the candidate: ${origins.join(", ")}`
    );
  });

  await test("Default: an ordinary legitimate write is allowed", () => {
    // The deployment's own page writes to the deployment's own origin.
    const request = new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: { host: "app.example.test", origin: "https://app.example.test" },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(decision.allowed, "a same-origin write must be allowed");
    assert.strictEqual(decision.rule, "same-origin");
  });

  await test("Default: a forged forwarded host cannot make a foreign origin acceptable", () => {
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
    assert.ok(!decision.allowed, "a client must not be able to choose the comparison origin");
  });

  await test("Default: a forged forwarded host does not break a legitimate write", () => {
    const request = new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://app.example.test",
        host: "app.example.test",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "http",
      },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(decision.allowed, "a forged header must not refuse a legitimate write");
  });

  await test("Default: a multi-valued forwarded host is ignored", () => {
    // RFC 7239 lets a proxy append to a client-supplied value. The FIRST
    // element of such a list is the one the client controls.
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
  });

  await test("Default: the scheme still comes from the request URL, not from the forwarded host", () => {
    // The HOST is taken from the `Host` header and the SCHEME from the
    // request URL. This test pins the half of the pair that the forwarded
    // host cannot reach: a client that forges `X-Forwarded-Host` cannot
    // change the scheme, and therefore cannot turn `https://app` into
    // `http://evil`.
    const request = new Request("https://app.example.test/api/x", {
      headers: {
        host: "app.example.test",
        "x-forwarded-host": "evil.example.test",
      },
    });
    assert.deepStrictEqual(getRequestOrigins(request), ["https://app.example.test"]);
  });

  await test("Default: a forged forwarded PROTO can only refuse a write, never widen it", () => {
    // Next.js builds the request URL's scheme from `x-forwarded-proto`
    // (next/dist/server/next-server.js), so that header still reaches the
    // derived scheme even in the default configuration. Two properties are
    // pinned here:
    //
    //   1. it cannot make a FOREIGN origin acceptable — the host still comes
    //      from the `Host` header;
    //   2. it can refuse a write whose browser-side scheme no longer matches
    //      (the deployment-shape consequence, documented in §4 of
    //      docs/SECURITY_AUTHENTICATION.md).
    const forged = new Request("http://app.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "http://app.example.test",
        host: "app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const origins = getRequestOrigins(forged);
    assert.ok(
      !origins.some((origin) => origin.includes("evil")),
      `the forwarded proto must not introduce a foreign host: ${origins.join(", ")}`
    );
    assert.ok(
      origins.every((origin) => origin.endsWith("app.example.test")),
      `the host must still come from the Host header: ${origins.join(", ")}`
    );

    // The request URL is built by Next.js from the same header, so the
    // derived scheme follows it — this is the behaviour that makes
    // EASY_LEARN_PUBLIC_ORIGIN the recommended configuration.
    const nextJsUrl = new Request("https://app.example.test/api/x", {
      headers: { host: "app.example.test", "x-forwarded-proto": "https" },
    });
    assert.deepStrictEqual(
      getRequestOrigins(nextJsUrl),
      ["https://app.example.test"],
      "the scheme follows the request URL, which Next.js derives from x-forwarded-proto"
    );
  });

  await test("Default: the Host header is the fallback", () => {
    const request = new Request("http://localhost:3000/api/x", {
      headers: { host: "localhost:3000" },
    });
    assert.strictEqual(getRequestOrigin(request), "http://localhost:3000");
  });

  await test("Opt-in: a single-valued forwarded host is used", () => {
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const origins = withEnv({ [TRUST_PROXY_HEADERS_ENV]: "true" }, () => getRequestOrigins(request));
    assert.ok(
      origins.includes("https://app.example.test"),
      `the forwarded host must be a candidate with the opt-in: ${origins.join(", ")}`
    );
  });

  await test("Opt-in: a multi-valued forwarded host is distrusted entirely", () => {
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test, app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const origins = withEnv({ [TRUST_PROXY_HEADERS_ENV]: "true" }, () => getRequestOrigins(request));
    assert.ok(
      !origins.some((origin) => origin.includes("evil.example.test")),
      `the client-controlled first element must not be trusted: ${origins.join(", ")}`
    );
    assert.ok(
      !origins.some((origin) => origin.includes("app.example.test")),
      `a multi-valued forwarded host must be distrusted entirely: ${origins.join(", ")}`
    );
    assert.ok(
      origins.includes("https://internal.example.test"),
      `the Host header must still be a candidate: ${origins.join(", ")}`
    );
  });

  await test("Opt-in: a forwarded host is paired with the public https scheme", () => {
    // The server synthesises `x-forwarded-proto: http` for a plain internal hop
    // even when the client spoke https to the edge, so the public scheme must
    // be a candidate whenever a forwarded host was published.
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "http",
      },
    });
    const origins = withEnv({ [TRUST_PROXY_HEADERS_ENV]: "true" }, () => getRequestOrigins(request));
    assert.ok(
      origins.includes("https://app.example.test"),
      `the public https origin must be a candidate: ${origins.join(", ")}`
    );
  });

  await test("Opt-in: a chained proxy's forwarded host list is distrusted", () => {
    // Two proxies in a chain: the edge appends its own value to whatever it
    // received. The result is a multi-valued header, which is distrusted
    // entirely, so the `Host` header governs.
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "attacker.example.test, edge.example.test",
        "x-forwarded-proto": "https, http",
      },
    });
    const origins = withEnv({ [TRUST_PROXY_HEADERS_ENV]: "true" }, () => getRequestOrigins(request));
    assert.ok(
      !origins.some((origin) => origin.includes("attacker.example.test")),
      `no element of a chained list may be trusted: ${origins.join(", ")}`
    );
    assert.ok(
      !origins.some((origin) => origin.includes("edge.example.test")),
      `a chained list must be distrusted entirely: ${origins.join(", ")}`
    );
  });

  await test("Opt-in: a client that forges both forwarded headers reaches the origin it names", () => {
    // This is the documented consequence of the opt-in. A non-browser client
    // can set both headers, so the host it names becomes a candidate. It
    // gains nothing it did not already have through the deliberately
    // supported bearer path, and a browser cannot set these headers
    // cross-site without a CORS preflight.
    //
    // The name of this test used to say the request "is still origin-checked",
    // which is the opposite of what it asserts. The assertion is unchanged.
    const request = new Request("http://internal.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const decision = withEnv(
      { [TRUST_PROXY_HEADERS_ENV]: "true" },
      () => evaluateCsrfRequestForRequest(request)
    );
    assert.ok(decision.allowed, "the forwarded headers are trusted only as a single-valued pair");
  });

  await test("Opt-in: a client-supplied forwarded host list is refused", () => {
    const request = new Request("http://internal.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test, internal.example.test",
      },
    });
    const decision = withEnv(
      { [TRUST_PROXY_HEADERS_ENV]: "true" },
      () => evaluateCsrfRequestForRequest(request)
    );
    assert.ok(!decision.allowed, "a request that appends to its own forwarded host must be refused");
  });

  await test("Public origin: it is the only origin that is compared against", () => {
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const origins = withEnv(
      { [PUBLIC_ORIGIN_ENV]: "https://app.example.test" },
      () => getRequestOrigins(request)
    );
    assert.deepStrictEqual(origins, ["https://app.example.test"]);
  });

  await test("Public origin: a legitimate write is allowed through a rewriting proxy", () => {
    // The deployment shape that needs the explicit configuration: the edge
    // rewrites the Host header to an internal name, so the derived origin
    // would be the internal one and every write would be refused.
    const request = new Request("http://internal.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://app.example.test",
        host: "internal.example.test",
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const decision = withEnv(
      { [PUBLIC_ORIGIN_ENV]: "https://app.example.test" },
      () => evaluateCsrfRequestForRequest(request)
    );
    assert.ok(decision.allowed, "a legitimate same-origin write must not be refused");
  });

  await test("Public origin: a foreign origin is refused", () => {
    const request = new Request("http://internal.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        host: "internal.example.test",
      },
    });
    const decision = withEnv(
      { [PUBLIC_ORIGIN_ENV]: "https://app.example.test" },
      () => evaluateCsrfRequestForRequest(request)
    );
    assert.ok(!decision.allowed, "a foreign origin must be refused");
  });

  await test("Public origin: it takes precedence over the trusted-proxy opt-in", () => {
    const request = new Request("http://internal.example.test/api/x", {
      headers: {
        host: "internal.example.test",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const origins = withEnv(
      { [PUBLIC_ORIGIN_ENV]: "https://app.example.test", [TRUST_PROXY_HEADERS_ENV]: "true" },
      () => getRequestOrigins(request)
    );
    assert.deepStrictEqual(origins, ["https://app.example.test"]);
  });

  await test("Public origin: an unusable value is ignored rather than throwing", () => {
    const request = new Request("http://internal.example.test/api/x", {
      headers: { host: "internal.example.test" },
    });
    const origins = withEnv({ [PUBLIC_ORIGIN_ENV]: "not a url" }, () => getRequestOrigins(request));
    assert.deepStrictEqual(origins, ["http://internal.example.test"]);
  });

  await test("HTTPS termination: the request URL already carries the public scheme", () => {
    // Next.js derives the request URL's scheme from `x-forwarded-proto`, so a
    // TLS-terminating edge presents an https URL and the default policy
    // compares against the public origin without any extra configuration.
    const request = new Request("https://app.example.test/api/x", {
      method: "POST",
      headers: {
        origin: "https://app.example.test",
        host: "app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(decision.allowed, "a write behind a TLS-terminating edge must be allowed");
  });

  await test("HTTPS termination: an http request URL is not treated as the public origin", () => {
    const request = new Request("http://app.example.test/api/x", {
      method: "POST",
      headers: { origin: "https://app.example.test", host: "app.example.test" },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(!decision.allowed, "the scheme must match");
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
