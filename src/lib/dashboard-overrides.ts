import { db } from "@/db";
import { dashboardCardOverrides } from "@/db/schema";
import { eq, and, or, desc } from "drizzle-orm";

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
  } catch (err) {
    console.error("Failed to fetch overrides:", err);
    return new Map();
  }
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

  for (const [key, live] of Object.entries(liveData)) {
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
