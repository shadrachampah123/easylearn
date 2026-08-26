"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  maxScore: number;
  className: string | null;
  subjectName: string | null;
  submission: { status: string; score: number | null } | null;
}

export default function ParentAssignmentsPage() {
  const [children, setChildren] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (data.success) loadChildren(data.data.user.id); });
  }, []);

  async function loadChildren(parentId: string) {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/parent-learners?parentId=${parentId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) {
        const learnerIds = data.data.map((c: { learnerId: string }) => c.learnerId);
        const userRes = await fetch("/api/users?role=learner&limit=100", { headers: { Authorization: `Bearer ${token}` } });
        const userData = await userRes.json();
        if (userData.success) {
          const kids = userData.data.users.filter((l: { id: string }) => learnerIds.includes(l.id));
          setChildren(kids);
          if (kids.length > 0) loadAssignments(kids[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function loadAssignments(learnerId: string) {
    setChildId(learnerId);
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      // Since learners can only see their own assignments, use submissions to infer
      const res = await fetch("/api/assignments?status=published", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setAssignments(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Assignments</h1>
        <p className="text-sm text-slate-500">Track your child&apos;s homework</p>
      </div>

      {children.length > 0 && (
        <div className="mb-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-4">
          <select value={childId || ""} onChange={(e) => loadAssignments(e.target.value)}
            className="w-full max-w-sm px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
            {children.map((c) => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
          ))}
        </div>
      ) : children.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">👧</div>
          <h3 className="text-lg font-semibold text-slate-700">No children linked</h3>
        </div>
      ) : assignments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📝</div>
          <h3 className="text-lg font-semibold text-slate-700">No assignments yet</h3>
        </div>
      ) : (
        <div className="space-y-3">
          {assignments.map((a) => {
            const isDone = a.submission?.status === "graded";
            const isSubmitted = a.submission?.status === "submitted" || a.submission?.status === "late";
            return (
              <div key={a.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-lg text-slate-800">{a.title}</h3>
                  {isDone ? (
                    <span className="px-3 py-1 rounded-full bg-green-100 text-green-600 text-xs font-semibold">✓ Graded: {a.submission?.score}/{a.maxScore}</span>
                  ) : isSubmitted ? (
                    <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-600 text-xs font-semibold">Submitted</span>
                  ) : (
                    <span className="px-3 py-1 rounded-full bg-orange-100 text-orange-600 text-xs font-semibold">Pending</span>
                  )}
                </div>
                <p className="text-slate-500 text-sm mb-3">{a.description}</p>
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                  <span>📚 {a.subjectName}</span>
                  <span>🏫 {a.className}</span>
                  {a.dueDate && <span>📅 Due: {new Date(a.dueDate).toLocaleDateString()}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashboardShell>
  );
}
