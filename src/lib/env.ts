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

export function getJwtConfigurationProblem(): string | null {
  const secret = getJwtSecret();

  if (!secret) {
    return "JWT_SECRET is not configured in Vercel. Add a random secret of at least 32 characters and redeploy.";
  }

  if (secret.length < 32) {
    return "JWT_SECRET is too short. Use a random value of at least 32 characters and redeploy.";
  }

  return null;
}
