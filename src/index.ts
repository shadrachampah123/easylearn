import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function normalizeDatabaseUrl(rawValue: string | undefined): string {
  if (!rawValue) return "";

  let value = rawValue.trim().replace(/^['"]|['"]$/g, "");

  // Recover from pasting `DATABASE_URL=postgresql://...` into Vercel's value field.
  if (value.startsWith("DATABASE_URL=")) {
    value = value.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
  }

  return value;
}

const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

const usesManagedSsl =
  databaseUrl.includes("neon.tech") ||
  databaseUrl.includes("sslmode=require");

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    ssl: usesManagedSsl ? { rejectUnauthorized: false } : undefined,
    max: process.env.NODE_ENV === "production" ? 3 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool, { schema });
