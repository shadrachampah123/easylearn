import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  users,
  classes,
  subjects,
  assignments,
  submissions,
  attendance,
  announcements,
  resources,
  activityLogs,
} from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-helpers";
import { eq, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { readOverridesForDashboard, applyOverrides } from "@/lib/dashboard-overrides";
import {
  ensureSchemaFeature,
  isMissingColumn,
  isMissingRelation,
  isSchemaOutOfDate,
  toSchemaWarning,
  type SchemaWarning,
} from "@/lib/schema-resilience";

const ADMIN_ROLES = ["super_admin", "school_admin", "head_teacher"];

const AREA_LABELS: Record<string, string> = {
  teachers: "Total teachers",
  learners: "Total learners",
  parents: "Total parents",
  classes: "Classes",
  subjects: "Subjects",
  assignments: "Assignments",
  resources: "Resources",
  announcements: "Announcements",
  attendanceOverview: "Attendance overview",
  topClasses: "Class performance",
  activityFeed: "Recent activity",
  overrides: "Card overrides",
  degradedNotice: "Optional dashboard features",
};

type RawStats = {
  teachers: number;
  learners: number;
  parents: number;
  classes: number;
  subjects: number;
  assignments: number;
  resources: number;
  announcements: number;
};

type ActivityRow = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  description: string | null;
  details: string | null;
  createdAt: Date;
  actorFirstName: string | null;
  actorLastName: string | null;
  actorRole: string | null;
};

/** Collects per-section warnings so the client can explain degraded data instead of showing a 500. */
function createWarningCollector() {
  const warnings: SchemaWarning[] = [];

  const add = (warning?: SchemaWarning | null) => {
    if (!warning) return;
    if (warnings.some((existing) => existing.area === warning.area)) return;
    warnings.push(warning);
  };

  /** Run one dashboard section; a missing table/column degrades that section only. */
  const run = async <T,>(area: string, task: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      const schemaWarning = toSchemaWarning(area, error, AREA_LABELS[area]);
      add(
        schemaWarning ?? {
          area,
          message: `${AREA_LABELS[area] ?? area} could not be loaded because the database is unavailable.`,
        }
      );
      if (!schemaWarning && !isSchemaOutOfDate(error)) {
        console.error(`Admin dashboard [${area}] error:`, error);
      }
      return fallback;
    }
  };

  return { warnings, add, run };
}

function countFrom(
  table: typeof users | typeof classes | typeof subjects | typeof assignments | typeof resources | typeof announcements,
  where?: ReturnType<typeof sql>
) {
  const query = where
    ? db.select({ count: sql<number>`count(*)` }).from(table).where(where)
    : db.select({ count: sql<number>`count(*)` }).from(table);
  return query.then((rows) => Number(rows[0]?.count ?? 0));
}

const FEATURE_MIGRATIONS = {
  dashboard_card_overrides: "drizzle/0004_dashboard_overrides.sql",
  activity_logs_enrichment: "drizzle/0005_activity_enhancements.sql",
} as const;

/**
 * Recent activity, tolerant of migration 0005 not being applied: when the enriched
 * columns are absent we fall back to the base audit trail instead of failing.
 */
async function loadRecentActivity(add: (w?: SchemaWarning | null) => void): Promise<ActivityRow[]> {
  const actorAlias = alias(users, "actor");

  const baseSelect = () =>
    db
      .select({
        id: activityLogs.id,
        action: activityLogs.action,
        details: activityLogs.details,
        createdAt: activityLogs.createdAt,
        actorFirstName: actorAlias.firstName,
        actorLastName: actorAlias.lastName,
        actorRole: actorAlias.role,
      })
      .from(activityLogs)
      .leftJoin(actorAlias, eq(activityLogs.userId, actorAlias.id))
      .orderBy(desc(activityLogs.createdAt))
      .limit(10);

  try {
    return await db
      .select({
        id: activityLogs.id,
        action: activityLogs.action,
        entityType: activityLogs.entityType,
        entityId: activityLogs.entityId,
        description: activityLogs.description,
        details: activityLogs.details,
        createdAt: activityLogs.createdAt,
        actorFirstName: actorAlias.firstName,
        actorLastName: actorAlias.lastName,
        actorRole: actorAlias.role,
      })
      .from(activityLogs)
      .leftJoin(actorAlias, eq(activityLogs.userId, actorAlias.id))
      .orderBy(desc(activityLogs.createdAt))
      .limit(10);
  } catch (error) {
    if (isMissingRelation(error)) {
      // No activity_logs table at all (fresh or legacy database): empty feed, explained.
      add(toSchemaWarning("activityFeed", error, AREA_LABELS.activityFeed));
      return [];
    }

    if (isMissingColumn(error)) {
      try {
        const rows = await baseSelect();
        add({
          area: "activityFeed",
          message: `${AREA_LABELS.activityFeed} is limited: ${FEATURE_MIGRATIONS.activity_logs_enrichment} has not been applied, so entity details are hidden.`,
          migration: FEATURE_MIGRATIONS.activity_logs_enrichment,
        });
        return rows.map((row) => ({ ...row, entityType: null, entityId: null, description: null }));
      } catch (fallbackError) {
        add(toSchemaWarning("activityFeed", fallbackError, AREA_LABELS.activityFeed));
        return [];
      }
    }

    console.error(`Admin dashboard [activityFeed] error:`, error);
    add({
      area: "activityFeed",
      message: `${AREA_LABELS.activityFeed} could not be loaded because the database is unavailable.`,
    });
    return [];
  }
}

/** Human sentence for activity rows logged before migration 0005 existed. */
function describeFallback(action: string, details: string | null): string {
  const verb = (action || "activity").replace(/[_-]/g, " ");
  let entity: string | null = null;
  if (details) {
    try {
      const parsed = JSON.parse(details);
      if (parsed && typeof parsed === "object") {
        entity = parsed.entityType || parsed.name || parsed.email || null;
      }
    } catch {
      entity = details.slice(0, 60);
    }
  }
  return entity ? `${verb} ${entity}` : verb;
}

export async function GET(request: NextRequest) {
  const collector = createWarningCollector();
  const { add, run, warnings } = collector;

  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    if (!ADMIN_ROLES.includes(payload.role)) {
      return errorResponse("Forbidden", 403);
    }

    // Self-heal the two optional dashboard migrations when DDL is allowed. If the DB role
    // cannot create objects we simply degrade, which is what this whole route is for.
    const [overrideStatus, activityStatus] = await Promise.all([
      ensureSchemaFeature("dashboard_card_overrides").catch(() => ({
        available: false,
        repaired: false,
        feature: "dashboard_card_overrides" as const,
        migration: FEATURE_MIGRATIONS.dashboard_card_overrides,
      })),
      ensureSchemaFeature("activity_logs_enrichment").catch(() => ({
        available: false,
        repaired: false,
        feature: "activity_logs_enrichment" as const,
        migration: FEATURE_MIGRATIONS.activity_logs_enrichment,
      })),
    ]);

    if (!overrideStatus.available) {
      add({
        area: "overrides",
        message: `Card overrides are disabled because ${overrideStatus.migration} has not been applied. The dashboard is showing live values.`,
        migration: overrideStatus.migration,
      });
    } else if (overrideStatus.repaired) {
      add({
        area: "overrides",
        message: `The dashboard_card_overrides table was missing and was created automatically. Please apply ${overrideStatus.migration} properly at the next deploy.`,
        migration: overrideStatus.migration,
        repaired: true,
      });
    }

    // Live metrics - each count is independent so one missing migration cannot 500 the page.
    const statQueries: Array<[keyof RawStats, () => Promise<number>]> = [
      ["teachers", () => countFrom(users, eq(users.role, "teacher"))],
      ["learners", () => countFrom(users, eq(users.role, "learner"))],
      ["parents", () => countFrom(users, eq(users.role, "parent"))],
      ["classes", () => countFrom(classes)],
      ["subjects", () => countFrom(subjects)],
      ["assignments", () => countFrom(assignments)],
      ["resources", () => countFrom(resources)],
      ["announcements", () => countFrom(announcements)],
    ];

    const statValues = await Promise.all(statQueries.map(([key, task]) => run(key, task, 0)));
    const rawStats = statQueries.reduce(
      (acc, [key], index) => ({ ...acc, [key]: statValues[index] }),
      {} as RawStats
    );

    const attendanceByLevel = await run(
      "attendanceOverview",
      async () =>
        db
          .select({
            level: classes.level,
            total: sql<number>`count(${attendance.id})`,
            present: sql<number>`count(*) FILTER (WHERE ${attendance.isPresent} = true)`,
          })
          .from(attendance)
          .leftJoin(classes, eq(attendance.classId, classes.id))
          .groupBy(classes.level),
      [] as { level: string | null; total: number; present: number }[]
    );

    const attendanceOverview = attendanceByLevel.map((row) => ({
      level: row.level,
      total: Number(row.total),
      present: Number(row.present),
      pct: Number(row.total) > 0 ? Math.round((Number(row.present) / Number(row.total)) * 100) : 0,
    }));

    const classPerformance = await run(
      "topClasses",
      async () =>
        db
          .select({
            classId: classes.id,
            className: classes.name,
            avgScore: sql<number>`COALESCE(AVG(${submissions.percentage}), 0)`,
            totalSubmissions: sql<number>`count(${submissions.id})`,
          })
          .from(classes)
          .leftJoin(assignments, eq(assignments.classId, classes.id))
          .leftJoin(submissions, eq(submissions.assignmentId, assignments.id))
          .groupBy(classes.id, classes.name)
          .orderBy(sql`COALESCE(AVG(${submissions.percentage}), 0) DESC`)
          .limit(5),
      [] as { classId: string; className: string; avgScore: number; totalSubmissions: number }[]
    );

    const topClasses = classPerformance.map((c) => ({
      classId: c.classId,
      className: c.className,
      avg: Math.round(Number(c.avgScore)),
      submissions: Number(c.totalSubmissions),
    }));

    const activityRows = await loadRecentActivity(add);

    const activityFeed = activityRows.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType ?? null,
      entityId: a.entityId ?? null,
      description: a.description || describeFallback(a.action, a.details ?? null),
      actor: a.actorFirstName ? `${a.actorFirstName} ${a.actorLastName}` : "System",
      actorRole: a.actorRole ?? null,
      timestamp: a.createdAt,
    }));

    // Live data structure for overrides
    const liveData = {
      admin_total_teachers: { value: rawStats.teachers, label: "Total Teachers", icon: "👩‍🏫", color: "bg-blue-100" },
      admin_total_learners: { value: rawStats.learners, label: "Total Learners", icon: "🎓", color: "bg-green-100" },
      admin_total_parents: { value: rawStats.parents, label: "Total Parents", icon: "👨‍👩‍👧", color: "bg-purple-100" },
      admin_total_classes: { value: rawStats.classes, label: "Classes", icon: "🏫", color: "bg-orange-100" },
      admin_total_subjects: { value: rawStats.subjects, label: "Subjects", icon: "📚", color: "bg-pink-100" },
      admin_total_assignments: { value: rawStats.assignments, label: "Assignments", icon: "📝", color: "bg-yellow-100" },
      admin_total_resources: { value: rawStats.resources, label: "Resources", icon: "📚", color: "bg-cyan-100" },
      admin_total_announcements: { value: rawStats.announcements, label: "Announcements", icon: "📢", color: "bg-indigo-100" },
    };

    // Overrides never break the dashboard: unavailable == "show live values".
    const overrideResult = await readOverridesForDashboard("admin");
    add(overrideResult.warning);
    const mergedStats = applyOverrides(liveData, overrideResult.overrides);

    return successResponse({
      stats: mergedStats,
      rawStats,
      attendanceOverview: attendanceOverview.length > 0 ? attendanceOverview : [],
      topClasses: topClasses.filter((c) => c.submissions > 0),
      recentActivity: activityFeed,
      meta: {
        degraded: warnings.length > 0,
        warnings,
        overridesAvailable: overrideResult.available,
        overridesRepaired: overrideResult.repaired,
        activityEnriched: activityStatus.available || activityStatus.repaired,
      },
    });
  } catch (error) {
    // Only auth or a completely unreachable database reaches this point: every section
    // above is isolated. Answer with an empty (degraded) dashboard rather than a 500.
    console.error("Admin dashboard error:", error);

    if (isSchemaOutOfDate(error)) {
      add(
        toSchemaWarning("degradedNotice", error, "The admin dashboard") ?? {
          area: "degradedNotice",
          message: "The EasyLearn tables are missing from this database. Run the pending migrations, then reload.",
        }
      );
    }

    return successResponse({
      stats: {},
      rawStats: {
        teachers: 0,
        learners: 0,
        parents: 0,
        classes: 0,
        subjects: 0,
        assignments: 0,
        resources: 0,
        announcements: 0,
      },
      attendanceOverview: [],
      topClasses: [],
      recentActivity: [],
      meta: {
        degraded: true,
        overridesAvailable: false,
        warnings: warnings.length > 0 ? warnings : [
          {
            area: "degradedNotice",
            message: "The database is unavailable right now, so the dashboard is showing no live values.",
          },
        ],
      },
    });
  }
}
