/**
 * END-TO-END PostgreSQL TLS test — a real TLS-enabled PostgreSQL 16 server.
 *
 * `tests/postgres-tls.test.js` proves the *policy* of `src/lib/postgres-tls.js` and
 * completes a TLS handshake against a bare `tls.createServer`. This suite goes further:
 * it starts a genuine PostgreSQL 16 cluster with `ssl = on`, connects with the real `pg`
 * driver through `createPostgresConnectionConfig`, and asserts what the server actually
 * negotiates.
 *
 * Covered end to end:
 *   1. a TRUSTED certificate completes the connection and the server confirms
 *      `pg_stat_ssl.ssl = true` with a real TLS version and cipher;
 *   2. an UNTRUSTED certificate (a CA the server was not issued by) is rejected;
 *   3. a HOSTNAME MISMATCH (a certificate that is trusted but issued for another host)
 *      is rejected;
 *   4. `sslmode=require` is UPGRADED to verified TLS — it is not downgraded to
 *      `rejectUnauthorized: false` the way `pg-connection-string` would do it;
 *   5. `sslmode=disable` and `sslmode=verify-ca` are refused before any connection;
 *   6. the disposable-test escape hatch (`allowInsecureLocal`) cannot weaken an explicit
 *      TLS request, even for a 127.0.0.1 URL.
 *
 * The server is started on 127.0.0.1 from a throwaway data directory and is deleted
 * afterwards. The suite never contacts a production database.
 *
 * Server discovery, in order:
 *   1. `EASY_LEARN_TLS_PG_BIN` — a directory containing `initdb`/`pg_ctl`/`postgres`;
 *   2. `@embedded-postgres/<platform>-<arch>` — the optional dependency, which ships a
 *      PostgreSQL 16 build linked against OpenSSL;
 *   3. common system locations for a PostgreSQL 16 installation.
 *
 * If no TLS-capable PostgreSQL 16 can be found, the suite SKIPS with an explicit message
 *   (exit 0). It never reports a skip as a pass. Set `EASY_LEARN_REQUIRE_TLS_E2E=true`
 *   to turn a skip into a failure — CI does exactly that, so the job proves these
 *   assertions really ran.
 */

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { Client } = require("pg");
const {
  createPostgresConnectionConfig,
} = require("../src/lib/postgres-tls.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${(error && error.message) || error}`);
    failed += 1;
  }
}

/* ── Discovery ── */

const SYSTEM_BIN_CANDIDATES = [
  "/usr/lib/postgresql/16/bin",
  "/usr/pgsql-16/bin",
  "/usr/local/pgsql/bin",
  "/opt/homebrew/opt/postgresql@16/bin",
];

function findPostgresBin() {
  const candidates = [];

  if (process.env.EASY_LEARN_TLS_PG_BIN) {
    candidates.push({ source: "EASY_LEARN_TLS_PG_BIN", dir: process.env.EASY_LEARN_TLS_PG_BIN });
  }

  const embeddedPackage = `@embedded-postgres/${process.platform}-${process.arch}`;
  try {
    const entry = require.resolve(embeddedPackage);
    candidates.push({ source: embeddedPackage, dir: path.resolve(path.dirname(entry), "..", "native", "bin") });
  } catch {
    /* not installed on this platform */
  }

  for (const dir of SYSTEM_BIN_CANDIDATES) {
    candidates.push({ source: "system", dir });
  }

  for (const candidate of candidates) {
    const postgres = path.join(candidate.dir, "postgres");
    const initdb = path.join(candidate.dir, "initdb");
    const pgCtl = path.join(candidate.dir, "pg_ctl");
    if (![postgres, initdb, pgCtl].every((file) => fs.existsSync(file))) continue;

    /* A build without OpenSSL cannot serve TLS. Detect it up front so the suite can
       report the limitation precisely instead of failing obscurely later. */
    let hasOpenSsl = false;
    try {
      const linked = execFileSync("ldd", [postgres], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      hasOpenSsl = /libssl|libcrypto/i.test(linked);
    } catch {
      hasOpenSsl = true; /* ldd unavailable (non-ELF platform): assume TLS and let the
                             cluster start decide. */
    }
    return { ...candidate, postgres, initdb, pgCtl, hasOpenSsl };
  }

  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/* Start the cluster on a free port, retrying with a new port if the chosen one was
   taken between the probe and the bind. */
async function startClusterWithRetry(bin, directory, certificates) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    try {
      return { port, cluster: startCluster(bin, directory, certificates, port) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("could not start the PostgreSQL cluster");
}

/* ── Certificate material ── */

function generateCertificates(directory) {
  const caKey = path.join(directory, "ca.key");
  const caCert = path.join(directory, "ca.crt");
  const serverKey = path.join(directory, "server.key");
  const serverCsr = path.join(directory, "server.csr");
  const serverCert = path.join(directory, "server.crt");
  const otherCaKey = path.join(directory, "other-ca.key");
  const otherCaCert = path.join(directory, "other-ca.crt");
  const sanFile = path.join(directory, "san.ext");

  const openssl = (args) => execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });

  openssl(["req", "-new", "-x509", "-nodes", "-days", "2", "-newkey", "rsa:2048",
    "-keyout", caKey, "-out", caCert, "-subj", "/CN=EasyLearn TLS Test CA"]);

  /* The server certificate is issued for `localhost` ONLY. Connecting to the very same
     server through 127.0.0.1 therefore produces a genuine hostname mismatch, because
     Node requires an `IP Address:` SAN for an IP target and this certificate has none. */
  openssl(["req", "-new", "-nodes", "-newkey", "rsa:2048",
    "-keyout", serverKey, "-out", serverCsr, "-subj", "/CN=localhost"]);
  fs.writeFileSync(sanFile, "subjectAltName=DNS:localhost\n");
  openssl(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
    "-out", serverCert, "-days", "2", "-sha256", "-extfile", sanFile]);
  fs.chmodSync(serverKey, 0o600);

  /* A second, unrelated CA: certificates issued by it are untrusted. */
  openssl(["req", "-new", "-x509", "-nodes", "-days", "2", "-newkey", "rsa:2048",
    "-keyout", otherCaKey, "-out", otherCaCert, "-subj", "/CN=Untrusted TLS Test CA"]);

  return { caCert, serverCert, serverKey, otherCaCert };
}

/* ── Cluster lifecycle ── */

function startCluster(bin, directory, certificates, port) {
  const dataDir = path.join(directory, "data");
  const initResult = spawnSync(bin.initdb, ["-D", dataDir, "-U", "easylearn", "--auth=trust", "--encoding=UTF8"], {
    encoding: "utf8",
  });
  if (initResult.status !== 0) {
    throw new Error(`initdb failed: ${(initResult.stderr || "").slice(-2000)}`);
  }

  fs.appendFileSync(
    path.join(dataDir, "postgresql.conf"),
    [
      "",
      "ssl = on",
      `ssl_cert_file = '${certificates.serverCert}'`,
      `ssl_key_file = '${certificates.serverKey}'`,
      `ssl_ca_file = '${certificates.caCert}'`,
      "listen_addresses = '127.0.0.1'",
      `port = ${port}`,
      `unix_socket_directories = '${os.tmpdir()}'`,
      "",
    ].join("\n")
  );

  const logFile = path.join(directory, "postgres.log");
  const startResult = spawnSync(bin.pgCtl, ["-D", dataDir, "-l", logFile, "-w", "-t", "60", "start"], {
    encoding: "utf8",
  });
  if (startResult.status !== 0) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    throw new Error(`pg_ctl start failed: ${(startResult.stderr || log).slice(-2000)}`);
  }

  return {
    dataDir,
    stop() {
      spawnSync(bin.pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"], {
        encoding: "utf8",
      });
    },
  };
}

/* ── Connection helper ── */

async function connect(url, options = {}) {
  const config = createPostgresConnectionConfig(url, options);
  const client = new Client({ ...config, connectionTimeoutMillis: 10000 });
  await client.connect();
  return { client, config };
}

async function tryConnect(url, options = {}) {
  let client;
  try {
    const connected = await connect(url, options);
    client = connected.client;
    return { ok: true, client, config: connected.config };
  } catch (error) {
    return { ok: false, error };
  }
}

function describeError(error) {
  return `${(error && error.code) || ""} ${(error && error.message) || String(error)}`.trim();
}

/* ── Suite ── */

async function main() {
  console.log("🔐 End-to-end PostgreSQL TLS tests (real TLS-enabled PostgreSQL 16 server)\n");

  /* Locally the suite skips gracefully when no TLS-capable PostgreSQL 16 exists. In CI
     (`EASY_LEARN_REQUIRE_TLS_E2E=true`) a skip is a FAILURE: the CI job must actually
     execute these assertions, not quietly pass without them. */
  const requireExecution = process.env.EASY_LEARN_REQUIRE_TLS_E2E === "true";
  const skip = (message) => {
    console.log(message);
    if (requireExecution) {
      console.error("❌ FAIL: EASY_LEARN_REQUIRE_TLS_E2E=true — the TLS end-to-end suite must run, not skip.");
      process.exitCode = 1;
    }
  };

  if (!fs.existsSync(path.join(os.tmpdir(), "."))) {
    throw new Error("temporary directory is unavailable");
  }

  const bin = findPostgresBin();
  if (!bin) {
    skip(
      "⏭️  SKIP: no PostgreSQL 16 server binary was found.\n" +
        "   Install the optional dependency with `npm ci` on linux-x64/darwin-x64,\n" +
        "   or point EASY_LEARN_TLS_PG_BIN at a PostgreSQL 16 bin directory."
    );
    return;
  }
  if (!bin.hasOpenSsl) {
    skip(
      `⏭️  SKIP: the PostgreSQL build at ${bin.dir} is not linked against OpenSSL,\n` +
        "   so it cannot serve TLS. Provide a TLS-capable build via\n" +
        "   EASY_LEARN_TLS_PG_BIN to run this suite."
    );
    return;
  }

  const version = spawnSync(bin.postgres, ["--version"], { encoding: "utf8" }).stdout || "";
  console.log(`📦 Using PostgreSQL from ${bin.source}: ${version.trim()}`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "easylearn-pg-tls-e2e-"));
  let cluster = null;
  let port = 0;

  try {
    const certificates = generateCertificates(directory);
    const started = await startClusterWithRetry(bin, directory, certificates);
    port = started.port;
    cluster = started.cluster;
    console.log(`🔌 PostgreSQL is listening on 127.0.0.1:${port} with ssl = on\n`);

    const base = `postgres://easylearn@localhost:${port}/postgres`;
    const trustedUrl = `${base}?sslmode=verify-full&sslrootcert=${encodeURIComponent(certificates.caCert)}`;
    const untrustedUrl = `${base}?sslmode=verify-full&sslrootcert=${encodeURIComponent(certificates.otherCaCert)}`;

    await test("a trusted certificate completes a real TLS connection to PostgreSQL", async () => {
      const result = await tryConnect(trustedUrl);
      assert.ok(result.ok, `expected the connection to succeed, got: ${describeError(result.error)}`);
      try {
        const ssl = await result.client.query(
          "select ssl, version, cipher, bits from pg_stat_ssl where pid = pg_backend_pid()"
        );
        assert.strictEqual(ssl.rows[0].ssl, true, "the server must report that the session is encrypted");
        assert.ok(/^TLSv1\.[23]$/.test(ssl.rows[0].version), `unexpected TLS version: ${ssl.rows[0].version}`);
        assert.ok(ssl.rows[0].cipher && ssl.rows[0].cipher.length > 0, "the server must report a negotiated cipher");
      } finally {
        await result.client.end().catch(() => undefined);
      }
    });

    await test("an untrusted certificate is rejected by the PostgreSQL connection", async () => {
      const result = await tryConnect(untrustedUrl);
      assert.ok(!result.ok, "an untrusted certificate must not be able to connect");
      assert.ok(
        /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|certificate/i.test(
          describeError(result.error)
        ),
        `expected a certificate verification failure, got: ${describeError(result.error)}`
      );
    });

    await test("a certificate issued for another host is rejected (hostname mismatch)", async () => {
      const url = `postgres://easylearn@127.0.0.1:${port}/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(certificates.caCert)}`;
      const result = await tryConnect(url);
      assert.ok(!result.ok, "a hostname mismatch must not be able to connect");
      assert.ok(
        /ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/i.test(describeError(result.error)),
        `expected a hostname verification failure, got: ${describeError(result.error)}`
      );
    });

    await test("sslmode=require is upgraded to verified TLS instead of being downgraded", async () => {
      const requireUrl = `${base}?sslmode=require&sslrootcert=${encodeURIComponent(certificates.caCert)}`;

      /* pg-connection-string translates sslmode=require into rejectUnauthorized:false.
         EasyLearn removes the query option first, so the connection must still be fully
         verified — a trusted CA connects, an untrusted one does not. */
      const trusted = await tryConnect(requireUrl);
      assert.ok(trusted.ok, `expected sslmode=require to connect with a trusted CA, got: ${describeError(trusted.error)}`);
      try {
        const ssl = await trusted.client.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()");
        assert.strictEqual(ssl.rows[0].ssl, true, "the session must still be encrypted");
      } finally {
        await trusted.client.end().catch(() => undefined);
      }

      const untrustedRequireUrl = `${base}?sslmode=require&sslrootcert=${encodeURIComponent(certificates.otherCaCert)}`;
      const untrusted = await tryConnect(untrustedRequireUrl);
      assert.ok(
        !untrusted.ok,
        "sslmode=require must NOT downgrade to rejectUnauthorized:false — an untrusted CA must still fail"
      );
    });

    await test("sslmode=disable and sslmode=verify-ca are refused before any connection is attempted", async () => {
      for (const mode of ["disable", "verify-ca"]) {
        assert.throws(
          () => createPostgresConnectionConfig(`${base}?sslmode=${mode}`),
          /not permitted/i,
          `sslmode=${mode} must be refused`
        );
      }
    });

    await test("the disposable-test escape hatch cannot weaken an explicit TLS request", async () => {
      /* `allowInsecureLocal` is the test-only opt-in that permits plaintext to a local
         instance. It must not apply once a TLS policy has been requested. */
      const result = await tryConnect(untrustedUrl, { allowInsecureLocal: true });
      assert.ok(!result.ok, "allowInsecureLocal must not disable certificate verification");
      assert.ok(
        /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|certificate/i.test(
          describeError(result.error)
        ),
        `expected a certificate verification failure, got: ${describeError(result.error)}`
      );
    });

    await test("the connection really is refused before any statement runs", async () => {
      const result = await tryConnect(untrustedUrl);
      assert.ok(!result.ok, "expected the connection to be refused");
      assert.ok(
        !/pg_stat_ssl/.test(describeError(result.error)),
        "the failure must come from the TLS handshake, not from a later statement"
      );
    });
  } finally {
    if (cluster) cluster.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log(`✅ ${passed} end-to-end PostgreSQL TLS tests passed`);
  }
}

main().catch((error) => {
  console.error("❌ FAIL: the end-to-end PostgreSQL TLS suite could not run");
  console.error(error);
  process.exitCode = 1;
});
