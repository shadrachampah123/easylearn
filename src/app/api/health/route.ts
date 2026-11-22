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
    optionalMigrations: {} as Record<string, boolean>,
    migrationWarnings: [] as string[],
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

    // Read-only probe of the migrations that add optional objects, so an operator can see
    // "overrides are disabled because 0004 was never applied" from one URL. Never runs DDL.
    let sessionRevocationUnavailable = false;
    let loginThrottleUnavailable = false;
    /* F-7: if this probe cannot run at all, the schema state of the two security-critical
       features is unknown, and "unknown" must not be reported as ready. */
    let featureProbeUnavailable = false;
    try {
      const { probeSchemaFeatures, getSchemaRepairFailure } = await import("@/lib/schema-resilience");
      const optional = await probeSchemaFeatures();
      for (const item of optional) {
        checks.optionalMigrations[item.feature] = item.present;
        /* Session revocation is security-critical, not optional polish. If the column is
           missing AND automatic repair is disabled, verifyToken fails closed and every
           authenticated request answers 503 — while this endpoint was reporting "ready"
           (Issue #54 production finding, 2026-10-27). When repair is enabled the next
           authenticated request will attempt the idempotent repair DDL, so that case
           stays a warning: this read-only probe cannot know whether the runtime role
           may execute DDL. */
        /* M-R4a: escalate on `repairBlocked`, not on "repair is switched off". A
           security-critical feature fails CLOSED when it is missing, and repair being enabled is
           not reassurance — the runtime role may have no CREATE privilege on `public`, or a
           repair may already have been attempted and failed. Before this, all three states
           reported ok:true while every login answered 503. */
        if (item.feature === "session_revocation" && item.repairBlocked) {
          sessionRevocationUnavailable = true;
          /* F-4: log the cause here too. This branch used to escalate silently, so an operator
             staring at a 503 had no way to tell "repair switched off" from "repair tried and
             failed" from "the column drifted" without reading the response text. */
          const failure = getSchemaRepairFailure("session_revocation");
          const cause = [
            item.probeError ? "the schema probe itself failed" : null,
            item.repairEnabled ? null : "AUTO_SCHEMA_REPAIR is disabled",
            item.ddlCapable === false ? "the runtime role has no CREATE privilege on schema public" : null,
            failure
              ? `the last repair attempt applied ${failure.appliedStatements}/${failure.totalStatements} statements and failed: ${failure.reason}`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          console.error(`[health] session revocation is unavailable (${cause || "users.session_version is missing"})`);
        }
        /* Same reasoning for login throttling since the H-1 fix (2026-11-19): the throttle
           now fails CLOSED, so a database without login_attempts and without automatic
           repair refuses every login with 503. This endpoint must not answer "Login and
           registration services are ready" in that state. When repair is enabled the next
           login recreates the table, so that case stays a warning. */
        if (item.feature === "login_attempts" && item.repairBlocked) {
          loginThrottleUnavailable = true;
          /* The cause belongs in the server log, never in this unauthenticated response: the
             endpoint already discloses more schema state than is ideal (finding L-4). */
          const failure = getSchemaRepairFailure("login_attempts");
          const cause = [
            item.probeError ? "the schema probe itself failed" : null,
            item.repairEnabled ? null : "AUTO_SCHEMA_REPAIR is disabled",
            item.ddlCapable === false ? "the runtime role has no CREATE privilege on schema public" : null,
            failure
              ? `the last repair attempt applied ${failure.appliedStatements}/${failure.totalStatements} statements and failed: ${failure.reason}`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          console.error(`[health] login throttling is unavailable and cannot be repaired automatically (${cause || "cause unknown"})`);
        }
        if (!item.present) {
          /* F-1: "missing" now covers a relation that exists without the columns the code
             needs, which is what a relation-only probe could not see. */
          const remedy = item.autoRepairable
            ? item.repairBlocked
              ? "Automatic repair cannot create it in this deployment; run `node run-migration.js` to apply it."
              : "EasyLearn creates it on demand, but run `node run-migration.js` to make it official."
            : "EasyLearn never creates this automatically. An administrator must run " +
              "`node run-migration.js` under the documented preflight, because the tenant " +
              "boundary must not change without review.";
          checks.migrationWarnings.push(
            `${item.migration} has not been applied (${item.feature} ${
              item.probeError ? "could not be verified" : "is missing or incomplete"
            }) - ${remedy}`
          );
        }
      }
    } catch (error) {
      console.error("Health optional-schema probe failed:", error);
      featureProbeUnavailable = true;
    }

    /* F-7: never answer ok:true while a security-critical feature is reported false, and never
       answer ok:true when their state could not be read at all. Both used to be possible: a
       probe that raised produced `ok:true` with `login_attempts: false` in the same body. */
    const securityCriticalMissing = (["login_attempts", "session_revocation"] as const).some(
      (feature) => checks.optionalMigrations[feature] === false
    );
    if (featureProbeUnavailable || securityCriticalMissing) {
      sessionRevocationUnavailable =
        sessionRevocationUnavailable || checks.optionalMigrations.session_revocation === false || featureProbeUnavailable;
      loginThrottleUnavailable =
        loginThrottleUnavailable || checks.optionalMigrations.login_attempts === false || featureProbeUnavailable;
    }

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

    if (sessionRevocationUnavailable) {
      return Response.json(
        {
          ok: false,
          service: "EasyLearn API",
          checks,
          message:
            "Database is connected, but session revocation is unavailable: users.session_version " +
            "is missing or could not be verified (drizzle/0019_session_revocation.sql), so token " +
            "verification fails closed and authenticated requests will return 503. Apply the " +
            "migration with `node run-migration.js`.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (loginThrottleUnavailable) {
      return Response.json(
        {
          ok: false,
          service: "EasyLearn API",
          checks,
          message:
            "Database is connected, but login throttling is unavailable: the login_attempts table " +
            "or a column the throttle requires is missing (drizzle/0012_login_attempts.sql), so " +
            "login fails closed and every sign-in attempt will return 503. Apply the migration " +
            "with `node run-migration.js`.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    /* Reached only when both security-critical features were probed successfully and are
       present, so "ready" is now a statement this endpoint has actually verified (F-1/F-7). */
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
