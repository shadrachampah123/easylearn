/*
 * The forwarded-header configuration matrix for PR #40.
 *
 * PR #40 replaced "trust the client's `X-Forwarded-Host`" with an explicit
 * three-configuration policy:
 *
 *   1. `EASY_LEARN_PUBLIC_ORIGIN` — the configured value IS the origin; the
 *      forwarded headers are ignored completely.
 *   2. The default — the origin comes from the `Host` header and the scheme
 *      of the request URL. The forwarded headers are NOT consulted.
 *   3. `EASY_LEARN_TRUST_PROXY_HEADERS=true` — an opt-in for an edge that is
 *      known to OVERWRITE (never append to) `X-Forwarded-Host` and
 *      `X-Forwarded-Proto`.
 *
 * This probe starts ONE server per configuration and sends the same set of
 * state-changing requests to each, so the difference between them is visible.
 * It is a MANUAL probe: it needs three running production servers.
 *
 * ── How to run it ────────────────────────────────────────────────────────────
 *
 *   # the default configuration
 *   DATABASE_URL=... JWT_SECRET=... EASY_LEARN_TEST_DATABASE=true \
 *     UPLOAD_DIR=/tmp/rv40-uploads NODE_ENV=production npx next start -p 3400
 *
 *   # the opt-in configuration
 *   DATABASE_URL=... JWT_SECRET=... EASY_LEARN_TEST_DATABASE=true \
 *     EASY_LEARN_TRUST_PROXY_HEADERS=true UPLOAD_DIR=/tmp/rv40-uploads \
 *     NODE_ENV=production npx next start -p 3401
 *
 *   # the explicitly configured public origin
 *   DATABASE_URL=... JWT_SECRET=... EASY_LEARN_TEST_DATABASE=true \
 *     EASY_LEARN_PUBLIC_ORIGIN=https://easylearn.example.com \
 *     UPLOAD_DIR=/tmp/rv40-uploads NODE_ENV=production npx next start -p 3402
 *
 *   # then
 *   node tests/manual/forwarded-header-configuration-matrix.js
 */
"use strict";

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";

const CONFIGURATIONS = [
  {
    kind: "default",
    name: "default (forwarded headers are NOT trusted)",
    base: process.env.PROBE_BASE || "http://127.0.0.1:3400",
  },
  {
    kind: "opt-in",
    name: "opt-in (EASY_LEARN_TRUST_PROXY_HEADERS=true)",
    base: process.env.PROBE_OPTIN_BASE || "http://127.0.0.1:3401",
  },
  {
    kind: "public-origin",
    name: "configured public origin (EASY_LEARN_PUBLIC_ORIGIN)",
    base: process.env.PROBE_PUBLIC_ORIGIN_BASE || "http://127.0.0.1:3402",
  },
];

/** The requests every configuration is asked to answer. */
const REQUESTS = [
  {
    id: "same-origin",
    description: "Origin is the app's own origin",
    origin: (base) => base,
    headers: {},
    expect: "allowed",
  },
  {
    id: "foreign-origin",
    description: "Origin is a foreign origin",
    origin: () => "https://evil.test",
    headers: {},
    expect: "refused",
  },
  {
    id: "foreign-origin-forged-forwarded",
    description: "Origin is foreign and the forwarded headers are forged to match it",
    origin: () => "https://evil.test",
    headers: { "X-Forwarded-Host": "evil.test", "X-Forwarded-Proto": "https" },
    expect: "refused unless the opt-in is on",
  },
  {
    id: "foreign-origin-browser-claims-same-origin",
    description: "Origin is foreign but the browser claims same-origin",
    origin: () => "https://evil.test",
    headers: { "Sec-Fetch-Site": "same-origin" },
    expect: "refused",
  },
  {
    id: "same-origin-forged-forwarded",
    description: "Origin is the app's own origin, the forwarded headers are forged and no browser claim is present",
    origin: (base) => base,
    headers: { "X-Forwarded-Host": "evil.test", "X-Forwarded-Proto": "https" },
    /* A forged `X-Forwarded-Proto` makes the DERIVED scheme `https`, so the
       strict comparison against `http://<host>` fails. Without the browser's
       own `Sec-Fetch-Site: same-origin` there is no proof about the real
       origins, so the request is refused — failing closed. With
       EASY_LEARN_PUBLIC_ORIGIN the comparison origin is exact and the
       request is allowed. */
    expect: { default: "refused", "opt-in": "refused", "public-origin": "allowed" },
  },
  {
    id: "same-origin-forged-forwarded-browser",
    description: "the same, with the browser's own same-origin claim",
    origin: (base) => base,
    headers: {
      "X-Forwarded-Host": "evil.test",
      "X-Forwarded-Proto": "https",
      "Sec-Fetch-Site": "same-origin",
    },
    expect: "allowed",
  },
  {
    id: "same-host-different-scheme-browser",
    description: "the same host, the other scheme, and the browser reports same-site",
    origin: (base) => (base.startsWith("https:") ? "http" : "https") + base.slice(base.indexOf("//")),
    headers: { "Sec-Fetch-Site": "same-site" },
    expect: "refused",
  },
  {
    id: "no-origin",
    description: "no Origin header at all (a non-browser client)",
    origin: null,
    headers: {},
    /* A request that carries NEITHER `Origin` nor `Sec-Fetch-Site` is REFUSED:
       there is no information about where it came from, and failing open would
       make "strip the Origin header" a bypass. A non-browser client presents a
       Bearer token instead — that is the documented path, and it is what
       `tests/csrf-policy.test.ts` covers. */
    expect: "refused",
  },
];

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`   ✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`   ❌ FAIL: ${name}${detail ? `\n      ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("🧭 Forwarded-header configuration matrix\n");

  for (const configuration of CONFIGURATIONS) {
    console.log(`── ${configuration.name} — ${configuration.base} ──`);

    let cookie = "";
    const login = await fetch(`${configuration.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: configuration.base },
      body: JSON.stringify({ email: "teacher@browser.test", password: "BrowserProbe123!" }),
    }).catch(() => null);
    if (!login) {
      console.error(`   ⚠️  the server at ${configuration.base} is not reachable — skipping`);
      continue;
    }
    const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      if (pair.startsWith("el_token=")) cookie = pair;
    }
    console.log(`   login: ${login.status}`);

    for (const request of REQUESTS) {
      const headers = {
        "Content-Type": "application/json",
        Cookie: cookie,
        ...request.headers,
      };
      const origin = request.origin ? request.origin(configuration.base) : null;
      if (origin) headers.Origin = origin;
      const response = await fetch(`${configuration.base}/api/auth/select-school`, {
        method: "POST",
        headers,
        body: JSON.stringify({ schoolId: SCHOOL_ID }),
      });
      const allowed = response.status >= 200 && response.status < 400;
      const label = `${request.description} → ${response.status}`;

      /* The expectation may be one string for every configuration, or a map
         keyed by the configuration's kind. */
      const expectation =
        typeof request.expect === "string" ? request.expect : request.expect[configuration.kind];
      let expected;
      if (expectation === "allowed") expected = allowed;
      else if (expectation === "refused") expected = !allowed;
      else {
        /* "refused unless the opt-in is on" */
        expected = configuration.kind === "opt-in" ? allowed : !allowed;
      }
      check(label, expected, `expected ${expectation}`);
    }
    console.log("");
  }

  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("The matrix probe failed:", error);
  process.exitCode = 1;
});
