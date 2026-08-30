"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import LearnerProgressPanel from "@/components/dashboard/LearnerProgressPanel";
import { adminNav } from "@/lib/admin-nav";

interface Reports {
  overview: {
    totalAssignments: number;
    publishedAssignments: number;
    totalSubmissions: number;
    gradedSubmissions: number;
    submissionRate: number;
  };
  quizzes: { totalAttempts: number; averageScore: number };
  attendance: { rate: number; total: number; present: number };
  learners: { total: number; classDistribution: { className: string; classLevel: string; learnerCount: number }[] };
}

export default function AdminReportsPage() {
  const [data, setData] = useState<Reports | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/reports", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.json())
      .then((result) => { if (result.success) setData(result.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/reports", { headers: { Authorization: `Bearer ${token}` } });
      const result = await res.json();
      if (result.success) setData(result.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function exportCSV() {
    if (!data) return;
    const headers = ["Metric", "Value"];
    const rows = [
      ["Total Assignments", data.overview.totalAssignments],
      ["Published Assignments", data.overview.publishedAssignments],
      ["Total Submissions", data.overview.totalSubmissions],
      ["Graded Submissions", data.overview.gradedSubmissions],
      ["Submission Rate (%)", data.overview.submissionRate],
      ["Quiz Attempts", data.quizzes.totalAttempts],
      ["Average Quiz Score (%)", data.quizzes.averageScore],
      ["Attendance Rate (%)", data.attendance.rate],
      ["Total Learners", data.learners.total],
    ];
    let csv = headers.join(",") + "\n";
    rows.forEach((r) => { csv += r.join(",") + "\n"; });
    csv += "\nClass Distribution\n";
    data.learners.classDistribution.forEach((c) => {
      csv += `${c.className},${c.learnerCount}\n`;
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "CBISM-Report.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
        <div className="animate-pulse space-y-4">
          <div className="h-32 bg-slate-200 rounded-2xl" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Reports & Analytics</h1>
          <p className="text-sm text-slate-500">School-wide performance and analytics</p>
        </div>
        <button onClick={exportCSV} className="px-5 py-2.5 rounded-xl bg-green-600 text-white font-semibold shadow-lg hover:shadow-xl transition-all">
          📥 Export CSV
        </button>
      </div>

      {data && (
        <>
          {/* Overview Stats */}
          <div className="grid md:grid-cols-4 gap-4 mb-8">
            <div className="bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl p-6 text-white">
              <p className="text-blue-100 text-sm mb-1">Assignments</p>
              <p className="text-3xl font-bold">{data.overview.totalAssignments}</p>
              <p className="text-blue-200 text-xs mt-1">{data.overview.publishedAssignments} published</p>
            </div>
            <div className="bg-gradient-to-br from-green-500 to-green-700 rounded-2xl p-6 text-white">
              <p className="text-green-100 text-sm mb-1">Submission Rate</p>
              <p className="text-3xl font-bold">{data.overview.submissionRate}%</p>
              <p className="text-green-200 text-xs mt-1">{data.overview.gradedSubmissions} graded</p>
            </div>
            <div className="bg-gradient-to-br from-purple-500 to-purple-700 rounded-2xl p-6 text-white">
              <p className="text-purple-100 text-sm mb-1">Quiz Avg Score</p>
              <p className="text-3xl font-bold">{data.quizzes.averageScore}%</p>
              <p className="text-purple-200 text-xs mt-1">{data.quizzes.totalAttempts} attempts</p>
            </div>
            <div className="bg-gradient-to-br from-orange-500 to-orange-700 rounded-2xl p-6 text-white">
              <p className="text-orange-100 text-sm mb-1">Attendance</p>
              <p className="text-3xl font-bold">{data.attendance.rate}%</p>
              <p className="text-orange-200 text-xs mt-1">{data.attendance.present}/{data.attendance.total}</p>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Class Distribution */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                <span>🏫</span> Learner Distribution by Class
              </h2>
              <div className="space-y-4">
                {data.learners.classDistribution.map((cls) => {
                  const pct = data.learners.total > 0 ? Math.round((cls.learnerCount / data.learners.total) * 100) : 0;
                  return (
                    <div key={cls.className}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-slate-600 font-medium">{cls.className}</span>
                        <span className="text-slate-800 font-bold">{cls.learnerCount} learners</span>
                      </div>
                      <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-primary-400 to-primary-600" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Performance Metrics */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                <span>📊</span> Performance Metrics
              </h2>
              <div className="space-y-3">
                {[
                  { label: "Assignment Completion", value: data.overview.submissionRate, color: "bg-green-500" },
                  { label: "Assignments Graded", value: data.overview.publishedAssignments > 0 ? Math.round((data.overview.gradedSubmissions / data.overview.totalSubmissions) * 100) : 0, color: "bg-blue-500" },
                  { label: "Quiz Average Score", value: data.quizzes.averageScore, color: "bg-purple-500" },
                  { label: "Attendance Rate", value: data.attendance.rate, color: "bg-orange-500" },
                ].map((m) => (
                  <div key={m.label}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600 font-medium">{m.label}</span>
                      <span className="text-slate-800 font-bold">{m.value}%</span>
                    </div>
                    <div className="w-full h-4 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full rounded-full ${m.color}`} style={{ width: `${m.value}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <LearnerProgressPanel />
    </DashboardShell>
  );
}
