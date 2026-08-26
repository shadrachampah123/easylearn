type DatabaseErrorLike = {
  code?: string;
  message?: string;
  cause?: unknown;
};

function asDatabaseError(error: unknown): DatabaseErrorLike {
  if (typeof error === "object" && error !== null) {
    return error as DatabaseErrorLike;
  }
  return { message: String(error) };
}

export function getDatabaseErrorMessage(error: unknown): string {
  const dbError = asDatabaseError(error);
  const nested = asDatabaseError(dbError.cause);
  const code = dbError.code || nested.code;
  const message = `${dbError.message || ""} ${nested.message || ""}`.toLowerCase();

  if (code === "42P01" || message.includes("relation") && message.includes("does not exist")) {
    return "Database setup is incomplete. Apply the Drizzle schema to Neon, then try again.";
  }

  if (code === "42704" || message.includes("type") && message.includes("does not exist")) {
    return "Database setup is incomplete. Apply all Drizzle schema changes to Neon, then try again.";
  }

  if (code === "28P01" || message.includes("password authentication failed")) {
    return "The Neon database credentials in Vercel are invalid. Update DATABASE_URL and redeploy.";
  }

  if (code === "3D000" || message.includes("database") && message.includes("does not exist")) {
    return "The database named in DATABASE_URL does not exist. Copy a fresh connection string from Neon.";
  }

  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    message.includes("getaddrinfo") ||
    message.includes("connect timeout")
  ) {
    return "EasyLearn cannot connect to Neon. Check DATABASE_URL in Vercel and redeploy.";
  }

  if (message.includes("self-signed certificate") || message.includes("certificate")) {
    return "The database SSL connection failed. Use the complete Neon connection string with sslmode=require.";
  }

  return "The authentication database is unavailable. Check /api/health and the Vercel function logs.";
}
