"use client";

import { useEffect, useState, use } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Question {
  id: string;
  questionType: string;
  questionText: string;
  imageUrl?: string | null;
  options: string[] | null;
  correctAnswer: string | null;
  points: number;
}

interface Attempt {
  id: string;
  learnerName: string;
  score: number;
  maxScore: number;
  percentage: number;
  completedAt: string;
}

interface Quiz {
  id: string;
  title: string;
  description: string | null;
  timeLimitMinutes: number | null;
  shuffleQuestions: boolean;
  shuffleAnswers: boolean;
  showResults: boolean;
  isPublished: boolean;
  maxAttempts: number;
  className: string | null;
  subjectName: string | null;
  questions: Question[];
}

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "My Classes", href: "/dashboard/teacher/classes", icon: "🏫" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "📚" },
  { name: "Attendance", href: "/dashboard/teacher/attendance", icon: "✅" },
];

export default function TeacherQuizDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const router = useRouter();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "questions" | "attempts">("details");

  useEffect(() => {
    loadQuiz();
  }, [resolvedParams.id]);

  async function loadQuiz() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/quizzes/${resolvedParams.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setQuiz(data.data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function togglePublish() {
    if (!quiz) return;
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // Send only the flag. Sending the whole quiz back used to re-submit `questions`
        // too, which deleted and re-created every question on a simple publish toggle.
        body: JSON.stringify({ isPublished: !quiz.isPublished }),
      });
      const data = await res.json();
      if (data.success) {
        setQuiz({ ...quiz, isPublished: !quiz.isPublished });
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function deleteQuiz() {
    if (!confirm("Are you sure you want to delete this quiz?")) return;
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/quizzes/${resolvedParams.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        router.push("/dashboard/teacher/quizzes");
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (loading) {
    return (
      <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="w-8 h-8 border-3 border-secondary-200 border-t-secondary-600 rounded-full animate-spin" />
        </div>
      </DashboardShell>
    );
  }

  if (!quiz) {
    return (
      <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
        <div className="text-center py-16">
          <h2 className="text-xl font-bold text-slate-800">Quiz not found</h2>
          <Link href="/dashboard/teacher/quizzes" className="text-secondary-600 mt-4 inline-block">
            ← Back to quizzes
          </Link>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-4">
        <div>
          <Link href="/dashboard/teacher/quizzes" className="text-slate-500 text-sm hover:text-secondary-600 mb-2 inline-block">
            ← Back to quizzes
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-800">{quiz.title}</h1>
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
              quiz.isPublished ? "bg-green-100 text-green-600" : "bg-slate-100 text-slate-600"
            }`}>
              {quiz.isPublished ? "Published" : "Draft"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={togglePublish}
            disabled={saving}
            className={`px-4 py-2 rounded-xl font-semibold text-sm transition-colors ${
              quiz.isPublished ? "bg-amber-100 text-amber-700 hover:bg-amber-200" : "bg-green-600 text-white hover:bg-green-700"
            }`}
          >
            {quiz.isPublished ? "Unpublish Quiz" : "Publish Quiz"}
          </button>
          <button
            onClick={deleteQuiz}
            className="px-4 py-2 rounded-xl bg-red-100 text-red-600 font-semibold text-sm hover:bg-red-200 transition-colors"
          >
            Delete Quiz
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 mb-6">
        {[
          { key: "details", label: "Overview", icon: "📋" },
          { key: "questions", label: `Questions (${quiz.questions.length})`, icon: "❓" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as any)}
            className={`px-5 py-3 font-semibold text-sm border-b-2 flex items-center gap-2 transition-all ${
              activeTab === tab.key
                ? "border-secondary-600 text-secondary-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === "details" && (
        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-6">
            <div>
              <h3 className="text-sm font-medium text-slate-400 mb-1">Description</h3>
              <p className="text-slate-700">{quiz.description || "No description provided."}</p>
            </div>
            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-100">
              <div>
                <h3 className="text-sm font-medium text-slate-400 mb-1">Class</h3>
                <p className="font-semibold text-slate-800">{quiz.className || "N/A"}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-400 mb-1">Subject</h3>
                <p className="font-semibold text-slate-800">{quiz.subjectName || "N/A"}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-400 mb-1">Time Limit</h3>
                <p className="font-semibold text-slate-800">{quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} minutes` : "No limit"}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-400 mb-1">Max Attempts</h3>
                <p className="font-semibold text-slate-800">{quiz.maxAttempts}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-4">
            <h3 className="font-bold text-slate-800">Quiz Settings</h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Shuffle Questions</span>
                <span className={`font-semibold ${quiz.shuffleQuestions ? "text-green-600" : "text-slate-400"}`}>
                  {quiz.shuffleQuestions ? "Yes" : "No"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Shuffle Answers</span>
                <span className={`font-semibold ${quiz.shuffleAnswers ? "text-green-600" : "text-slate-400"}`}>
                  {quiz.shuffleAnswers ? "Yes" : "No"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Show Results to Learner</span>
                <span className={`font-semibold ${quiz.showResults ? "text-green-600" : "text-slate-400"}`}>
                  {quiz.showResults ? "Yes" : "No"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Questions Tab */}
      {activeTab === "questions" && (
        <div className="space-y-4">
          {quiz.questions.map((q, idx) => (
            <div key={q.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 rounded-xl bg-secondary-100 text-secondary-600 flex items-center justify-center font-bold text-sm">
                    {idx + 1}
                  </span>
                  <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold">
                    {q.questionType.toUpperCase()}
                  </span>
                </div>
                <span className="text-sm font-bold text-slate-600">{q.points} pt{q.points > 1 ? "s" : ""}</span>
              </div>

              {q.imageUrl && (
                <div className="mb-4 rounded-xl overflow-hidden max-h-64 bg-slate-100 border border-slate-200">
                  <img src={q.imageUrl} alt="Question banner" className="w-full h-full object-cover" />
                </div>
              )}

              <p className="font-semibold text-slate-800 text-lg mb-4">{q.questionText}</p>

              {q.questionType === "mcq" && q.options && (
                <div className="grid grid-cols-2 gap-2">
                  {q.options.map((opt, oIdx) => {
                    const letter = String.fromCharCode(65 + oIdx);
                    const isCorrect = q.correctAnswer === letter;
                    return (
                      <div
                        key={oIdx}
                        className={`p-3 rounded-xl border flex items-center gap-3 ${
                          isCorrect ? "bg-green-50 border-green-300 text-green-800 font-semibold" : "bg-slate-50 border-slate-200 text-slate-700"
                        }`}
                      >
                        <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold ${
                          isCorrect ? "bg-green-500 text-white" : "bg-slate-200 text-slate-600"
                        }`}>
                          {letter}
                        </span>
                        <span>{opt}</span>
                        {isCorrect && <span className="ml-auto text-green-600 text-xs">✓ Correct</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {q.correctAnswer && q.questionType !== "mcq" && (
                <p className="text-sm text-green-600 font-semibold mt-2">
                  Correct Answer: {q.correctAnswer}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
