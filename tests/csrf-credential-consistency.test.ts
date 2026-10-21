/**
 * F5 — the CSRF bearer carve-out and the session identity that the auth layer selects.
 *
 * The background
 * --------------
 * The browser session is an `httpOnly` cookie. The CSRF policy in `@/lib/csrf` exempts a
 * request that carries an `Authorization: Bearer` header from the origin check, because a
 * browser cannot attach that header to a cross-site request without a CORS preflight.
 *
 * That premise ("a request that presents the session cookie has no `Authorization`
 * header") was an ASSUMPTION about the client, not an enforced property. The auth layer
 * (`getTokenFromRequest` in `@/lib/auth`) actually selects the session identity in this
 * order:
 *
 *     1. the `Authorization: Bearer` token, if there is one;
 *     2. otherwise the `el_token` session cookie.
 *
 * So a request CAN carry both credentials at once. Before this fix the carve-out was
 * granted to any bearer-bearing request, including one that also carried the session
 * cookie — a request that holds ambient authority and skipped the only control that
 * protects the cookie-authenticated path. The module documentation promised the opposite
 * ("a request that presents the session cookie … is always checked"), so the code and its
 * own stated invariant disagreed.
 *
 * The fix
 * -------
 * The carve-out is granted only when the bearer is the ONLY credential on the request:
 * a request that also presents the session cookie is always origin-checked, whatever
 * else it carries. That is the smallest change that makes the policy consistent with
 * the credential the auth layer actually selects, and it removes the latent bypass that
 * a future CORS deployment would otherwise open.
 *
 * Every test marked "regression" fails against the pre-fix behaviour.
 */

import assert from "assert";
import { evaluateCsrfRequest, evaluateCsrfRequestForRequest } from "@/lib/csrf";
import { getTokenFromRequest } from "@/lib/auth";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import proxy from "@/proxy";
import { NextRequest } from "next/server";

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

const APP_ORIGIN = "https://app.example.test";
const FOREIGN_ORIGIN = "https://evil.example.test";
const SESSION_COOKIE = `${SESSION_COOKIE_NAME}=session-token-value`;
const BEARER = "Bearer bearer-token-value";

function post(headers: Record<string, string>, url = `https://app.example.test/api/quizzes`): NextRequest {
  // The `Host` header is a forbidden header name, so a constructed Request does not
  // carry one — and the policy derives the comparison origin from it. It is set here
  // explicitly, exactly as the platform's HTTP server would.
  return new NextRequest(url, {
    method: "POST",
    headers: { host: "app.example.test", ...headers },
  });
}

async function main() {
  console.log("\n🛡️  Running CSRF credential-consistency tests (F5)\n");

  /* ── The identity the auth layer actually selects ────────────────────────── */

  await test("Identity: the auth layer selects the BEARER credential when a request carries both", () => {
    const request = post({
      cookie: SESSION_COOKIE,
      authorization: BEARER,
    });
    assert.strictEqual(
      getTokenFromRequest(request),
      "bearer-token-value",
      "the bearer token is the credential the auth layer selects"
    );
  });

  await test("Identity: the session cookie is the identity when there is no bearer", () => {
    const request = post({ cookie: SESSION_COOKIE });
    assert.strictEqual(
      getTokenFromRequest(request),
      "session-token-value",
      "the session cookie is the identity when no bearer is present"
    );
  });

  /* ── F5 — the carve-out must not extend to cookie-bearing requests ───────── */

  await test("F5 regression: a cookie+bearer request is NOT exempt from the origin check", () => {
    const decision = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
        "sec-fetch-site": "cross-site",
      })
    );
    assert.ok(!decision.allowed, "a request that carries the session cookie must be origin-checked");
    assert.strictEqual(decision.rule, "cross-origin", `unexpected rule: ${decision.rule}`);
  });

  await test("F5 regression: a cookie+bearer request whose browser says it is cross-site is refused", () => {
    const decision = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        "sec-fetch-site": "cross-site",
      })
    );
    assert.ok(!decision.allowed, "a request the browser reports as cross-site must be refused");
    assert.strictEqual(decision.rule, "cross-origin", `unexpected rule: ${decision.rule}`);
  });

  await test("F5 regression: a cookie+bearer request with no origin metadata at all is refused", () => {
    const decision = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
      })
    );
    assert.ok(!decision.allowed, "a request with no verifiable origin must be refused");
    assert.strictEqual(decision.rule, "missing-origin", `unexpected rule: ${decision.rule}`);
  });

  await test("F5: a cookie+bearer request from this application's own origin is allowed", () => {
    const decision = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: APP_ORIGIN,
        "sec-fetch-site": "same-origin",
      })
    );
    assert.ok(decision.allowed, "a same-origin request must pass");
    assert.strictEqual(decision.rule, "same-origin", `unexpected rule: ${decision.rule}`);
  });

  await test("F5: the carve-out is granted exactly when the bearer is the only credential", () => {
    const bearerOnly = evaluateCsrfRequest({
      method: "POST",
      origin: FOREIGN_ORIGIN,
      fetchSite: "cross-site",
      hasBearerAuthorization: true,
      hasSessionCookie: false,
      requestOrigin: APP_ORIGIN,
      allowedOrigins: [],
    });
    assert.ok(bearerOnly.allowed, "a bearer-only request stays exempt");
    assert.strictEqual(bearerOnly.rule, "bearer", `unexpected rule: ${bearerOnly.rule}`);

    const withCookie = evaluateCsrfRequest({
      method: "POST",
      origin: FOREIGN_ORIGIN,
      fetchSite: "cross-site",
      hasBearerAuthorization: true,
      hasSessionCookie: true,
      requestOrigin: APP_ORIGIN,
      allowedOrigins: [],
    });
    assert.ok(!withCookie.allowed, "the same request with a session cookie must not be exempt");
    assert.strictEqual(withCookie.rule, "cross-origin", `unexpected rule: ${withCookie.rule}`);
  });

  /* ── The documented non-browser path must keep working ──────────────────── */

  await test("Non-browser clients: a bearer-only request is exempt, with or without an Origin", () => {
    const withoutOrigin = evaluateCsrfRequestForRequest(post({ authorization: BEARER }));
    assert.ok(withoutOrigin.allowed, "a bearer-only request must not be origin-checked");
    assert.strictEqual(withoutOrigin.rule, "bearer", `unexpected rule: ${withoutOrigin.rule}`);

    const withForeignOrigin = evaluateCsrfRequestForRequest(
      post({ authorization: BEARER, origin: FOREIGN_ORIGIN })
    );
    assert.ok(withForeignOrigin.allowed, "a bearer-only request must not be origin-checked");
    assert.strictEqual(withForeignOrigin.rule, "bearer", `unexpected rule: ${withForeignOrigin.rule}`);
  });

  await test("Non-browser clients: a cookie-only request is still origin-checked", () => {
    const foreign = evaluateCsrfRequestForRequest(
      post({ cookie: SESSION_COOKIE, origin: FOREIGN_ORIGIN })
    );
    assert.ok(!foreign.allowed, "a cookie-only request from a foreign origin must be refused");
    assert.strictEqual(foreign.rule, "cross-origin", `unexpected rule: ${foreign.rule}`);

    const missing = evaluateCsrfRequestForRequest(post({ cookie: SESSION_COOKIE }));
    assert.ok(!missing.allowed, "a cookie-only request without an origin must be refused");
    assert.strictEqual(missing.rule, "missing-origin", `unexpected rule: ${missing.rule}`);

    const sameOrigin = evaluateCsrfRequestForRequest(
      post({ cookie: SESSION_COOKIE, origin: APP_ORIGIN })
    );
    assert.ok(sameOrigin.allowed, "a same-origin cookie request must pass");
    assert.strictEqual(sameOrigin.rule, "same-origin", `unexpected rule: ${sameOrigin.rule}`);
  });

  await test("A non-state-changing request is still allowed whatever it carries", () => {
    const request = new NextRequest("https://app.example.test/api/quizzes", {
      method: "GET",
      headers: {
        host: "app.example.test",
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
      },
    });
    const decision = evaluateCsrfRequestForRequest(request);
    assert.ok(decision.allowed, "GET is not state-changing");
    assert.strictEqual(decision.rule, "method", `unexpected rule: ${decision.rule}`);
  });

  /* ── The session cookie is recognised under its own name only ────────────── */

  await test("Only the real session cookie counts as ambient authority", () => {
    const lookalike = evaluateCsrfRequestForRequest(
      post({
        cookie: "other_el_token=not-the-session",
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
      })
    );
    assert.ok(lookalike.allowed, "a cookie that is not the session cookie carries no authority");
    assert.strictEqual(lookalike.rule, "bearer", `unexpected rule: ${lookalike.rule}`);

    const real = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
      })
    );
    assert.ok(!real.allowed, "the real session cookie must be treated as ambient authority");
  });

  /* ── Future CORS assumptions ─────────────────────────────────────────────── */

  await test("Future CORS: the refusal does not depend on CORS being disabled", () => {
    const plain = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
        "sec-fetch-site": "cross-site",
      })
    );

    // The same request, but shaped like a CORS preflight would shape it. A future
    // deployment that allows the origin must not change this decision: the session
    // cookie is present, so the origin check applies and the foreign origin fails.
    const withCorsHeaders = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
        "sec-fetch-site": "cross-site",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      })
    );

    assert.ok(!plain.allowed, "the plain request must be refused");
    assert.ok(!withCorsHeaders.allowed, "the CORS-shaped request must be refused too");
    assert.strictEqual(withCorsHeaders.rule, plain.rule, "the rule must not change");
  });

  await test("Future CORS: the proxy refuses a cookie+bearer request from a foreign origin", async () => {
    const refused = await proxy(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
        "sec-fetch-site": "cross-site",
      })
    );
    assert.strictEqual(refused.status, 403, "the proxy must refuse the request");

    const cookieOnly = await proxy(
      post({ cookie: SESSION_COOKIE, origin: FOREIGN_ORIGIN, "sec-fetch-site": "cross-site" })
    );
    assert.strictEqual(cookieOnly.status, 403, "the proxy must refuse a cookie-only foreign request");

    const bearerOnly = await proxy(post({ authorization: BEARER }));
    assert.notStrictEqual(bearerOnly.status, 403, "the proxy must let a bearer-only request through");

    const sameOrigin = await proxy(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: APP_ORIGIN,
        "sec-fetch-site": "same-origin",
      })
    );
    assert.notStrictEqual(sameOrigin.status, 403, "the proxy must let a same-origin request through");
  });

  /* ── The refusal never leaks a credential ────────────────────────────────── */

  await test("The refusal message never leaks a credential", () => {
    const decision = evaluateCsrfRequestForRequest(
      post({
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        origin: FOREIGN_ORIGIN,
      })
    );
    assert.ok(decision.reason, "a refusal must explain itself");
    assert.ok(
      !decision.reason.includes("session-token-value") && !decision.reason.includes("bearer-token-value"),
      decision.reason
    );
    assert.ok(!/bearer|token|cookie/i.test(decision.reason), decision.reason);
  });

  console.log(`\n📊 csrf credential consistency: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
