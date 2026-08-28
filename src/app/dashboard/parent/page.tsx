"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import Link from "next/link";

const parentNav = [
  { name: "Dashboard", href: "/dashboard/parent", icon: "🏠" },
  { name: "My Children", href: "/dashboard/parent/children", icon: "👧" },
  { name: "Timetable", href: "/dashboard/parent/timetable", icon: "📅" },
  { name: "Grades", href: "/dashboard/parent/grades", icon: "📊" },
  { name: "Attendance", href: "/dashboard/parent/attendance", icon: "✅" },
  { name: "Assignments", href: "/dashboard/parent/assignments", icon: "📝" },
  { name: "Announcements", href: "/dashboard/parent/announcements", icon: "📢" },
  { name: "Messages", href: "/dashboard/parent/messages", icon: "💬" },
  { name: "Reports", href: "/dashboard/parent/reports", icon: "📈" },
  { name: "Fees", href: "/dashboard/parent/fees", icon: "💳" },
];

export default function ParentDashboard() {
  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Parent Dashboard</h1>
        <p className="text-sm text-slate-500">Monitor your child&apos;s academic progress and stay connected</p>
      </div>

      {/* Child Selector */}
      <div className="mb-6 p-5 rounded-2xl bg-white shadow-sm border border-slate-100">
        <p className="text-sm font-medium text-slate-500 mb-3">Currently viewing:</p>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center text-white text-2xl font-bold shadow-md">
            AA
          </div>
          <div>
            <p className="font-bold text-lg text-slate-800">Ama Asante</p>
            <p className="text-sm text-slate-500">Primary 1 • Academic Year 2024/2025</p>
          </div>
          <Link href="/dashboard/parent/children" className="ml-auto px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-medium hover:bg-slate-200 transition-colors">
            Switch Child
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard icon="📊" label="Average Grade" value="82%" change="+5%" color="bg-blue-100" />
        <StatCard icon="✅" label="Attendance" value="95%" color="bg-green-100" />
        <StatCard icon="📝" label="Pending Work" value={3} color="bg-orange-100" />
        <StatCard icon="🏆" label="Class Rank" value="#5" change="+2" color="bg-purple-100" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Performance Summary */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>📈</span> Subject Performance
          </h2>
          <div className="space-y-4">
            {[
              { subject: "Mathematics", score: 88, prev: 82, grade: "A" },
              { subject: "English Language", score: 75, prev: 78, grade: "B" },
              { subject: "Integrated Science", score: 92, prev: 85, grade: "A+" },
              { subject: "Social Studies", score: 70, prev: 72, grade: "B" },
              { subject: "French", score: 65, prev: 60, grade: "C+" },
              { subject: "ICT", score: 90, prev: 88, grade: "A" },
            ].map((s) => (
              <div key={s.subject} className="flex items-center gap-4">
                <div className="w-24 text-sm font-medium text-slate-700 shrink-0">{s.subject}</div>
                <div className="flex-1">
                  <div className="w-full h-4 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${s.score >= 80 ? "bg-green-500" : s.score >= 60 ? "bg-yellow-500" : "bg-red-500"}`}
                      style={{ width: `${s.score}%` }}
                    />
                  </div>
                </div>
                <div className="w-12 text-right">
                  <span className="font-bold text-sm text-slate-800">{s.score}%</span>
                </div>
                <span className={`text-xs font-semibold ${s.score > s.prev ? "text-green-600" : "text-red-500"}`}>
                  {s.score > s.prev ? "↑" : "↓"}{Math.abs(s.score - s.prev)}%
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-100 text-xs font-bold text-slate-600">{s.grade}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Upcoming */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>📋</span> Homework Due
            </h2>
            <div className="space-y-2">
              {[
                { title: "Math Chapter 5", due: "Tomorrow", status: "pending" },
                { title: "English Essay", due: "Wed, Oct 18", status: "pending" },
                { title: "Science Report", due: "Fri, Oct 20", status: "submitted" },
              ].map((h, i) => (
                <div key={i} className="p-3 rounded-xl bg-slate-50 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-700">{h.title}</p>
                    <p className="text-xs text-slate-400">Due: {h.due}</p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-semibold ${
                    h.status === "submitted" ? "bg-green-100 text-green-600" : "bg-orange-100 text-orange-600"
                  }`}>
                    {h.status === "submitted" ? "✓ Done" : "Pending"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Announcements */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>📢</span> Announcements
            </h2>
            <div className="space-y-3">
              {[
                { title: "Parent-Teacher Conference", date: "Oct 15", icon: "🤝" },
                { title: "Mid-term Exams Schedule", date: "Oct 10", icon: "📋" },
              ].map((a, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="text-lg">{a.icon}</span>
                  <div>
                    <p className="text-sm font-medium text-slate-700">{a.title}</p>
                    <p className="text-xs text-slate-400">{a.date}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Attendance */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>✅</span> Attendance
            </h2>
            <div className="flex items-center justify-center">
              <div className="relative w-28 h-28">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" fill="none" stroke="#e2e8f0" strokeWidth="8" />
                  <circle cx="50" cy="50" r="40" fill="none" stroke="#22c55e" strokeWidth="8"
                    strokeDasharray={`${95 * 2.51} ${100 * 2.51}`} strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-2xl font-bold text-slate-800">95%</span>
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-slate-500 mt-2">38 out of 40 school days attended</p>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
