"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

export default function ParentReportsPage() {
  const [children, setChildren] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [data, setData] = useState<{ grades: unknown[]; overall: { average: number }; attendance: { rate: number } } | null>(null);
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
      const rel = await res.json();
      if (rel.success) {
        const learnerIds = rel.data.map((c: { learnerId: string }) => c.learnerId);
        const userRes = await fetch("/api/users?role=learner&limit=100", { headers: { Authorization: `Bearer ${token}` } });
        const userData = await userRes.json();
        if (userData.success) {
          const kids = userData.data.users.filter((l: { id: string }) => learnerIds.includes(l.id));
          setChildren(kids);
          if (kids.length > 0) loadReport(kids[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function loadReport(learnerId: string) {
    setChildId(learnerId);
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const [gradeRes, attRes] = await Promise.all([
        fetch(`/api/grades?learnerId=${learnerId}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/attendance?learnerId=${learnerId}`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const gradeData = await gradeRes.json();
      const attData = await attRes.json();
      if (gradeData.success) {
        const present = attData.success ? attData.data.filter((r: { isPresent: boolean }) => r.isPresent).length : 0;
        const total = attData.success ? attData.data.length : 0;
        setData({
          grades: gradeData.data.grades,
          overall: gradeData.data.overall,
          attendance: { rate: total > 0 ? Math.round((present / total) * 100) : 0 },
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function printReport() {
    window.print();
  }

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Report Cards</h1>
        <p className="text-sm text-slate-500">View and download your child&apos;s reports</p>
      </div>

      {children.length > 0 && (
        <div className="mb-6 flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-2">Select Child</label>
            <select value={childId || ""} onChange={(e) => loadReport(e.target.value)}
              className="w-full max-w-sm px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
              {children.map((c) => (
                <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
              ))}
            </select>
          </div>
          <button onClick={printReport} className="px-5 py-3 rounded-xl bg-purple-600 text-white font-semibold shadow-lg hover:shadow-xl transition-all">
            🖨️ Print Report
          </button>
        </div>
      )}

      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-24 bg-slate-200 rounded-2xl" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      ) : children.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">👧</div>
          <h3 className="text-lg font-semibold text-slate-700">No children linked</h3>
        </div>
      ) : data ? (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-6 bg-gradient-to-br from-purple-500 to-purple-700 text-white print:bg-white print:text-black">
            <h2 className="text-xl font-bold mb-1">Progress Report</h2>
            <p className="text-sm text-white/80">Term 1 • Academic Year 2024/2025</p>
          </div>
          <div className="p-6">
            <div className="grid md:grid-cols-2 gap-4 mb-6">
              <div className="p-4 rounded-xl bg-purple-50">
                <p className="text-sm text-purple-600">Overall Average</p>
                <p className="text-3xl font-bold text-purple-700">{data.overall.average}%</p>
              </div>
              <div className="p-4 rounded-xl bg-green-50">
                <p className="text-sm text-green-600">Attendance</p>
                <p className="text-3xl font-bold text-green-700">{data.attendance.rate}%</p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
              <span>💡</span> Report card download will be available in a future update.
            </div>
          </div>
        </div>
      ) : null}
    </DashboardShell>
  );
}
