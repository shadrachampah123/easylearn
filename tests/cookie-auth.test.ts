/**
 * Cookie-authentication regression tests.
 *
 * These are the structural guarantees that the browser session is an `httpOnly`
 * cookie and nothing else. They are source-level and policy-level checks, so they
 * run without a database and they fail loudly if a future change puts the session
 * token back into a response body, a web-storage slot, a request header or a URL.
 *
 * Each assertion fails against the pre-hardening behaviour.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { readSessionCookie } from "@/lib/session-cookie";

const REPO_ROOT = path.join(__dirname, "..");

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

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Every browser-side source file: the app pages and the components, not the API. */
function browserFiles(): string[] {
  const roots = [path.join(REPO_ROOT, "src/app"), path.join(REPO_ROOT, "src/components")];
  const out: string[] = [];
  for (const root of roots) {
    for (const file of listFiles(root)) {
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      // Server route handlers are not browser code.
      if (relative.startsWith("src/app/api/")) continue;
      out.push(relative);
    }
  }
  return out;
}

function apiRouteFiles(): string[] {
  return listFiles(path.join(REPO_ROOT, "src/app/api")).filter((f) => f.endsWith("route.ts"));
}

async function main() {
  console.log("🍪 Running cookie-authentication regression tests\n");

  // ── The response body must not carry the token ──────────────────────────────
  await test("Login: the response body does not carry the session token", () => {
    const source = read("src/app/api/auth/login/route.ts");
    const body = source.slice(source.indexOf("const response = successResponse("));
    const bodyBlock = body.slice(0, body.indexOf("});"));
    assert.ok(
      !/\btoken\b\s*[:,]/.test(bodyBlock),
      "the login response body must not include the token"
    );
  });

  await test("Login: the session is still delivered as an httpOnly cookie", () => {
    const source = read("src/app/api/auth/login/route.ts");
    assert.ok(
      source.includes("response.cookies.set(SESSION_COOKIE_NAME"),
      "the cookie must still be set, using the shared cookie name"
    );
    assert.ok(source.includes("httpOnly: true"), "the cookie must stay httpOnly");
    assert.ok(source.includes('secure: process.env.NODE_ENV === "production"'), "secure in production");
    assert.ok(source.includes('sameSite: "lax"'), "SameSite must stay lax");
    assert.ok(source.includes('path: "/"'), "the cookie path must stay /");
    assert.ok(source.includes("maxAge: 60 * 60 * 24"), "the cookie lifetime must match the token lifetime");
  });

  await test("School selection: the response body does not carry the session token", () => {
    const source = read("src/app/api/auth/select-school/route.ts");
    const body = source.slice(source.indexOf("const response = successResponse("));
    const bodyBlock = body.slice(0, body.indexOf("});"));
    assert.ok(
      !/\btoken\b\s*[:,]/.test(bodyBlock),
      "the selection response body must not include the token"
    );
    assert.ok(source.includes("httpOnly: true"), "the re-issued cookie must stay httpOnly");
    assert.ok(
      source.includes("response.cookies.set(SESSION_COOKIE_NAME"),
      "the re-issued cookie must use the shared cookie name"
    );
  });

  // ── No token in a URL ───────────────────────────────────────────────────────
  await test("Files: the ?token= query-parameter fallback is gone", () => {
    const source = read("src/app/api/files/[id]/route.ts");
    assert.ok(
      !source.includes('searchParams.get("token")'),
      "the files route must not read a token from the query string"
    );
  });

  await test("Tenant: the token-override hook is gone", () => {
    const source = read("src/lib/tenant.ts");
    assert.ok(!source.includes("tokenOverride"), "no route may supply a token from outside the request");
  });

  await test("No route anywhere reads a token from a query parameter", () => {
    for (const file of apiRouteFiles()) {
      const source = fs.readFileSync(file, "utf8");
      assert.ok(
        !source.includes('searchParams.get("token")'),
        `${path.relative(REPO_ROOT, file)} must not read a token from the query string`
      );
    }
  });

  // ── No token in web storage, in a header, or in a URL, in the browser ───────
  await test("Browser: no client file stores the session token in web storage", () => {
    for (const file of browserFiles()) {
      const source = read(file);
      const writes = source.match(/setItem\(\s*["']el_token["']/g);
      assert.ok(!writes, `${file} must not write the session token to web storage`);
      const reads = source.match(/getItem\(\s*["']el_token["']/g);
      assert.ok(!reads, `${file} must not read the session token from web storage`);
    }
  });

  await test("Browser: the only el_token reference is the deliberate legacy cleanup", () => {
    const offenders: string[] = [];
    for (const file of browserFiles()) {
      const source = read(file);
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("el_token")) return;
        // The one permitted use: removing the token an earlier release cached.
        if (line.includes("removeItem(") && line.includes("el_token")) return;
        offenders.push(`${file}:${index + 1}`);
      });
    }
    assert.deepStrictEqual(offenders, [], `unexpected el_token references: ${offenders.join(", ")}`);
  });

  await test("Browser: no client file builds an Authorization: Bearer header", () => {
    for (const file of browserFiles()) {
      const source = read(file);
      assert.ok(
        !/Bearer \$\{/.test(source),
        `${file} must not send a bearer token from the browser`
      );
    }
  });

  await test("Browser: no client file puts a token in a URL", () => {
    for (const file of browserFiles()) {
      const source = read(file);
      assert.ok(!source.includes("?token="), `${file} must not put a token in a URL`);
    }
  });

  await test("Browser: no client file caches the session profile in web storage", () => {
    for (const file of browserFiles()) {
      const source = read(file);
      const writes = source.match(/setItem\(\s*["']el_user["']/g);
      assert.ok(!writes, `${file} must not write the session profile to web storage`);
      const reads = source.match(/getItem\(\s*["']el_user["']/g);
      assert.ok(!reads, `${file} must not read the session profile from web storage`);
    }
  });

  // ── The one audited call path ──────────────────────────────────────────────
  await test("The client has a single audited API call path", () => {
    const source = read("src/lib/api-client.ts");
    assert.ok(source.includes('credentials: "same-origin"'), "the cookie must be sent same-origin only");
    assert.ok(source.includes('headers.delete("authorization")'), "a bearer header must be stripped");
  });

  await test("The client call path is used by the browser code", () => {
    const files = browserFiles();
    const usingFetch = files.filter((file) => {
      const source = read(file);
      return /(^|[^.\w])fetch\s*\(/.test(source) && !source.includes("apiFetch");
    });
    assert.deepStrictEqual(
      usingFetch,
      [],
      `these browser files still call fetch() directly: ${usingFetch.join(", ")}`
    );
  });

  // ── The server still supports the deliberately supported non-browser clients ─
  await test("The server still accepts a bearer token for non-browser clients", () => {
    const source = read("src/lib/auth.ts");
    assert.ok(
      source.includes('authHeader?.startsWith("Bearer ")'),
      "the documented non-browser bearer path must keep working"
    );
  });

  // ── No state-changing GET ──────────────────────────────────────────────────
  await test("No API route changes state in a GET handler", () => {
    const WRITE_FORMS: [RegExp, string][] = [
      [/\.insert\s*\(/, ".insert("],
      [/\.update\s*\(/, ".update("],
      [/\.delete\s*\(/, ".delete("],
      [/\bINSERT\s+INTO\b/i, "raw SQL INSERT"],
      [/\bUPDATE\s+\w+\s+SET\b/i, "raw SQL UPDATE"],
      [/\bDELETE\s+FROM\b/i, "raw SQL DELETE"],
      [/legacyInsert\s*\(/, "legacyInsert("],
    ];

    const offenders: string[] = [];
    for (const file of apiRouteFiles()) {
      const source = fs.readFileSync(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name && node.name.text === "GET") {
          const body = node.getText(parsed);
          // A read-only capability probe (`select ... limit 0`) is not a mutation.
          const withoutProbes = body.replace(/db\.execute\s*\(\s*sql`select[^`]*`\s*\)/g, "");
          for (const [pattern, label] of WRITE_FORMS) {
            if (pattern.test(withoutProbes)) {
              offenders.push(`${path.relative(REPO_ROOT, file)} (${label})`);
              break;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    assert.deepStrictEqual(offenders, [], `state-changing GET handlers: ${offenders.join(", ")}`);
  });

  await test("The two former state-changing GET routes now have a POST", () => {
    for (const route of [
      "src/app/api/messages/route.ts",
      "src/app/api/learner/stats/route.ts",
    ]) {
      const source = read(route);
      assert.ok(
        source.includes("export async function POST("),
        `${route} must offer a POST for the write`
      );
    }
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "src/app/api/messages/read/route.ts")),
      "the message read-marking route must exist"
    );
  });

  // ── The CSRF enforcement point ─────────────────────────────────────────────
  await test("The CSRF policy is enforced in one place for every API route", () => {
    const source = read("src/middleware.ts");
    assert.ok(source.includes('matcher: ["/api/:path*"]'), "the middleware must cover the whole API");
    assert.ok(
      source.includes("evaluateCsrfRequestForRequest"),
      "the middleware must use the shared policy"
    );
  });

  await test("The CSRF policy fails closed when the origin cannot be verified", () => {
    const source = read("src/lib/csrf.ts");
    assert.ok(
      source.includes('rule: "missing-origin"'),
      "a request with no verifiable origin must be refused"
    );
    assert.ok(
      source.includes("hasBearerAuthorization"),
      "the documented non-browser path must be handled explicitly"
    );
  });

  // ── One cookie name, one definition ─────────────────────────────────────────
  await test("The session cookie has exactly one definition", () => {
    const definition = read("src/lib/session-cookie.ts");
    assert.ok(
      definition.includes('export const SESSION_COOKIE_NAME = "el_token"'),
      "the canonical definition must live in session-cookie.ts"
    );

    // No server file may hardcode the name beside the canonical definition.
    for (const file of apiRouteFiles().concat([path.join(REPO_ROOT, "src/lib/auth.ts")])) {
      const source = fs.readFileSync(file, "utf8");
      const hardcoded = source.match(/cookies\.set\(\s*["']el_token["']/);
      assert.ok(
        !hardcoded,
        `${path.relative(REPO_ROOT, file)} must use SESSION_COOKIE_NAME, not a literal`
      );
    }
  });

  await test("The cookie reader finds the session cookie among other cookies", () => {
    assert.strictEqual(readSessionCookie("el_token=abc.def.ghi"), "abc.def.ghi");
    assert.strictEqual(
      readSessionCookie("theme=dark; el_token=abc.def.ghi; other=1"),
      "abc.def.ghi"
    );
    assert.strictEqual(readSessionCookie("other=1; el_token=abc.def.ghi"), "abc.def.ghi");
  });

  await test("The cookie reader does not accept a cookie whose name merely ends with it", () => {
    assert.strictEqual(readSessionCookie("other_el_token=abc"), null);
    assert.strictEqual(readSessionCookie("not-el_token=abc"), null);
    assert.strictEqual(readSessionCookie("el_token_extra=abc"), null);
  });

  await test("The cookie reader treats a missing or empty cookie as absent", () => {
    assert.strictEqual(readSessionCookie(null), null);
    assert.strictEqual(readSessionCookie(undefined), null);
    assert.strictEqual(readSessionCookie(""), null);
    assert.strictEqual(readSessionCookie("theme=dark"), null);
    assert.strictEqual(readSessionCookie("el_token="), null);
  });

  await test("The cookie reader survives a malformed percent-encoding", () => {
    assert.strictEqual(readSessionCookie("el_token=%E0%A4%A"), null);
  });

  await test("The cookie reader decodes a percent-encoded value", () => {
    assert.strictEqual(readSessionCookie("el_token=a%2Eb"), "a.b");
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} cookie-authentication tests passed`);
}

main().catch((error: unknown) => {
  console.error("Cookie-authentication suite failed to run:", error);
  process.exitCode = 1;
});
