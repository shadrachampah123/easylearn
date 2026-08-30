"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import LearnerProgressPanel from "@/components/dashboard/LearnerProgressPanel";
import { teacherNav } from "@/lib/teacher-nav";

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
}

export default function TeacherReportsPage() {
  const [data, setData] = useState<Reports | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/reports", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((result) => { if (result.success) setData(result.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
        <div className="animate-pulse space-y-4">
          <div className="h-32 bg-slate-200 rounded-2xl" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Reports & Analytics</h1>
        <p className="text-sm text-slate-500">Your teaching performance metrics</p>
      </div>

      {data && (
        <>
          <div className="grid md:grid-cols-4 gap-4 mb-8">
            <div className="bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl p-6 text-white">
              <p className="text-blue-100 text-sm mb-1">Assignments</p>
              <p className="text-3xl font-bold">{data.overview.totalAssignments}</p>
            </div>
            <div className="bg-gradient-to-br from-green-500 to-green-700 rounded-2xl p-6 text-white">
              <p className="text-green-100 text-sm mb-1">Submission Rate</p>
              <p className="text-3xl font-bold">{data.overview.submissionRate}%</p>
            </div>
            <div className="bg-gradient-to-br from-purple-500 to-purple-700 rounded-2xl p-6 text-white">
              <p className="text-purple-100 text-sm mb-1">Quiz Avg</p>
              <p className="text-3xl font-bold">{data.quizzes.averageScore}%</p>
            </div>
            <div className="bg-gradient-to-br from-orange-500 to-orange-700 rounded-2xl p-6 text-white">
              <p className="text-orange-100 text-sm mb-1">Attendance</p>
              <p className="text-3xl font-bold">{data.attendance.rate}%</p>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4">Performance Metrics</h2>
            <div className="space-y-4">
              {[
                { label: "Assignment Submission", value: data.overview.submissionRate, color: "bg-green-500" },
                { label: "Grading Progress", value: data.overview.publishedAssignments > 0 ? Math.round((data.overview.gradedSubmissions / data.overview.totalSubmissions) * 100) : 0, color: "bg-blue-500" },
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
        </>
      )}

      <LearnerProgressPanel />
    </DashboardShell>
  );
}
