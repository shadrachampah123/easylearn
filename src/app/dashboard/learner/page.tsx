/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import TodaysSchedule from "@/components/dashboard/TodaysSchedule";
import { useEffect, useState } from "react";
import { learnerNav } from "@/lib/learner-nav";
import Link from "next/link";

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
    numericValue?: number;
  }>;
  rawStats: {
    pending: number;
    completed: number;
    averageScore: number;
    classRank: number | null;
    totalPoints: number;
    level: number;
    levelProgress: number;
    className: string | null;
  };
  upcomingDeadlines: { id: string; title: string; subject: string; due: string; urgency: string }[];
  recentGrades: { id: string; title: string; subject: string; score: number; maxScore: number; percentage: number; gradedAt: string }[];
  badges: { id: string; name: string; icon: string }[];
  points: { total: number; level: number; levelProgress: number; pointsToNext: number };
}

const levelTitles = ["Beginner", "Explorer", "Rising Star", "Scholar", "Champion", "Master", "Expert", "Legend", "Elite", "Ultimate Learner"];

function getGradeLetter(pct: number) {
  if (pct >= 90) return "A+";
  if (pct >= 80) return "A";
  if (pct >= 70) return "B";
  if (pct >= 60) return "C";
  if (pct >= 50) return "D";
  return "F";
}

export default function LearnerDashboard() {
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

    fetch("/api/dashboard/learner", {
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
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="animate-pulse space-y-6">
          <div className="h-40 bg-slate-200 rounded-3xl" />
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
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="p-8 text-center bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-4xl mb-3">⚠️</div>
          <p className="text-slate-600">{error}</p>
          <button onClick={() => window.location.reload()} className="mt-4 px-5 py-2 rounded-xl bg-accent-500 text-white font-semibold">
            Retry
          </button>
        </div>
      </DashboardShell>
    );
  }

  const levelTitle = data?.points ? levelTitles[Math.min(data.points.level - 1, levelTitles.length - 1)] : "Beginner";
  const statsArray = data?.stats
    ? Object.entries(data.stats).filter(([_, v]) => v.isVisible !== false).sort((a, b) => (a[1].sortOrder || 0) - (b[1].sortOrder || 0))
    : [];

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Dashboard</h1>
        <p className="text-sm text-slate-500">Track your learning progress and stay on top of your work!</p>
        {data?.rawStats.className && <p className="text-xs text-slate-400 mt-1">Class: {data.rawStats.className}</p>}
      </div>

      {/* Gamification Banner - LIVE */}
      <div className="mb-6 p-6 rounded-2xl bg-gradient-to-r from-accent-500 via-coral to-lavender text-white relative overflow-hidden">
        <div className="absolute right-4 top-4 text-6xl opacity-20 animate-float">🌟</div>
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-3">
            <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center text-3xl">🎓</div>
            <div>
              <p className="font-bold text-lg">Level {data?.points.level || 1} - {levelTitle}!</p>
              <p className="text-white/80 text-sm">{data?.points.total || 0} XP • {data?.points.pointsToNext || 100} XP to next level</p>
            </div>
          </div>
          <div className="w-full h-3 rounded-full bg-white/20 overflow-hidden">
            <div className="h-full rounded-full bg-white/80 transition-all" style={{ width: `${data?.points.levelProgress || 0}%` }} />
          </div>
          <div className="mt-3 flex gap-3 flex-wrap">
            <span className="px-3 py-1 rounded-full bg-white/20 text-xs">📊 {data?.rawStats.averageScore || 0}% Avg</span>
            <span className="px-3 py-1 rounded-full bg-white/20 text-xs">⭐ {data?.points.total || 0} Points</span>
            <span className="px-3 py-1 rounded-full bg-white/20 text-xs">🏆 {data?.badges.length || 0} Badges</span>
            {data?.rawStats.classRank && <span className="px-3 py-1 rounded-full bg-white/20 text-xs">🏅 Rank #{data.rawStats.classRank}</span>}
          </div>
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
            <StatCard icon="📝" label="Pending Assignments" value={data?.rawStats.pending ?? "—"} color="bg-orange-100" />
            <StatCard icon="✅" label="Completed" value={data?.rawStats.completed ?? "—"} color="bg-green-100" />
            <StatCard icon="📊" label="Average Score" value={`${data?.rawStats.averageScore ?? 0}%`} color="bg-blue-100" />
            <StatCard icon="🏆" label="Class Rank" value={data?.rawStats.classRank ? `#${data.rawStats.classRank}` : "—"} color="bg-yellow-100" />
          </>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Upcoming Deadlines - LIVE */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
              <span>⏰</span> Upcoming Deadlines
            </h2>
            <Link href="/dashboard/learner/assignments" className="text-xs text-accent-600 hover:underline">
              View all
            </Link>
          </div>
          {!data?.upcomingDeadlines || data.upcomingDeadlines.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📅</div>
              <p className="text-slate-500 text-sm">No upcoming deadlines in the next 7 days</p>
              <p className="text-slate-400 text-xs mt-1">You&apos;re all caught up!</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.upcomingDeadlines.map((item: any) => (
                <Link key={item.id} href={item.type === "quiz" ? `/dashboard/learner/quizzes/${item.id}` : `/dashboard/learner/assignments/${item.id}`} className="flex items-center gap-4 p-4 rounded-xl hover:bg-slate-50 transition-colors border border-slate-100">
                  <div className={`w-3 h-3 rounded-full ${item.urgency === "urgent" ? "bg-red-500 animate-pulse" : item.type === "quiz" ? "bg-purple-500" : "bg-yellow-500"}`} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-700 truncate">{item.title}</p>
                    <p className="text-xs text-slate-400">{item.subject} {item.type === "quiz" ? "• ❓ Quiz" : ""}</p>
                  </div>
                  <span className={`text-xs font-semibold px-3 py-1 rounded-full ${item.urgency === "urgent" ? "bg-red-100 text-red-600" : item.type === "quiz" ? "bg-purple-100 text-purple-600" : "bg-slate-100 text-slate-500"}`}>
                    {item.type === "quiz" ? "Available Now 🚀" : (item.due ? new Date(item.due).toLocaleDateString() : "No due date")}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>🏆</span> My Badges
            </h2>
            {!data?.badges || data.badges.length === 0 ? (
              <div className="text-center py-6">
                <div className="text-3xl mb-2">🏅</div>
                <p className="text-slate-500 text-xs">No badges earned yet</p>
                <p className="text-slate-400 text-[10px]">Complete tasks to earn badges</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {data.badges.map((b) => (
                  <div key={b.id} className="p-3 rounded-xl text-center bg-yellow-50 border border-yellow-200">
                    <div className="text-2xl mb-1">{b.icon || "🏅"}</div>
                    <p className="text-[10px] font-medium text-slate-600">{b.name}</p>
                  </div>
                ))}
              </div>
            )}
            <Link href="/dashboard/learner/achievements" className="mt-3 block text-center text-xs text-accent-600 hover:underline">
              View all achievements →
            </Link>
          </div>

          <TodaysSchedule title="Today's Classes" emptyMessage="You have no classes scheduled for today." viewAllHref="/dashboard/learner/timetable" />
        </div>
      </div>

      {/* Recent Grades - LIVE */}
      <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
            <span>📊</span> Recent Grades
          </h2>
          <Link href="/dashboard/learner/grades" className="text-xs text-accent-600 hover:underline">
            View all
          </Link>
        </div>
        {!data?.recentGrades || data.recentGrades.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">📊</div>
            <p className="text-slate-500 text-sm">No graded assignments yet</p>
            <p className="text-slate-400 text-xs mt-1">Complete and submit work to see grades</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {data.recentGrades.map((g) => {
              const colorMap: Record<string, string> = {
                Mathematics: "from-blue-400 to-blue-600",
                English: "from-green-400 to-green-600",
                Science: "from-purple-400 to-purple-600",
                default: "from-slate-400 to-slate-600",
              };
              const color = colorMap[g.subject] || colorMap.default;
              return (
                <div key={g.id} className={`p-4 rounded-2xl bg-gradient-to-br ${color} text-white shadow-md`}>
                  <p className="text-sm font-medium text-white/80 truncate">{g.subject || "General"}</p>
                  <p className="text-xs text-white/60 truncate">{g.title}</p>
                  <div className="flex items-end gap-2 mt-1">
                    <p className="text-3xl font-bold">{g.score}</p>
                    <p className="text-sm text-white/60 mb-1">/ {g.maxScore}</p>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-white/20 text-xs font-bold">{getGradeLetter(g.percentage)} {g.percentage}%</span>
                    <div className="flex-1 h-2 rounded-full bg-white/20">
                      <div className="h-full rounded-full bg-white/60" style={{ width: `${g.percentage}%` }} />
                    </div>
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
