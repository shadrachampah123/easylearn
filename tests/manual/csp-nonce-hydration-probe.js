/**
 * CSP nonce/nonce-propagation probe — needs a running production build.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 * `src/proxy.ts` sets a per-request nonce and sends
 *   script-src 'self' 'nonce-…' 'strict-dynamic' 'unsafe-inline' blob:
 * On a browser, `'strict-dynamic'` makes it IGNORE 'self' and `'unsafe-inline'`,
 * so the ONLY scripts allowed are the ones carrying that exact nonce (plus
 * whatever those scripts insert themselves).
 *
 * Next.js can only inject the request's nonce into its `<script>` tags when the
 * document is rendered per request. A prerendered document is a build-time
 * artifact: it has no nonce, every chunk is blocked, React never hydrates, and a
 * handler such as the login form's `onSubmit` never exists — so no
 * `POST /api/auth/login` is ever dispatched and no session cookie is ever set.
 * That exact failure shipped in af4fd93; this probe is the regression guard.
 *
 * It asserts, over plain HTTP (no browser required), that for every interactive
 * route:
 *   1. the response carries a `nonce-…` in its Content-Security-Policy,
 *   2. the document renders at least one <script>,
 *   3. EVERY <script> tag carries a nonce attribute, and
 *   4. every nonce equals the one in the response header.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node tests/manual/csp-nonce-hydration-probe.js
 *   BASE_URL=https://your-deployment.vercel.app node tests/manual/csp-nonce-hydration-probe.js
 *
 * A Vercel deployment protected by Deployment Protection answers with the Vercel
 * SSO page instead of the app; point BASE_URL at an unprotected production alias,
 * or send a session cookie. The probe never writes to the database.
 */

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

/** Routes that must be interactive (they are client components). */
const INTERACTIVE_ROUTES = [
  "/login",
  "/register",
  "/change-password",
  "/dashboard/admin",
  "/dashboard/teacher",
  "/dashboard/learner",
  "/dashboard/parent",
];

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`   ✅ ${label}`);
  } else {
    failures++;
    console.error(`   ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The nonce the response's CSP header allows, or null when there is none. */
function headerNonce(headers) {
  const csp = headers.get("content-security-policy");
  if (!csp) return { csp: null, nonce: null };
  const match = /'nonce-([^']+)'/.exec(csp);
  return { csp, nonce: match ? match[1] : null };
}

/** Every <script …> opening tag in the document. */
function scriptTags(html) {
  return html.match(/<script\b[^>]*>/gi) || [];
}

function attributeNonce(tag) {
  const match = /\bnonce="([^"]*)"/i.exec(tag);
  return match ? match[1] : null;
}

async function probeRoute(route) {
  console.log(`\n▶ ${route}`);
  const response = await fetch(`${BASE_URL}${route}`, {
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    redirect: "follow",
  });
  const html = await response.text();
  const { csp, nonce } = headerNonce(response.headers);
  const tags = scriptTags(html);
  const nonced = tags.map(attributeNonce);
  const missing = nonced.filter((value) => value === null).length;
  const distinct = [...new Set(nonced.filter(Boolean))];

  console.log(`   status ${response.status}`);
  console.log(
    `   cache-control: ${response.headers.get("cache-control") || "(none)"}`
  );
  console.log(`   csp nonce: ${nonce === null ? "(none in header)" : nonce}`);
  console.log(`   scripts: ${tags.length} total, ${tags.length - missing} nonced`);
  console.log(`   distinct script nonces: ${distinct.length ? distinct.join(", ") : "(none)"}`);

  check(response.ok, `responds 2xx (got ${response.status})`);
  check(nonce !== null, "the CSP response header carries a nonce");
  check(tags.length > 0, "the document renders at least one <script>");
  check(
    missing === 0,
    "every <script> tag carries a nonce attribute",
    `${missing} of ${tags.length} have none`
  );
  check(
    distinct.length <= 1,
    "all scripts share a single nonce",
    distinct.join(", ")
  );
  check(
    nonce !== null && distinct.length === 1 && distinct[0] === nonce,
    "the script nonce equals the CSP header nonce",
    `header=${nonce} html=${distinct.join(",") || "(none)"}`
  );
  if (csp) console.log(`   policy: ${csp}`);
}

(async () => {
  console.log(`\n🔒 CSP nonce propagation probe — ${BASE_URL}\n`);
  for (const route of INTERACTIVE_ROUTES) {
    try {
      await probeRoute(route);
    } catch (error) {
      failures++;
      console.error(`   ❌ ${route} failed: ${error.message}`);
    }
  }
  console.log(
    failures === 0
      ? "\n✅ All interactive routes use a matching per-request nonce.\n"
      : `\n❌ ${failures} check(s) failed — pages without a matching nonce cannot hydrate.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
