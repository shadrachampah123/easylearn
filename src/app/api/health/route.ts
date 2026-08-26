import { getDatabaseErrorMessage } from "@/lib/database-errors";
import {
  getDatabaseConfigurationProblem,
  getDatabaseUrl,
  getJwtConfigurationProblem,
} from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const databaseProblem = getDatabaseConfigurationProblem();
  const jwtProblem = getJwtConfigurationProblem();
  const checks = {
    databaseUrlConfigured: Boolean(getDatabaseUrl()),
    jwtSecretConfigured: !jwtProblem,
    databaseConnected: false,
    schemaReady: false,
  };

  if (databaseProblem) {
    return Response.json(
      {
        ok: false,
        service: "EasyLearn API",
        checks,
        message: databaseProblem,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const { pool } = await import("@/db");
    const connectionResult = await pool.query<{
      users_table: string | null;
      users_columns: number;
    }>(`
      select
        to_regclass('public.users')::text as users_table,
        (
          select count(*)::int
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'users'
            and column_name in (
              'id', 'email', 'password_hash', 'role', 'first_name',
              'last_name', 'is_active', 'created_at', 'updated_at'
            )
        ) as users_columns
    `);

    checks.databaseConnected = true;
    checks.schemaReady =
      connectionResult.rows[0]?.users_table === "users" &&
      Number(connectionResult.rows[0]?.users_columns) === 9;

    if (!checks.schemaReady) {
      return Response.json(
        {
          ok: false,
          service: "EasyLearn API",
          checks,
          message: "Neon is connected, but the EasyLearn users table is missing or incompatible. Run the Drizzle schema push for this repository.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (jwtProblem) {
      return Response.json(
        {
          ok: false,
          service: "EasyLearn API",
          checks,
          message: jwtProblem,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    return Response.json(
      {
        ok: true,
        service: "EasyLearn API",
        checks,
        message: "Login and registration services are ready.",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Health check error:", error);
    return Response.json(
      {
        ok: false,
        service: "EasyLearn API",
        checks,
        message: getDatabaseErrorMessage(error),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
