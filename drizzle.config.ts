import "dotenv/config";
import type { Config } from "drizzle-kit";
import {
  createPostgresConnectionConfig,
  getDatabaseUrlFromEnvironment,
} from "./src/lib/postgres-tls.js";

const databaseUrl = getDatabaseUrlFromEnvironment(process.env);

if (!databaseUrl) {
  throw new Error("A valid PostgreSQL DATABASE_URL is required to apply the EasyLearn database schema");
}

const postgresConfig = createPostgresConnectionConfig(databaseUrl, {
  allowInsecureLocal: process.env.EASY_LEARN_TEST_DATABASE === "true",
});

export default {
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: postgresConfig.connectionString,
    ssl: postgresConfig.ssl,
  },
} satisfies Config;
