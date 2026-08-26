"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

interface GradeRow {
  id: string;
  type: string;
  title: string;
  score: number | null;
  maxScore: number;
  subjectName: string | null;
  gradedAt: string | null;
}

interface GradesData {
  grades: GradeRow[];
  subjectAverages: { subject: string; average: number }[];
  overall: { average: number; totalGrades: number };
}

export default function ParentGradesPage() {
  const [data, setData] = useState<GradesData | null>(null);
  const [currentParentId, setCurrentParentId] = useState<string | null>(null);
  const [childId, setChildId] = useState<string | null>(null);
  const [children, setChildren] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setCurrentParentId(data.data.user.id);
          loadChildren(data.data.user.id);
        }
      });
  }, []);

  async function loadChildren(parentId: string) {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/parent-learners?parentId=${parentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        const learnerIds = data.data.map((c: { learnerId: string }) => c.learnerId);
        const userRes = await fetch("/api/users?role=learner&limit=100", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const userData = await userRes.json();
        if (userData.success) {
          const kids = userData.data.users.filter((l: { id: string }) => learnerIds.includes(l.id));
          setChildren(kids);
          if (kids.length > 0) loadGrades(kids[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function loadGrades(learnerId: string) {
    setChildId(learnerId);
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch(`/api/grades?learnerId=${learnerId}`, {
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

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Child&apos;s Grades</h1>
        <p className="text-sm text-slate-500">Monitor your child&apos;s academic performance</p>
      </div>

      {children.length > 0 && (
        <div className="mb-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">Select Child</label>
          <select
            value={childId || ""}
            onChange={(e) => loadGrades(e.target.value)}
            className="w-full max-w-sm px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm"
          >
            {children.map((c) => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
            ))}
          </select>
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
          <h3 className="text-lg font-semibold text-slate-700">No children linked to your account</h3>
          <p className="text-slate-500 text-sm mt-1">Contact the school to link your children</p>
        </div>
      ) : data && data.grades.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📊</div>
          <h3 className="text-lg font-semibold text-slate-700">No grades recorded yet</h3>
        </div>
      ) : data ? (
        <>
          <div className="grid md:grid-cols-2 gap-4 mb-6">
            <div className="bg-gradient-to-br from-purple-500 to-purple-700 rounded-2xl p-6 text-white">
              <p className="text-purple-100 text-sm mb-1">Overall Average</p>
              <p className="text-3xl font-bold">{data.overall.average}%</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-slate-100">
              <p className="text-slate-500 text-sm mb-1">Total Grades</p>
              <p className="text-3xl font-bold text-slate-800">{data.overall.totalGrades}</p>
            </div>
          </div>

          {data.subjectAverages.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4">Subject Performance</h2>
              <div className="space-y-4">
                {data.subjectAverages.map((s) => (
                  <div key={s.subject}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600 font-medium">{s.subject}</span>
                      <span className="text-slate-800 font-bold">{s.average}%</span>
                    </div>
                    <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full rounded-full ${s.average >= 80 ? "bg-green-500" : s.average >= 60 ? "bg-yellow-500" : "bg-red-500"}`} style={{ width: `${s.average}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
            <div className="p-4 border-b border-slate-100">
              <h2 className="font-bold text-lg text-slate-800">All Grades</h2>
            </div>
            <div className="divide-y divide-slate-100">
              {data.grades.map((grade) => (
                <div key={grade.id} className="p-4 flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white ${grade.type === "quiz" ? "bg-purple-500" : "bg-blue-500"}`}>
                    {grade.type === "quiz" ? "❓" : "📝"}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-slate-700">{grade.title}</p>
                    <p className="text-xs text-slate-400">{grade.subjectName}</p>
                  </div>
                  <span className="font-bold text-lg text-slate-800">{grade.score}/{grade.maxScore}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </DashboardShell>
  );
}
