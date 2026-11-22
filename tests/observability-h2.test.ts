/**
 * H-2 (observability) regression suite — no database, no server, no build required.
 *
 * Audit finding H-2 (2026-11-19) said, in one line: *no error boundaries, no
 * instrumentation, no monitoring — the C-1 outage produced zero server-side signal*.
 * This suite pins the code that closes it, and it is written the same way the earlier
 * H-1 suites were: every assertion is one a plausible refactor could break, and the
 * ones that could pass for the wrong reason have a positive control.
 *
 * SECTIONS
 *   1. Boundaries exist where Next.js looks for them, and obey the contract
 *   2. Instrumentation uses the supported lifecycle and cannot break boot
 *   3. Redaction removes every secret class in the brief (with a positive control)
 *   4. Logging cannot crash a request — including when console itself throws
 *   5. Request correlation is safe against a forged id
 *   6. Health: configuration vs availability, and no infrastructure disclosure
 *   7. The intake endpoint is bounded and cannot 500
 *   8. Existing security controls are intact (CSRF, auth, tenant, throttle, migrations)
 *   9. The roadmap distinguishes merged / deployed / Production-verified
 *
 * Run: npx tsx tests/observability-h2.test.ts
 */
import assert from "assert";
import fs from "fs";
import path from "path";

/* `@/lib/*` modules import `@/db`, which throws at import time without a URL. A dummy
   local URL is enough: pg.Pool connects lazily and nothing here runs a query. */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:1/testdb";
process.env.JWT_SECRET = "observability-h2-suite-secret-0123456789abcdef";

const REPO_ROOT = path.join(__dirname, "..");

function readFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relative));
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed += 1;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${(error as Error).message}`);
      failed += 1;
    });
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Import a module that this work introduced, turning "the file does not exist" into a
 * usable value.
 *
 * On the branch this suite ships with, every import below resolves. Against the PRE-H-2
 * tree — which is how the negative control is run — none of them do, and a bare dynamic
 * import throws during module evaluation, which aborts the whole suite and reports
 * nothing. That would make the negative control worthless: "the suite crashed" is not the
 * same evidence as "these specific assertions failed". So each import is guarded and the
 * dependent tests fail individually, which is what a reviewer needs to see.
 */
async function importOrMissing<T>(specifier: string, fallback: () => T): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return fallback();
  }
}

/** Capture everything written to the console while `fn` runs. */
async function captureConsole(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const record = (...args: unknown[]) => {
    lines.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
}

/** A realistic set of secrets to look for in output. */
const SECRETS = {
  databaseUrl: "postgresql://neondb_owner:sup3r-s3cret-pw@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJyb2xlIjoiYWRtaW4ifQ.c2lnbmF0dXJlLXZhbHVl",
  cookie: "easylearn_session=abc123def456ghi789jkl012",
  authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  r2Secret: "R2SecretAccessKey/with+special=chars0123456789",
  r2AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
  password: "Hunter2-very-secret-password",
  apiKey: "api_key=sk_live_51H8xYzABCDEFGHIJKLMNOP",
  email: "amina.yawson@example.com",
  presignedQuery: "X-Amz-Signature=9f8e7d6c5b4a39281706f5e4d3c2b1a0",
};

/** Every secret value must be absent from `output`. */
function assertNoSecrets(output: string, context: string): void {
  for (const [name, secret] of Object.entries(SECRETS)) {
    /* The presigned-signature case is asserted on its value, not the parameter name:
       keeping the parameter name is deliberate (it tells an operator a signed URL was
       involved) while the signature itself must never appear. */
    const needle = name === "presignedQuery" ? "9f8e7d6c5b4a39281706f5e4d3c2b1a0" : secret;
    assert(
      !output.includes(needle),
      `${context}: the ${name} value leaked into the output`
    );
  }
}

async function main() {
  /* ══ 1. ERROR BOUNDARIES ══════════════════════════════════════════════════ */

  await test("H-2: the three boundaries exist where Next.js looks for them", () => {
    for (const file of ["src/app/error.tsx", "src/app/global-error.tsx", "src/app/not-found.tsx"]) {
      assert(exists(file), `${file} must exist — its absence was audit finding H-2`);
    }
  });

  await test("H-2: error.tsx and global-error.tsx are client boundaries with the required props", async () => {
    const errorBoundary = readFile("src/app/error.tsx");
    const globalBoundary = readFile("src/app/global-error.tsx");

    for (const [name, source] of [
      ["error.tsx", errorBoundary],
      ["global-error.tsx", globalBoundary],
    ] as const) {
      assert(source.trimStart().startsWith('"use client"'), `${name} must be a Client Component`);
      assert(/export default function/.test(source), `${name} must default-export the boundary`);
      assert(/\berror\b/.test(source) && /\breset\b/.test(source), `${name} must accept { error, reset }`);
      /* `digest` is the only handle a server error has; without it the boundary cannot
         be correlated with the framework's own log line. */
      assert(source.includes("digest"), `${name} must surface the error digest`);
      assert(/reset\(\)/.test(source), `${name} must offer recovery`);
      /* The brief's rule: never show internals. A message rendered from the error
         object is the classic way a stack trace or a database DSN reaches a user. */
      assert(
        !/\{error\.message\}|\{error\?\.message\}/.test(source),
        `${name} must not render the raw error message`
      );
    }

    /* global-error.tsx replaces the root layout, so it must supply the document itself. */
    assert(globalBoundary.includes("<html"), "global-error.tsx must render <html>");
    assert(globalBoundary.includes("<body"), "global-error.tsx must render <body>");
  });

  await test("H-2: not-found.tsx is a server component that does not echo the requested path", () => {
    const notFound = readFile("src/app/not-found.tsx");
    assert(!notFound.includes('"use client"'), "a 404 needs no client JavaScript");
    /* Reflecting the URL would put a token or an email address into a cacheable page. */
    assert(!/usePathname|useSearchParams|params\.|\bpathname\b/.test(notFound), "not-found must not reflect the request path");
    assert(notFound.includes("/login") && notFound.includes('href="/"'), "must offer a way forward");
  });

  await test("H-2: both boundaries report to the intake endpoint without awaiting it", () => {
    for (const file of ["src/app/error.tsx", "src/app/global-error.tsx"]) {
      const source = readFile(file);
      assert(source.includes("/api/internal/client-error"), `${file} must report the failure server-side`);
      /* `keepalive` is what keeps the report alive when the user navigates away. */
      assert(source.includes("keepalive"), `${file} must use keepalive so the report survives a navigation`);
      /* A monitoring call must never be able to break the recovery path. */
      assert(/\.catch\(\s*\(\)\s*=>/.test(source), `${file} must swallow a failed report`);
      /* The call must be the AUDITED browser path, not the global `fetch`: the repository
         has exactly one browser call path (`src/lib/api-client.ts`) and
         `tests/cookie-auth.test.ts` fails any browser file that calls `fetch` directly.
         Pinning the name here means this suite fails for the same reason, at the same
         time, instead of leaving the other suite to catch it. */
      assert(/try\s*\{[\s\S]{0,600}apiFetch\(/.test(source), `${file} must guard the report call itself`);
      assert(
        source.includes('from "@/lib/api-client"'),
        `${file} must report through the audited browser call path, not the global fetch`
      );
    }
  });

  await test("H-2: the boundaries send only the digest, the error name and the route", () => {
    const body = readFile("src/app/error.tsx");
    /* Take the object literal handed to `JSON.stringify` and stop at its closing brace.
       Slicing to `keepalive` was wrong the first time this test was written: `keepalive`
       appears BEFORE the payload in the file, so the slice was empty and the assertions
       would have passed on an empty string. */
    const start = body.indexOf("JSON.stringify({");
    assert(start > -1, "the report payload must be an object literal");
    const end = body.indexOf("})", start);
    const sent = body.slice(start, end);
    for (const allowed of ["digest", "name", "route"]) {
      assert(sent.includes(allowed), `the report may carry ${allowed}`);
    }
    /* The request body is the one place a server-rendered message could be
       re-transmitted to an unauthenticated intake. It must not be in the payload. */
    assert(!/message\s*:/.test(sent), "the report must not carry the error message");
    assert(!/stack\s*:/.test(sent), "the report must not carry a stack trace");
  });

  /* ══ 2. INSTRUMENTATION ═══════════════════════════════════════════════════ */

  await test("H-2: instrumentation.ts exists in src/ and exports the supported lifecycle", () => {
    assert(exists("src/instrumentation.ts"), "src/instrumentation.ts must exist");
    const source = readFile("src/instrumentation.ts");
    assert(/export async function register\(/.test(source), "must export register()");
    assert(/export async function onRequestError\(/.test(source), "must export onRequestError()");
    /* The framework reads the signature positionally; a renamed first parameter is fine,
       a reordered one is not. Pin the three positions. */
    assert(
      /onRequestError\(\s*error[^,]*,\s*request[^,]*,\s*context/.test(source),
      "onRequestError must take (error, request, context) in that order"
    );
  });

  await test("H-2: instrumentation is guarded by NEXT_RUNTIME and cannot break boot", () => {
    const source = readFile("src/instrumentation.ts");
    assert(
      source.includes('process.env.NEXT_RUNTIME !== "nodejs"'),
      "the Node-only hooks must not half-initialise under the Edge runtime"
    );
    /* register() must catch its own failures: a diagnostic that refuses to boot is an
       outage caused by monitoring. */
    assert(/try\s*\{[\s\S]*\}\s*catch/.test(source), "register() must catch its own failures");
    assert(
      !/throw new Error/.test(source),
      "instrumentation must not throw: a logging problem is not a startup failure"
    );
  });

  await test("H-2: onRequestError logs a structured line and never logs request headers wholesale", () => {
    const source = readFile("src/instrumentation.ts");
    assert(source.includes('event: "request.error"'), "the escaped-error event must have a stable name");
    for (const field of ["routePath", "routeType", "routerKind", "method", "path"]) {
      assert(source.includes(field), `the error line must carry ${field}`);
    }
    /* `request.headers` holds cookie and authorization. Only named, safe headers may be
       read, and there must be no spread of the whole object. */
    assert(!/\.\.\.request\.headers|headers:\s*request\.headers/.test(source), "must not log the whole header dict");
    assert(/safeHeader\(/.test(source), "header access must go through the allow-list helper");
  });

  await test("H-2: register() performs no network I/O", () => {
    const source = readFile("src/instrumentation.ts");
    /* A boot hook that calls out is billed, slow and can fail the function. */
    assert(!/\bfetch\(/.test(source), "register() must not call fetch");
    assert(!/checkObjectStorageReachability/.test(source), "register() must not run the deep storage probe");
    assert(!/pool\.query|db\.query/.test(source), "register() must not query the database at boot");
  });

  /* ══ 3. REDACTION ═════════════════════════════════════════════════════════ */

  type RedactionModule = typeof import("@/lib/log-redaction");
  const logRedaction = await importOrMissing<RedactionModule>("@/lib/log-redaction", () => {
    const fail = (name: string) => () => {
      throw new Error(`${name} does not exist: src/lib/log-redaction.ts is missing`);
    };
    return {
      redactText: fail("redactText"),
      redactValue: fail("redactValue"),
      isSensitiveKey: () => false,
      REDACTED: "[redacted]",
    } as never;
  });
  const { redactText, redactValue, isSensitiveKey, REDACTED } = logRedaction as {
    redactText: (input: string) => string;
    redactValue: (value: unknown, depth?: number, seen?: WeakSet<object>) => unknown;
    isSensitiveKey: (key: string) => boolean;
    REDACTED: string;
  };

  await test("H-2: every secret class named in the brief is redacted from free text", () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const rendered = redactText(`context=${secret} end`);
      assert(!rendered.includes(secret), `redactText left the ${name} value intact: ${rendered.slice(0, 120)}`);
      assert(rendered.includes(REDACTED), `redactText must mark the ${name} value as redacted`);
    }
  });

  await test("H-2: the shapes a real log line takes are each redacted", () => {
    /* Every entry here is a value that actually reached a log line while this work was
       being built, or a shape the brief names. Two of them were MISSED by earlier
       versions of the rule list and are kept as named regressions:
         - a bare `easylearn_session=...` with no `Cookie:` prefix;
         - a two-letter TLD (`.gh`) — this is a Ghanaian deployment, and requiring three
           letters silently skipped its own users' addresses. */
    const shapes: [string, string][] = [
      ["connection string", "connect postgres://u:p@host/db failed"],
      ["connection string with query", "dsn postgresql://owner:pw@ep-x.neon.tech/db?sslmode=require"],
      ["JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij"],
      ["bearer header", "Authorization: Bearer abc123def456ghi789"],
      ["cookie header", "cookie: easylearn_session=abc; other=1"],
      ["bare session cookie", "__Secure-next-auth.session-token=xyz123abc"],
      ["authorization, unknown scheme", "authorization: SomeScheme12345"],
      ["access key id", "key AKIAIOSFODNN7EXAMPLE"],
      ["presigned signature", "X-Amz-Signature=deadbeef&X-Amz-Expires=60"],
      ["email, two-letter TLD", "user a.b@school.edu.gh failed"],
      ["email, three-letter TLD", "amina.yawson@example.com"],
      ["free-standing secret", "R2SecretAccessKey/with+special=chars0123456789"],
      ["password pair", "password=Hunter2"],
      ["api key pair", "api_key=sk_live_51H8xYzABCDEFGHIJKLMNOP"],
    ];
    for (const [label, input] of shapes) {
      assert.notStrictEqual(redactText(input), input, `${label} must be redacted: ${input}`);
    }
  });

  await test("H-2: redaction does not eat the identifiers an operator needs", () => {
    /* The counterweight to the test above. A redactor that removes everything passes
       every "no secret" assertion and produces a log nobody can use. */
    for (const kept of [
      "request id 2f40b8c4-780f-4563-9fb1-d0a4b65a3a4d",
      "file a@b.ts stays",
      "dep react@19.2.6 ok",
      "durationMs 1234",
      "route /api/health",
      "status 503",
      "code 23505",
      "feature login_attempts",
      /* LEAKED FROM REAL OUTPUT, twice: a path in a stack trace matched the email rule.
         `src/app/page.tsx` contains `app@page`, and without requiring a DOT in the domain
         every stack frame was redacted — which destroys the most useful part of an error
         log. Both of these were observed in this suite's own console output before the
         rule was fixed, so they are pinned rather than trusted. */
      "src/app/page.tsx",
      "at /home/user/easylearn/node_modules/pg-pool/index.js:45:11",
      "src/app/api/health/route.ts:106:30",
    ]) {
      assert.strictEqual(redactText(kept), kept, `redaction must leave this readable: ${kept}`);
    }
  });

  await test("H-2: a connection string keeps its scheme and loses its credentials and host", () => {
    const rendered = redactText(`failed to connect: ${SECRETS.databaseUrl}`);
    assert(rendered.includes("postgresql://"), "the scheme stays: it is not secret and it is diagnostic");
    assert(!rendered.includes("sup3r-s3cret-pw"), "the password must be gone");
    assert(!rendered.includes("neondb_owner"), "the user name must be gone");
    assert(!rendered.includes("neon.tech"), "the host names the infrastructure and must be gone");
  });

  await test("H-2: redactValue drops sensitive VALUES and keeps the KEY as a marker", () => {
    const payload = {
      email: SECRETS.email,
      password: SECRETS.password,
      firstName: "Amina",
      sessionToken: SECRETS.jwt,
      headers: { authorization: SECRETS.authorization, cookie: SECRETS.cookie },
      objectStorage: { accessKeyId: SECRETS.r2AccessKeyId, secretAccessKey: SECRETS.r2Secret },
      /* An innocent key holding a secret value: the structural pass alone would miss it,
         the text pass catches it. This is the case a key-only redactor fails. */
      detail: `upstream said: ${SECRETS.databaseUrl}`,
      userId: "9f1c2b3a-0000-4000-8000-000000000000",
    };
    const rendered = JSON.stringify(redactValue(payload));
    assertNoSecrets(rendered, "redactValue");
    for (const key of ["email", "password", "firstName", "sessionToken", "authorization", "cookie", "accessKeyId", "secretAccessKey"]) {
      assert(rendered.includes(`"${key}":"${REDACTED}"`), `${key} must be present as a redaction marker, so an operator knows the field was there`);
    }
    assert(rendered.includes("9f1c2b3a-0000-4000-8000-000000000000"), "a non-sensitive id must survive: over-redaction makes logs useless");
  });

  await test("H-2: POSITIVE CONTROL — an unredacted payload fails the same assertion", () => {
    /* Without this control the suite could pass because the needle strings are wrong,
       or because `redactValue` returned an empty object. */
    const unredacted = JSON.stringify({ message: `login failed for ${SECRETS.email}`, dsn: SECRETS.databaseUrl });
    assert.throws(() => assertNoSecrets(unredacted, "control"), /leaked/, "the control must fail on unredacted input");
  });

  await test("H-2: a presigned URL keeps its parameter name and loses its signature", () => {
    const url = `https://bucket.example.r2.cloudflarestorage.com/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&${SECRETS.presignedQuery}&X-Amz-Expires=60`;
    const rendered = redactText(url);
    assert(!rendered.includes("9f8e7d6c5b4a39281706f5e4d3c2b1a0"), "the signature must be gone");
    assert(/X-Amz-Signature=\[redacted\]/.test(rendered), "the parameter must remain, marked redacted");
  });

  await test("H-2: redaction is bounded, cyclic-safe and never throws", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const rendered = JSON.stringify(redactValue(cyclic));
    assert(rendered.includes("[circular]"), "a cycle must be marked, not followed");

    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 20; i += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    assert(JSON.stringify(redactValue(deep)).includes("[depth-limit]"), "depth must be bounded");

    assert.strictEqual(redactValue(BigInt(10)), "10", "a BigInt must not throw JSON.stringify downstream");
    assert.strictEqual(redactValue(Number.NaN), "NaN", "NaN must serialise as a string");
    assert(JSON.stringify(redactValue([1, 2, 3])).includes("2"), "arrays are preserved");

    /* Pathological input: a getter that throws. */
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
      safe: "ok",
    };
    const survived = redactValue(hostile);
    assert(survived && typeof survived === "object", "a throwing getter must not break redaction");
  });

  await test("H-2: sensitive key detection covers the spellings the codebase actually uses", () => {
    for (const key of [
      "password",
      "password_hash",
      "passwordHash",
      "X-Api-Key",
      "api_key",
      "authorization",
      "Authorization",
      "cookie",
      "set-cookie",
      "secretAccessKey",
      "OBJECT_STORAGE_SECRET_ACCESS_KEY",
      "sessionToken",
      "csrfToken",
      "email",
      "firstName",
      "ip_address",
    ]) {
      assert(isSensitiveKey(key), `${key} must be treated as sensitive`);
    }
    for (const key of ["userId", "status", "durationMs", "route", "event", "code", "count"]) {
      assert(!isSensitiveKey(key), `${key} must NOT be redacted, or the logs lose their value`);
    }
  });

  /* ══ 4. LOGGING CANNOT CRASH A REQUEST ════════════════════════════════════ */

  type LoggerModule = typeof import("@/lib/logger");
  const loggerModule = await importOrMissing<LoggerModule>("@/lib/logger", () => {
    const fail = (name: string) => () => {
      throw new Error(`${name} does not exist: src/lib/logger.ts is missing`);
    };
    return { log: { debug: fail("log.debug"), info: fail("log.info"), warn: fail("log.warn"), error: fail("log.error") }, describeError: fail("describeError"), withLoggedSpan: fail("withLoggedSpan"), resolveRequestId: fail("resolveRequestId"), isAcceptableRequestId: () => false } as never;
  });
  const { log, describeError, withLoggedSpan } = loggerModule as {
    log: { debug: (m: string, f?: object) => void; info: (m: string, f?: object) => void; warn: (m: string, f?: object) => void; error: (m: string, f?: object) => void };
    describeError: (error: unknown) => Record<string, unknown>;
    withLoggedSpan: <T>(fields: object, run: () => Promise<T>, options?: object) => Promise<T>;
  };

  await test("H-2: a normal log line is one JSON object with the correlation fields", async () => {
    const lines = await captureConsole(() => {
      log.error("something failed", { event: "test.event", requestId: "req-abcdefgh", status: 503, durationMs: 12 });
    });
    assert.strictEqual(lines.length, 1, "exactly one line per event");
    const record = JSON.parse(lines[0]);
    assert.strictEqual(record.level, "error");
    assert.strictEqual(record.event, "test.event");
    assert.strictEqual(record.requestId, "req-abcdefgh");
    assert.strictEqual(record.status, 503);
    assert.strictEqual(record.service, "easylearn");
    assert(record.time, "a timestamp must be present");
    assert(record.msg, "a message must be present");
  });

  await test("H-2: a secret placed in ANY log field is redacted", async () => {
    const lines = await captureConsole(() => {
      log.error("login failed", {
        event: "test.redaction",
        /* Deliberately wrong field names: the redactor must not depend on the caller. */
        detail: `dsn=${SECRETS.databaseUrl}`,
        note: `cookie: ${SECRETS.cookie}`,
        extra: `auth ${SECRETS.authorization}`,
        password: SECRETS.password,
        email: SECRETS.email,
      });
    });
    const output = lines.join("\n");
    assertNoSecrets(output, "logger");
    assert(output.includes(REDACTED), "the redaction marker must appear");
  });

  await test("H-2: logging never throws, even when console.error itself throws", async () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalLog = console.log;
    let attempts = 0;
    const exploding = () => {
      attempts += 1;
      throw new Error("EPIPE: the log sink is gone");
    };
    console.error = exploding as never;
    console.warn = exploding as never;
    console.log = exploding as never;
    try {
      /* The requirement in the brief, stated as an assertion: a logging failure must not
         crash the request. `emit` must swallow even a throw from the sink itself. */
      assert.doesNotThrow(() => log.error("a failure while failed", { event: "test.explode" }));
      assert.doesNotThrow(() => log.warn("warn", { event: "test.explode" }));
      assert.doesNotThrow(() => log.info("info", { event: "test.explode" }));
      assert(attempts > 0, "the sink must actually have been called, or this test proves nothing");
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });

  await test("H-2: an unserialisable field cannot break the logger", async () => {
    const cyclic: Record<string, unknown> = { event: "test.cyclic" };
    cyclic.self = cyclic;
    /* `JSON.stringify` on the raw object would throw; `emit` redacts first, which
       replaces the cycle, and the line still lands. */
    const lines = await captureConsole(() => log.error("cyclic", cyclic));
    assert.strictEqual(lines.length, 1);
    JSON.parse(lines[0]);
  });

  await test("H-2: withLoggedSpan logs the outcome, rethrows, and never swallows", async () => {
    let caught: unknown = null;
    const lines = await captureConsole(async () => {
      try {
        await withLoggedSpan({ event: "test.span" }, async () => {
          throw new Error("the work failed");
        });
      } catch (error) {
        caught = error;
      }
    });
    assert(caught instanceof Error, "the error must propagate to the caller");
    const record = JSON.parse(lines.find((line) => line.includes("test.span")) ?? "{}");
    assert.strictEqual(record.outcome, "error", "the failure must be visible in the log");
    assert(record.error?.message?.includes("the work failed"), "the message must be present (it contains no secret)");
  });

  await test("H-2: describeError carries a machine-readable code for alerting", () => {
    const dbError = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    const described = describeError(dbError);
    assert.strictEqual(described.code, "23505", "the SQLSTATE must survive: alert rules key on it");
    assert.strictEqual(described.name, "Error");
  });

  /* ══ 5. REQUEST CORRELATION ═══════════════════════════════════════════════ */

  const { resolveRequestId, isAcceptableRequestId } = loggerModule as {
    resolveRequestId: (sources?: { headers?: { get(name: string): string | null } | null }) => string;
    isAcceptableRequestId: (candidate: string) => boolean;
  };
  type ContextModule = typeof import("@/lib/request-context");
  const contextModule = await importOrMissing<ContextModule>("@/lib/request-context", () => {
    const fail = (name: string) => () => {
      throw new Error(`${name} does not exist: src/lib/request-context.ts is missing`);
    };
    return { runWithRequestContext: fail("runWithRequestContext"), currentRequestId: () => undefined, currentRequestInfo: () => undefined } as never;
  });
  const { runWithRequestContext, currentRequestId, currentRequestInfo } = contextModule as {
    runWithRequestContext: <T>(context: { requestId: string; route?: string }, fn: () => T) => T;
    currentRequestId: () => string | undefined;
    currentRequestInfo: () => { requestId: string; route?: string; elapsedMs: number } | undefined;
  };

  await test("H-2: a platform request id is reused when it is well-formed", () => {
    const headers = new Headers({ "x-vercel-id": "iad1::abc123def456::xyz" });
    assert.strictEqual(resolveRequestId({ headers }), "iad1::abc123def456::xyz");
  });

  await test("H-2: a forged or malformed request id is replaced, never echoed", () => {
    for (const hostile of [
      '"><script>alert(1)</script>',
      "id with spaces",
      "a".repeat(300),
      "short",
      '{"level":"error"}',
      "id;with=semicolons",
    ]) {
      assert(!isAcceptableRequestId(hostile), `${JSON.stringify(hostile.slice(0, 20))} must be rejected`);
      const resolved = resolveRequestId({ headers: new Headers({ "x-request-id": hostile }) });
      assert.notStrictEqual(resolved, hostile, "a rejected id must not be echoed");
      assert(isAcceptableRequestId(resolved), "the replacement must itself be well-formed");
    }
    /* A newline cannot be put in a real header at all — the platform rejects it before
       the application sees it — but the guard must still reject it if one ever arrives
       through a shim, so it is asserted against the predicate directly. */
    assert(!isAcceptableRequestId("newline\ninjection"), "a control character must be rejected");
  });

  await test("H-2: with no header at all an id is generated and is unique", () => {
    const first = resolveRequestId();
    const second = resolveRequestId();
    assert.notStrictEqual(first, second);
    assert(isAcceptableRequestId(first));
  });

  await test("H-2: the AsyncLocalStorage context reaches an awaited catch, and is absent outside", async () => {
    assert.strictEqual(currentRequestId(), undefined, "outside a request there is no id");
    let observed: string | undefined;
    await runWithRequestContext({ requestId: "correlation-1234", route: "/api/health" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed = currentRequestId();
      const info = currentRequestInfo();
      assert.strictEqual(info?.route, "/api/health");
      assert.strictEqual(typeof info?.elapsedMs, "number");
    });
    assert.strictEqual(observed, "correlation-1234", "the id must survive an await boundary");
    assert.strictEqual(currentRequestId(), undefined, "and must not leak out of the request");
  });

  await test("H-2: the context cannot change the return value of the work it wraps", async () => {
    const value = await runWithRequestContext({ requestId: "x-12345678" }, async () => 42);
    assert.strictEqual(value, 42);
    const sync = runWithRequestContext({ requestId: "y-12345678" }, () => "ok");
    assert.strictEqual(sync, "ok");
  });

  /* ══ 6. HEALTH: CONFIGURATION vs AVAILABILITY, NO INFRASTRUCTURE ══════════ */

  type ReadinessModule = typeof import("@/lib/object-storage-readiness");
  const readiness = await importOrMissing<ReadinessModule>("@/lib/object-storage-readiness", () => {
    const fail = (name: string) => () => {
      throw new Error(`${name} does not exist: src/lib/object-storage-readiness.ts is missing`);
    };
    return {
      describeObjectStorage: fail("describeObjectStorage"),
      checkObjectStorageReachability: fail("checkObjectStorageReachability"),
      assertNoSecretsInStorageSection: (value: unknown) => value,
      inspectObjectStorageConfiguration: fail("inspectObjectStorageConfiguration"),
    } as never;
  });

  /** Snapshot and restore every object-storage variable this suite touches. */
  const STORAGE_KEYS = [
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ACCESS_KEY_ID",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
    "OBJECT_STORAGE_ENDPOINT",
    "OBJECT_STORAGE_REGION",
    "OBJECT_STORAGE_PUBLIC_URL",
    "OBJECT_STORAGE_ALLOW_PUBLIC_URL",
    "OBJECT_STORAGE_UPLOAD_EXPIRY",
    "OBJECT_STORAGE_DOWNLOAD_EXPIRY",
    "EASY_LEARN_STORAGE_PROBE_TIMEOUT_MS",
    "NODE_ENV",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();
  for (const key of STORAGE_KEYS) savedEnv.set(key, process.env[key]);
  const restoreEnv = () => {
    for (const key of STORAGE_KEYS) {
      const value = savedEnv.get(key);
      const target = process.env as Record<string, string | undefined>;
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
  };
  const setStorage = (values: Record<string, string>) => {
    for (const key of STORAGE_KEYS) if (key !== "NODE_ENV") delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  };

  try {
    await test("H-2: nothing configured reports disabled / local-disk, not misconfigured", async () => {
      setStorage({});
      const report = await readiness.describeObjectStorage();
      assert.strictEqual(report.configured, false);
      assert.strictEqual(report.state, "disabled", "local disk is a supported mode, not an error");
      assert.strictEqual(report.mode, "local-disk");
      assert.strictEqual(report.reachable, null, "reachable must be null: nothing was checked");
      assert.strictEqual(report.checked, false);
      assert.deepStrictEqual(report.missingVariables.sort(), [
        "OBJECT_STORAGE_ACCESS_KEY_ID",
        "OBJECT_STORAGE_BUCKET",
        "OBJECT_STORAGE_SECRET_ACCESS_KEY",
      ]);
    });

    await test("H-2: partially configured is misconfigured, and names only the missing VARIABLES", async () => {
      setStorage({ OBJECT_STORAGE_BUCKET: "easylearn-private-files" });
      const report = await readiness.describeObjectStorage();
      assert.strictEqual(report.configured, false);
      assert.strictEqual(report.state, "misconfigured");
      assert.deepStrictEqual(report.missingVariables.sort(), [
        "OBJECT_STORAGE_ACCESS_KEY_ID",
        "OBJECT_STORAGE_SECRET_ACCESS_KEY",
      ]);
      /* The bucket name must not appear anywhere in the report — not even to say which
         bucket is half-configured. */
      assert(!JSON.stringify(report).includes("easylearn-private-files"), "the bucket name must never be reported");
    });

    await test("H-2: fully configured WITHOUT a deep check is 'configured-unverified', not 'ready'", async () => {
      setStorage({
        OBJECT_STORAGE_BUCKET: "easylearn-private-files",
        OBJECT_STORAGE_ACCESS_KEY_ID: SECRETS.r2AccessKeyId,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: SECRETS.r2Secret,
        OBJECT_STORAGE_ENDPOINT: "https://accountid.r2.cloudflarestorage.com",
      });
      const report = await readiness.describeObjectStorage();
      assert.strictEqual(report.configured, true);
      /* THE FINDING: presence is not availability. */
      assert.strictEqual(report.state, "configured-unverified");
      assert.strictEqual(report.reachable, null, "nothing was contacted, so reachability is unknown — not true");
      assert.strictEqual(report.checked, false);
      assert.strictEqual(report.reason, "live_check_not_requested");
      const serialised = JSON.stringify(report);
      for (const forbidden of [
        "easylearn-private-files",
        SECRETS.r2AccessKeyId,
        SECRETS.r2Secret,
        "accountid",
        "r2.cloudflarestorage.com",
      ]) {
        assert(!serialised.includes(forbidden), `the health section must not disclose ${forbidden}`);
      }
    });

    await test("H-2: a deep check reports 'verified' ONLY after a real request succeeds", async () => {
      setStorage({
        OBJECT_STORAGE_BUCKET: "easylearn-private-files",
        OBJECT_STORAGE_ACCESS_KEY_ID: SECRETS.r2AccessKeyId,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: SECRETS.r2Secret,
        OBJECT_STORAGE_ENDPOINT: "https://accountid.r2.cloudflarestorage.com",
      });
      const report = await readiness.describeObjectStorage({ deep: true });
      /* No network in this suite, and the endpoint does not resolve: the honest answer
         is an error, and crucially NOT "verified". This is the assertion that fails if
         someone "simplifies" the deep path into a configuration lookup. */
      assert.strictEqual(report.checked, true, "a deep check must report that it ran");
      assert.strictEqual(report.state, "error", `an unreachable store is not verified (got ${report.state})`);
      assert.strictEqual(report.reachable, false);
      assert(["live_check_transport_error", "live_check_timeout", "live_check_http_error"].includes(report.reason), report.reason);
      assert.strictEqual(typeof report.latencyMs, "number");
      const serialised = JSON.stringify(report);
      assert(!serialised.includes("accountid"), "a failed probe must not disclose the endpoint");
      assert(!serialised.includes(SECRETS.r2AccessKeyId), "nor the key id");
    });

    await test("H-2: a 404 from the store counts as reachable; 403 and 500 do not", async () => {
      const config = {
        enabled: true,
        bucket: "b",
        endpoint: "https://example.invalid",
        region: "auto",
        accessKeyId: "id",
        secretAccessKey: "secret",
        forcePathStyle: true,
        uploadExpirySeconds: 300,
        downloadExpirySeconds: 3600,
      };
      const withStatus = (status: number) =>
        readiness.checkObjectStorageReachability(config, {
          timeoutMs: 500,
          fetchImpl: (async () => new Response(null, { status })) as unknown as typeof fetch,
        });

      const notFound = await withStatus(404);
      assert.strictEqual(notFound.reachable, true, "404 proves the store answered and accepted the signature");
      assert.strictEqual(notFound.reason, "live_check_succeeded");

      for (const status of [403, 500, 301]) {
        const result = await withStatus(status);
        assert.strictEqual(result.reachable, false, `${status} must not be reported as reachable`);
        assert.strictEqual(result.reason, "live_check_http_error");
      }
    });

    await test("H-2: the deep probe times out and says so, instead of hanging the endpoint", async () => {
      const config = {
        enabled: true,
        bucket: "b",
        endpoint: "https://example.invalid",
        region: "auto",
        accessKeyId: "id",
        secretAccessKey: "secret",
        forcePathStyle: true,
        uploadExpirySeconds: 300,
        downloadExpirySeconds: 3600,
      };
      const startedAt = Date.now();
      const result = await readiness.checkObjectStorageReachability(config, {
        timeoutMs: 150,
        fetchImpl: ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          })) as unknown as typeof fetch,
      });
      const elapsed = Date.now() - startedAt;
      assert.strictEqual(result.reachable, false);
      assert.strictEqual(result.reason, "live_check_timeout");
      assert(elapsed < 2_000, `the probe must be bounded by its timeout (took ${elapsed} ms)`);
    });

    await test("H-2: the production public-URL guard is surfaced as a warning, not a crash", async () => {
      setStorage({
        OBJECT_STORAGE_BUCKET: "b",
        OBJECT_STORAGE_ACCESS_KEY_ID: "id",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
        OBJECT_STORAGE_PUBLIC_URL: "https://cdn.example.com",
      });
      (process.env as Record<string, string>).NODE_ENV = "production";
      const report = await readiness.describeObjectStorage();
      assert(report.warnings.includes("public_url_in_production"), "SEC-1's guard must be visible before an upload fails");
      assert(!JSON.stringify(report).includes("cdn.example.com"), "the public URL itself must not be disclosed");
    });

    await test("H-2: the safety net suppresses a section that would have leaked the endpoint", () => {
      const leaky = {
        configured: true,
        missingVariables: [],
        mode: "object-storage" as const,
        state: "configured-unverified" as const,
        reachable: null,
        reason: "live_check_not_requested" as const,
        checked: false,
        /* A field added by a future change, carrying the endpoint: this is the case the
           runtime assertion exists for. */
        endpoint: "https://accountid.r2.cloudflarestorage.com",
        warnings: [],
      };
      const safe = readiness.assertNoSecretsInStorageSection(leaky);
      assert(!JSON.stringify(safe).includes("accountid"), "the leaked value must be gone");
      assert.strictEqual(safe.configured, false, "a suppressed section reports the least it can");
      assert.strictEqual(safe.checked, false);
    });

    await test("H-2: /api/health exposes the storage section without claiming a check it did not run", async () => {
      const { GET } = await import("@/app/api/health/route");
      /* A database that does not answer: the endpoint must still render a storage
         section, because the two failures are independent. */
      const response = await GET(new Request("http://localhost/api/health"));
      const body = (await response.json()) as {
        checks: { requestId?: string; objectStorage?: Record<string, unknown> };
      };
      const storageSection = body.checks.objectStorage;
      assert(storageSection, "the response must carry checks.objectStorage");
      assert.strictEqual(storageSection.checked, false, "a plain GET must not run the deep probe");
      assert.notStrictEqual(storageSection.state, "verified", "an unverified store must never be reported verified");
      assert.strictEqual(typeof storageSection.configured, "boolean");
      assert(response.headers.get("X-Request-Id"), "every response carries the correlation header");
      assert.strictEqual(body.checks.requestId, response.headers.get("X-Request-Id"), "body and header must agree");
    });

    await test("H-2: /api/health echoes a well-formed caller request id and ignores a forged one", async () => {
      const { GET } = await import("@/app/api/health/route");
      const supplied = "monitor-check-abc123";
      const withId = await GET(new Request("http://localhost/api/health", { headers: { "x-request-id": supplied } }));
      assert.strictEqual(withId.headers.get("X-Request-Id"), supplied, "a monitor's id must be reused so its log line can be found");

      const forged = await GET(
        new Request("http://localhost/api/health", { headers: { "x-request-id": "bad id with spaces" } })
      );
      assert.notStrictEqual(forged.headers.get("X-Request-Id"), "bad id with spaces");
    });

    await test("H-2: /api/health never puts a DSN or a password in its body", async () => {
      const { GET } = await import("@/app/api/health/route");
      const body = await (await GET(new Request("http://localhost/api/health"))).text();
      const serialised = readFile("src/app/api/health/route.ts");
      /* The endpoint's own source must not interpolate a URL into a response either:
         `getDatabaseUrl()` is checked for presence, never echoed. */
      assert(!/message:\s*getDatabaseUrl\(\)/.test(serialised), "the database URL must never be a response value");
      assert(!body.includes("sup3r"), "no credential material may appear in the body");
      assert(!/postgres(ql)?:\/\/[^"\s]*:[^"\s]*@/.test(body), "no credentialed DSN may appear in the body");
    });
  } finally {
    restoreEnv();
  }

  /* ══ 7. INTAKE ENDPOINT ══════════════════════════════════════════════════ */

  await test("H-2: the intake endpoint answers 204, even for junk, and never 500", async () => {
    setStorage({});
    const { POST, GET } = await import("@/app/api/internal/client-error/route");

    const cases: { label: string; request: Request }[] = [
      { label: "valid", request: jsonRequest({ digest: "1234567890", name: "TypeError", route: "/dashboard" }) },
      { label: "no body", request: new Request("http://localhost/api/internal/client-error", { method: "POST" }) },
      { label: "not json", request: new Request("http://localhost/api/internal/client-error", { method: "POST", body: "<xml/>" }) },
      { label: "huge", request: new Request("http://localhost/api/internal/client-error", { method: "POST", body: "x".repeat(5000) }) },
      { label: "wrong types", request: jsonRequest({ digest: 42, name: {}, route: 9 }) },
      { label: "hostile digest", request: jsonRequest({ digest: "<script>", name: "x'; DROP TABLE", route: "javascript:1" }) },
      { label: "null", request: jsonRequest(null) },
    ];

    const lines = await captureConsole(async () => {
      for (const { label, request } of cases) {
        const response = await POST(request);
        assert.strictEqual(response.status, 204, `${label} must answer 204, got ${response.status}`);
        assert.strictEqual(response.headers.get("Cache-Control"), "no-store");
        assert.strictEqual((await response.text()).length, 0, `${label} must not echo anything`);
      }
      const getResponse = await GET();
      assert.strictEqual(getResponse.status, 405, "a GET is a misconfiguration, not a resource");
      assert.strictEqual(getResponse.headers.get("Allow"), "POST");
    });

    /* Every line must be parseable JSON: a log platform that has to guess is a log
       platform nobody queries. */
    for (const line of lines) {
      if (line.includes("client error") || line.includes("client_error")) {
        JSON.parse(line);
      }
    }
  });

  await test("H-2: the intake endpoint logs the digest and never the message", async () => {
    const { POST } = await import("@/app/api/internal/client-error/route");
    const lines = await captureConsole(async () => {
      await POST(jsonRequest({ digest: "9876543210", name: "TypeError", route: "/dashboard/x", message: "secret-ish detail" }));
    });
    const payload = lines.join("\n");
    assert(payload.includes("9876543210"), "the digest must reach the log — it is the correlation handle");
    assert(payload.includes("client_error"), "the event name must be stable for alert rules");
    assert(!payload.includes("secret-ish detail"), "the endpoint must not log a message it was sent");
  });

  await test("H-2: the intake endpoint is rate-limited per source", async () => {
    const { POST } = await import("@/app/api/internal/client-error/route");
    /* A missing source is `unattributable`, which is a valid bucket: the valve must
       still protect the log platform. */
    const lines = await captureConsole(async () => {
      for (let i = 0; i < 40; i += 1) {
        const response = await POST(jsonRequest({ digest: "1111111111", name: "Error", route: "/x" }));
        assert.strictEqual(response.status, 204, "a rate-limited report is still a silent success for the browser");
      }
    });
    const logged = lines.filter((line) => line.includes('"event":"client_error"')).length;
    assert(logged < 40, `the valve must suppress some reports (logged ${logged} of 40)`);
    assert(lines.some((line) => line.includes("rate_limited")), "a suppression must be observable");
  });

  /* ══ 8. EXISTING CONTROLS INTACT ═════════════════════════════════════════ */

  await test("preserved: the CSRF proxy still refuses a cross-origin state-changing request", async () => {
    const { evaluateCsrfRequest } = await import("@/lib/csrf");
    const refused = evaluateCsrfRequest({
      method: "POST",
      origin: "https://evil.example",
      fetchSite: "cross-site",
      hasBearerAuthorization: false,
      hasSessionCookie: false,
      requestOrigins: ["https://easylearn.example"],
      requestHosts: ["easylearn.example"],
      originIsDerived: true,
    });
    assert.strictEqual(refused.allowed, false, "the CSRF policy must be unchanged by this work");

    const allowed = evaluateCsrfRequest({
      method: "POST",
      origin: "https://easylearn.example",
      fetchSite: "same-origin",
      hasBearerAuthorization: false,
      hasSessionCookie: false,
      requestOrigins: ["https://easylearn.example"],
      requestHosts: ["easylearn.example"],
      originIsDerived: true,
    });
    assert.strictEqual(allowed.allowed, true, "the boundary's own same-origin report must pass");
  });

  await test("preserved: the throttle's constants and fail-closed contract are unchanged", async () => {
    const rateLimit = await import("@/lib/rate-limit");
    assert.strictEqual(rateLimit.MAX_ATTEMPTS, 5);
    assert.strictEqual(rateLimit.MAX_ATTEMPTS_PER_IDENTIFIER, 15);
    assert.strictEqual(rateLimit.MAX_ATTEMPTS_PER_IP, 40);
    assert.strictEqual(rateLimit.MAX_IDENTIFIERS_PER_IP, 10);
    assert.strictEqual(rateLimit.WINDOW_MINUTES, 15);
    assert.strictEqual(rateLimit.BLOCK_MINUTES, 30);
    assert.strictEqual(rateLimit.DEFAULT_LOGIN_LOCK_TIMEOUT_MS, 2_000);
    /* H-1's fail-closed decision is not something H-2 may relax, even to make an error
       easier to log. */
    const source = readFile("src/lib/rate-limit.ts");
    assert(/reason:\s*"unavailable"/.test(source), "the throttle must still fail closed");
  });

  await test("preserved: session revocation still fails closed and the schema features are unchanged", async () => {
    const resilience = await import("@/lib/schema-resilience");
    for (const feature of ["login_attempts", "session_revocation"]) {
      assert(resilience.SECURITY_CRITICAL_FEATURES.has(feature as never), `${feature} must stay security-critical`);
    }
    assert.strictEqual(resilience.FEATURE_SQL.login_attempts.length, 8, "the F-1a repair list is unchanged");
    /* F-1a's ordering must survive any edit this work makes to schema handling. */
    const statements = resilience.FEATURE_SQL.login_attempts;
    const firstIndex = statements.findIndex((sql) => /CREATE INDEX/i.test(sql));
    const lastColumn = statements.findLastIndex((sql) => /ADD COLUMN/i.test(sql));
    assert(lastColumn < firstIndex, "columns must still be repaired before indexes are built");
  });

  await test("preserved: no migration file was added, and no DDL now targets login_attempts outside the repair", async () => {
    const resilience = await import("@/lib/schema-resilience");
    const migrations = fs.readdirSync(path.join(REPO_ROOT, "drizzle")).filter((name) => name.endsWith(".sql"));
    assert(!migrations.some((name) => name.startsWith("0020") || name.startsWith("0021")), "this work adds no migration");
    /* Assert against the EXECUTED statement list, not the file text: the file's own
       comment quotes `ALTER TABLE login_attempts DROP COLUMN ip_address` to explain the
       drift this repair fixes, and a text scan cannot tell an explanation from a
       command. */
    const loginAttempts = resilience.FEATURE_SQL.login_attempts as readonly string[];
    assert(loginAttempts.length > 0, "the repair list must be readable");
    for (const statement of loginAttempts) {
      assert(!/^\s*DROP\s/i.test(statement), `repair stays additive, found: ${statement.slice(0, 60)}`);
      assert(!/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\s/i.test(statement), `repair stays additive, found: ${statement.slice(0, 60)}`);
    }
  });

  await test("preserved: the auth cookie remains httpOnly and same-site", () => {
    const loginRoute = readFile("src/app/api/auth/login/route.ts");
    assert(/httpOnly:\s*true/.test(loginRoute), "the session cookie must stay httpOnly");
    assert(/sameSite:\s*"lax"/i.test(loginRoute), "the session cookie must stay SameSite=Lax");
    /* H-2 adds no logging that reads the cookie's value. */
    assert(!/setCookie\([^)]*console\./.test(loginRoute));
  });

  await test("preserved: no new dependency was added for observability", async () => {
    const pkg = JSON.parse(readFile("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const banned of ["@sentry/nextjs", "@sentry/node", "dd-trace", "newrelic", "datadog", "pino", "winston", "logtail", "@logtail/next", "posthog-node"]) {
      assert(!(banned in all), `${banned} would be an unapproved monitoring dependency`);
    }
    /* The audit's plain dependency count: adding one requires approval. */
    assert(Object.keys(pkg.dependencies).length <= 16, "no runtime dependency was added by this work");
  });

  /* ══ 9. ROADMAP HONESTY ══════════════════════════════════════════════════ */

  await test("H-2: the roadmap records H-2 and distinguishes merged / deployed / Production-verified", () => {
    const roadmap = readFile("docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md");
    assert(roadmap.includes("H-2"), "the register must carry the finding");
    /* The three states the brief requires to be distinguished. A claim of
       "Production-verified" for observability would be untrue: nothing has been deployed
       from this branch. */
    assert(
      /H-2[\s\S]{0,4000}Production-verified/.test(roadmap) || /Production-verified[\s\S]{0,4000}H-2/.test(roadmap),
      "the H-2 section must state its verification state explicitly"
    );
    assert(
      !/H-2[^.]{0,200}\bfully verified in Production\b/i.test(roadmap),
      "H-2 must not claim Production verification it does not have"
    );
  });

  await test("H-2: the roadmap documents the alert rules an operator must configure", () => {
    const roadmap = readFile("docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md");
    for (const term of ["request.error", "server.startup", "health."]) {
      assert(roadmap.includes(term), `the operator instructions must reference the ${term} event family`);
    }
    assert(/uptime/i.test(roadmap), "an uptime check must be described");
    assert(/\/api\/health\?deep=1/.test(roadmap), "the deep health URL must be given exactly");
  });

  await test("H-2: the security document describes what the logs can and cannot contain", () => {
    const security = readFile("docs/SECURITY_AUTHENTICATION.md");
    assert(/H-2/.test(security), "section 11 or a new section must record H-2");
    for (const term of ["redact", "request id", "correlation"]) {
      assert(new RegExp(term, "i").test(security), `the security document must cover ${term}`);
    }
    assert(/never/i.test(security), "the limits must be stated, not implied");
  });

  /* ══ SUMMARY ═════════════════════════════════════════════════════════════ */

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/** Build a JSON POST request for the intake tests. */
function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/internal/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

main().catch((error) => {
  console.error("suite crashed:", error);
  process.exitCode = 1;
});
