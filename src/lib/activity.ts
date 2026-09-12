import { db } from "@/db";
import { activityLogs } from "@/db/schema";
import { isUuid } from "@/lib/tenant";
import { isMissingColumn } from "@/lib/schema-resilience";

interface LogParams {
  userId?: string | null;
  /**
   * Phase 2E (Step 1): the caller's VERIFIED school, taken from the authenticated
   * school context (`ctx.schoolId`). School-scoped call sites must always pass it so
   * the audit row is tenant-attributed. It is persisted as-is when it is a valid
   * UUID; anything else is dropped to NULL rather than poisoning the column with
   * bad data (this module never throws).
   */
  schoolId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  description?: string;
  details?: string;
  ipAddress?: string;
}

/**
 * Safe activity logger - never throws, never exposes sensitive data
 */
export async function logActivity(params: LogParams): Promise<void> {
  try {
    // Sanitize details - remove sensitive fields
    let safeDetails = params.details;
    if (safeDetails) {
      try {
        const parsed = JSON.parse(safeDetails);
        const sanitized = sanitizeObject(parsed);
        safeDetails = JSON.stringify(sanitized);
      } catch {
        // If not JSON, keep as is but truncate
        safeDetails = safeDetails.substring(0, 2000);
      }
    }

    const baseValues = {
      userId: params.userId || null,
      action: params.action,
      entityType: params.entityType || null,
      entityId: params.entityId || null,
      description: params.description?.substring(0, 1000) || null,
      details: safeDetails?.substring(0, 2000) || null,
      ipAddress: params.ipAddress?.substring(0, 50) || null,
    };

    // Phase 2E (Step 1): tenant attribution. School-scoped call sites pass the verified
    // ctx.schoolId (always a UUID). A non-UUID value is dropped to keep the column clean.
    const schoolId = params.schoolId && isUuid(params.schoolId) ? params.schoolId : null;

    if (schoolId) {
      try {
        await db.insert(activityLogs).values({ ...baseValues, schoolId });
        return;
      } catch (error) {
        // Narrow legacy compatibility ONLY: a pre-0016 database has no
        // activity_logs.school_id column yet. In that (and only that) case retry without
        // the column so audit logging keeps working. Any other error (constraint,
        // connection, validation) is reported and NOT retried without the school — a
        // dropped audit row is preferable to an unattributed one.
        if (isMissingColumn(error)) {
          await db.insert(activityLogs).values(baseValues);
          return;
        }
        throw error;
      }
    }

    await db.insert(activityLogs).values(baseValues);
  } catch (err) {
    console.error("Failed to log activity:", err);
    // Never throw - logging should not break main flow
  }
}

function sanitizeObject(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  const sensitiveKeys = ["password", "passwordHash", "token", "secret", "jwt", "auth", "credentials"];
  const sanitized: any = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(s => lowerKey.includes(s))) {
      sanitized[key] = "[REDACTED]";
    } else if (value && typeof value === "object") {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Helper to generate human-readable descriptions
 */
export function describeAction(action: string, entityType: string, entityName?: string): string {
  const actionMap: Record<string, string> = {
    create: "created",
    update: "updated",
    delete: "deleted",
    enroll: "enrolled",
    assign: "assigned",
    grade: "graded",
    publish: "published",
    login: "logged in",
    logout: "logged out",
  };

  const verb = actionMap[action] || action;
  if (entityName) {
    return `${verb} ${entityType}: ${entityName}`;
  }
  return `${verb} ${entityType}`;
}
