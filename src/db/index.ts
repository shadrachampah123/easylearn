import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { getDatabaseConfigurationProblem, getDatabaseUrl } from "@/lib/env";
import { createPostgresConnectionConfig } from "@/lib/postgres-tls.js";

const databaseProblem = getDatabaseConfigurationProblem();
if (databaseProblem) {
  throw new Error(databaseProblem);
}

const databaseUrl = getDatabaseUrl();
const postgresConfig = createPostgresConnectionConfig(databaseUrl, {
  // Only the disposable PostgreSQL harnesses opt into this. Production and normal local
  // application configuration always use verified TLS; the flag is never set by the app.
  allowInsecureLocal: process.env.EASY_LEARN_TEST_DATABASE === "true",
});

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    ...postgresConfig,
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
