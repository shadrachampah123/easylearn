"use client";

import { useEffect, useState, use } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Submission {
  id: string;
  status: string;
  score: number | null;
  submittedAt: string | null;
  learnerFirstName: string;
  learnerLastName: string;
  learnerId: string;
}

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  status: string;
  dueDate: string | null;
  maxScore: number;
  allowLate: boolean;
  className: string | null;
  subjectName: string | null;
  createdAt: string;
  submissions: Submission[];
}

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "📚" },
];

export default function AssignmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [grading, setGrading] = useState<string | null>(null);
  const [gradeForm, setGradeForm] = useState({ score: 0, feedback: "" });

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
      if (data.success) setAssignment(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleGrade(submissionId: string) {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/submissions/${submissionId}/grade`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(gradeForm),
      });
      const data = await res.json();
      if (data.success) {
        setGrading(null);
        setGradeForm({ score: 0, feedback: "" });
        loadAssignment();
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function toggleStatus() {
    const token = localStorage.getItem("el_token");
    const newStatus = assignment?.status === "published" ? "closed" : "published";
    try {
      const res = await fetch(`/api/assignments/${resolvedParams.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...assignment, status: newStatus }),
      });
      const data = await res.json();
      if (data.success) loadAssignment();
    } catch (err) {
      console.error(err);
    }
  }

  if (loading) {
    return (
      <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 rounded w-1/3" />
          <div className="h-4 bg-slate-100 rounded w-1/2" />
        </div>
      </DashboardShell>
    );
  }

  if (!assignment) {
    return (
      <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
        <div className="text-center py-16">
          <h2 className="text-xl font-bold text-slate-800">Assignment not found</h2>
          <Link href="/dashboard/teacher/assignments" className="text-secondary-600 mt-4 inline-block">
            ← Back to assignments
          </Link>
        </div>
      </DashboardShell>
    );
  }

  const submittedCount = assignment.submissions.filter((s) => s.status !== "pending").length;
  const gradedCount = assignment.submissions.filter((s) => s.status === "graded").length;

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <Link href="/dashboard/teacher/assignments" className="text-slate-500 text-sm hover:text-secondary-600 mb-4 inline-block">
        ← Back to assignments
      </Link>

      {/* Assignment Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-slate-800">{assignment.title}</h1>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                assignment.status === "published" ? "bg-green-100 text-green-600" :
                assignment.status === "closed" ? "bg-red-100 text-red-600" :
                "bg-slate-100 text-slate-600"
              }`}>
                {assignment.status}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm text-slate-500">
              <span>📚 {assignment.subjectName}</span>
              <span>🏫 {assignment.className}</span>
              <span>📊 Max Score: {assignment.maxScore}</span>
              {assignment.dueDate && (
                <span>📅 Due: {new Date(assignment.dueDate).toLocaleString()}</span>
              )}
            </div>
          </div>
          <button
            onClick={toggleStatus}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
              assignment.status === "published"
                ? "bg-red-100 text-red-600 hover:bg-red-200"
                : "bg-green-100 text-green-600 hover:bg-green-200"
            }`}
          >
            {assignment.status === "published" ? "Close" : "Publish"}
          </button>
        </div>

        {assignment.description && (
          <div className="mb-4">
            <h3 className="font-semibold text-slate-700 mb-1">Description</h3>
            <p className="text-slate-600 text-sm">{assignment.description}</p>
          </div>
        )}

        {assignment.instructions && (
          <div>
            <h3 className="font-semibold text-slate-700 mb-1">Instructions</h3>
            <p className="text-slate-600 text-sm whitespace-pre-wrap">{assignment.instructions}</p>
          </div>
        )}
      </div>

      {/* Submissions Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-2xl p-4 border border-slate-100">
          <div className="text-3xl font-bold text-slate-800">{assignment.submissions.length}</div>
          <div className="text-sm text-slate-500">Total Students</div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-slate-100">
          <div className="text-3xl font-bold text-green-600">{submittedCount}</div>
          <div className="text-sm text-slate-500">Submitted</div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-slate-100">
          <div className="text-3xl font-bold text-blue-600">{gradedCount}</div>
          <div className="text-sm text-slate-500">Graded</div>
        </div>
      </div>

      {/* Submissions List */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
        <div className="p-4 border-b border-slate-100">
          <h2 className="font-bold text-lg text-slate-800">Submissions</h2>
        </div>
        {assignment.submissions.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No submissions yet</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {assignment.submissions.map((sub) => (
              <div key={sub.id} className="p-4 flex items-center justify-between hover:bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-secondary-100 flex items-center justify-center text-secondary-600 font-bold">
                    {sub.learnerFirstName?.[0]}{sub.learnerLastName?.[0]}
                  </div>
                  <div>
                    <p className="font-medium text-slate-700">{sub.learnerFirstName} {sub.learnerLastName}</p>
                    <p className="text-xs text-slate-400">
                      {sub.submittedAt ? `Submitted: ${new Date(sub.submittedAt).toLocaleString()}` : "Not submitted"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {sub.status === "graded" ? (
                    <span className="px-3 py-1.5 rounded-lg bg-green-100 text-green-700 font-bold text-sm">
                      {sub.score}/{assignment.maxScore}
                    </span>
                  ) : sub.status === "submitted" || sub.status === "late" ? (
                    grading === sub.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={assignment.maxScore}
                          value={gradeForm.score}
                          onChange={(e) => setGradeForm({ ...gradeForm, score: parseInt(e.target.value) || 0 })}
                          className="w-20 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Score"
                        />
                        <input
                          type="text"
                          value={gradeForm.feedback}
                          onChange={(e) => setGradeForm({ ...gradeForm, feedback: e.target.value })}
                          className="w-40 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Feedback"
                        />
                        <button
                          onClick={() => handleGrade(sub.id)}
                          className="px-3 py-2 rounded-lg bg-green-500 text-white text-sm font-semibold"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setGrading(null)}
                          className="px-3 py-2 rounded-lg bg-slate-200 text-slate-600 text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setGrading(sub.id);
                          setGradeForm({ score: 0, feedback: "" });
                        }}
                        className="px-4 py-2 rounded-lg bg-secondary-100 text-secondary-600 text-sm font-semibold hover:bg-secondary-200"
                      >
                        Grade
                      </button>
                    )
                  ) : (
                    <span className="text-sm text-slate-400">Pending</span>
                  )}
                  {sub.status === "late" && (
                    <span className="px-2 py-1 rounded bg-orange-100 text-orange-600 text-xs">Late</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
