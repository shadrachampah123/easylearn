/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import TodaysSchedule from "@/components/dashboard/TodaysSchedule";
import Link from "next/link";
import { useEffect, useState } from "react";
import { parentNav } from "@/lib/parent-nav";

interface DashboardData {
  children: { id: string; firstName: string; lastName: string; className: string; relationship: string }[];
  selectedChild: { id: string; firstName: string; lastName: string; className: string; classLevel: string } | null;
  stats: Record<string, { value: any; label: string; icon: string; color: string; trend?: string; isOverridden?: boolean; liveValue?: any; isVisible?: boolean; sortOrder?: number }>;
  rawStats: { averageGrade: number; attendanceRate: number; pendingWork: number; classRank: number | null; present: number; totalAttendance: number };
  subjectPerformance: { subject: string; score: number }[];
  homeworkDue: { id: string; title: string; due: string; status: string }[];
  announcements: { id: string; title: string; createdAt: string }[];
  attendance: { rate: number; present: number; total: number };
}

export default function ParentDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [selectedChildId]);

  async function loadData(childId?: string) {
    const token = localStorage.getItem("el_token");
    if (!token) {
      setLoading(false);
      setError("Not authenticated");
      return;
    }

    const idToUse = childId || selectedChildId;
    const url = idToUse ? `/api/dashboard/parent?learnerId=${idToUse}` : "/api/dashboard/parent";

    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const result = await res.json();
      if (result.success) {
        setData(result.data);
        if (!selectedChildId && result.data.selectedChild) {
          setSelectedChildId(result.data.selectedChild.id);
        }
      } else {
        setError(result.error || "Failed to load dashboard");
      }
    } catch (err) {
      console.error(err);
      setError("Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }

  function handleChildSwitch(childId: string) {
    setSelectedChildId(childId);
    setLoading(true);
    loadData(childId);
  }

  if (loading) {
    return (
      <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
        <div className="animate-pulse space-y-6">
          <div className="h-24 bg-slate-200 rounded-2xl" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-slate-200 rounded-2xl" />
            ))}
          </div>
        </div>
      </DashboardShell>
    );
  }

  if (error) {
    return (
      <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
        <div className="p-8 text-center bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-4xl mb-3">⚠️</div>
          <p className="text-slate-600">{error}</p>
          <button onClick={() => window.location.reload()} className="mt-4 px-5 py-2 rounded-xl bg-purple-600 text-white font-semibold">
            Retry
          </button>
        </div>
      </DashboardShell>
    );
  }

  if (!data || data.children.length === 0) {
    return (
      <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-800">Parent Dashboard</h1>
          <p className="text-sm text-slate-500">Monitor your child&apos;s academic progress</p>
        </div>
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">👧</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No children linked to your account</h3>
          <p className="text-slate-500 text-sm">Contact the school administrator to link your children</p>
        </div>
      </DashboardShell>
    );
  }

  const statsArray = data.stats
    ? Object.entries(data.stats).filter(([_, v]) => v.isVisible !== false).sort((a, b) => (a[1].sortOrder || 0) - (b[1].sortOrder || 0))
    : [];

  const child = data.selectedChild;

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Parent Dashboard</h1>
        <p className="text-sm text-slate-500">Monitor your child&apos;s academic progress and stay connected</p>
      </div>

      {/* Child Selector - LIVE */}
      <div className="mb-6 p-5 rounded-2xl bg-white shadow-sm border border-slate-100">
        <p className="text-sm font-medium text-slate-500 mb-3">Currently viewing:</p>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center text-white text-2xl font-bold shadow-md">
            {child ? `${child.firstName?.[0] || ""}${child.lastName?.[0] || ""}` : "?"}
          </div>
          <div className="flex-1 min-w-[200px]">
            <p className="font-bold text-lg text-slate-800">{child ? `${child.firstName} ${child.lastName}` : "Select child"}</p>
            <p className="text-sm text-slate-500">{child?.className || "No class"} • {child?.classLevel ? child.classLevel.replace("_", " ") : ""}</p>
          </div>
          {data.children.length > 1 ? (
            <select
              value={selectedChildId || ""}
              onChange={(e) => handleChildSwitch(e.target.value)}
              className="ml-auto px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-medium outline-none"
            >
              {data.children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName} {c.className ? `(${c.className})` : ""}
                </option>
              ))}
            </select>
          ) : (
            <Link href="/dashboard/parent/children" className="ml-auto px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-medium hover:bg-slate-200 transition-colors">
              View Children
            </Link>
          )}
        </div>
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
            <StatCard icon="📊" label="Average Grade" value={`${data.rawStats.averageGrade}%`} color="bg-blue-100" />
            <StatCard icon="✅" label="Attendance" value={`${data.rawStats.attendanceRate}%`} color="bg-green-100" />
            <StatCard icon="📝" label="Pending Work" value={data.rawStats.pendingWork} color="bg-orange-100" />
            <StatCard icon="🏆" label="Class Rank" value={data.rawStats.classRank ? `#${data.rawStats.classRank}` : "—"} color="bg-purple-100" />
          </>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Performance Summary - LIVE */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>📈</span> Subject Performance
          </h2>
          {!data.subjectPerformance || data.subjectPerformance.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📈</div>
              <p className="text-slate-500 text-sm">No graded assignments yet</p>
              <p className="text-slate-400 text-xs mt-1">Subject performance will appear after grading</p>
            </div>
          ) : (
            <div className="space-y-4">
              {data.subjectPerformance.map((s) => (
                <div key={s.subject} className="flex items-center gap-4">
                  <div className="w-24 text-sm font-medium text-slate-700 shrink-0 truncate">{s.subject || "General"}</div>
                  <div className="flex-1">
                    <div className="w-full h-4 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${s.score >= 80 ? "bg-green-500" : s.score >= 60 ? "bg-yellow-500" : "bg-red-500"}`} style={{ width: `${s.score}%` }} />
                    </div>
                  </div>
                  <div className="w-12 text-right">
                    <span className="font-bold text-sm text-slate-800">{s.score}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <TodaysSchedule title="Today's Classes" showClass emptyMessage="Your child has no classes scheduled for today." viewAllHref="/dashboard/parent/timetable" />

          {/* Homework Due - LIVE */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
                <span>📋</span> Homework Due
              </h2>
              <Link href="/dashboard/parent/assignments" className="text-xs text-purple-600 hover:underline">
                View all
              </Link>
            </div>
            {!data.homeworkDue || data.homeworkDue.length === 0 ? (
              <div className="text-center py-6">
                <div className="text-2xl mb-2">📚</div>
                <p className="text-slate-500 text-sm">No homework assigned</p>
              </div>
            ) : (
              <div className="space-y-2">
                {data.homeworkDue.slice(0, 3).map((h) => (
                  <div key={h.id} className="p-3 rounded-xl bg-slate-50 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-700 truncate">{h.title}</p>
                      <p className="text-xs text-slate-400">Due: {h.due ? new Date(h.due).toLocaleDateString() : "No due date"}</p>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full font-semibold ${h.status === "graded" || h.status === "submitted" ? "bg-green-100 text-green-600" : "bg-orange-100 text-orange-600"}`}>
                      {h.status === "graded" || h.status === "submitted" ? "✓ Done" : "Pending"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Announcements - LIVE */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>📢</span> Announcements
            </h2>
            {!data.announcements || data.announcements.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-slate-500 text-sm">No announcements</p>
              </div>
            ) : (
              <div className="space-y-3">
                {data.announcements.map((a) => (
                  <div key={a.id} className="flex items-start gap-3">
                    <span className="text-lg">📢</span>
                    <div>
                      <p className="text-sm font-medium text-slate-700">{a.title}</p>
                      <p className="text-xs text-slate-400">{new Date(a.createdAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Attendance - LIVE */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>✅</span> Attendance
            </h2>
            <div className="flex items-center justify-center">
              <div className="relative w-28 h-28">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" fill="none" stroke="#e2e8f0" strokeWidth="8" />
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="#22c55e"
                    strokeWidth="8"
                    strokeDasharray={`${(data.attendance.rate || 0) * 2.51} ${100 * 2.51}`}
                    strokeLinecap="round"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-2xl font-bold text-slate-800">{data.attendance.rate}%</span>
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-slate-500 mt-2">
              {data.attendance.present} out of {data.attendance.total} school days attended
            </p>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
