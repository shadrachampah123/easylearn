"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";
import { adminNav } from "@/lib/admin-nav";

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  maxScore: number;
  aiGradingEnabled: boolean | null;
  aiMaxMarks: number | null;
  className: string | null;
  subjectName: string | null;
  teacherFirstName: string | null;
  teacherLastName: string | null;
  createdAt: string;
}

export default function AdminAssignmentsPage() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  useEffect(() => { loadAssignments(); }, []);

  async function loadAssignments() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/assignments", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setAssignments(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const filtered = filter === "all" ? assignments : assignments.filter((a) => a.status === filter);

  const statusColors: Record<string, string> = {
    draft: "bg-slate-100 text-slate-600",
    published: "bg-green-100 text-green-600",
    closed: "bg-red-100 text-red-600",
  };

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">All Assignments</h1>
        <p className="text-sm text-slate-500">View assignments created by all teachers</p>
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {[
          { key: "all", label: "All", icon: "📋" },
          { key: "published", label: "Published", icon: "✅" },
          { key: "draft", label: "Drafts", icon: "📝" },
          { key: "closed", label: "Closed", icon: "🔒" },
        ].map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
              filter === f.key ? "gradient-primary text-white shadow-lg" : "bg-white text-slate-600 border border-slate-200"
            }`}>
            {f.icon} {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📝</div>
          <h3 className="text-lg font-semibold text-slate-700">No assignments found</h3>
          <p className="text-slate-500 text-sm mt-1">Assignments will appear here once teachers create them</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((a) => (
            <div key={a.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-bold text-lg text-slate-800">{a.title}</h3>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusColors[a.status]}`}>{a.status}</span>
                  </div>
                  <p className="text-slate-500 text-sm mb-3 line-clamp-2">{a.description || "No description"}</p>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                    <span>📚 {a.subjectName}</span>
                    <span>🏫 {a.className}</span>
                    <span>👩‍🏫 {a.teacherFirstName} {a.teacherLastName}</span>
                    <span>📊 Max: {a.maxScore}</span>
                    {a.aiGradingEnabled && (
                      <span className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200 font-semibold">
                        ✨ EasyAI · /{a.aiMaxMarks ?? a.maxScore}
                      </span>
                    )}
                    {a.dueDate && <span>📅 {new Date(a.dueDate).toLocaleDateString()}</span>}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
