"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { teacherNav } from "@/lib/teacher-nav";

interface GradeRow {
  id: string;
  type: string;
  title: string;
  score: number | null;
  maxScore: number;
  gradedAt: string | null;
  subjectName: string | null;
  className: string | null;
  learnerFirstName?: string;
  learnerLastName?: string;
}

interface GradesData {
  grades: GradeRow[];
  overall: { average: number; totalGrades: number };
}

export default function TeacherGradesPage() {
  const [data, setData] = useState<GradesData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    if (token) {
      fetch("/api/grades", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((result) => { if (result.success) setData(result.data); })
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, []);

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Grades</h1>
        <p className="text-sm text-slate-500">Overview of student grades</p>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-24 bg-slate-200 rounded-2xl" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      ) : !data || data.grades.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📊</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No grades recorded</h3>
          <p className="text-slate-500 text-sm">Grades will appear here once you grade submissions</p>
        </div>
      ) : (
        <>
          <div className="grid md:grid-cols-3 gap-4 mb-6">
            <div className="bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl p-6 text-white">
              <p className="text-blue-100 text-sm mb-1">Overall Average</p>
              <p className="text-3xl font-bold">{data.overall.average}%</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-slate-100">
              <p className="text-slate-500 text-sm mb-1">Total Grades</p>
              <p className="text-3xl font-bold text-slate-800">{data.overall.totalGrades}</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-slate-100">
              <p className="text-slate-500 text-sm mb-1">Assignments</p>
              <p className="text-3xl font-bold text-slate-800">{data.grades.filter((g) => g.type === "assignment").length}</p>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
            <div className="p-4 border-b border-slate-100">
              <h2 className="font-bold text-lg text-slate-800">All Grades</h2>
            </div>
            <div className="divide-y divide-slate-100">
              {data.grades.map((grade) => (
                <div key={grade.id} className="p-4 flex items-center gap-4 hover:bg-slate-50">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white ${
                    grade.type === "quiz" ? "bg-purple-500" : "bg-blue-500"
                  }`}>
                    {grade.type === "quiz" ? "❓" : "📝"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-700 truncate">{grade.title}</p>
                    <p className="text-xs text-slate-400">{grade.subjectName}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-lg text-slate-800">{grade.score}/{grade.maxScore}</p>
                    <p className="text-xs text-slate-400">{grade.className}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </DashboardShell>
  );
}
