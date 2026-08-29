/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import Link from "next/link";
import { useEffect, useState } from "react";
import { adminNav } from "@/lib/admin-nav";

interface ActivityItem {
  id: string;
  action: string;
  entityType: string | null;
  description: string | null;
  actor: string;
  actorRole: string | null;
  timestamp: string;
}

interface StatEntry {
  value?: any;
  label?: string;
  title?: string;
  icon?: string;
  color?: string;
  trend?: string;
  subtitle?: string;
  description?: string;
  isOverridden?: boolean;
  isCustom?: boolean;
  overrideId?: string;
  liveValue?: any;
  isVisible?: boolean;
  sortOrder?: number;
}

interface SchemaWarning {
  area: string;
  message: string;
  migration?: string;
  repaired?: boolean;
}

interface DashboardData {
  stats?: Record<string, StatEntry>;
  rawStats?: {
    teachers?: number;
    learners?: number;
    parents?: number;
    classes?: number;
    subjects?: number;
    assignments?: number;
    resources?: number;
    announcements?: number;
  };
  attendanceOverview?: { level: string | null; pct: number; total: number; present: number }[];
  topClasses?: { classId: string; className: string; avg: number; submissions: number }[];
  recentActivity?: ActivityItem[];
  /** Present when the API had to degrade (e.g. migrations not applied yet). */
  meta?: {
    degraded?: boolean;
    overridesAvailable?: boolean;
    overridesRepaired?: boolean;
    warnings?: SchemaWarning[];
  };
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  if (!dateStr || Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function getActionIcon(action: string, entityType: string | null): string {
  if (entityType === "user") {
    if (action === "create") return "👤";
    return "👥";
  }
  if (entityType === "class") return "🏫";
  if (entityType === "assignment") return "📝";
  if (entityType === "attendance") return "✅";
  if (entityType === "announcement") return "📢";
  if (entityType === "resource") return "📚";
  if (entityType === "subject") return "📖";
  if (entityType === "timetable") return "📅";
  if (entityType === "dashboard_card_override") return "🎛️";
  if (entityType === "parent_learner") return "🔗";
  return "📋";
}

/** Overridden values are stored as text; keep anything odd readable instead of crashing. */
function displayValue(value: unknown): string | number {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value : "—";
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return "—";
}

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    if (!token) {
      setLoading(false);
      setError("Not authenticated");
      return;
    }

    fetch("/api/dashboard/admin", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        const result = await r.json().catch(() => null);
        if (!r.ok && !result?.data) {
          throw new Error(result?.error || `Dashboard unavailable (${r.status})`);
        }
        return result;
      })
      .then((result) => {
        if (result?.success) {
          setData(result.data || {});
        } else {
          setError(result?.error || "Failed to load dashboard");
        }
      })
      .catch((err) => {
        console.error(err);
        setError(err instanceof Error ? err.message : "Failed to load dashboard data");
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
        <div className="animate-pulse space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-24 bg-slate-200 rounded-2xl" />
            ))}
          </div>
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 h-64 bg-slate-200 rounded-2xl" />
            <div className="h-64 bg-slate-200 rounded-2xl" />
          </div>
        </div>
      </DashboardShell>
    );
  }

  if (error) {
    return (
      <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
        <div className="p-8 text-center bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-4xl mb-3">⚠️</div>
          <p className="text-slate-600">{error}</p>
          <p className="text-xs text-slate-400 mt-2">
            If the database was just provisioned, the pending migrations in <code>drizzle/</code> still need to be applied.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-5 py-2 rounded-xl bg-primary-500 text-white font-semibold"
          >
            Retry
          </button>
        </div>
      </DashboardShell>
    );
  }

  const stats = data?.stats && typeof data.stats === "object" ? data.stats : {};
  const statsArray = Object.entries(stats)
    .filter(([, value]) => value && value.isVisible !== false)
    .sort((a, b) => Number(a[1]?.sortOrder || 0) - Number(b[1]?.sortOrder || 0));
  const warnings =
    data?.meta?.degraded && !warningsDismissed ? (data.meta.warnings || []) : [];
  const attendanceOverview = Array.isArray(data?.attendanceOverview) ? data!.attendanceOverview : [];
  const topClasses = Array.isArray(data?.topClasses) ? data!.topClasses : [];
  const recentActivity = Array.isArray(data?.recentActivity) ? data!.recentActivity : [];

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Admin Dashboard</h1>
        <p className="text-sm text-slate-500">Overview of your school&apos;s performance and management</p>
      </div>

      {/* Degraded-mode notice: a missing migration disables sections, it must never blank the page */}
      {warnings.length > 0 && (
        <div className="mb-6 p-4 rounded-2xl bg-amber-50 border border-amber-200">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-amber-800">
                ⚠️ Some dashboard sections are unavailable on this database
              </p>
              <ul className="mt-2 space-y-1">
                {warnings.map((warning) => (
                  <li key={warning.area} className="text-xs text-amber-700">
                    • {warning.message}
                  </li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={() => setWarningsDismissed(true)}
              className="shrink-0 text-xs font-semibold text-amber-700 hover:text-amber-900"
            >
              Hide
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/dashboard/admin/overrides"
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors"
            >
              Card overrides
            </Link>
            <Link
              href="/dashboard/admin/settings"
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors"
            >
              Activity &amp; settings
            </Link>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-white text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors"
            >
              Reload after migrating
            </button>
          </div>
        </div>
      )}

      {/* Stats Grid - live data with override support */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {statsArray.length > 0 ? (
          statsArray.map(([key, stat]) => (
            <div key={key} className="relative">
              <StatCard
                icon={stat?.icon || "📊"}
                label={stat?.label || stat?.title || key}
                value={displayValue(stat?.value)}
                change={typeof stat?.trend === "string" ? stat.trend : undefined}
                color={stat?.color || "bg-slate-100"}
              />
              {stat?.isOverridden && (
                <Link
                  href="/dashboard/admin/overrides"
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-amber-400 text-white text-[10px] flex items-center justify-center font-bold"
                  title={`Overridden (live: ${displayValue(stat.liveValue)})`}
                >
                  !
                </Link>
              )}
            </div>
          ))
        ) : (
          <>
            <StatCard icon="👩‍🏫" label="Total Teachers" value={data?.rawStats?.teachers ?? "—"} color="bg-blue-100" />
            <StatCard icon="🎓" label="Total Learners" value={data?.rawStats?.learners ?? "—"} color="bg-green-100" />
            <StatCard icon="👨‍👩‍👧" label="Total Parents" value={data?.rawStats?.parents ?? "—"} color="bg-purple-100" />
            <StatCard icon="🏫" label="Classes" value={data?.rawStats?.classes ?? "—"} color="bg-orange-100" />
            <StatCard icon="📚" label="Subjects" value={data?.rawStats?.subjects ?? "—"} color="bg-pink-100" />
            <StatCard icon="📝" label="Assignments" value={data?.rawStats?.assignments ?? "—"} color="bg-yellow-100" />
          </>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent Activity - LIVE */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
              <span>📋</span> Recent Activity
            </h2>
            <Link href="/dashboard/admin/settings" className="text-xs text-primary-600 hover:underline">
              View all
            </Link>
          </div>

          {recentActivity.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-slate-500 text-sm">No recent activity yet</p>
              <p className="text-slate-400 text-xs mt-1">Activities will appear here as admins manage records</p>
            </div>
          ) : (
            <div className="space-y-3">
              {recentActivity.map((item) => (
                <div key={item.id} className="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-lg shrink-0">
                    {getActionIcon(item.action, item.entityType ?? null)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-700 truncate">
                      {item.description || `${item.action} record`}
                    </p>
                    <p className="text-xs text-slate-400">
                      by {item.actor || "System"}
                      {item.actorRole ? ` (${item.actorRole})` : ""}
                      {item.entityType ? ` • ${item.entityType}` : ""}
                    </p>
                  </div>
                  <span className="text-xs text-slate-400 whitespace-nowrap">{formatTimeAgo(item.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>⚡</span> Quick Actions
          </h2>
          <div className="space-y-2">
            {[
              { label: "Add New Teacher", icon: "👩‍🏫", href: "/dashboard/admin/teachers", color: "bg-blue-50 text-blue-600 hover:bg-blue-100" },
              { label: "Add New Learner", icon: "🎓", href: "/dashboard/admin/learners", color: "bg-green-50 text-green-600 hover:bg-green-100" },
              { label: "Link Parents to Learners", icon: "🔗", href: "/dashboard/admin/parents", color: "bg-teal-50 text-teal-600 hover:bg-teal-100" },
              { label: "Create Class", icon: "🏫", href: "/dashboard/admin/classes", color: "bg-orange-50 text-orange-600 hover:bg-orange-100" },
              { label: "Post Announcement", icon: "📢", href: "/dashboard/admin/announcements", color: "bg-purple-50 text-purple-600 hover:bg-purple-100" },
              { label: "Card Overrides", icon: "🎛️", href: "/dashboard/admin/settings?tab=overrides", color: "bg-amber-50 text-amber-600 hover:bg-amber-100" },
            ].map((action, i) => (
              <Link key={i} href={action.href} className={`w-full flex items-center gap-3 p-3 rounded-xl text-sm font-medium transition-all ${action.color}`}>
                <span className="text-lg">{action.icon}</span>
                {action.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 grid lg:grid-cols-2 gap-6">
        {/* Attendance Overview - LIVE */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>📈</span> Attendance Overview
          </h2>
          {attendanceOverview.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">📊</div>
              <p className="text-slate-500 text-sm">No attendance records yet</p>
              <p className="text-slate-400 text-xs mt-1">Teachers need to mark attendance</p>
            </div>
          ) : (
            <div className="space-y-3">
              {attendanceOverview.map((item) => {
                const colorMap: Record<string, string> = {
                  nursery: "bg-pink-500",
                  kindergarten: "bg-yellow-500",
                  primary: "bg-blue-500",
                  junior_high: "bg-green-500",
                };
                const levelKey = (item.level || "").replace(/[^a-z_]/gi, "");
                return (
                  <div key={levelKey || "unassigned"}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600 font-medium capitalize">
                        {item.level ? item.level.replace("_", " ") : "Not assigned"}
                      </span>
                      <span className="text-slate-800 font-bold">{item.pct}% ({item.present}/{item.total})</span>
                    </div>
                    <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full rounded-full ${colorMap[levelKey] || "bg-slate-500"} transition-all`} style={{ width: `${Math.min(Math.max(Number(item.pct) || 0, 0), 100)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top Performing Classes - LIVE */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>🏆</span> Top Performing Classes
          </h2>
          {topClasses.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">🏆</div>
              <p className="text-slate-500 text-sm">No graded submissions yet</p>
              <p className="text-slate-400 text-xs mt-1">Class performance will appear after grading</p>
            </div>
          ) : (
            <div className="space-y-3">
              {topClasses.map((item, idx) => {
                const emojis = ["🥇", "🥈", "🥉", "4", "5"];
                return (
                  <div key={item.classId} className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                    <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-sm font-bold">
                      {emojis[idx] || `${idx + 1}`}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-sm text-slate-700">{item.className}</p>
                      <p className="text-xs text-slate-400">{item.submissions} submissions</p>
                    </div>
                    <span className="text-sm font-bold text-primary-600">{item.avg}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
