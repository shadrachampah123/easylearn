import { db } from "@/db";
import { activityLogs } from "@/db/schema";

interface LogParams {
  userId?: string | null;
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

    await db.insert(activityLogs).values({
      userId: params.userId || null,
      action: params.action,
      entityType: params.entityType || null,
      entityId: params.entityId || null,
      description: params.description?.substring(0, 1000) || null,
      details: safeDetails?.substring(0, 2000) || null,
      ipAddress: params.ipAddress?.substring(0, 50) || null,
    });
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
