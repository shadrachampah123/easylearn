"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import TodaysSchedule from "@/components/dashboard/TodaysSchedule";
import Link from "next/link";

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "My Classes", href: "/dashboard/teacher/classes", icon: "🏫" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "📚" },
  { name: "Attendance", href: "/dashboard/teacher/attendance", icon: "✅" },
  { name: "Timetable", href: "/dashboard/teacher/timetable", icon: "📅" },
  { name: "Grades", href: "/dashboard/teacher/grades", icon: "📊" },
  { name: "Announcements", href: "/dashboard/teacher/announcements", icon: "📢" },
  { name: "Messages", href: "/dashboard/teacher/messages", icon: "💬" },
  { name: "Reports", href: "/dashboard/teacher/reports", icon: "📈" },
];

export default function TeacherDashboard() {
  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Teacher Dashboard</h1>
        <p className="text-sm text-slate-500">Manage your classes, assignments, and learner progress</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard icon="🏫" label="My Classes" value={3} color="bg-blue-100" />
        <StatCard icon="📝" label="Assignments" value={12} change="+3" color="bg-green-100" />
        <StatCard icon="📚" label="Resources" value={28} change="+5" color="bg-orange-100" />
        <StatCard icon="🎓" label="Students" value={85} color="bg-purple-100" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <TodaysSchedule
          className="lg:col-span-2"
          showClass
          showTeacher={false}
          emptyMessage="No periods are scheduled for you today."
          viewAllHref="/dashboard/teacher/timetable"
        />

        {/* Quick Actions */}
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

          {/* Pending Tasks */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>⏳</span> Pending
            </h2>
            <div className="space-y-2">
              {[
                { task: "Grade Math Homework", count: 15, icon: "📊" },
                { task: "Review submissions", count: 8, icon: "📝" },
                { task: "Mark attendance", count: 1, icon: "✅" },
              ].map((t, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                  <span className="text-sm text-slate-600 flex items-center gap-2">
                    <span>{t.icon}</span>{t.task}
                  </span>
                  <span className="w-6 h-6 rounded-full bg-red-100 text-red-600 text-xs font-bold flex items-center justify-center">{t.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Class Performance */}
      <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
          <span>📈</span> Class Performance
        </h2>
        <div className="grid md:grid-cols-3 gap-4">
          {[
            { cls: "Primary 1", avg: 82, top: "Ama Asante", submissions: 28, color: "from-blue-400 to-blue-600" },
            { cls: "Primary 2", avg: 78, top: "Kofi Mensah", submissions: 25, color: "from-green-400 to-green-600" },
            { cls: "Primary 3", avg: 85, top: "Akua Boateng", submissions: 30, color: "from-orange-400 to-orange-600" },
          ].map((c, i) => (
            <div key={i} className="p-5 rounded-2xl bg-gradient-to-br text-white shadow-md" style={{ background: `linear-gradient(135deg, var(--tw-gradient-stops))` }}>
              <div className={`p-5 rounded-2xl bg-gradient-to-br ${c.color} text-white shadow-md`}>
                <h3 className="font-bold text-lg mb-3">{c.cls}</h3>
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
                  <span className="text-white/70">Top Student:</span> {c.top} ⭐
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardShell>
  );
}
