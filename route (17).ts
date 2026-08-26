import { getDatabaseErrorMessage } from "@/lib/database-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks = {
    databaseUrlConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    jwtSecretConfigured: Boolean(process.env.JWT_SECRET?.trim()),
    databaseConnected: false,
    schemaReady: false,
  };

  if (!checks.databaseUrlConfigured) {
    return Response.json(
      {
        ok: false,
        service: "EasyLearn API",
        checks,
        message: "DATABASE_URL is missing in Vercel environment variables.",
      },
      { status: 503 }
    );
  }

  try {
    const { pool } = await import("@/db");
    const connectionResult = await pool.query<{ users_table: string | null }>(
      "select to_regclass('public.users')::text as users_table"
    );

    checks.databaseConnected = true;
    checks.schemaReady = connectionResult.rows[0]?.users_table === "users";

    if (!checks.schemaReady) {
      return Response.json(
        {
          ok: false,
          service: "EasyLearn API",
          checks,
          message: "Neon is connected, but the EasyLearn database tables have not been created.",
        },
        { status: 503 }
      );
    }

    return Response.json({
      ok: true,
      service: "EasyLearn API",
      checks,
      message: checks.jwtSecretConfigured
        ? "Authentication database is ready."
        : "Database is ready, but JWT_SECRET should be added in Vercel.",
    });
  } catch (error) {
    console.error("Health check error:", error);
    return Response.json(
      {
        ok: false,
        service: "EasyLearn API",
        checks,
        message: getDatabaseErrorMessage(error),
      },
      { status: 503 }
    );
  }
}
