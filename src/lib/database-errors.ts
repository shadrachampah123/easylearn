type DatabaseErrorLike = {
  code?: string;
  message?: string;
  detail?: string;
  cause?: unknown;
};

function asDatabaseError(error: unknown): DatabaseErrorLike {
  if (typeof error === "object" && error !== null) {
    return error as DatabaseErrorLike;
  }
  return { message: String(error) };
}

export function getDatabaseErrorCode(error: unknown): string | undefined {
  const outer = asDatabaseError(error);
  const inner = asDatabaseError(outer.cause);
  return outer.code || inner.code;
}

export function isUniqueViolation(error: unknown): boolean {
  return getDatabaseErrorCode(error) === "23505";
}

export function getDatabaseErrorMessage(error: unknown): string {
  const dbError = asDatabaseError(error);
  const nested = asDatabaseError(dbError.cause);
  const code = dbError.code || nested.code;
  const message = `${dbError.message || ""} ${dbError.detail || ""} ${nested.message || ""} ${nested.detail || ""}`.toLowerCase();

  if (code === "42P01" || (message.includes("relation") && message.includes("does not exist"))) {
    return "Neon is connected, but the EasyLearn tables are missing. Apply the Drizzle schema, then redeploy.";
  }

  if (code === "42704" || (message.includes("type") && message.includes("does not exist"))) {
    return "Neon is connected, but the EasyLearn database types are missing. Apply the Drizzle schema, then redeploy.";
  }

  if (code === "28P01" || message.includes("password authentication failed")) {
    return "The Neon credentials in Vercel are invalid. Copy a fresh connection string into DATABASE_URL and redeploy.";
  }

  if (code === "3D000" || (message.includes("database") && message.includes("does not exist"))) {
    return "The database in DATABASE_URL does not exist. Select the correct Neon database and copy its connection string.";
  }

  if (code === "53300" || message.includes("too many connections")) {
    return "Neon has reached its connection limit. Use the pooled Neon connection string in Vercel.";
  }

  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    message.includes("getaddrinfo") ||
    message.includes("connect timeout") ||
    message.includes("connection terminated")
  ) {
    return "EasyLearn cannot connect to Neon. Verify DATABASE_URL and use the pooled connection string in Vercel.";
  }

  if (message.includes("self-signed certificate") || message.includes("certificate")) {
    return "The Neon SSL connection failed. Copy the complete connection string including sslmode=require.";
  }

  return "The authentication database is unavailable. Open /api/health and check the Vercel function logs.";
}
