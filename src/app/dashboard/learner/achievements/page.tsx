"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";

interface Achievement {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  earnedAt?: string;
}

interface LearnerStats {
  points: {
    total: number;
    level: number;
    pointsToNextLevel: number;
    levelProgress: number;
  };
  achievements: {
    earned: Achievement[];
    all: Achievement[];
    new: string[];
  };
  stats: {
    assignments: { completed: number; total: number };
    quizzes: { completed: number; averageScore: number };
    attendance: { rate: number; present: number; total: number };
  };
  recentPoints: { id: string; points: number; reason: string; createdAt: string }[];
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
  { name: "Achievements", href: "/dashboard/learner/achievements", icon: "🏆" },
];

const levelTitles = [
  "Beginner", "Explorer", "Rising Star", "Scholar", "Champion",
  "Master", "Expert", "Legend", "Elite", "Ultimate Learner"
];

export default function LearnerAchievementsPage() {
  const [data, setData] = useState<LearnerStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/learner/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await res.json();
      if (result.success) setData(result.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="animate-pulse space-y-6">
          <div className="h-40 bg-slate-200 rounded-3xl" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      </DashboardShell>
    );
  }

  if (!data) return null;

  const earnedIds = new Set(data.achievements.earned.map((a) => a.id));
  const levelTitle = levelTitles[Math.min(data.points.level - 1, levelTitles.length - 1)];

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Achievements</h1>
        <p className="text-sm text-slate-500">Track your progress and earn badges!</p>
      </div>

      {/* New Achievement Alert */}
      {data.achievements.new.length > 0 && (
        <div className="mb-6 p-4 rounded-2xl bg-gradient-to-r from-yellow-100 to-amber-100 border border-yellow-200 animate-pulse">
          <p className="text-yellow-800 font-semibold flex items-center gap-2">
            🎉 New Achievement Unlocked: {data.achievements.new.join(", ")}!
          </p>
        </div>
      )}

      {/* Level Progress Card */}
      <div className="bg-gradient-to-br from-accent-500 via-coral to-lavender rounded-3xl p-6 md:p-8 text-white mb-6 relative overflow-hidden">
        <div className="absolute top-4 right-4 text-8xl opacity-10">🏆</div>
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center text-3xl border border-white/30">
              {data.points.level}
            </div>
            <div>
              <p className="text-white/80 text-sm">Current Level</p>
              <p className="text-2xl font-bold">Level {data.points.level} - {levelTitle}</p>
            </div>
          </div>

          <div className="mb-2 flex justify-between text-sm">
            <span>{data.points.levelProgress} / 100 XP</span>
            <span>Level {data.points.level + 1}</span>
          </div>
          <div className="w-full h-4 rounded-full bg-white/20 overflow-hidden mb-4">
            <div
              className="h-full rounded-full bg-white transition-all"
              style={{ width: `${data.points.levelProgress}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="p-3 rounded-xl bg-white/10 backdrop-blur-sm text-center">
              <p className="text-2xl font-bold">{data.points.total}</p>
              <p className="text-xs text-white/70">Total XP</p>
            </div>
            <div className="p-3 rounded-xl bg-white/10 backdrop-blur-sm text-center">
              <p className="text-2xl font-bold">{data.achievements.earned.length}</p>
              <p className="text-xs text-white/70">Badges</p>
            </div>
            <div className="p-3 rounded-xl bg-white/10 backdrop-blur-sm text-center">
              <p className="text-2xl font-bold">{data.points.pointsToNextLevel}</p>
              <p className="text-xs text-white/70">XP to Next</p>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-2xl p-5 border border-slate-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center text-xl">📝</div>
            <div>
              <p className="text-sm text-slate-500">Assignments</p>
              <p className="font-bold text-slate-800">{data.stats.assignments.completed} completed</p>
            </div>
          </div>
          <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full bg-blue-500" style={{ width: "100%" }} />
          </div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center text-xl">❓</div>
            <div>
              <p className="text-sm text-slate-500">Quizzes</p>
              <p className="font-bold text-slate-800">{data.stats.quizzes.completed} completed</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">Avg Score: {data.stats.quizzes.averageScore}%</p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center text-xl">✅</div>
            <div>
              <p className="text-sm text-slate-500">Attendance</p>
              <p className="font-bold text-slate-800">{data.stats.attendance.rate}%</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">{data.stats.attendance.present}/{data.stats.attendance.total} days</p>
        </div>
      </div>

      {/* Achievements Grid */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
          <span>🏆</span> Badges
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {data.achievements.all.map((achievement) => {
            const isEarned = earnedIds.has(achievement.id);
            return (
              <div
                key={achievement.id}
                className={`p-4 rounded-2xl text-center transition-all ${
                  isEarned
                    ? "bg-gradient-to-br from-yellow-50 to-amber-50 border-2 border-yellow-200"
                    : "bg-slate-50 border-2 border-slate-100 opacity-50 grayscale"
                }`}
              >
                <div className="text-4xl mb-2">{achievement.icon || "🏅"}</div>
                <p className="font-semibold text-sm text-slate-800 mb-1">{achievement.name}</p>
                <p className="text-xs text-slate-500">{achievement.description}</p>
                {isEarned && (
                  <p className="text-xs text-green-600 mt-2 font-semibold">✓ Earned</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Points */}
      {data.recentPoints.length > 0 && (
        <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>⭐</span> Recent XP
          </h2>
          <div className="space-y-3">
            {data.recentPoints.map((point) => (
              <div key={point.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                <div>
                  <p className="text-sm font-medium text-slate-700">{point.reason}</p>
                  <p className="text-xs text-slate-400">
                    {new Date(point.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span className="px-3 py-1 rounded-full bg-green-100 text-green-600 font-bold text-sm">
                  +{point.points} XP
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
