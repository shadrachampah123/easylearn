import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { getDatabaseConfigurationProblem, getDatabaseUrl } from "@/lib/env";

const databaseProblem = getDatabaseConfigurationProblem();
if (databaseProblem) {
  throw new Error(databaseProblem);
}

const databaseUrl = getDatabaseUrl();

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

const usesManagedSsl =
  databaseUrl.includes("neon.tech") ||
  databaseUrl.includes("sslmode=require") ||
  databaseUrl.includes("ssl=true");

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    ssl: usesManagedSsl ? { rejectUnauthorized: false } : undefined,
    max: process.env.NODE_ENV === "production" ? 2 : 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    allowExitOnIdle: true,
  });

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool, { schema });
