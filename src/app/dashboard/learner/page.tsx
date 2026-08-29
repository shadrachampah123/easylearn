"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import StatCard from "@/components/dashboard/StatCard";
import TodaysSchedule from "@/components/dashboard/TodaysSchedule";

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
  { name: "Timetable", href: "/dashboard/learner/timetable", icon: "📅" },
  { name: "Achievements", href: "/dashboard/learner/achievements", icon: "🏆" },
  { name: "Announcements", href: "/dashboard/learner/announcements", icon: "📢" },
  { name: "Bookmarks", href: "/dashboard/learner/bookmarks", icon: "🔖" },
  { name: "Messages", href: "/dashboard/learner/messages", icon: "💬" },
];

export default function LearnerDashboard() {
  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Dashboard</h1>
        <p className="text-sm text-slate-500">Track your learning progress and stay on top of your work!</p>
      </div>

      {/* Gamification Banner */}
      <div className="mb-6 p-6 rounded-2xl bg-gradient-to-r from-accent-500 via-coral to-lavender text-white relative overflow-hidden">
        <div className="absolute right-4 top-4 text-6xl opacity-20 animate-float">🌟</div>
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-3">
            <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center text-3xl">🎓</div>
            <div>
              <p className="font-bold text-lg">Level 5 - Rising Star!</p>
              <p className="text-white/80 text-sm">350 / 500 XP to next level</p>
            </div>
          </div>
          <div className="w-full h-3 rounded-full bg-white/20 overflow-hidden">
            <div className="h-full rounded-full bg-white/80 transition-all" style={{ width: "70%" }} />
          </div>
          <div className="mt-3 flex gap-3">
            <span className="px-3 py-1 rounded-full bg-white/20 text-xs">🔥 5 Day Streak</span>
            <span className="px-3 py-1 rounded-full bg-white/20 text-xs">⭐ 350 Points</span>
            <span className="px-3 py-1 rounded-full bg-white/20 text-xs">🏆 3 Badges</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard icon="📝" label="Pending Assignments" value={4} color="bg-orange-100" />
        <StatCard icon="✅" label="Completed" value={18} change="+3" color="bg-green-100" />
        <StatCard icon="📊" label="Average Score" value="82%" color="bg-blue-100" />
        <StatCard icon="🏆" label="Class Rank" value="#5" color="bg-yellow-100" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Upcoming Deadlines */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>⏰</span> Upcoming Deadlines
          </h2>
          <div className="space-y-3">
            {[
              { title: "Math Homework - Chapter 5", subject: "Mathematics", due: "Tomorrow, 8:00 AM", urgency: "urgent" },
              { title: "English Essay Writing", subject: "English Language", due: "Wed, Oct 18", urgency: "normal" },
              { title: "Science Quiz - Forces", subject: "Integrated Science", due: "Fri, Oct 20", urgency: "normal" },
              { title: "French Vocabulary Test", subject: "French", due: "Mon, Oct 23", urgency: "low" },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-4 p-4 rounded-xl hover:bg-slate-50 transition-colors border border-slate-100">
                <div className={`w-3 h-3 rounded-full ${
                  item.urgency === "urgent" ? "bg-red-500 animate-pulse" : item.urgency === "normal" ? "bg-yellow-500" : "bg-green-500"
                }`} />
                <div className="flex-1">
                  <p className="font-medium text-sm text-slate-700">{item.title}</p>
                  <p className="text-xs text-slate-400">{item.subject}</p>
                </div>
                <span className={`text-xs font-semibold px-3 py-1 rounded-full ${
                  item.urgency === "urgent" ? "bg-red-100 text-red-600" : "bg-slate-100 text-slate-500"
                }`}>
                  {item.due}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Achievements */}
        <div className="space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>🏆</span> My Badges
            </h2>
            <div className="grid grid-cols-3 gap-2">
              {[
                { icon: "🌟", name: "First Login", earned: true },
                { icon: "📝", name: "Ace", earned: true },
                { icon: "🏆", name: "Quiz Master", earned: true },
                { icon: "📚", name: "Bookworm", earned: false },
                { icon: "⭐", name: "Perfect", earned: false },
                { icon: "🔥", name: "Streak", earned: false },
              ].map((b, i) => (
                <div key={i} className={`p-3 rounded-xl text-center ${b.earned ? "bg-yellow-50 border border-yellow-200" : "bg-slate-50 opacity-50"}`}>
                  <div className="text-2xl mb-1">{b.icon}</div>
                  <p className="text-[10px] font-medium text-slate-600">{b.name}</p>
                </div>
              ))}
            </div>
          </div>

          <TodaysSchedule
            title="Today's Classes"
            emptyMessage="You have no classes scheduled for today."
            viewAllHref="/dashboard/learner/timetable"
          />
        </div>
      </div>

      {/* Recent Grades */}
      <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
          <span>📊</span> Recent Grades
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { subject: "Mathematics", score: 88, max: 100, grade: "A", color: "from-blue-400 to-blue-600" },
            { subject: "English", score: 75, max: 100, grade: "B", color: "from-green-400 to-green-600" },
            { subject: "Science", score: 92, max: 100, grade: "A+", color: "from-purple-400 to-purple-600" },
            { subject: "Social Studies", score: 70, max: 100, grade: "B", color: "from-orange-400 to-orange-600" },
          ].map((g, i) => (
            <div key={i} className={`p-4 rounded-2xl bg-gradient-to-br ${g.color} text-white shadow-md`}>
              <p className="text-sm font-medium text-white/80">{g.subject}</p>
              <div className="flex items-end gap-2 mt-1">
                <p className="text-3xl font-bold">{g.score}</p>
                <p className="text-sm text-white/60 mb-1">/ {g.max}</p>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-white/20 text-xs font-bold">{g.grade}</span>
                <div className="flex-1 h-2 rounded-full bg-white/20">
                  <div className="h-full rounded-full bg-white/60" style={{ width: `${g.score}%` }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardShell>
  );
}
