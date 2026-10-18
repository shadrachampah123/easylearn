export type PostgresVerifiedSsl = {
  rejectUnauthorized: true;
  servername: string;
  ca?: string;
};

export type PostgresConnectionConfig = {
  connectionString: string;
  ssl: PostgresVerifiedSsl | false;
  sslMode: string;
  servername: string;
};

export const DATABASE_ENV_KEYS: readonly string[];

export function cleanEnvironmentValue(value: string | undefined, key?: string): string;

export function getDatabaseUrlFromEnvironment(
  env?: Record<string, string | undefined>
): string;

export function buildPostgresConnectionConfig(
  rawUrl: string,
  options?: { ca?: string }
): PostgresConnectionConfig;

/**
 * `allowInsecureLocal` is a test-only escape hatch for disposable PostgreSQL instances.
 * Production application and migration callers must leave it false.
 */
export function createPostgresConnectionConfig(
  rawUrl: string,
  options?: { ca?: string; allowInsecureLocal?: boolean }
): PostgresConnectionConfig;
