"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";

interface Grade {
  id: string;
  type: string;
  title: string;
  score: number | null;
  maxScore: number;
  gradedAt: string | null;
  feedback: string | null;
  subjectName: string | null;
  className: string | null;
}

interface GradesData {
  grades: Grade[];
  subjectAverages: { subject: string; average: number; totalGrades: number }[];
  overall: { average: number; totalGrades: number; totalScore: number; totalMax: number };
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
  { name: "Achievements", href: "/dashboard/learner/achievements", icon: "🏆" },
];

export default function LearnerGradesPage() {
  const [data, setData] = useState<GradesData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadGrades();
  }, []);

  async function loadGrades() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/grades", {
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

  function getGradeLetter(percentage: number) {
    if (percentage >= 90) return { letter: "A+", color: "text-green-600" };
    if (percentage >= 80) return { letter: "A", color: "text-green-500" };
    if (percentage >= 70) return { letter: "B", color: "text-blue-500" };
    if (percentage >= 60) return { letter: "C", color: "text-yellow-500" };
    if (percentage >= 50) return { letter: "D", color: "text-orange-500" };
    return { letter: "F", color: "text-red-500" };
  }

  if (loading) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="animate-pulse space-y-4">
          <div className="h-32 bg-slate-200 rounded-2xl" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Grades</h1>
        <p className="text-sm text-slate-500">View your academic performance</p>
      </div>

      {/* Overall Stats */}
      {data && (
        <div className="grid md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gradient-to-br from-accent-500 to-accent-600 rounded-2xl p-6 text-white">
            <p className="text-accent-100 text-sm mb-1">Overall Average</p>
            <p className="text-4xl font-bold">{data.overall.average}%</p>
            <p className="text-accent-200 text-xs mt-1">{getGradeLetter(data.overall.average).letter}</p>
          </div>
          <div className="bg-white rounded-2xl p-6 border border-slate-100">
            <p className="text-slate-500 text-sm mb-1">Total Graded</p>
            <p className="text-3xl font-bold text-slate-800">{data.overall.totalGrades}</p>
            <p className="text-slate-400 text-xs mt-1">assignments & quizzes</p>
          </div>
          <div className="bg-white rounded-2xl p-6 border border-slate-100">
            <p className="text-slate-500 text-sm mb-1">Total Points</p>
            <p className="text-3xl font-bold text-slate-800">{data.overall.totalScore}</p>
            <p className="text-slate-400 text-xs mt-1">out of {data.overall.totalMax}</p>
          </div>
          <div className="bg-white rounded-2xl p-6 border border-slate-100">
            <p className="text-slate-500 text-sm mb-1">Best Subject</p>
            <p className="text-xl font-bold text-slate-800">
              {data.subjectAverages[0]?.subject || "N/A"}
            </p>
            <p className="text-green-500 text-xs mt-1">
              {data.subjectAverages[0]?.average || 0}%
            </p>
          </div>
        </div>
      )}

      {/* Subject Performance */}
      {data && data.subjectAverages.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>📚</span> Subject Performance
          </h2>
          <div className="space-y-4">
            {data.subjectAverages.map((subject) => {
              const grade = getGradeLetter(subject.average);
              return (
                <div key={subject.subject} className="flex items-center gap-4">
                  <div className="w-32 text-sm font-medium text-slate-700 truncate">
                    {subject.subject}
                  </div>
                  <div className="flex-1">
                    <div className="h-4 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          subject.average >= 80 ? "bg-green-500" :
                          subject.average >= 60 ? "bg-yellow-500" : "bg-red-500"
                        }`}
                        style={{ width: `${subject.average}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-16 text-right">
                    <span className={`font-bold ${grade.color}`}>{subject.average}%</span>
                  </div>
                  <div className="w-10 text-center">
                    <span className={`font-bold text-lg ${grade.color}`}>{grade.letter}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Grades */}
      {data && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="p-4 border-b border-slate-100">
            <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
              <span>📋</span> Recent Grades
            </h2>
          </div>
          {data.grades.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              No grades yet. Complete assignments and quizzes to see your grades here.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.grades.map((grade) => {
                const percentage = grade.maxScore > 0 ? Math.round(((grade.score || 0) / grade.maxScore) * 100) : 0;
                const letterGrade = getGradeLetter(percentage);
                return (
                  <div key={grade.id} className="p-4 flex items-center gap-4 hover:bg-slate-50">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-white text-2xl ${
                      grade.type === "quiz" ? "bg-purple-500" : "bg-blue-500"
                    }`}>
                      {grade.type === "quiz" ? "❓" : "📝"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800 truncate">{grade.title}</p>
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span>{grade.subjectName}</span>
                        <span>•</span>
                        <span>{grade.gradedAt ? new Date(grade.gradedAt).toLocaleDateString() : "N/A"}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-lg text-slate-800">
                        {grade.score}/{grade.maxScore}
                      </p>
                      <p className={`text-sm font-semibold ${letterGrade.color}`}>
                        {percentage}% ({letterGrade.letter})
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </DashboardShell>
  );
}
