import "dotenv/config";
import type { Config } from "drizzle-kit";

function clean(value: string | undefined, key: string): string {
  if (!value) return "";
  let result = value.trim().replace(/^['"]|['"]$/g, "");
  if (result.startsWith(`${key}=`)) {
    result = result.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return result;
}

const databaseCandidates = [
  ["DATABASE_URL", process.env.DATABASE_URL],
  ["POSTGRES_URL", process.env.POSTGRES_URL],
  ["POSTGRES_PRISMA_URL", process.env.POSTGRES_PRISMA_URL],
  ["NEON_DATABASE_URL", process.env.NEON_DATABASE_URL],
] as const;

const candidates = databaseCandidates
  .map(([key, value]) => clean(value, key))
  .filter(Boolean);

const databaseUrl = candidates.find((value) =>
  /^postgres(?:ql)?:\/\//i.test(value) &&
  (!process.env.VERCEL || !/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(value))
);

if (!databaseUrl) {
  throw new Error("A valid Neon DATABASE_URL is required to apply the EasyLearn database schema");
}

export default {
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
