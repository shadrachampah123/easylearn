"use strict";

const fs = require("node:fs");

const DATABASE_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "NEON_DATABASE_URL",
];

const SSL_QUERY_KEYS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert"];
const INSECURE_SSL_MODES = new Set(["disable", "allow", "prefer"]);
const HOSTNAME_PATTERN = /^[a-z0-9._:-]+$/i;

function cleanEnvironmentValue(value, key) {
  if (!value) return "";
  let cleaned = String(value).trim().replace(/^['"]|['"]$/g, "");
  if (key && cleaned.startsWith(`${key}=`)) {
    cleaned = cleaned.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return cleaned;
}

function getDatabaseUrlFromEnvironment(env = process.env) {
  const candidates = DATABASE_ENV_KEYS
    .map((key) => cleanEnvironmentValue(env[key], key))
    .filter(Boolean);

  return candidates.find((value) => {
    if (!/^postgres(?:ql)?:\/\//i.test(value)) return false;
    return !(env.VERCEL && /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(value));
  }) || candidates[0] || "";
}

function readCertificate(value, label) {
  if (!value) return undefined;
  const cleaned = String(value).trim();
  if (!cleaned) return undefined;
  if (cleaned.includes("BEGIN CERTIFICATE")) return cleaned;

  try {
    return fs.readFileSync(cleaned, "utf8");
  } catch (error) {
    throw new Error(`${label} must contain a PEM certificate or point to a readable certificate file`);
  }
}

function localDatabaseUrl(value) {
  try {
    const url = new URL(value);
    return /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function buildPostgresConnectionConfig(rawUrl, options = {}) {
  const databaseUrl = cleanEnvironmentValue(rawUrl, "DATABASE_URL");
  if (!databaseUrl) throw new Error("A PostgreSQL connection string is required");
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error("The database URL must use the postgres:// or postgresql:// scheme");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("The database URL is not a valid PostgreSQL connection string");
  }

  if (!parsed.hostname || !HOSTNAME_PATTERN.test(parsed.hostname)) {
    throw new Error("The database URL must contain a valid PostgreSQL hostname");
  }

  const configuredMode = parsed.searchParams.get("sslmode") || process.env.PGSSLMODE || "";
  const sslMode = configuredMode.trim().toLowerCase();
  if (INSECURE_SSL_MODES.has(sslMode)) {
    throw new Error(
      `PostgreSQL sslmode=${sslMode} is not permitted; EasyLearn requires certificate and hostname verification`
    );
  }
  // verify-ca authenticates the CA but explicitly does not guarantee hostname validation.
  // Requiring verify-full here prevents a provider connection string from silently weakening
  // the hostname check. The Node TLS config below also sets servername explicitly.
  if (sslMode === "verify-ca") {
    throw new Error("PostgreSQL sslmode=verify-ca is not permitted; use verify-full");
  }

  const explicitCa = options.ca || process.env.DATABASE_CA_CERT || process.env.PGSSLROOTCERT;
  let ca = readCertificate(explicitCa, "DATABASE_CA_CERT/PGSSLROOTCERT");
  if (!ca) {
    const queryRootCertificate = parsed.searchParams.get("sslrootcert");
    ca = readCertificate(queryRootCertificate, "sslrootcert");
  }

  // pg-connection-string translates sslmode=require into
  // { rejectUnauthorized: false }. It also overwrites an ssl object supplied alongside a
  // connectionString when an SSL query option is present. Remove those query options before
  // handing the URL to pg and provide the verified Node TLS options ourselves.
  const sanitized = new URL(parsed.toString());
  for (const key of SSL_QUERY_KEYS) sanitized.searchParams.delete(key);

  const ssl = {
    rejectUnauthorized: true,
    // pg passes this through to tls.connect. Setting it explicitly makes the hostname check
    // deterministic even when a provider uses a pooler hostname.
    servername: parsed.hostname,
    ...(ca ? { ca } : {}),
  };

  return {
    connectionString: sanitized.toString(),
    ssl,
    sslMode: sslMode || "verify-full-enforced",
    servername: parsed.hostname,
  };
}

function createPostgresConnectionConfig(rawUrl, options = {}) {
  const allowInsecureLocal = options.allowInsecureLocal === true;
  if (allowInsecureLocal && localDatabaseUrl(rawUrl)) {
    let parsed;
    try {
      parsed = new URL(cleanEnvironmentValue(rawUrl, "DATABASE_URL"));
    } catch {
      return buildPostgresConnectionConfig(rawUrl, options);
    }

    // This escape hatch is for disposable PostgreSQL instances used by automated tests only.
    // It is never enabled by application or migration code unless the caller opts in.
    const mode = parsed.searchParams.get("sslmode") || process.env.PGSSLMODE || "";
    const hasSslQueryOption = SSL_QUERY_KEYS.some((key) => parsed.searchParams.has(key));
    if (!mode && !hasSslQueryOption) {
      return {
        connectionString: parsed.toString(),
        ssl: false,
        sslMode: "test-local-no-tls",
        servername: parsed.hostname,
      };
    }
  }

  return buildPostgresConnectionConfig(rawUrl, options);
}

module.exports = {
  DATABASE_ENV_KEYS,
  buildPostgresConnectionConfig,
  cleanEnvironmentValue,
  createPostgresConnectionConfig,
  getDatabaseUrlFromEnvironment,
};
