const assert = require("assert");
const tls = require("tls");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const pgConnectionString = require("pg-connection-string");
const {
  buildPostgresConnectionConfig,
  createPostgresConnectionConfig,
  getDatabaseUrlFromEnvironment,
} = require("../src/lib/postgres-tls.js");

let passed = 0;

function test(name, fn) {
  fn();
  console.log(`✅ PASS: ${name}`);
  passed += 1;
}

console.log("🔐 PostgreSQL TLS policy tests\n");

const trustedCa = "-----BEGIN CERTIFICATE-----\ntrusted-test-ca\n-----END CERTIFICATE-----";

test("provider connection strings use verified TLS even when sslmode=require", () => {
  const config = buildPostgresConnectionConfig(
    "postgresql://user:p%40ss@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    { ca: trustedCa }
  );

  assert.strictEqual(config.ssl.rejectUnauthorized, true);
  assert.strictEqual(config.ssl.servername, "ep-example.us-east-2.aws.neon.tech");
  assert.strictEqual(config.ssl.ca, trustedCa);
  assert(!config.connectionString.includes("sslmode="), "pg must not be allowed to downgrade sslmode=require");
  assert(config.connectionString.includes("channel_binding=require"));
});

test("untrusted certificates cannot be accepted by configuration", () => {
  const config = buildPostgresConnectionConfig("postgres://u:p@db.example.test/app?sslmode=verify-full");
  assert.strictEqual(config.ssl.rejectUnauthorized, true);
  assert.notStrictEqual(config.ssl.rejectUnauthorized, false);

  assert.throws(
    () => buildPostgresConnectionConfig("postgres://u:p@db.example.test/app?sslmode=disable"),
    /certificate and hostname verification/i
  );
});

test("hostname mismatch is rejected by Node's hostname verifier", () => {
  const matchingCertificate = { subjectaltname: "DNS:db.example.test" };
  const mismatchingCertificate = { subjectaltname: "DNS:other.example.test" };

  assert.strictEqual(tls.checkServerIdentity("db.example.test", matchingCertificate), undefined);
  assert(tls.checkServerIdentity("db.example.test", mismatchingCertificate) instanceof Error);

  const config = buildPostgresConnectionConfig("postgres://u:p@db.example.test/app");
  assert.strictEqual(config.ssl.servername, "db.example.test");
});

test("sslmode=verify-ca is rejected because it does not require hostname validation", () => {
  assert.throws(
    () => buildPostgresConnectionConfig("postgres://u:p@db.example.test/app?sslmode=verify-ca"),
    /verify-full/i
  );
});

test("supported PostgreSQL URL formats and environment names resolve consistently", () => {
  for (const url of [
    "postgres://user:password@db.example.test:5432/app",
    "postgresql://user:password@db.example.test/app?sslmode=verify-full",
  ]) {
    const config = buildPostgresConnectionConfig(url);
    assert.strictEqual(config.ssl.rejectUnauthorized, true);
    assert.strictEqual(config.ssl.servername, "db.example.test");
  }

  assert.strictEqual(
    getDatabaseUrlFromEnvironment({ POSTGRES_URL: "postgres://user:p@db.example.test/app" }),
    "postgres://user:p@db.example.test/app"
  );
  assert.strictEqual(
    getDatabaseUrlFromEnvironment({ POSTGRES_PRISMA_URL: "postgresql://user:p@db.example.test/app" }),
    "postgresql://user:p@db.example.test/app"
  );
  assert.strictEqual(
    getDatabaseUrlFromEnvironment({ NEON_DATABASE_URL: "postgresql://user:p@db.example.test/app" }),
    "postgresql://user:p@db.example.test/app"
  );

  const caPath = path.join(os.tmpdir(), `easylearn-ca-${process.pid}.pem`);
  fs.writeFileSync(caPath, trustedCa);
  try {
    const fromPath = buildPostgresConnectionConfig(
      `postgresql://user:p@db.example.test/app?sslrootcert=${encodeURIComponent(caPath)}`
    );
    assert.strictEqual(fromPath.ssl.ca, trustedCa);
    assert(!fromPath.connectionString.includes("sslrootcert="), "CA path is consumed before pg parses the URL");
  } finally {
    fs.rmSync(caPath, { force: true });
  }
});

test("the pg parser downgrade is neutralized before the Pool receives the URL", () => {
  const parsed = pgConnectionString.parse(
    "postgresql://user:p@db.example.test/app?uselibpqcompat=true&sslmode=require"
  );
  assert.strictEqual(parsed.ssl.rejectUnauthorized, false);

  const config = buildPostgresConnectionConfig(
    "postgresql://user:p@db.example.test/app?sslmode=require"
  );
  assert.strictEqual(config.ssl.rejectUnauthorized, true);
  assert(!config.connectionString.includes("sslmode=require"));
});

test("application and migration paths use the same verified config and only explicit test opt-in permits local plaintext", () => {
  const appConfig = createPostgresConnectionConfig("postgres://u:p@db.example.test/app?sslmode=require");
  const migrationConfig = createPostgresConnectionConfig("postgres://u:p@db.example.test/app?sslmode=require");
  assert.deepStrictEqual(migrationConfig, appConfig);

  const local = createPostgresConnectionConfig("postgres://u:p@127.0.0.1:5432/app", {
    allowInsecureLocal: true,
  });
  assert.strictEqual(local.ssl, false);
  const securedLocal = createPostgresConnectionConfig("postgres://u:p@127.0.0.1:5432/app");
  assert.strictEqual(securedLocal.ssl.rejectUnauthorized, true);
  assert.strictEqual(securedLocal.ssl.servername, "127.0.0.1");
});

async function runLiveTlsTests() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "easylearn-tls-test-"));
  const keyPath = path.join(directory, "server.key");
  const certPath = path.join(directory, "server.crt");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=db.example.test",
      "-addext", "subjectAltName=DNS:db.example.test",
      "-keyout", keyPath, "-out", certPath,
    ], { stdio: "ignore" });
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    const server = tls.createServer({ key, cert }, (socket) => socket.end("ready"));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;

    const connect = (options) => new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port,
        rejectUnauthorized: true,
        ...options,
      }, () => {
        socket.resume();
        socket.once("end", resolve);
      });
      socket.once("error", reject);
    });

    await connect({ ca: cert, servername: "db.example.test" });
    console.log("✅ PASS: a trusted certificate and matching hostname complete a verified TLS handshake");
    passed += 1;

    await assert.rejects(
      connect({ ca: [], servername: "db.example.test" }),
      (error) => error && ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(error.code)
    );
    console.log("✅ PASS: an untrusted certificate is rejected by the TLS handshake");
    passed += 1;

    await assert.rejects(
      connect({ ca: cert, servername: "other.example.test" }),
      (error) => error && error.code === "ERR_TLS_CERT_ALTNAME_INVALID"
    );
    console.log("✅ PASS: a trusted certificate with a mismatched hostname is rejected");
    passed += 1;

    await new Promise((resolve) => server.close(resolve));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

runLiveTlsTests()
  .then(() => console.log(`\n✅ ${passed} PostgreSQL TLS tests passed`))
  .catch((error) => {
    console.error("❌ FAIL: live PostgreSQL TLS handshake tests");
    console.error(error);
    process.exitCode = 1;
  });
