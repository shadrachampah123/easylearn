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

/**
 * The Node.js version the current server instance is running on, or `null` when the
 * question does not apply.
 *
 * WHY THIS IS A HELPER AND NOT `process.version` IN LINE (H-2 follow-up, 2026-11-19)
 * ---------------------------------------------------------------------------------
 * Next compiles `src/instrumentation.ts` a second time for the Edge runtime, and its
 * build-time checker flags any `process.<member>` member-chain it sees in that graph:
 *
 *   Warning: A Node.js API is used (process.version at line: 60) which is not supported
 *   in the Edge Runtime.
 *
 * The warning is a static-analysis artifact, not a runtime fault. Two independent reasons:
 *
 *  1. The access sits behind `if (process.env.NEXT_RUNTIME !== "nodejs") return`, and the
 *     Edge compiler tree-shakes that path — the Edge entry for `register()` is literally
 *     `async function t(){}`. It never executes there.
 *  2. Even if it did, Next's Edge `process` polyfill only throws for *function*-valued
 *     members (`process.cwd`); a plain property such as `version` resolves to `undefined`.
 *
 * The checker cannot see (1) or (2) — it matches identifiers — so the correct response is
 * to stop writing the expression in the Edge graph rather than to silence the warning.
 * Moving it here keeps the information (an operator still gets `nodeVersion` on the
 * startup line) and gives the Edge build nothing to flag. `src/lib/env.ts` is inside the
 * Node-only graph: nothing the proxy imports reaches it, so importing this from
 * `instrumentation.ts` does not add `env.ts` to the edge bundle.
 *
 * `process.versions.node` is used rather than `process.version` because that is the
 * documented, structured form of the same value, and this helper is the single place it
 * is read.
 */
export function getNodeRuntimeVersion(): string | null {
  try {
    /* `NEXT_RUNTIME` is "nodejs" only in the Node.js server; in the Edge runtime this
       helper is never called, and the guard keeps the answer honest if it ever were. */
    if (process.env.NEXT_RUNTIME !== "nodejs") return null;
    const version = process.versions?.node;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    /* Version reporting is diagnostic; it must never be a reason a boot report fails. */
    return null;
  }
}
