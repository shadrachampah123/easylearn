#!/usr/bin/env node
/**
 * Live CSRF / proxy-trust probe.
 *
 * Runs against a PRODUCTION build (`next start`) and measures the actual HTTP
 * outcome of a state-changing request under every header combination the
 * deployment can be in. It does not assert anything about the policy module in
 * isolation: it asserts what the server really answers.
 *
 * The refusal is identified by its BODY, not by the status code, because a
 * route is free to answer 403 for its own reasons. The proxy's refusal body is
 * `{"success":false,"error":"This request did not come from the application's own origin."}`.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3400 node tests/manual/csrf-proxy-trust-probe.js
 *
 * Optional: the same probe can be pointed at a second server started with
 * EASY_LEARN_PUBLIC_ORIGIN set, by passing its base URL as BASE_URL_2.
 */

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3400";
const BASE_URL_2 = process.env.BASE_URL_2 || "";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 15000);

const REFUSAL_MESSAGES = [
  "This request did not come from the application's own origin.",
  "This request did not include an origin that could be verified, so it was refused.",
];

let passed = 0;
let failed = 0;

function record(name, ok, detail) {
  if (ok) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${name}\n   ${detail}`);
    failed++;
  }
}

/**
 * Sends one state-changing request and reports what came back.
 * The session cookie is deliberately NOT sent: the point of the probe is the
 * cross-site policy, which runs before authentication.
 */
async function send(baseUrl, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ email: "nobody@example.test", password: "wrong" }),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the response is the cross-site policy's refusal. */
function refusedByPolicy(result) {
  return REFUSAL_MESSAGES.some((message) => result.body.includes(message));
}

async function main() {
  console.log(`🛡️  Live CSRF / proxy-trust probe against ${BASE_URL}\n`);
  if (BASE_URL_2) console.log(`   second deployment: ${BASE_URL_2}\n`);

  /* ── 1. The default deployment ─────────────────────────────────────── */

  const legitimate = await send(BASE_URL, {
    origin: BASE_URL,
    host: new URL(BASE_URL).host,
    "sec-fetch-site": "same-origin",
  });
  record(
    "A legitimate same-origin write is not refused by the cross-site policy",
    !refusedByPolicy(legitimate),
    `the policy refused it: ${legitimate.status} ${legitimate.body.slice(0, 200)}`
  );

  const forgedProto = await send(BASE_URL, {
    origin: BASE_URL,
    host: new URL(BASE_URL).host,
    "sec-fetch-site": "same-origin",
    "x-forwarded-proto": "https",
  });
  record(
    "A client-supplied X-Forwarded-Proto does not refuse a legitimate write",
    !refusedByPolicy(forgedProto),
    `the policy refused it: ${forgedProto.status} ${forgedProto.body.slice(0, 200)}`
  );

  const forgedProtoNoAssertion = await send(BASE_URL, {
    origin: BASE_URL,
    host: new URL(BASE_URL).host,
    "x-forwarded-proto": "https",
  });
  record(
    "Without the browser's own Sec-Fetch-Site the write is still refused (fail closed)",
    refusedByPolicy(forgedProtoNoAssertion),
    `expected the policy to refuse it, got ${forgedProtoNoAssertion.status} ${forgedProtoNoAssertion.body.slice(0, 200)}`
  );

  const foreign = await send(BASE_URL, {
    origin: "https://evil.example.test",
    host: new URL(BASE_URL).host,
    "sec-fetch-site": "same-origin",
  });
  record(
    "A foreign origin is refused even when the browser claims same-origin",
    refusedByPolicy(foreign),
    `expected the policy to refuse it, got ${foreign.status} ${foreign.body.slice(0, 200)}`
  );

  const sameSite = await send(BASE_URL, {
    origin: "http://app.example.test",
    host: new URL(BASE_URL).host,
    "sec-fetch-site": "same-site",
  });
  record(
    "A same-site (different scheme) request is refused",
    refusedByPolicy(sameSite),
    `expected the policy to refuse it, got ${sameSite.status} ${sameSite.body.slice(0, 200)}`
  );

  const noHeaders = await send(BASE_URL, { host: new URL(BASE_URL).host });
  record(
    "A request with neither Origin nor Sec-Fetch-Site is refused",
    refusedByPolicy(noHeaders),
    `expected the policy to refuse it, got ${noHeaders.status} ${noHeaders.body.slice(0, 200)}`
  );

  const get = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { host: new URL(BASE_URL).host },
  });
  const getBody = await get.text();
  record(
    "A GET is not state-changing and is not refused by the cross-site policy",
    !refusedByPolicy({ body: getBody }),
    "a GET was refused by the cross-site policy"
  );

  /* ── 2. A deployment with EASY_LEARN_PUBLIC_ORIGIN ────────────────── */

  if (BASE_URL_2) {
    const configured = await send(BASE_URL_2, {
      origin: BASE_URL_2,
      host: new URL(BASE_URL_2).host,
      "sec-fetch-site": "same-origin",
    });
    record(
      "The configured public origin accepts its own write",
      !refusedByPolicy(configured),
      `the policy refused it: ${configured.status} ${configured.body.slice(0, 200)}`
    );

    /* The same host, the OTHER scheme: the configured origin is exact, so this
       must be refused even though the browser claims same-origin and even
       though the host matches. */
    const otherScheme = BASE_URL_2.startsWith("https:") ? "http:" : "https:";
    const otherOrigin = `${otherScheme}//${new URL(BASE_URL_2).host}`;
    const configuredPlaintext = await send(BASE_URL_2, {
      origin: otherOrigin,
      host: new URL(BASE_URL_2).host,
      "sec-fetch-site": "same-origin",
    });
    record(
      `The configured public origin is authoritative: ${otherOrigin} is refused`,
      refusedByPolicy(configuredPlaintext),
      `expected the policy to refuse it, got ${configuredPlaintext.status} ${configuredPlaintext.body.slice(0, 200)}`
    );
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} live CSRF probe checks passed`);
}

main().catch((error) => {
  console.error("CSRF probe failed to run:", error);
  process.exitCode = 1;
});
