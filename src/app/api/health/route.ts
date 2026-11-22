import { getDatabaseErrorMessage } from "@/lib/database-errors";
import {
  getDatabaseConfigurationProblem,
  getDatabaseUrl,
  getJwtConfigurationProblem,
} from "@/lib/env";
import { log } from "@/lib/logger";
import {
  assertNoSecretsInStorageSection,
  describeObjectStorage,
  type ObjectStorageReadiness,
} from "@/lib/object-storage-readiness";
import { runWithCurrentRequest } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * H-2: `/api/health` now answers three more questions than it did, without becoming a
 * dependency probe.
 *
 *  - **Which request is this?** Every response carries `X-Request-Id` and every body
 *    carries `requestId`, so a failing health check from an uptime monitor can be
 *    joined to the log line that explains it. An unauthenticated endpoint does not
 *    normally get to invent identifiers, but this one is a fixed-format value the
 *    caller can also *supply* (`x-vercel-id`), which is what makes it useful.
 *  - **Is object storage configured?** Reported as `configured`, `mode` and the
 *    names-only list of missing variables. This is a *configuration* statement and
 *    says so.
 *  - **Is object storage reachable?** Only answered when `?deep=1` is passed, and only
 *    `state: "verified"` after a real signed request succeeded. The default response
 *    says `configured-unverified` with `checked: false`, which is the honest answer
 *    for an endpoint that performed no I/O.
 *
 * The storage section never contains a bucket name, endpoint, key, region or signature;
 * `assertNoSecretsInStorageSection` enforces that at runtime rather than trusting the
 * code to keep being careful.
 */
/**
 * The handler body, wrapped so that everything it does runs inside a correlation context.
 *
 * `runWithCurrentRequest` reads the id the proxy published (or generates one when the
 * route is called directly, as the tests do), so a `log.error` inside a `catch` here — and
 * anything this handler awaits that logs — carries the same id without being told.
 */
export async function GET(request?: Request) {
  return runWithCurrentRequest(request, (requestId) =>
    healthCheck(request, requestId),
  );
}

async function healthCheck(request: Request | undefined, requestId: string) {
  /* `?deep=1` opts into the live object-storage check. Anything else — including a
     value a monitor might guess at — means "status only". */
  let deep = false;
  try {
    deep =
      new URL(request?.url ?? "http://localhost/api/health").searchParams.get(
        "deep",
      ) === "1";
  } catch {
    deep = false;
  }
  const databaseProblem = getDatabaseConfigurationProblem();
  const jwtProblem = getJwtConfigurationProblem();
  /* The storage section is computed before the database branch so that a database
     outage still reports the storage state (they are independent failures, and an
     operator debugging one should not have to fix the other to see it). It performs no
     I/O unless `deep` was requested. */
  let objectStorage: ObjectStorageReadiness;
  try {
    objectStorage = assertNoSecretsInStorageSection(
      await describeObjectStorage({ deep }),
    );
  } catch (error) {
    /* A storage probe must never take the endpoint down: the database answer is more
       important and is computed next. `error` goes through the redactor. */
    log.warn("health object-storage section failed", {
      event: "health.object_storage.error",
      requestId,
      error,
    });
    objectStorage = {
      configured: false,
      missingVariables: [],
      mode: "local-disk",
      state: "error",
      reachable: null,
      reason: "live_check_transport_error",
      checked: false,
      warnings: [],
    };
  }

  const checks = {
    requestId,
    databaseUrlConfigured: Boolean(getDatabaseUrl()),
    jwtSecretConfigured: !jwtProblem,
    databaseConnected: false,
    schemaReady: false,
    optionalMigrations: {} as Record<string, boolean>,
    /**
     * Progress for probes that can count (currently only the 0018 composite tenant keys).
     * `present < expected` with `present > 0` means the schema was partially changed —
     * a different situation from a migration that never ran, and one an operator must
     * look at before re-running anything.
     */
    migrationDetail: {} as Record<string, { expected: number; present: number; valid: number }>,
    migrationWarnings: [] as string[],
    objectStorage,
  };

  /* One place builds every response, so the correlation header cannot be forgotten on a
     branch added later. `Cache-Control: no-store` is repeated from the previous version
     for the same reason. */
  const respond = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    });

  if (databaseProblem) {
    return respond(
      {
        ok: false,
        service: "EasyLearn API",
        checks,
        message: databaseProblem,
      },
      503,
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
      const { probeSchemaFeatures, getSchemaRepairFailure } =
        await import("@/lib/schema-resilience");
      const optional = await probeSchemaFeatures();
      for (const item of optional) {
        checks.optionalMigrations[item.feature] = item.present;
        /* Post-deployment H-2 review: a bare `false` could not distinguish "the migration
           never ran" from "it ran and left the schema half-changed". For the composite
           tenant probe the counts are already computed, so report them — schema metadata
           only, no names, no data. */
        if (item.detail) {
          checks.migrationDetail[item.feature] = item.detail;
        }
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
            item.ddlCapable === false
              ? "the runtime role has no CREATE privilege on schema public"
              : null,
            failure
              ? `the last repair attempt applied ${failure.appliedStatements}/${failure.totalStatements} statements and failed: ${failure.reason}`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          log.error("session revocation is unavailable", {
            event: "health.session_revocation_unavailable",
            requestId,
            cause: cause || "users.session_version is missing",
          });
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
            item.ddlCapable === false
              ? "the runtime role has no CREATE privilege on schema public"
              : null,
            failure
              ? `the last repair attempt applied ${failure.appliedStatements}/${failure.totalStatements} statements and failed: ${failure.reason}`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          log.error(
            "login throttling is unavailable and cannot be repaired automatically",
            {
              event: "health.login_throttle_unavailable",
              requestId,
              cause: cause || "cause unknown",
            },
          );
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
          /* A partially-applied migration is not the same finding as one that never ran,
             and it is the case an operator is most likely to make worse by re-running
             something. Say which it is. */
          const progress = item.detail
            ? item.detail.present === 0
              ? `; 0 of ${item.detail.expected} constraints present, so the migration has not run`
              : `; only ${item.detail.present} of ${item.detail.expected} constraints present ` +
                `(${item.detail.valid} validated) — the schema is PARTIALLY migrated, inspect before re-running`
            : "";
          checks.migrationWarnings.push(
            `${item.migration} has not been applied (${item.feature} ${
              item.probeError
                ? "could not be verified"
                : "is missing or incomplete"
            })${progress} - ${remedy}`,
          );
        }
      }
    } catch (error) {
      log.error("health optional-schema probe failed", {
        event: "health.schema_probe_failed",
        requestId,
        error,
      });
      featureProbeUnavailable = true;
    }

    /* F-7: never answer ok:true while a security-critical feature is reported false, and never
       answer ok:true when their state could not be read at all. Both used to be possible: a
       probe that raised produced `ok:true` with `login_attempts: false` in the same body. */
    const securityCriticalMissing = (
      ["login_attempts", "session_revocation"] as const
    ).some((feature) => checks.optionalMigrations[feature] === false);
    if (featureProbeUnavailable || securityCriticalMissing) {
      sessionRevocationUnavailable =
        sessionRevocationUnavailable ||
        checks.optionalMigrations.session_revocation === false ||
        featureProbeUnavailable;
      loginThrottleUnavailable =
        loginThrottleUnavailable ||
        checks.optionalMigrations.login_attempts === false ||
        featureProbeUnavailable;
    }

    if (!checks.schemaReady) {
      return respond(
        {
          ok: false,
          service: "EasyLearn API",
          checks,
          message:
            "Neon is connected, but the EasyLearn users table is missing or incompatible. Run the Drizzle schema push for this repository.",
        },
        503,
      );
    }

    if (jwtProblem) {
      return respond(
        {
          ok: false,
          service: "EasyLearn API",
          checks,
          message: jwtProblem,
        },
        503,
      );
    }

    if (sessionRevocationUnavailable) {
      return respond(
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
        503,
      );
    }

    if (loginThrottleUnavailable) {
      return respond(
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
        503,
      );
    }

    /* Reached only when both security-critical features were probed successfully and are
       present, so "ready" is now a statement this endpoint has actually verified (F-1/F-7). */
    return respond({
      ok: true,
      service: "EasyLearn API",
      checks,
      message: "Login and registration services are ready.",
    });
  } catch (error) {
    /* H-2: the health check's own failure is now a structured line carrying the request
       id, so a 503 body an operator copied out of a monitor maps to exactly one log
       entry. The response text is unchanged (it was already sanitised). */
    log.error("health check failed", {
      event: "health.check_failed",
      requestId,
      error,
    });
    return respond(
      {
        ok: false,
        service: "EasyLearn API",
        checks,
        message: getDatabaseErrorMessage(error),
      },
      503,
    );
  }
}
