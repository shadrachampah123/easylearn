"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Quiz {
  id: string;
  title: string;
  description: string | null;
  timeLimitMinutes: number | null;
  isPublished: boolean;
  questionCount: number;
  maxAttempts: number;
  className: string | null;
  subjectName: string | null;
  teacherFirstName: string | null;
  teacherLastName: string | null;
  attemptsUsed: number;
  attemptsLeft: number | null;
  myAttempt: {
    id: string;
    score: number | null;
    completedAt: string | null;
  } | null;
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
  { name: "Achievements", href: "/dashboard/learner/achievements", icon: "🏆" },
];

export default function LearnerQuizzesPage() {
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadQuizzes();
  }, []);

  async function loadQuizzes() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/quizzes", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setQuizzes(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Quizzes</h1>
        <p className="text-sm text-slate-500">Test your knowledge with interactive quizzes</p>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse">
              <div className="h-5 bg-slate-200 rounded w-1/2 mb-3" />
              <div className="h-4 bg-slate-100 rounded w-3/4" />
            </div>
          ))}
        </div>
      ) : quizzes.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">❓</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No quizzes available</h3>
          <p className="text-slate-500 text-sm">Check back later for new quizzes from your teachers</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {quizzes.map((quiz) => {
            const isCompleted = quiz.myAttempt?.completedAt;
            const score = quiz.myAttempt?.score;

            return (
              <Link
                key={quiz.id}
                href={`/dashboard/learner/quizzes/${quiz.id}`}
                className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md hover:border-accent-200 transition-all group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center text-white text-2xl group-hover:scale-110 transition-transform">
                    ❓
                  </div>
                  {quiz.attemptsLeft === 0 ? (
                    <div className="px-3 py-1.5 rounded-xl bg-slate-100 text-slate-500 font-bold text-sm">
                      {isCompleted ? `Score: ${score}` : "No attempts left"}
                    </div>
                  ) : isCompleted ? (
                    <div className="px-3 py-1.5 rounded-xl bg-green-100 text-green-600 font-bold text-sm">
                      Score: {score}
                    </div>
                  ) : (
                    <div className="px-3 py-1.5 rounded-xl bg-accent-100 text-accent-600 font-semibold text-sm">
                      Take Quiz
                    </div>
                  )}
                </div>

                <h3 className="font-bold text-lg text-slate-800 mb-2 group-hover:text-accent-600 transition-colors">
                  {quiz.title}
                </h3>
                <p className="text-slate-500 text-sm mb-4 line-clamp-2">
                  {quiz.description || "No description"}
                </p>

                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                  <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100">
                    <span>🏫</span> {quiz.className}
                  </span>
                  <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100">
                    <span>📚</span> {quiz.subjectName}
                  </span>
                  <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100">
                    <span>❓</span> {quiz.questionCount} questions
                  </span>
                  {quiz.timeLimitMinutes && (
                    <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100">
                      <span>⏱️</span> {quiz.timeLimitMinutes} min
                    </span>
                  )}
                </div>

                <p className="mt-3 text-xs text-slate-400">
                  Set by {quiz.teacherFirstName} {quiz.teacherLastName}
                  {quiz.maxAttempts ? ` · attempt ${Math.min(quiz.attemptsUsed + 1, quiz.maxAttempts)} of ${quiz.maxAttempts}` : ""}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </DashboardShell>
  );
}
