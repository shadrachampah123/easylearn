/**
 * Schema resilience helpers.
 *
 * EasyLearn ships migrations as plain SQL files (drizzle/00XX_*.sql) that are applied by
 * hand (`node run-migration.js` / `npx drizzle-kit push`). Those steps get forgotten - and
 * two of the files (0004/0005) were additionally unrunnable because they had been saved with
 * shell-escaped \" quotes. A missing table or column used to turn the whole admin dashboard,
 * the card-override CRUD and the activity feed into a bare "Internal server error" 500.
 *
 * These helpers let route handlers:
 *  1. classify Postgres/Drizzle errors as "the schema is behind" vs "something else broke",
 *  2. run each query independently and fall back to a safe default (degraded, not 500),
 *  3. self-heal the three migrations that only add optional objects (0004 card overrides,
 *     0005 activity log columns, 0006 user identity columns) with idempotent DDL.
 */
import { pool } from "@/db";
import { getDatabaseErrorCode } from "@/lib/database-errors";

/* ── Error classification ── */

export const PG_UNDEFINED_TABLE = "42P01";
export const PG_UNDEFINED_COLUMN = "42703";
export const PG_UNDEFINED_OBJECT = "42704";
export const PG_INVALID_TEXT_REPRESENTATION = "22P02";
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FK_VIOLATION = "23503";

type ErrorLike = {
  code?: string;
  message?: string;
  detail?: string;
  cause?: unknown;
};

function asErrorLike(error: unknown): ErrorLike {
  if (typeof error === "object" && error !== null) return error as ErrorLike;
  return { message: typeof error === "string" ? error : String(error) };
}

/** Flat view of a (possibly nested) database error: drizzle wraps the pg error in `cause`. */
export function inspectDbError(error: unknown): { code?: string; text: string } {
  const outer = asErrorLike(error);
  const inner = asErrorLike(outer.cause);
  const innermost = asErrorLike(inner.cause);
  return {
    code: getDatabaseErrorCode(error),
    text: [outer.message, outer.detail, inner.message, inner.detail, innermost.message]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" "),
  };
}

// Postgres phrases these precisely and drizzle prepends the failing SQL to the message,
// so a loose `includes("relation")` check matches unrelated text (e.g. the
// `parse_relation.c` source location). Anchor on the real message shape instead.
const MISSING_RELATION_RE = /relation\s+"?[\w$]+"?(?:\."?[\w$]+"?)?\s+does not exist/i;
const MISSING_COLUMN_RE = /column\s+"?[\w$]+"?\.?"?[\w$]*"?\s+does not exist/i;
const MISSING_TYPE_RE = /type\s+"?[\w$]+"?(?:\."?[\w$]+"?)?\s+does not exist/i;

export function isMissingRelation(error: unknown): boolean {
  const { code, text } = inspectDbError(error);
  return code === PG_UNDEFINED_TABLE || MISSING_RELATION_RE.test(text);
}

export function isMissingColumn(error: unknown): boolean {
  const { code, text } = inspectDbError(error);
  return code === PG_UNDEFINED_COLUMN || MISSING_COLUMN_RE.test(text);
}

export function isMissingEnumType(error: unknown): boolean {
  const { code, text } = inspectDbError(error);
  if (code === PG_UNDEFINED_OBJECT) return true;
  // A missing enum type reads as `type "dashboard_role" does not exist`.
  return MISSING_TYPE_RE.test(text) && !MISSING_COLUMN_RE.test(text);
}

/** Bad enum literal / malformed uuid — usually a client input problem, not a server bug. */
export function isInvalidLiteral(error: unknown): boolean {
  const { code, text } = inspectDbError(error);
  const lower = text.toLowerCase();
  return (
    code === PG_INVALID_TEXT_REPRESENTATION ||
    lower.includes("invalid input value for enum") ||
    lower.includes("invalid input syntax for type uuid")
  );
}

export function isUniqueViolation(error: unknown): boolean {
  const { code, text } = inspectDbError(error);
  return code === PG_UNIQUE_VIOLATION || text.toLowerCase().includes("duplicate key value");
}

export function isForeignKeyViolation(error: unknown): boolean {
  const { code, text } = inspectDbError(error);
  return code === PG_FK_VIOLATION || text.toLowerCase().includes("foreign key");
}

/** True when the failure is "the database has not been migrated yet". */
export function isSchemaOutOfDate(error: unknown): boolean {
  return isMissingRelation(error) || isMissingColumn(error) || isMissingEnumType(error);
}

/** `column activity_logs.entity_type does not exist` -> `activity_logs.entity_type` */
export function missingObject(error: unknown): string | null {
  const { text } = inspectDbError(error);
  const match = /(?:relation|column|type)\s+(?:"?[\w$]+"?\."?[\w$]+"?|"?[\w$]+"?)/i.exec(text);
  if (!match) return null;
  return match[0]
    .replace(/^(relation|column|type)\s+/i, "")
    .replace(/"/g, "");
}

/* ── Warnings ── */
const AREA_LABELS: Record<string, string> = {
  overrides: "Card overrides",
  activityFeed: "Recent activity",
  attendanceOverview: "Attendance overview",
  topClasses: "Class performance",
  teachers: "Total teachers",
  learners: "Total learners",
  parents: "Total parents",
  classes: "Classes",
  subjects: "Subjects",
  assignments: "Assignments",
  resources: "Resources",
  announcements: "Announcements",
  stats: "Dashboard counts",
  quizzes: "Quizzes",
  quizQuestions: "Quiz questions",
  submissions: "Submissions",
};


export interface SchemaWarning {
  /** Which part of the payload degraded, e.g. `overrides`, `activityFeed`. */
  area: string;
  /** Actionable, user-facing sentence. Never contains SQL or credentials. */
  message: string;
  /** Migration file that would fix it. */
  migration?: string;
  /** Set when we silently repaired the gap on this request. */
  repaired?: boolean;
}

const MIGRATION_BY_OBJECT: Record<string, string> = {
  dashboard_card_overrides: "drizzle/0004_dashboard_overrides.sql",
  "dashboard_role": "drizzle/0004_dashboard_overrides.sql",
  "card_scope_type": "drizzle/0004_dashboard_overrides.sql",
  "activity_logs.entity_type": "drizzle/0005_activity_enhancements.sql",
  "activity_logs.entity_id": "drizzle/0005_activity_enhancements.sql",
  "activity_logs.description": "drizzle/0005_activity_enhancements.sql",
  "users.username": "drizzle/0006_user_identity_columns.sql",
  "users.must_change_password": "drizzle/0006_user_identity_columns.sql",
  username: "drizzle/0006_user_identity_columns.sql",
  must_change_password: "drizzle/0006_user_identity_columns.sql",
  // drizzle/0007 adds quiz_questions.image_url. It is declared in src/db/schema.ts, so
  // drizzle emits the column in every INSERT/SELECT against quiz_questions - on a database
  // that never ran it, creating or opening a quiz fails with 42703 and the learner sees no
  // quizzes at all. Keyed on the qualified name only: gallery_items and news have an
  // image_url column too, and pointing those at 0007 would send an operator to the wrong file.
  "quiz_questions.image_url": "drizzle/0007_quiz_images.sql",
};

export function migrationFor(objectName: string | null): string | undefined {
  if (!objectName) return undefined;
  return MIGRATION_BY_OBJECT[objectName] ?? MIGRATION_BY_OBJECT[objectName.split(".").pop() as string];
}

/** Turn a thrown error into a friendly warning, or null when it is not a schema gap. */
export function toSchemaWarning(area: string, error: unknown, label?: string): SchemaWarning | null {
  if (!isSchemaOutOfDate(error)) return null;
  const object = missingObject(error);
  const migration = migrationFor(object);
  const isRelation = isMissingRelation(error) || isMissingEnumType(error);
  const subject = label || AREA_LABELS[area] || area;
  let gapKind = "column";
  if (isMissingEnumType(error)) gapKind = "type";
  else if (isMissingRelation(error)) gapKind = "table";
  const gap = object
    ? `${object} ${gapKind} is missing from this database`
    : "this part of the schema is missing from this database";
  return {
    area,
    message: `${subject} is unavailable because ${gap}. Run \`${migration ?? "the pending migrations"}\` to enable it.`,
    ...(migration ? { migration } : {}),
  };
}

/**
 * Message for an API response: safe to show to an admin, mentions the migration file to
 * run when the failure is a missing table/column, and never echoes raw database errors.
 */
export function schemaAwareErrorMessage(error: unknown, fallback: string): string {
  if (isSchemaOutOfDate(error)) {
    const object = missingObject(error);
    const migration = migrationFor(object);
    const gap = object ? `${object} is missing from this database` : "the database schema is out of date";
    const run = migration ? ` Apply ${migration} (or \`npx drizzle-kit push\`), then retry.` : " Apply the pending files in drizzle/, then retry.";
    return `${fallback} The underlying issue is that ${gap}.${run}`;
  }
  return clientSafeErrorMessage(error, fallback);
}

/** Human message for errors that are NOT schema gaps (used by API routes instead of "Internal server error"). */
export function clientSafeErrorMessage(error: unknown, fallback = "The database is unavailable right now."): string {
  if (isInvalidLiteral(error)) return "One of the submitted values is not valid for this field.";
  if (isUniqueViolation(error)) return "That record already exists.";
  if (isForeignKeyViolation(error)) return "A related record is missing, so this action was rejected.";
  return fallback;
}

/* ── Optional self-healing for the migrations that only add optional columns/tables ── */

export type SchemaFeature =
  | "dashboard_card_overrides"
  | "activity_logs_enrichment"
  | "optional_user_columns"
  | "quiz_question_images";

const FEATURE_STATUS_TTL_MS = 60_000;

const FEATURE_MIGRATIONS: Record<SchemaFeature, string> = {
  dashboard_card_overrides: "drizzle/0004_dashboard_overrides.sql",
  activity_logs_enrichment: "drizzle/0005_activity_enhancements.sql",
  optional_user_columns: "drizzle/0006_user_identity_columns.sql",
  quiz_question_images: "drizzle/0007_quiz_images.sql",
};

/** DDL mirrors the idempotent migration files; safe to run repeatedly. */
const FEATURE_SQL: Record<SchemaFeature, string[]> = {
  dashboard_card_overrides: [
    `DO $$ BEGIN
       CREATE TYPE "public"."dashboard_role" AS ENUM('admin', 'teacher', 'learner', 'parent', 'global');
     EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    `DO $$ BEGIN
       CREATE TYPE "public"."card_scope_type" AS ENUM('global', 'role', 'class', 'learner', 'parent', 'teacher', 'user');
     EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    `CREATE TABLE IF NOT EXISTS "dashboard_card_overrides" (
       "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
       "card_key" varchar(150) NOT NULL,
       "dashboard_role" "dashboard_role" DEFAULT 'global' NOT NULL,
       "title" varchar(255),
       "label" varchar(255),
       "value" text,
       "subtitle" varchar(255),
       "description" text,
       "trend" varchar(100),
       "is_visible" boolean DEFAULT true NOT NULL,
       "sort_order" integer DEFAULT 0 NOT NULL,
       "is_enabled" boolean DEFAULT true NOT NULL,
       "override_payload" jsonb,
       "scope_type" "card_scope_type" DEFAULT 'global' NOT NULL,
       "scope_id" uuid,
       "created_by" uuid,
       "created_at" timestamp DEFAULT now() NOT NULL,
       "updated_at" timestamp DEFAULT now() NOT NULL
     );`,
    `DO $$ BEGIN
       ALTER TABLE "dashboard_card_overrides" ADD CONSTRAINT "dashboard_card_overrides_created_by_users_id_fk"
         FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
     EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    `CREATE INDEX IF NOT EXISTS "dashboard_card_overrides_key_role_idx" ON "dashboard_card_overrides" USING btree ("card_key", "dashboard_role");`,
    `CREATE INDEX IF NOT EXISTS "dashboard_card_overrides_scope_idx" ON "dashboard_card_overrides" USING btree ("scope_type", "scope_id");`,
    `CREATE INDEX IF NOT EXISTS "dashboard_card_overrides_enabled_idx" ON "dashboard_card_overrides" USING btree ("is_enabled", "is_visible");`,
  ],
  activity_logs_enrichment: [
    `ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "entity_type" varchar(100);`,
    `ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "entity_id" uuid;`,
    `ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "description" text;`,
    `CREATE INDEX IF NOT EXISTS "activity_logs_entity_idx" ON "activity_logs" USING btree ("entity_type", "entity_id");`,
    `CREATE INDEX IF NOT EXISTS "activity_logs_created_at_idx" ON "activity_logs" USING btree ("created_at" DESC);`,
    `CREATE INDEX IF NOT EXISTS "activity_logs_user_action_idx" ON "activity_logs" USING btree ("user_id", "action");`,
  ],
  optional_user_columns: [
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" varchar(100);`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "users_username_unique_idx" ON "users" ("username") WHERE "username" IS NOT NULL;`,
  ],
  quiz_question_images: [
    `ALTER TABLE "quiz_questions" ADD COLUMN IF NOT EXISTS "image_url" text;`,
  ],
};

/**
 * Cheap existence probe per feature, so the repair DDL only runs when something is
 * actually missing (a single catalog query, cached for a minute).
 */
type FeatureProbe =
  | { mode: "relation"; relation: string }
  | { mode: "columns"; table: string; columns: string[] };

const FEATURE_PROBE: Record<SchemaFeature, FeatureProbe> = {
  dashboard_card_overrides: { mode: "relation", relation: "dashboard_card_overrides" },
  activity_logs_enrichment: {
    mode: "columns",
    table: "activity_logs",
    columns: ["entity_type", "entity_id", "description"],
  },
  optional_user_columns: {
    mode: "columns",
    table: "users",
    columns: ["username", "must_change_password"],
  },
  quiz_question_images: {
    mode: "columns",
    table: "quiz_questions",
    columns: ["image_url"],
  },
};

function probeSql(probe: FeatureProbe): string {
  if (probe.mode === "relation") {
    return `SELECT to_regclass('public.${probe.relation}') AS object`;
  }
  const list = probe.columns.map((column) => `'${column}'`).join(", ");
  return `SELECT count(*)::int AS object FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${probe.table}'
            AND column_name IN (${list})`;
}

function probeSatisfied(probe: FeatureProbe, value: unknown): boolean {
  if (probe.mode === "relation") return Boolean(value);
  return Number(value ?? 0) >= probe.columns.length;
}

type FeatureState = { available: boolean; repaired: boolean; at: number };

const globalForSchemaState = globalThis as typeof globalThis & {
  __easylearnSchemaFeatures?: Map<SchemaFeature, FeatureState>;
};

function featureStates(): Map<SchemaFeature, FeatureState> {
  if (!globalForSchemaState.__easylearnSchemaFeatures) {
    globalForSchemaState.__easylearnSchemaFeatures = new Map();
  }
  return globalForSchemaState.__easylearnSchemaFeatures;
}

/**
 * Auto-repair can be switched off (e.g. a locked-down DB role with no DDL rights, or a
 * strict migration policy) with `AUTO_SCHEMA_REPAIR=false`. When disabled we only probe.
 */
export function autoSchemaRepairEnabled(): boolean {
  const flag = (process.env.AUTO_SCHEMA_REPAIR ?? "true").trim().toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "off";
}

export interface FeatureStatus {
  feature: SchemaFeature;
  available: boolean;
  repaired: boolean;
  migration: string;
}

/**
 * Make sure the objects a feature needs exist. Probes the database, runs the feature's
 * idempotent DDL when something is missing, and caches the verdict for a minute so the
 * dashboard does not pay for it on every request.
 */
export async function ensureSchemaFeature(feature: SchemaFeature): Promise<FeatureStatus> {
  const states = featureStates();
  const cached = states.get(feature);
  if (cached && Date.now() - cached.at < FEATURE_STATUS_TTL_MS) {
    return { feature, available: cached.available, repaired: cached.repaired, migration: FEATURE_MIGRATIONS[feature] };
  }

  const spec = FEATURE_PROBE[feature];
  let available = false;
  try {
    const probe = await pool.query(probeSql(spec));
    available = probeSatisfied(spec, probe.rows[0]?.object);
  } catch (error) {
    console.error(`[schema] unable to probe ${feature}:`, error);
    return { feature, available: false, repaired: false, migration: FEATURE_MIGRATIONS[feature] };
  }

  let repaired = false;
  if (!available && autoSchemaRepairEnabled()) {
    const statements = FEATURE_SQL[feature];
    const recheckSql = probeSql(spec);
    const executed: string[] = [];
    for (const statement of statements) {
      try {
        await pool.query(statement);
        executed.push(statement);
      } catch (error) {
        // Permissive DDL is expected to be re-runnable; log and keep going so a single
        // blocked statement (e.g. no FK privileges) does not disable the whole feature.
        console.warn(`[schema] could not auto-apply part of ${feature}:`, inspectDbError(error).text);
      }
    }
    if (executed.length > 0) {
      try {
        const recheck = await pool.query(recheckSql);
        available = probeSatisfied(spec, recheck.rows[0]?.object);
        repaired = available;
      } catch {
        available = false;
      }
    }
  }

  states.set(feature, { available, repaired, at: Date.now() });

  return { feature, available, repaired, migration: FEATURE_MIGRATIONS[feature] };
}

/**
 * `users.username` / `users.must_change_password` live in src/db/schema.ts but were only
 * introduced by drizzle/0006_user_identity_columns.sql, so every route that reads the
 * users table needs this before querying.
 */
export function ensureUserIdentityColumns(): Promise<FeatureStatus> {
  return ensureSchemaFeature("optional_user_columns");
}

/**
 * `quiz_questions.image_url` is declared in src/db/schema.ts but only ever added by
 * drizzle/0007_quiz_images.sql. Drizzle lists every schema column in the SQL it generates,
 * so on a database that never ran 0007 *every* quiz insert and every quiz-question read
 * fails with `column "image_url" of relation "quiz_questions" does not exist` - which is
 * exactly the "quizzes set by the teacher never appear" symptom. Every quiz route calls
 * this before touching quiz_questions.
 */
export function ensureQuizImageColumn(): Promise<FeatureStatus> {
  return ensureSchemaFeature("quiz_question_images");
}

export interface OptionalSchemaStatus {
  feature: SchemaFeature;
  present: boolean;
  migration: string;
  repairEnabled: boolean;
}

/**
 * Read-only catalog check for /api/health and admin diagnostics: reports which optional
 * migration objects exist without ever running DDL or touching the repair cache.
 */
export async function probeSchemaFeatures(
  features: SchemaFeature[] = [
    "dashboard_card_overrides",
    "activity_logs_enrichment",
    "optional_user_columns",
    "quiz_question_images",
  ]
): Promise<OptionalSchemaStatus[]> {
  const repairEnabled = autoSchemaRepairEnabled();
  return Promise.all(
    features.map(async (feature) => {
      const spec = FEATURE_PROBE[feature];
      let present = false;
      try {
        const probe = await pool.query(probeSql(spec));
        present = probeSatisfied(spec, probe.rows[0]?.object);
      } catch (error) {
        console.error(`[schema] health probe for ${feature} failed:`, inspectDbError(error).text);
        present = false;
      }
      return { feature, present, migration: FEATURE_MIGRATIONS[feature], repairEnabled };
    })
  );
}

/** Reset cached verdicts — used by tests and after running migrations by hand. */
export function resetSchemaFeatureCache(): void {
  featureStates().clear();
}

export function schemaWarningForFeature(status: FeatureStatus, area: string): SchemaWarning {
  return {
    area,
    message: `${status.migration} has not been applied, so this part of the dashboard is disabled. Ask an administrator to run \`node run-migration.js ${status.migration.split("/").pop()}\`.`,
    migration: status.migration,
    repaired: status.repaired,
  };
}
