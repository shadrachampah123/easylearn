"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import Link from "next/link";
import { useEffect, useState } from "react";

const adminNav = [
  { name: "Dashboard", href: "/dashboard/admin", icon: "📊" },
  { name: "Teachers", href: "/dashboard/admin/teachers", icon: "👩‍🏫" },
  { name: "Learners", href: "/dashboard/admin/learners", icon: "🎓" },
  { name: "Parents", href: "/dashboard/admin/parents", icon: "👨‍👩‍👧" },
  { name: "Classes", href: "/dashboard/admin/classes", icon: "🏫" },
  { name: "Subjects", href: "/dashboard/admin/subjects", icon: "📚" },
  { name: "Departments", href: "/dashboard/admin/departments", icon: "🏢" },
  { name: "Timetable", href: "/dashboard/admin/timetable", icon: "📅" },
  { name: "Assignments", href: "/dashboard/admin/assignments", icon: "📝" },
  { name: "Announcements", href: "/dashboard/admin/announcements", icon: "📢" },
  { name: "Attendance", href: "/dashboard/admin/attendance", icon: "✅" },
  { name: "Reports", href: "/dashboard/admin/reports", icon: "📈" },
  { name: "Settings", href: "/dashboard/admin/settings", icon: "⚙️" },
];

interface Stats {
  teachers: number;
  learners: number;
  parents: number;
  classes: number;
  subjects: number;
  assignments: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    if (token) {
      fetch("/api/dashboard/stats", {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) setStats(data.data);
        })
        .catch(console.error);
    }
  }, []);

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Admin Dashboard</h1>
        <p className="text-sm text-slate-500">Overview of your school&apos;s performance and management</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <StatCard icon="👩‍🏫" label="Total Teachers" value={stats?.teachers ?? "—"} change="+2" color="bg-blue-100" />
        <StatCard icon="🎓" label="Total Learners" value={stats?.learners ?? "—"} change="+15" color="bg-green-100" />
        <StatCard icon="👨‍👩‍👧" label="Total Parents" value={stats?.parents ?? "—"} change="+8" color="bg-purple-100" />
        <StatCard icon="🏫" label="Classes" value={stats?.classes ?? "—"} color="bg-orange-100" />
        <StatCard icon="📚" label="Subjects" value={stats?.subjects ?? "—"} color="bg-pink-100" />
        <StatCard icon="📝" label="Assignments" value={stats?.assignments ?? "—"} color="bg-yellow-100" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent Activity */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>📋</span> Recent Activity
          </h2>
          <div className="space-y-3">
            {[
              { action: "New learner enrolled", details: "Ama Asante joined Primary 1", time: "2 hours ago", icon: "🎓" },
              { action: "Assignment created", details: "Math Homework - Week 5 by Grace Mensah", time: "3 hours ago", icon: "📝" },
              { action: "Attendance marked", details: "Primary 1 - 28/30 present", time: "5 hours ago", icon: "✅" },
              { action: "New announcement", details: "Parent-Teacher Conference scheduled", time: "1 day ago", icon: "📢" },
              { action: "Resource uploaded", details: "Science Notes Chapter 3 approved", time: "1 day ago", icon: "📚" },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-lg shrink-0">
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-slate-700">{item.action}</p>
                  <p className="text-xs text-slate-400">{item.details}</p>
                </div>
                <span className="text-xs text-slate-400 whitespace-nowrap">{item.time}</span>
              </div>
            ))}
          </div>
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
              { label: "Manage Terms", icon: "📅", href: "/dashboard/admin/settings", color: "bg-cyan-50 text-cyan-600 hover:bg-cyan-100" },
            ].map((action, i) => (
              <Link key={i} href={action.href} className={`w-full flex items-center gap-3 p-3 rounded-xl text-sm font-medium transition-all ${action.color}`}>
                <span className="text-lg">{action.icon}</span>
                {action.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Performance Chart Placeholder */}
      <div className="mt-6 grid lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>📈</span> Attendance Overview
          </h2>
          <div className="space-y-3">
            {[
              { level: "Nursery", pct: 95, color: "bg-pink-500" },
              { level: "Kindergarten", pct: 92, color: "bg-yellow-500" },
              { level: "Primary", pct: 88, color: "bg-blue-500" },
              { level: "Junior High", pct: 91, color: "bg-green-500" },
            ].map((item) => (
              <div key={item.level}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-slate-600 font-medium">{item.level}</span>
                  <span className="text-slate-800 font-bold">{item.pct}%</span>
                </div>
                <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full rounded-full ${item.color} transition-all`} style={{ width: `${item.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>🏆</span> Top Performing Classes
          </h2>
          <div className="space-y-3">
            {[
              { rank: 1, cls: "Primary 1", avg: 85.2, emoji: "🥇" },
              { rank: 2, cls: "KG 2", avg: 82.7, emoji: "🥈" },
              { rank: 3, cls: "JHS 1", avg: 80.1, emoji: "🥉" },
              { rank: 4, cls: "Primary 3", avg: 78.9, emoji: "4" },
              { rank: 5, cls: "JHS 2", avg: 77.4, emoji: "5" },
            ].map((item) => (
              <div key={item.rank} className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-sm font-bold">
                  {item.emoji}
                </div>
                <div className="flex-1">
                  <p className="font-medium text-sm text-slate-700">{item.cls}</p>
                </div>
                <span className="text-sm font-bold text-primary-600">{item.avg}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Seed Banner */}
      <div className="mt-6 p-4 rounded-2xl bg-blue-50 border border-blue-200">
        <p className="text-sm text-blue-700">
          💡 <strong>Tip:</strong> If this is a fresh install, seed the database by running a POST request to <code className="bg-blue-100 px-1 rounded">/api/seed</code> to create demo data.
        </p>
      </div>
    </DashboardShell>
  );
}
