import { describeJwtSecretProblem } from "@/lib/jwt-policy";

function cleanEnvironmentValue(value: string | undefined, key?: string): string {
  if (!value) return "";

  let cleaned = value.trim().replace(/^['"]|['"]$/g, "");

  if (key && cleaned.startsWith(`${key}=`)) {
    cleaned = cleaned.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
  }

  return cleaned;
}

const databaseKeys = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "NEON_DATABASE_URL",
] as const;

function getDatabaseCandidates(): string[] {
  return databaseKeys
    .map((key) => cleanEnvironmentValue(process.env[key], key))
    .filter(Boolean);
}

function isPostgresUrl(value: string): boolean {
  return /^postgres(?:ql)?:\/\//i.test(value);
}

function isLocalDatabaseUrl(value: string): boolean {
  return /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(value);
}

export function getDatabaseUrl(): string {
  const candidates = getDatabaseCandidates();
  const usable = candidates.find((value) =>
    isPostgresUrl(value) && (!process.env.VERCEL || !isLocalDatabaseUrl(value))
  );

  return usable || candidates[0] || "";
}

export function getJwtSecret(): string {
  const candidates = [
    ["JWT_SECRET", process.env.JWT_SECRET],
    ["AUTH_SECRET", process.env.AUTH_SECRET],
    ["NEXTAUTH_SECRET", process.env.NEXTAUTH_SECRET],
  ] as const;

  for (const [key, value] of candidates) {
    const cleaned = cleanEnvironmentValue(value, key);
    if (cleaned) return cleaned;
  }

  return "";
}

export function getDatabaseConfigurationProblem(): string | null {
  const candidates = getDatabaseCandidates();
  const databaseUrl = getDatabaseUrl();

  if (candidates.length === 0) {
    return "No database URL is configured. Add DATABASE_URL in Vercel and redeploy.";
  }

  if (!databaseUrl || !isPostgresUrl(databaseUrl)) {
    return "The database URL is invalid. Copy a fresh PostgreSQL connection string from Neon.";
  }

  if (process.env.VERCEL && isLocalDatabaseUrl(databaseUrl)) {
    return "Vercel is configured with a local database URL. Replace it with the Neon connection string.";
  }

  return null;
}

/**
 * Reports whether the configured JWT secret is usable, using the shared policy in
 * `@/lib/jwt-policy` — the same policy enforced at the signing/verification
 * chokepoint in `@/lib/auth`. Keeping one policy means the health endpoint and the
 * token code can never disagree about what "acceptable" means.
 *
 * The returned string describes the requirement; it never contains the secret.
 */
export function getJwtConfigurationProblem(): string | null {
  const problem = describeJwtSecretProblem(getJwtSecret());
  return problem ? problem.message : null;
}
