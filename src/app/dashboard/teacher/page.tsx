/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import TodaysSchedule from "@/components/dashboard/TodaysSchedule";
import Link from "next/link";
import { useEffect, useState } from "react";
import { teacherNav } from "@/lib/teacher-nav";

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
    myClasses: number;
    assignments: number;
    resources: number;
    students: number;
    pendingGrading: number;
  };
  classes: { classId: string; className: string; subjectName: string }[];
  classPerformance: { classId: string; className: string; avg: number; submissions: number; topStudent: string | null }[];
  pendingTasks: { task: string; count: number; icon: string; href: string }[];
}

export default function TeacherDashboard() {
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

    fetch("/api/dashboard/teacher", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((result) => {
        if (result.success) setData(result.data);
        else setError(result.error || "Failed to load dashboard");
      })
      .catch((err) => {
        console.error(err);
        setError("Failed to load dashboard data");
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
        <div className="animate-pulse space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-slate-200 rounded-2xl" />
            ))}
          </div>
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      </DashboardShell>
    );
  }

  if (error) {
    return (
      <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
        <div className="p-8 text-center bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-4xl mb-3">⚠️</div>
          <p className="text-slate-600">{error}</p>
          <button onClick={() => window.location.reload()} className="mt-4 px-5 py-2 rounded-xl bg-secondary-500 text-white font-semibold">
            Retry
          </button>
        </div>
      </DashboardShell>
    );
  }

  const statsArray = data?.stats
    ? Object.entries(data.stats).filter(([_, v]) => v.isVisible !== false).sort((a, b) => (a[1].sortOrder || 0) - (b[1].sortOrder || 0))
    : [];

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Teacher Dashboard</h1>
        <p className="text-sm text-slate-500">Manage your classes, assignments, and learner progress</p>
      </div>

      {/* Stats - LIVE */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {statsArray.length > 0 ? (
          statsArray.map(([key, stat]) => (
            <div key={key} className="relative">
              <StatCard icon={stat.icon} label={stat.label} value={stat.value} change={stat.trend} color={stat.color} />
              {stat.isOverridden && (
                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-amber-400 text-white text-[10px] flex items-center justify-center font-bold" title={`Overridden (live: ${stat.liveValue})`}>
                  !
                </span>
              )}
            </div>
          ))
        ) : (
          <>
            <StatCard icon="🏫" label="My Classes" value={data?.rawStats.myClasses ?? "—"} color="bg-blue-100" />
            <StatCard icon="📝" label="Assignments" value={data?.rawStats.assignments ?? "—"} color="bg-green-100" />
            <StatCard icon="📚" label="Resources" value={data?.rawStats.resources ?? "—"} color="bg-orange-100" />
            <StatCard icon="🎓" label="Students" value={data?.rawStats.students ?? "—"} color="bg-purple-100" />
          </>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <TodaysSchedule
          className="lg:col-span-2"
          showClass
          showTeacher={false}
          emptyMessage="No periods are scheduled for you today."
          viewAllHref="/dashboard/teacher/timetable"
        />

        <div className="space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>⚡</span> Quick Actions
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Create Assignment", icon: "📝", href: "/dashboard/teacher/assignments", color: "bg-blue-50 text-blue-600" },
                { label: "Upload Resource", icon: "📤", href: "/dashboard/teacher/resources", color: "bg-green-50 text-green-600" },
                { label: "Take Attendance", icon: "✅", href: "/dashboard/teacher/attendance", color: "bg-orange-50 text-orange-600" },
                { label: "Create Quiz", icon: "❓", href: "/dashboard/teacher/quizzes", color: "bg-purple-50 text-purple-600" },
              ].map((a, i) => (
                <Link key={i} href={a.href} className={`p-3 rounded-xl text-center transition-all hover:shadow-md ${a.color}`}>
                  <div className="text-2xl mb-1">{a.icon}</div>
                  <p className="text-xs font-medium">{a.label}</p>
                </Link>
              ))}
            </div>
          </div>

          {/* Pending Tasks - LIVE */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>⏳</span> Pending
            </h2>
            {!data?.pendingTasks || data.pendingTasks.length === 0 ? (
              <div className="text-center py-6">
                <div className="text-2xl mb-2">✅</div>
                <p className="text-slate-500 text-sm">All caught up!</p>
                <p className="text-slate-400 text-xs">No pending tasks</p>
              </div>
            ) : (
              <div className="space-y-2">
                {data.pendingTasks.map((t, i) => (
                  <Link key={i} href={t.href} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 transition-colors">
                    <span className="text-sm text-slate-600 flex items-center gap-2">
                      <span>{t.icon}</span>
                      {t.task}
                    </span>
                    <span className="w-6 h-6 rounded-full bg-red-100 text-red-600 text-xs font-bold flex items-center justify-center">
                      {t.count}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Class Performance - LIVE */}
      <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
          <span>📈</span> Class Performance
        </h2>
        {!data?.classPerformance || data.classPerformance.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">📈</div>
            <p className="text-slate-500 text-sm">No class performance data yet</p>
            <p className="text-slate-400 text-xs mt-1">Performance will appear after assignments are graded</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-3 gap-4">
            {data.classPerformance.map((c, i) => {
              const colors = ["from-blue-400 to-blue-600", "from-green-400 to-green-600", "from-orange-400 to-orange-600"];
              return (
                <div key={c.classId} className={`p-5 rounded-2xl bg-gradient-to-br ${colors[i % colors.length]} text-white shadow-md`}>
                  <h3 className="font-bold text-lg mb-3">{c.className}</h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-white/70 text-xs">Avg Score</p>
                      <p className="font-bold text-lg">{c.avg}%</p>
                    </div>
                    <div>
                      <p className="text-white/70 text-xs">Submissions</p>
                      <p className="font-bold text-lg">{c.submissions}</p>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-white/20 text-xs">
                    <span className="text-white/70">Top Student:</span> {c.topStudent || "—"} {c.topStudent ? "⭐" : ""}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
