/**
 * H-2 / PR #70 review round 2 — request correlation, proven through the REAL entry points.
 *
 * The first round shipped `runWithRequestContext` with no production caller and a logger
 * that never consulted the ambient context, so "correlation" existed only in a unit test
 * that called the helper itself. A unit test cannot catch that class of defect: it
 * exercises the mechanism and never the wiring.
 *
 * These tests therefore drive the same functions Next calls — the proxy's default export
 * and the route handler's exported `GET`/`POST` — and assert on the line that reaches the
 * log. If either end of the wiring is removed, they fail.
 *
 *   1. the proxy publishes one well-formed id and route handlers inherit it
 *   2. a line logged AFTER an asynchronous boundary carries the same id
 *   3. a hostile caller id is replaced, never logged
 *   4. machine traffic with no ambient request still logs (the field is simply absent)
 *
 * Run: npx tsx tests/observability-correlation.test.ts
 */
import assert from "assert";
import type { ObjectStorageConfig } from "@/lib/object-storage";

/* `@/lib/*` pulls in `@/db`, which throws at import time without a URL. pg.Pool connects
   lazily, so a dummy local URL is enough — nothing here queries. */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:1/testdb";
process.env.JWT_SECRET = "observability-correlation-secret-0123456789abcdef";

const GOOD_ID = "corr-3f9a1c2e-77bd-4a10";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed += 1;
  } catch (error: unknown) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${(error as Error).message}`);
    failed += 1;
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Capture the structured lines the logger writes to stderr. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    lines.push(String(args[0]));
  }) as typeof console.error;
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

function jsonLines(lines: string[]): Array<Record<string, unknown>> {
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object") parsed.push(value as Record<string, unknown>);
    } catch {
      /* not a structured line — captureLogs also sees whatever else writes there */
    }
  }
  return parsed;
}

/** Run `fn` with the log captured, always restoring the console. */
async function withLogs<T>(fn: (lines: string[]) => Promise<T>): Promise<T> {
  const capture = captureLogs();
  try {
    return await fn(capture.lines);
  } finally {
    capture.restore();
  }
}

/**
 * Read a header the proxy forwarded to the route handler.
 *
 * A Next.js proxy does not mutate the incoming request: it returns a `NextResponse` and
 * hands values to the handler through `x-middleware-request-<name>`, listing the
 * overridden headers in `x-middleware-override-headers`. Reading the value through that
 * mechanism keeps the test honest — asserting `response.headers.get("x-request-id")`
 * would pass against a proxy that only set an outgoing response header and forwarded
 * nothing to the handler at all.
 */
function forwardedHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

/** A header Next would silently drop is not forwarded — check the override list too. */
function isForwarded(response: Response, name: string): boolean {
  return (response.headers.get("x-middleware-override-headers") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .includes(name);
}

/** Parse SigV4's `YYYYMMDDTHHMMSSZ` back into a Date. */
function parseAmzDate(value: string): Date {
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
}

/** The request a route handler receives after the proxy forwarded it. */
function requestWithForwardedId(id: string, path = "https://example.test/api/health"): Request {
  return new Request(path, { headers: { "x-request-id": id } });
}

async function main() {
  const { default: proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  const { log } = await import("@/lib/logger");
  const { runWithCurrentRequest } = await import("@/lib/request-context");

  /* ══ 1. the proxy is where the id comes from ══════════════════════════════ */

  await test("H-2: the proxy publishes a well-formed x-request-id on the forwarded request", () => {
    const forwarded = proxy(
      new NextRequest("https://example.test/api/health", { headers: { "x-request-id": GOOD_ID } }),
    );
    assert.ok(isForwarded(forwarded, "x-request-id"), "the id must be forwarded to the handler");
    assert.strictEqual(
      forwardedHeader(forwarded, "x-request-id"),
      GOOD_ID,
      "a well-formed caller id must be reused so a client can correlate its own request",
    );

    /* No id supplied: one is generated, forwarded, and well-formed. */
    const generated = proxy(new NextRequest("https://example.test/api/health"));
    const id = forwardedHeader(generated, "x-request-id") ?? "";
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notStrictEqual(
      forwardedHeader(proxy(new NextRequest("https://example.test/api/health")), "x-request-id"),
      id,
      "two requests must not share an id",
    );
  });

  /* ══ 2. the real route handler inherits it (header and body) ══════════════ */

  await test("H-2: /api/health reports the id the proxy published, in header and body", async () => {
    const forwarded = proxy(
      new NextRequest("https://example.test/api/health", { headers: { "x-request-id": GOOD_ID } }),
    );
    const request = requestWithForwardedId(forwardedHeader(forwarded, "x-request-id") as string);

    const { GET } = await import("@/app/api/health/route");
    const response = await GET(request);
    const body = (await response.json()) as { checks: { requestId: string } };

    assert.strictEqual(response.headers.get("x-request-id"), GOOD_ID);
    assert.strictEqual(
      body.checks.requestId,
      GOOD_ID,
      "the body must agree with the header — that is the quoted value",
    );
  });

  /* ══ 3. the review's criterion: a log after an await, same id ════════════ */

  await test("H-2: a line logged after an asynchronous boundary carries the request id", async () => {
    const forwarded = proxy(
      new NextRequest("https://example.test/api/health", { headers: { "x-request-id": GOOD_ID } }),
    );
    const request = requestWithForwardedId(forwardedHeader(forwarded, "x-request-id") as string);

    await withLogs(async (lines) => {
      /* This is NOT the defect the review found — a handler that never enters the context
         at all. The route-level assertions above cover that. This case pins the other
         half: once inside, the id survives real async work (here a timer, which runs on
         a later turn of the event loop, not a single microtask hop). */
      await runWithCurrentRequest(request, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.error("line after an asynchronous boundary", { event: "test.after_await" });
      });

      const record = jsonLines(lines).find((entry) => entry.event === "test.after_await");
      assert.ok(record, "the line must have been emitted");
      assert.strictEqual(record.requestId, GOOD_ID);
    });
  });

  await test("H-2: the ambient id reaches a nested async chain, not just one level", async () => {
    const forwarded = proxy(
      new NextRequest("https://example.test/api/health", { headers: { "x-request-id": GOOD_ID } }),
    );
    const request = requestWithForwardedId(forwardedHeader(forwarded, "x-request-id") as string);

    await withLogs(async (lines) => {
      await runWithCurrentRequest(request, async () => {
        const deep = async (depth: number): Promise<void> => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (depth > 0) return deep(depth - 1);
          log.error("deepest frame", { event: "test.deep" });
        };
        await deep(3);
      });

      const record = jsonLines(lines).find((entry) => entry.event === "test.deep");
      assert.strictEqual(record?.requestId, GOOD_ID);
    });
  });

  /* ══ 4. a hostile id is replaced, never logged ═══════════════════════════ */

  await test("H-2: a malformed caller id is replaced before it can reach a log", async () => {
    /* Two hostile shapes. Node refuses a newline in a header value outright — the
       transport is the first line of defence — but a merely *odd* id (spaces, quotes, a
       JSON fragment) travels fine and must still be replaced before it reaches the log,
       or an attacker could forge a structured line's fields. */
    assert.throws(
      () =>
        new NextRequest("https://example.test/api/health", {
          headers: { "x-request-id": "value with \n newline" },
        }),
      /invalid header value/i,
      "the transport must refuse a newline in a header value",
    );

    const hostile = 'bad id with spaces, "quotes" and {"level":"error"}';
    const forwarded = proxy(
      new NextRequest("https://example.test/api/health", { headers: { "x-request-id": hostile } }),
    );
    const id = forwardedHeader(forwarded, "x-request-id") as string;

    assert.notStrictEqual(id, hostile);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.ok(!id.includes(" "), "no whitespace may survive into the logged field");

    await withLogs(async (lines) => {
      await runWithCurrentRequest(requestWithForwardedId(id), async () => {
        await Promise.resolve();
        log.error("hostile id replaced", { event: "test.hostile" });
      });

      const record = jsonLines(lines).find((entry) => entry.event === "test.hostile");
      assert.strictEqual(record?.requestId, id);
      assert.ok(!JSON.stringify(record).includes("newline"), "the raw value must not appear");
    });
  });

  /* ══ 5. no ambient request: logging still works ══════════════════════════ */

  await test("H-2: a log outside any request is emitted without a requestId field", async () => {
    await withLogs(async (lines) => {
      log.error("outside any request", { event: "test.outside" });
      const record = jsonLines(lines).find((entry) => entry.event === "test.outside");
      assert.ok(record, "logging must never depend on there being a request");
      assert.ok(!("requestId" in (record as object)), "no id must be invented");
    });
  });

  await test("H-2: a caller-supplied requestId still wins over the ambient one", async () => {
    const forwarded = proxy(
      new NextRequest("https://example.test/api/health", { headers: { "x-request-id": GOOD_ID } }),
    );

    await withLogs(async (lines) => {
      await runWithCurrentRequest(requestWithForwardedId(GOOD_ID), async () => {
        log.error("explicit id", { event: "test.explicit", requestId: "explicit-id-0001" });
      });
      const record = jsonLines(lines).find((entry) => entry.event === "test.explicit");
      assert.strictEqual(record?.requestId, "explicit-id-0001");
    });
  });

  /* ══ 6. the intake endpoint uses the same chain ══════════════════════════ */

  await test("H-2: the client-error intake reports the inherited id, not a fresh one", async () => {
    const forwarded = proxy(
      new NextRequest("https://example.test/api/internal/client-error", {
        headers: { "x-request-id": GOOD_ID },
      }),
    );
    const id = forwardedHeader(forwarded, "x-request-id") as string;

    const request = new Request("https://example.test/api/internal/client-error", {
      method: "POST",
      headers: { "x-request-id": id, "content-type": "application/json" },
      body: JSON.stringify({ digest: "corr123456", name: "Error", route: "/dashboard" }),
    });

    const { POST } = await import("@/app/api/internal/client-error/route");

    await withLogs(async (lines) => {
      const response = await POST(request);

      /* The endpoint's own contract: success-shaped, empty, and it never echoes input. */
      assert.strictEqual(response.status, 204);
      assert.strictEqual(await response.text(), "");

      /* The line it wrote carries the proxy's id — that is the whole point. Note the
         proxy WAS consulted above, so this cannot pass vacuously: a handler that
         re-derives an id instead of inheriting one produces a different UUID. */
      const record = jsonLines(lines).find((entry) => entry.event === "client_error");
      assert.ok(record, "the intake must log the report");
      assert.strictEqual(record.requestId, GOOD_ID);
      assert.strictEqual(
        record.requestId,
        id,
        "the handler must inherit the forwarded id, not generate its own",
      );
    });
  });

  /* ══ 7. a path with NO id variable still gets one ════════════════════════ */

  await test("H-2: the instrumentation error hook correlates without being told the id", async () => {
    /* `onRequestError` receives no correlation id from the framework, and the code that
       builds its log fields never mentions one — so if this line carries the id, the
       logger got it from the ambient context rather than from the caller. That is the
       property the review asked for, on the path with the least help. */
    const previousRuntime = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      const { onRequestError } = await import("@/instrumentation");

      await withLogs(async (lines) => {
        await onRequestError(
          new Error("boom from a render"),
          { path: "/dashboard", method: "GET", headers: { "x-request-id": GOOD_ID } },
          {
            routerKind: "App Router",
            routePath: "/dashboard",
            routeType: "render",
            renderSource: "react-server-components",
            revalidateReason: undefined,
          },
        );

        const record = jsonLines(lines).find((entry) => entry.event === "request.error");
        assert.ok(record, "the hook must emit a structured line");
        assert.strictEqual(record.requestId, GOOD_ID);
        assert.strictEqual(record.routePath, "/dashboard");
      });
    } finally {
      if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = previousRuntime;
    }
  });

  /* ══ 8. the probe signs exactly the method it sends ══════════════════════ */

  await test("H-2: signing GET and HEAD over identical inputs yields different signatures", async () => {
    const storage = await import("@/lib/object-storage");

    /* The defect was `sign(GET)` + `send(HEAD)`. SigV4 puts the method in the canonical
       request, so this difference IS the 403 the old probe would have received from a
       healthy bucket. Pinning it keeps the defect's seriousness honest: it was not a
       cosmetic mismatch. */
    /* Dummy credentials — the well-known AWS documentation example pair, not a secret.
       Signing is local arithmetic; nothing here contacts a store. */
    const config: ObjectStorageConfig = {
      enabled: true,
      bucket: "probe-bucket",
      endpoint: "https://accountid.r2.cloudflarestorage.com",
      region: "auto",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      forcePathStyle: true,
      uploadExpirySeconds: 900,
      downloadExpirySeconds: 900,
    };
    const at = new Date("2026-11-19T00:00:00Z");
    const signature = (method: "GET" | "HEAD") =>
      new URL(
        storage.presignUrl(config, {
          method,
          key: "health/probe-not-an-object",
          expiresSeconds: 60,
          now: at,
        }).url,
      ).searchParams.get("X-Amz-Signature");

    assert.notStrictEqual(
      signature("GET"),
      signature("HEAD"),
      "a GET signature is not valid for HEAD",
    );
    assert.strictEqual(signature("HEAD"), signature("HEAD"), "the signer must be deterministic");
  });

  await test("H-2: the live probe signs and sends the same method, observed on the wire", async () => {
    const readiness = await import("@/lib/object-storage-readiness");
    const storage = await import("@/lib/object-storage");

    const declared = readiness.OBJECT_STORAGE_PROBE_METHOD;
    assert.ok(["GET", "HEAD"].includes(declared), `unexpected probe verb ${declared}`);

    const config: ObjectStorageConfig = {
      enabled: true,
      bucket: "probe-bucket",
      endpoint: "https://accountid.r2.cloudflarestorage.com",
      region: "auto",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      forcePathStyle: true,
      uploadExpirySeconds: 900,
      downloadExpirySeconds: 900,
    };

    /* Run the REAL readiness check against a fake transport. It captures the URL that was
       signed and the request that was dispatched, so neither side can be assumed. */
    const seen: Array<{ url: string; method: string }> = [];
    const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: String(init?.method) });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await readiness.checkObjectStorageReachability(config, {
      timeoutMs: 1_000,
      fetchImpl: fakeFetch,
    });

    assert.strictEqual(seen.length, 1, "the probe must make exactly one request");
    const dispatched = seen[0];

    /* What the probe SENT: a HEAD. */
    assert.strictEqual(dispatched.method, declared);

    /* What the probe SIGNED: recompute the signature for each candidate verb over the
       exact URL it dispatched and compare to the one in that URL. The matching verb is
       the verb the bucket will verify against — i.e. the verb that was actually signed. */
    const signedUrl = new URL(dispatched.url);
    const receive = signedUrl.searchParams.get("X-Amz-Signature");
    assert.ok(receive, "the dispatched URL must carry a SigV4 signature");

    const at = parseAmzDate(signedUrl.searchParams.get("X-Amz-Date") as string);
    const expiresSeconds = Number(signedUrl.searchParams.get("X-Amz-Expires"));
    const key = decodeURIComponent(signedUrl.pathname.replace(/^\/[^/]+\//, ""));

    const signatureFor = (method: "GET" | "HEAD"): string =>
      new URL(storage.presignUrl(config, { method, key, expiresSeconds, now: at }).url)
        .searchParams.get("X-Amz-Signature") as string;

    assert.strictEqual(
      signatureFor(dispatched.method as "GET" | "HEAD"),
      receive,
      "the dispatched URL's signature must be the one produced by signing the dispatched method",
    );

    /* Widened deliberately: the point is that the OTHER verb does not match, and the
       compiler must not fold that away because it knows the constant's value. */
    const other: "GET" | "HEAD" = (dispatched.method as string) === "GET" ? "HEAD" : "GET";
    assert.notStrictEqual(
      signatureFor(other),
      receive,
      "the OTHER verb must not reproduce the signature — otherwise this test proves nothing",
    );

    /* 404 is the healthy answer for a probe key that does not exist. */
    assert.strictEqual(result.reachable, true);
    assert.strictEqual(result.reason, "live_check_succeeded");
  });

  await test("H-2: the probe method has exactly one declaration in the readiness module", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "object-storage-readiness.ts"),
      "utf8",
    );
    const declarations = source.match(/OBJECT_STORAGE_PROBE_METHOD\s*=\s*"/g) ?? [];
    assert.strictEqual(
      declarations.length,
      1,
      "two literals can drift apart again — one constant must feed both signing and dispatch",
    );
  });

  /* ══ SUMMARY ═════════════════════════════════════════════════════════════ */  /* ══ SUMMARY ═════════════════════════════════════════════════════════════ */

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("suite crashed:", error);
  process.exitCode = 1;
});
