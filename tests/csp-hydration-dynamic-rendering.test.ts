/**
 * Regression: interactive routes must be dynamically rendered so that the per-request
 * CSP nonce can reach their <script> tags.
 *
 * ── The defect this locks down ────────────────────────────────────────────────
 * `src/proxy.ts` sends `script-src 'self' 'nonce-…' 'strict-dynamic' …`. Browsers
 * ignore `'self'` and `'unsafe-inline'` when `'strict-dynamic'` is present, so a
 * script may only run if it carries that request's nonce.
 *
 * Next.js injects the nonce only into a document rendered per request. A prerendered
 * route is a build artifact: its `<script>` tags carry no nonce, every chunk is
 * blocked (`(blocked:csp)`), React never hydrates, and DOM handlers never exist.
 *
 * In af4fd93 that is exactly what happened to `/login`: the form's `onSubmit` never
 * existed, clicking "Log In" did a native form GET back to `/login`, no
 * `POST /api/auth/login` was ever dispatched, and therefore no session cookie was
 * ever set. Measured on the production build: 11 <script> tags, 0 nonces, while the
 * CSP header carried a fresh nonce on every request.
 *
 * ── What is asserted here (fast; no build, no server, no database) ─────────────
 *  1. Every route under an interactive segment has a covering server layout that
 *     exports `dynamic = "force-dynamic"`.
 *  2. No `"use client"` page exports `dynamic` — Next.js accepts that export and
 *     silently ignores it, leaving the route prerendered. (Verified on 16.4.5:
 *     the export is a no-op, which makes it a trap worth forbidding.)
 *  3. The root layout does NOT force dynamic rendering, so public routes keep being
 *     prerendered and CDN-cached (`○`) as intended by this fix.
 *  4. `src/proxy.ts` still sets the nonce on BOTH the forwarded request headers (the
 *     mechanism Next.js reads to nonce its scripts) and the response headers, and
 *     still emits `'nonce-…'` + `'strict-dynamic'`. This is the security half of the
 *     fix: the dynamic-rendering change must never be "paid for" by weakening CSP.
 *
 * The served-HTML half (nonce on every script == header nonce) needs a running build:
 * `BASE_URL=http://127.0.0.1:3000 node tests/manual/csp-nonce-hydration-probe.js`.
 *
 * Run: npx tsx tests/csp-hydration-dynamic-rendering.test.ts
 */
import assert from "assert";
import fs from "fs";
import path from "path";

const APP_ROOT = path.join(__dirname, "..", "src", "app");
const PROXY_PATH = path.join(__dirname, "..", "src", "proxy.ts");
const ROOT_LAYOUT = path.join(APP_ROOT, "layout.tsx");

/** Segments whose pages are client components that must hydrate to work. */
const INTERACTIVE_SEGMENTS = ["login", "register", "change-password", "dashboard"];

const FORCE_DYNAMIC = /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌ FAIL: ${name}\n   ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function findPages(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findPages(full, out);
    else if (entry.name === "page.tsx" || entry.name === "page.ts") out.push(full);
  }
  return out;
}

/** `/dashboard/admin/page.tsx` → `/dashboard/admin` (route groups are not used here). */
function routeOf(pageFile: string): string {
  const relative = path.relative(APP_ROOT, path.dirname(pageFile)).split(path.sep).join("/");
  return relative === "." ? "/" : `/${relative}`;
}

function isClientComponent(file: string): boolean {
  return /^\s*["']use client["'];?/m.test(read(file));
}

/** The nearest layout that applies to a page: its own directory first, then ancestors. */
function nearestLayout(pageFile: string): string | null {
  let dir = path.dirname(pageFile);
  const stop = path.resolve(APP_ROOT);
  for (;;) {
    for (const name of ["layout.tsx", "layout.ts"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (path.resolve(dir) === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when this route (or the layout that covers it) declares dynamic rendering. */
function routeIsDynamic(pageFile: string): boolean {
  if (FORCE_DYNAMIC.test(read(pageFile))) return true;
  const layout = nearestLayout(pageFile);
  return layout !== null && FORCE_DYNAMIC.test(read(layout));
}

function inInteractiveSegment(route: string): boolean {
  const first = route.split("/").filter(Boolean)[0];
  return INTERACTIVE_SEGMENTS.includes(first ?? "");
}

(async () => {
  console.log("\n🔒 CSP hydration / dynamic-rendering invariants\n");

  const pages = findPages(APP_ROOT);
  const interactive = pages.filter((file) => inInteractiveSegment(routeOf(file)));
  const publicPages = pages.filter((file) => !inInteractiveSegment(routeOf(file)));

  await test("the app router tree was found (pages exist under src/app)", () => {
    assert(pages.length > 0, "no page.tsx files found under src/app");
  });

  await test("every interactive segment has at least one page", () => {
    for (const segment of INTERACTIVE_SEGMENTS) {
      const found = interactive.some((file) => routeOf(file).split("/").filter(Boolean)[0] === segment);
      assert(found, `segment /${segment} has no page.tsx — expected segments: ${INTERACTIVE_SEGMENTS.join(", ")}`);
    }
  });

  await test("every interactive route is dynamically rendered (a layout exports force-dynamic)", () => {
    const offenders = interactive.filter((file) => !routeIsDynamic(file)).map(routeOf);
    assert(
      offenders.length === 0,
      `these routes would be prerendered without a CSP nonce, so every script would be ` +
        `blocked and the page would never hydrate: ${offenders.join(", ")}`
    );
  });

  await test("each interactive segment has its own server layout exporting force-dynamic", () => {
    for (const segment of INTERACTIVE_SEGMENTS) {
      const layout = path.join(APP_ROOT, segment, "layout.tsx");
      assert(fs.existsSync(layout), `missing segment layout: src/app/${segment}/layout.tsx`);
      assert(
        FORCE_DYNAMIC.test(read(layout)),
        `src/app/${segment}/layout.tsx must export const dynamic = "force-dynamic"`
      );
    }
  });

  await test('no "use client" page exports route segment config (it is silently ignored)', () => {
    const offenders: string[] = [];
    for (const file of pages) {
      if (!isClientComponent(file)) continue;
      if (/export\s+const\s+(dynamic|revalidate|fetchCache|runtime)\b/.test(read(file))) {
        offenders.push(routeOf(file));
      }
    }
    assert(
      offenders.length === 0,
      `Next.js accepts these exports and ignores them, leaving the route prerendered — ` +
        `put the config in a server layout instead: ${offenders.join(", ")}`
    );
  });

  await test("the root layout does NOT force dynamic rendering (public pages stay static)", () => {
    assert(!FORCE_DYNAMIC.test(read(ROOT_LAYOUT)), "src/app/layout.tsx must not export force-dynamic");
  });

  await test("public routes are not covered by an interactive force-dynamic layout", () => {
    const wronglyDynamic = publicPages.filter((file) => routeIsDynamic(file)).map(routeOf);
    assert(
      wronglyDynamic.length === 0,
      `these public routes would lose static rendering and CDN caching: ${wronglyDynamic.join(", ")}`
    );
  });

  await test("proxy still forwards the nonce to Next.js on the request headers", () => {
    const proxy = read(PROXY_PATH);
    assert(
      /requestHeaders\.set\(\s*["']Content-Security-Policy["']/.test(proxy),
      "the nonce must be set on the forwarded REQUEST headers; Next.js reads it from there to nonce its <script> tags"
    );
  });

  await test("proxy still sets the policy on the response headers", () => {
    assert(
      /response\.headers\.set\(\s*["']Content-Security-Policy["']/.test(read(PROXY_PATH)),
      "the response must carry the Content-Security-Policy header"
    );
  });

  await test("the script policy still uses a nonce AND strict-dynamic (not weakened)", () => {
    const proxy = read(PROXY_PATH);
    assert(/'nonce-\$\{nonce\}'/.test(proxy), "script-src must still interpolate a per-request nonce");
    assert(/'strict-dynamic'/.test(proxy), "script-src must still include 'strict-dynamic'");
    assert(
      /script-src 'self' 'nonce-\$\{nonce\}' 'strict-dynamic'/.test(proxy),
      "the production script-src must stay: script-src 'self' 'nonce-${nonce}' 'strict-dynamic'"
    );
  });

  await test("proxy still generates the nonce from a CSPRNG", () => {
    const proxy = read(PROXY_PATH);
    assert(/getRandomValues/.test(proxy), "the nonce must come from crypto.getRandomValues");
    assert(/new Uint8Array\(16\)/.test(proxy), "the nonce should be 16 random bytes");
  });

  console.log(`\n${failed === 0 ? "✅ all checks passed" : "❌ failures above"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
