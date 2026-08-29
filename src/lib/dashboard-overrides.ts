import { db } from "@/db";
import { dashboardCardOverrides } from "@/db/schema";
import { eq, and, or, desc } from "drizzle-orm";
import {
  ensureSchemaFeature,
  isSchemaOutOfDate,
  inspectDbError,
  toSchemaWarning,
  type SchemaWarning,
} from "@/lib/schema-resilience";

/** Enum values accepted by `dashboard_role` / `card_scope_type` (migration 0004). */
export const OVERRIDE_DASHBOARD_ROLES = ["admin", "teacher", "learner", "parent", "global"] as const;
export const OVERRIDE_SCOPE_TYPES = ["global", "role", "class", "learner", "parent", "teacher", "user"] as const;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OverrideInputProblem {
  field: string;
  message: string;
}

/**
 * Validate/normalise an override create/update body *before* it reaches Postgres.
 * Without this, one bad enum literal or uuid surfaced as a 500 override card.
 */
export function normalizeOverrideInput(
  body: Record<string, unknown>,
  options: { partial?: boolean } = {}
): { ok: true; values: Record<string, unknown>; problems?: undefined } | { ok: false; values?: undefined; problems: OverrideInputProblem[] } {
  const problems: OverrideInputProblem[] = [];
  const values: Record<string, unknown> = {};
  const partial = Boolean(options.partial);

  const set = (key: string, value: unknown) => {
    values[key] = value;
  };

  const text = (key: string, max: number, { required = false }: { required?: boolean } = {}) => {
    const raw = body[key];
    if (raw === undefined) {
      if (required && !partial) problems.push({ field: key, message: `${key} is required` });
      return;
    }
    if (raw === null || raw === "") {
      set(key, null);
      return;
    }
    const textValue = String(raw).trim();
    if (!textValue) {
      set(key, null);
      return;
    }
    if (textValue.length > max) problems.push({ field: key, message: `${key} must be ${max} characters or fewer` });
    set(key, textValue);
  };

  const flag = (key: string, fallback?: boolean) => {
    const raw = body[key];
    if (raw === undefined) {
      if (!partial && fallback !== undefined) set(key, fallback);
      return;
    }
    set(key, raw === true || raw === "true" || raw === 1 || raw === "1");
  };

  if (body.cardKey !== undefined) {
    text("cardKey", 150, { required: true });
  } else if (!partial) {
    problems.push({ field: "cardKey", message: "cardKey is required" });
  }

  if (body.dashboardRole !== undefined && body.dashboardRole !== null && body.dashboardRole !== "") {
    const role = String(body.dashboardRole);
    if (!(OVERRIDE_DASHBOARD_ROLES as readonly string[]).includes(role)) {
      problems.push({ field: "dashboardRole", message: `dashboardRole must be one of: ${OVERRIDE_DASHBOARD_ROLES.join(", ")}` });
    } else {
      set("dashboardRole", role);
    }
  } else if (!partial) {
    set("dashboardRole", "global");
  }

  if (body.scopeType !== undefined && body.scopeType !== null && body.scopeType !== "") {
    const scopeType = String(body.scopeType);
    if (!(OVERRIDE_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
      problems.push({ field: "scopeType", message: `scopeType must be one of: ${OVERRIDE_SCOPE_TYPES.join(", ")}` });
    } else {
      set("scopeType", scopeType);
    }
  } else if (!partial) {
    set("scopeType", "global");
  }

  if (body.scopeId !== undefined) {
    const scopeId = body.scopeId;
    if (scopeId === null || scopeId === "") {
      set("scopeId", null);
    } else if (typeof scopeId === "string" && UUID_PATTERN.test(scopeId)) {
      set("scopeId", scopeId);
    } else {
      problems.push({ field: "scopeId", message: "scopeId must be a learner/class/user id (uuid) or empty" });
    }
  }

  if (body.value !== undefined) {
    // `value` is text in the DB; accept numbers/booleans but never objects (they used to blow up rendering).
    const raw = body.value;
    if (raw === null || raw === "") set("value", null);
    else if (typeof raw === "object") problems.push({ field: "value", message: "value must be a simple text or number" });
    else set("value", String(raw));
  }

  if (body.sortOrder !== undefined) {
    const sort = Number(body.sortOrder);
    if (!Number.isFinite(sort)) problems.push({ field: "sortOrder", message: "sortOrder must be a number" });
    else set("sortOrder", Math.trunc(sort));
  }

  text("title", 255);
  text("label", 255);
  text("subtitle", 255);
  text("description", 2000);
  text("trend", 100);
  flag("isVisible", true);
  flag("isEnabled", true);

  if (body.overridePayload !== undefined) {
    const payload = body.overridePayload;
    if (payload === null || payload === "") set("overridePayload", null);
    else if (typeof payload === "object") set("overridePayload", payload);
    else problems.push({ field: "overridePayload", message: "overridePayload must be a JSON object" });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, values };
}

export interface CardOverride {
  id: string;
  cardKey: string;
  dashboardRole: string;
  title: string | null;
  label: string | null;
  value: string | null;
  subtitle: string | null;
  description: string | null;
  trend: string | null;
  isVisible: boolean;
  sortOrder: number;
  isEnabled: boolean;
  overridePayload: any;
  scopeType: string;
  scopeId: string | null;
}

/**
 * Get active overrides for a specific dashboard role and optional scopes
 * Returns map of cardKey -> override
 */
export async function getOverridesForDashboard(
  dashboardRole: string,
  scopes: { type: string; id: string }[] = []
): Promise<Map<string, CardOverride>> {
  const result = await readOverridesForDashboard(dashboardRole, scopes);
  return result.overrides;
}

export interface OverrideReadResult {
  overrides: Map<string, CardOverride>;
  /** False when the overrides table/type is unavailable, so callers can explain it. */
  available: boolean;
  /** True when the missing table was created on the fly by the self-healing DDL. */
  repaired: boolean;
  warning?: SchemaWarning;
}

/**
 * Read overrides without ever throwing: a missing migration 0004 (or a dead connection)
 * degrades to "no overrides, show live data" instead of a 500 dashboard.
 */
export async function readOverridesForDashboard(
  dashboardRole: string,
  scopes: { type: string; id: string }[] = []
): Promise<OverrideReadResult> {
  const status = await ensureSchemaFeature("dashboard_card_overrides");

  if (!status.available) {
    return {
      overrides: new Map(),
      available: false,
      repaired: false,
      warning: {
        area: "overrides",
        message: `Card overrides are disabled because ${status.migration} has not been applied. Dashboard values shown are live.`,
        migration: status.migration,
      },
    };
  }

  try {
    // Build conditions for relevant overrides
    // Always include global scope and role-specific scope
    const conditions = [
      eq(dashboardCardOverrides.isEnabled, true),
      or(
        eq(dashboardCardOverrides.dashboardRole, dashboardRole as any),
        eq(dashboardCardOverrides.dashboardRole, "global" as any)
      ),
    ];

    const allOverrides = await db
      .select()
      .from(dashboardCardOverrides)
      .where(and(...conditions))
      .orderBy(desc(dashboardCardOverrides.updatedAt));

    const map = selectOverrides(allOverrides, dashboardRole, scopes);

    return {
      overrides: map,
      available: true,
      repaired: status.repaired,
      ...(status.repaired
        ? {
            warning: {
              area: "overrides" as const,
              message: `The dashboard_card_overrides table was missing, so it was created automatically from ${status.migration}. Please apply that migration properly at your next deploy.`,
              migration: status.migration,
              repaired: true,
            } as SchemaWarning,
          }
        : {}),
    };
  } catch (err) {
    if (!isSchemaOutOfDate(err)) {
      console.error("Failed to fetch overrides:", inspectDbError(err).text);
    }
    return {
      overrides: new Map(),
      available: false,
      repaired: false,
      warning:
        toSchemaWarning("overrides", err, "Card overrides") ??
        ({
          area: "overrides",
          message: "Saved card overrides could not be loaded, so the dashboard is showing live values only.",
        } as SchemaWarning),
    };
  }
}

/** Narrow the raw override rows down to one winner per cardKey. */
function selectOverrides(
  allOverrides: (typeof dashboardCardOverrides.$inferSelect)[],
  _dashboardRole: string,
  scopes: { type: string; id: string }[]
): Map<string, CardOverride> {
  const map = new Map<string, CardOverride>();

  for (const override of allOverrides) {
    // Check scope matching
    // Global scope always applies
    // Role scope applies if matches
    // Specific scopes (class, learner, etc) only if provided in scopes list
    const scopeType = override.scopeType as string;
    const scopeId = override.scopeId;

    let matches = false;

    if (scopeType === "global") {
      matches = true;
    } else if (scopeType === "role") {
      // scopeId could be role name or null means all of this dashboard role
      matches = true; // role-level overrides for this dashboard already filtered
    } else {
      // Check if any provided scope matches
      matches = scopes.some(s => s.type === scopeType && s.id === scopeId);
      // Also if override has no scopeId but scopeType matches, treat as broader
      if (!matches && scopeId === null) {
        matches = scopes.some(s => s.type === scopeType);
      }
    }

    if (matches) {
      // Only set if not already set (first wins = most recent due to order)
      // But prefer more specific scopes over global
      const existing = map.get(override.cardKey);
      if (!existing) {
        map.set(override.cardKey, override as CardOverride);
      } else {
        // Prefer specific scope over global
        const existingIsGlobal = existing.scopeType === "global";
        const newIsSpecific = scopeType !== "global";
        if (existingIsGlobal && newIsSpecific) {
          map.set(override.cardKey, override as CardOverride);
        }
      }
    }
  }

  return map;
}


/**
 * Apply overrides to live data
 * liveData: { cardKey: { value, ... } }
 * Returns merged data with isOverridden flag
 */
export function applyOverrides<T extends Record<string, any>>(
  liveData: T,
  overrides: Map<string, CardOverride>
): Record<string, any> {
  const result: Record<string, any> = {};
  if (!overrides || overrides.size === 0) {
    for (const [key, raw] of Object.entries(liveData || {})) {
      result[key] = { ...(raw ?? {}), isOverridden: false, isVisible: (raw as any)?.isVisible ?? true };
    }
    return result;
  }

  for (const [key, rawLive] of Object.entries(liveData)) {
    // Defensive: a degraded metric can resolve to undefined/null at runtime.
    const live: Record<string, any> = rawLive && typeof rawLive === "object" ? rawLive : { value: rawLive };
    const override = overrides.get(key);
    if (override && override.isEnabled && override.isVisible) {
      result[key] = {
        ...live,
        // Override fields if present
        title: override.title || live.title || live.label,
        label: override.label || override.title || live.label || live.title,
        value: override.value !== null && override.value !== undefined ? override.value : live.value,
        subtitle: override.subtitle || live.subtitle,
        description: override.description || live.description,
        trend: override.trend || live.trend,
        isVisible: override.isVisible,
        sortOrder: override.sortOrder ?? live.sortOrder ?? 0,
        isOverridden: true,
        overrideId: override.id,
        liveValue: live.value, // Keep live for transparency
        payload: override.overridePayload || live.payload,
      };
    } else {
      result[key] = {
        ...live,
        isOverridden: false,
        isVisible: override ? override.isVisible : (live.isVisible ?? true),
        sortOrder: live.sortOrder ?? 0,
      };
    }
  }

  // Also include overrides that don't have live data (admin-created custom cards)
  for (const [key, override] of overrides.entries()) {
    if (!result[key] && override.isEnabled && override.isVisible) {
      result[key] = {
        title: override.title || override.label || key,
        label: override.label || override.title || key,
        value: override.value,
        subtitle: override.subtitle,
        description: override.description,
        trend: override.trend,
        isVisible: override.isVisible,
        sortOrder: override.sortOrder,
        isOverridden: true,
        isCustom: true,
        overrideId: override.id,
        payload: override.overridePayload,
      };
    }
  }

  return result;
}
