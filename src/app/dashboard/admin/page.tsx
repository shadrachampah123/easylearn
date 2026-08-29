/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import Link from "next/link";
import { useEffect, useState } from "react";
import { adminNav } from "@/lib/admin-nav";

interface DashboardData {
  stats: Record<string, {
    value: any;
    label: string;
    icon: string;
    color: string;
    trend?: string;
    isOverridden?: boolean;
    liveValue?: any;
    isVisible?: boolean;
    sortOrder?: number;
  }>;
  rawStats: {
    teachers: number;
    learners: number;
    parents: number;
    classes: number;
    subjects: number;
    assignments: number;
    resources: number;
    announcements: number;
  };
  attendanceOverview: { level: string; pct: number; total: number; present: number }[];
  topClasses: { classId: string; className: string; avg: number; submissions: number }[];
  recentActivity: {
    id: string;
    action: string;
    entityType: string;
    description: string;
    actor: string;
    actorRole: string;
    timestamp: string;
  }[];
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
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

function getActionIcon(action: string, entityType: string): string {
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
  return "📋";
}

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      .then((r) => r.json())
      .then((result) => {
        if (result.success) {
          setData(result.data);
        } else {
          setError(result.error || "Failed to load dashboard");
        }
      })
      .catch((err) => {
        console.error(err);
        setError("Failed to load dashboard data");
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

  const statsArray = data?.stats ? Object.entries(data.stats).filter(([_, v]) => v.isVisible !== false).sort((a, b) => (a[1].sortOrder || 0) - (b[1].sortOrder || 0)) : [];

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Admin Dashboard</h1>
        <p className="text-sm text-slate-500">Overview of your school&apos;s performance and management</p>
      </div>

      {/* Stats Grid - live data with override support */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {statsArray.length > 0 ? (
          statsArray.map(([key, stat]) => (
            <div key={key} className="relative">
              <StatCard
                icon={stat.icon}
                label={stat.label}
                value={stat.value}
                change={stat.trend}
                color={stat.color}
              />
              {stat.isOverridden && (
                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-amber-400 text-white text-[10px] flex items-center justify-center font-bold" title={`Overridden (live: ${stat.liveValue})`}>
                  !
                </span>
              )}
            </div>
          ))
        ) : (
          <>
            <StatCard icon="👩‍🏫" label="Total Teachers" value={data?.rawStats.teachers ?? "—"} color="bg-blue-100" />
            <StatCard icon="🎓" label="Total Learners" value={data?.rawStats.learners ?? "—"} color="bg-green-100" />
            <StatCard icon="👨‍👩‍👧" label="Total Parents" value={data?.rawStats.parents ?? "—"} color="bg-purple-100" />
            <StatCard icon="🏫" label="Classes" value={data?.rawStats.classes ?? "—"} color="bg-orange-100" />
            <StatCard icon="📚" label="Subjects" value={data?.rawStats.subjects ?? "—"} color="bg-pink-100" />
            <StatCard icon="📝" label="Assignments" value={data?.rawStats.assignments ?? "—"} color="bg-yellow-100" />
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

          {!data?.recentActivity || data.recentActivity.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-slate-500 text-sm">No recent activity yet</p>
              <p className="text-slate-400 text-xs mt-1">Activities will appear here as admins manage records</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.recentActivity.map((item) => (
                <div key={item.id} className="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-lg shrink-0">
                    {getActionIcon(item.action, item.entityType)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-700 truncate">{item.description}</p>
                    <p className="text-xs text-slate-400">
                      by {item.actor} {item.actorRole ? `(${item.actorRole})` : ""} • {item.entityType}
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
              { label: "Create Class", icon: "🏫", href: "/dashboard/admin/classes", color: "bg-orange-50 text-orange-600 hover:bg-orange-100" },
              { label: "Post Announcement", icon: "📢", href: "/dashboard/admin/announcements", color: "bg-purple-50 text-purple-600 hover:bg-purple-100" },
              { label: "View Reports", icon: "📊", href: "/dashboard/admin/reports", color: "bg-pink-50 text-pink-600 hover:bg-pink-100" },
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
          {!data?.attendanceOverview || data.attendanceOverview.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">📊</div>
              <p className="text-slate-500 text-sm">No attendance records yet</p>
              <p className="text-slate-400 text-xs mt-1">Teachers need to mark attendance</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.attendanceOverview.map((item) => {
                const colorMap: Record<string, string> = {
                  nursery: "bg-pink-500",
                  kindergarten: "bg-yellow-500",
                  primary: "bg-blue-500",
                  junior_high: "bg-green-500",
                };
                return (
                  <div key={item.level}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600 font-medium capitalize">{item.level?.replace("_", " ")}</span>
                      <span className="text-slate-800 font-bold">{item.pct}% ({item.present}/{item.total})</span>
                    </div>
                    <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full rounded-full ${colorMap[item.level] || "bg-slate-500"} transition-all`} style={{ width: `${item.pct}%` }} />
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
          {!data?.topClasses || data.topClasses.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">🏆</div>
              <p className="text-slate-500 text-sm">No graded submissions yet</p>
              <p className="text-slate-400 text-xs mt-1">Class performance will appear after grading</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.topClasses.map((item, idx) => {
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
