"use client";

import { useEffect, useState, use } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  dueDate: string | null;
  maxScore: number;
  allowLate: boolean;
  className: string | null;
  subjectName: string | null;
  teacherFirstName: string | null;
  teacherLastName: string | null;
  mySubmission: {
    id: string;
    content: string | null;
    status: string;
    score: number | null;
    feedback: string | null;
    submittedAt: string | null;
  } | null;
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
];

export default function LearnerAssignmentPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [content, setContent] = useState("");

  useEffect(() => {
    loadAssignment();
  }, [resolvedParams.id]);

  async function loadAssignment() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/assignments/${resolvedParams.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setAssignment(data.data);
        if (data.data.mySubmission?.content) {
          setContent(data.data.mySubmission.content);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) {
      alert("Please enter your answer");
      return;
    }

    setSubmitting(true);
    const token = localStorage.getItem("el_token");

    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          assignmentId: resolvedParams.id,
          content,
        }),
      });

      const data = await res.json();
      if (data.success) {
        loadAssignment();
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 rounded w-1/3" />
          <div className="h-4 bg-slate-100 rounded w-1/2" />
        </div>
      </DashboardShell>
    );
  }

  if (!assignment) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="text-center py-16">
          <h2 className="text-xl font-bold text-slate-800">Assignment not found</h2>
          <Link href="/dashboard/learner/assignments" className="text-accent-600 mt-4 inline-block">
            ← Back to assignments
          </Link>
        </div>
      </DashboardShell>
    );
  }

  const isOverdue = assignment.dueDate && new Date(assignment.dueDate) < new Date();
  const canSubmit = !isOverdue || assignment.allowLate;
  const isGraded = assignment.mySubmission?.status === "graded";
  const isSubmitted = assignment.mySubmission?.status === "submitted" || assignment.mySubmission?.status === "late";

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <Link href="/dashboard/learner/assignments" className="text-slate-500 text-sm hover:text-accent-600 mb-4 inline-block">
        ← Back to assignments
      </Link>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Assignment Details */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-800 mb-2">{assignment.title}</h1>
                <div className="flex items-center gap-4 text-sm text-slate-500">
                  <span>📚 {assignment.subjectName}</span>
                  <span>🏫 {assignment.className}</span>
                  <span>👩‍🏫 {assignment.teacherFirstName} {assignment.teacherLastName}</span>
                </div>
              </div>
              <span className="px-3 py-1.5 rounded-xl bg-accent-100 text-accent-700 font-bold text-lg">
                {assignment.maxScore} pts
              </span>
            </div>

            {assignment.description && (
              <div className="mb-4">
                <h3 className="font-semibold text-slate-700 mb-1">Description</h3>
                <p className="text-slate-600 text-sm">{assignment.description}</p>
              </div>
            )}

            {assignment.instructions && (
              <div className="p-4 rounded-xl bg-blue-50 border border-blue-100">
                <h3 className="font-semibold text-blue-800 mb-2 flex items-center gap-2">
                  <span>📋</span> Instructions
                </h3>
                <p className="text-blue-700 text-sm whitespace-pre-wrap">{assignment.instructions}</p>
              </div>
            )}
          </div>

          {/* Submission Form or Result */}
          {isGraded ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                <span>📊</span> Your Result
              </h2>
              <div className="flex items-center justify-center gap-4 mb-6 p-6 rounded-xl bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200">
                <div className="text-center">
                  <p className="text-4xl font-bold text-green-600">{assignment.mySubmission?.score}</p>
                  <p className="text-sm text-green-500">out of {assignment.maxScore}</p>
                </div>
                <div className="text-6xl">
                  {(assignment.mySubmission?.score || 0) >= assignment.maxScore * 0.9 ? "🏆" :
                   (assignment.mySubmission?.score || 0) >= assignment.maxScore * 0.7 ? "⭐" :
                   (assignment.mySubmission?.score || 0) >= assignment.maxScore * 0.5 ? "👍" : "📝"}
                </div>
              </div>

              {assignment.mySubmission?.feedback && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <h3 className="font-semibold text-slate-700 mb-2">Teacher Feedback</h3>
                  <p className="text-slate-600 text-sm">{assignment.mySubmission.feedback}</p>
                </div>
              )}

              <div className="mt-4 p-4 rounded-xl bg-slate-50">
                <h3 className="font-semibold text-slate-700 mb-2">Your Answer</h3>
                <p className="text-slate-600 text-sm whitespace-pre-wrap">{assignment.mySubmission?.content}</p>
              </div>
            </div>
          ) : isSubmitted ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <div className="text-center py-8">
                <div className="text-6xl mb-4">✅</div>
                <h2 className="text-xl font-bold text-slate-800 mb-2">Assignment Submitted!</h2>
                <p className="text-slate-500 text-sm mb-4">
                  Submitted on {assignment.mySubmission?.submittedAt ? new Date(assignment.mySubmission.submittedAt).toLocaleString() : "N/A"}
                </p>
                <p className="text-slate-500 text-sm">Waiting for your teacher to grade...</p>
              </div>
              <div className="mt-4 p-4 rounded-xl bg-slate-50">
                <h3 className="font-semibold text-slate-700 mb-2">Your Answer</h3>
                <p className="text-slate-600 text-sm whitespace-pre-wrap">{assignment.mySubmission?.content}</p>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                <span>✏️</span> Your Answer
              </h2>

              {!canSubmit && (
                <div className="mb-4 p-4 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
                  ⚠️ This assignment is overdue and late submissions are not allowed.
                </div>
              )}

              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={10}
                disabled={!canSubmit}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-accent-500 focus:border-transparent outline-none resize-none disabled:bg-slate-100 disabled:text-slate-400"
                placeholder="Type your answer here..."
              />

              <div className="mt-4 flex gap-3">
                <button
                  type="submit"
                  disabled={!canSubmit || submitting}
                  className="flex-1 py-3 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white font-semibold shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? "Submitting..." : "Submit Assignment 🚀"}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Due Date Card */}
          <div className={`p-5 rounded-2xl ${isOverdue ? "bg-red-50 border border-red-200" : "bg-white border border-slate-100"}`}>
            <h3 className="font-semibold text-sm text-slate-500 mb-2">Due Date</h3>
            <p className={`font-bold text-lg ${isOverdue ? "text-red-600" : "text-slate-800"}`}>
              {assignment.dueDate ? new Date(assignment.dueDate).toLocaleString() : "No due date"}
            </p>
            {isOverdue && (
              <p className="text-sm text-red-500 mt-1">
                {assignment.allowLate ? "Late submissions allowed" : "Overdue - submissions closed"}
              </p>
            )}
          </div>

          {/* Points Card */}
          <div className="p-5 rounded-2xl bg-gradient-to-br from-accent-500 to-accent-600 text-white">
            <h3 className="font-semibold text-sm text-accent-100 mb-1">Maximum Points</h3>
            <p className="font-bold text-3xl">{assignment.maxScore}</p>
          </div>

          {/* Tips Card */}
          <div className="p-5 rounded-2xl bg-yellow-50 border border-yellow-200">
            <h3 className="font-semibold text-slate-700 mb-2 flex items-center gap-2">
              <span>💡</span> Tips
            </h3>
            <ul className="text-sm text-slate-600 space-y-1">
              <li>• Read all instructions carefully</li>
              <li>• Double-check your answers</li>
              <li>• Submit before the deadline</li>
              <li>• Ask your teacher if you need help</li>
            </ul>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
