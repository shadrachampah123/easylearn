"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  maxScore: number;
  className: string | null;
  subjectName: string | null;
  submission: { status: string; score: number | null; maxScore: number | null; percentage: number | null } | null;
  myResult?: {
    score: number;
    maxScore: number;
    percentage: number;
    answers: {
      questionText: string;
      answer: string;
      isCorrect: boolean;
      pointsAwarded: number;
      pointsPossible: number;
      correctAnswer: string | null;
    }[];
  } | null;
}

export default function ParentAssignmentsPage() {
  const [children, setChildren] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resultDetails, setResultDetails] = useState<any>(null);

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
      const data = await res.json();
      if (data.success) {
        const learnerIds = data.data.map((c: { learnerId: string }) => c.learnerId);
        const userRes = await fetch("/api/users?role=learner&limit=100", { headers: { Authorization: `Bearer ${token}` } });
        const userData = await userRes.json();
        if (userData.success) {
          const kids = userData.data.users.filter((l: { id: string }) => learnerIds.includes(l.id));
          setChildren(kids);
          if (kids.length > 0) loadAssignments(kids[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function loadAssignments(learnerId: string) {
    setChildId(learnerId);
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/assignments?status=published", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setAssignments(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function viewResults(assignmentId: string) {
    if (!childId) return;
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/results?learnerId=${childId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setResultDetails(data.data);
        setExpandedId(assignmentId);
      }
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Assignments</h1>
        <p className="text-sm text-slate-500">Track your child&apos;s homework and performance</p>
      </div>

      {children.length > 0 && (
        <div className="mb-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-4">
          <select value={childId || ""} onChange={(e) => loadAssignments(e.target.value)}
            className="w-full max-w-sm px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
            {children.map((c) => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
            ))}
          </select>
        </div>
      )}

      {/* Summary Stats */}
      {assignments.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-2xl p-4 border border-slate-100">
            <div className="text-3xl font-bold text-slate-800">{assignments.length}</div>
            <div className="text-sm text-slate-500">Total Assignments</div>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100">
            <div className="text-3xl font-bold text-green-600">
              {assignments.filter((a) => a.submission?.status === "graded").length}
            </div>
            <div className="text-sm text-slate-500">Graded</div>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100">
            <div className="text-3xl font-bold text-blue-600">
              {assignments.filter((a) => a.submission?.percentage != null)
                .reduce((sum, a) => sum + (a.submission?.percentage || 0), 0) /
                Math.max(1, assignments.filter((a) => a.submission?.percentage != null).length)
              | 0}%
            </div>
            <div className="text-sm text-slate-500">Average Score</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
          ))}
        </div>
      ) : children.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">👧</div>
          <h3 className="text-lg font-semibold text-slate-700">No children linked</h3>
        </div>
      ) : assignments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📝</div>
          <h3 className="text-lg font-semibold text-slate-700">No assignments yet</h3>
        </div>
      ) : (
        <div className="space-y-3">
          {assignments.map((a) => {
            const isGraded = a.submission?.status === "graded";
            const isSubmitted = a.submission?.status === "submitted" || a.submission?.status === "late";
            const isExpanded = expandedId === a.id;

            return (
              <div key={a.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                <div
                  className="p-6 hover:bg-slate-50 transition-colors cursor-pointer"
                  onClick={() => isGraded ? viewResults(a.id) : setExpandedId(isExpanded ? null : a.id)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-lg text-slate-800">{a.title}</h3>
                    {isGraded ? (
                      <div className="flex items-center gap-2">
                        <span className="px-3 py-1 rounded-full bg-green-100 text-green-600 text-xs font-semibold">
                          ✓ Score: {a.submission?.score}/{a.submission?.maxScore}
                        </span>
                        <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-600 text-xs font-semibold">
                          {a.submission?.percentage}%
                        </span>
                      </div>
                    ) : isSubmitted ? (
                      <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-600 text-xs font-semibold">Submitted</span>
                    ) : (
                      <span className="px-3 py-1 rounded-full bg-orange-100 text-orange-600 text-xs font-semibold">Pending</span>
                    )}
                  </div>
                  {a.description && <p className="text-slate-500 text-sm mb-3">{a.description}</p>}
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                    <span>📚 {a.subjectName}</span>
                    <span>🏫 {a.className}</span>
                    {a.dueDate && <span>📅 Due: {new Date(a.dueDate).toLocaleDateString()}</span>}
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && resultDetails && resultDetails.hasSubmitted && (
                  <div className="border-t border-slate-100 p-6 bg-slate-50">
                    <div className="flex items-center justify-center gap-4 mb-6 p-4 rounded-xl bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200">
                      <div className="text-center">
                        <p className="text-3xl font-bold text-green-600">{resultDetails.score}/{resultDetails.maxScore}</p>
                        <p className="text-sm text-green-500">{resultDetails.percentage}%</p>
                      </div>
                    </div>

                    {(resultDetails.answers || []).length > 0 && (
                      <div className="space-y-3">
                        <h4 className="font-semibold text-slate-700 text-sm">Question Breakdown</h4>
                        {(resultDetails.answers || []).map((ans: any, i: number) => (
                          <div
                            key={i}
                            className={`p-3 rounded-xl border ${
                              ans.isCorrect ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-semibold text-slate-700">Q{i + 1}</span>
                              <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                                ans.isCorrect ? "bg-green-200 text-green-700" : "bg-red-200 text-red-700"
                              }`}>
                                {ans.pointsAwarded}/{ans.pointsPossible} pts
                              </span>
                            </div>
                            <p className="text-xs text-slate-600 mb-1">{ans.questionText}</p>
                            <p className="text-xs text-slate-500">
                              <span className="font-semibold">Answer:</span> {ans.answer || "(no answer)"}
                            </p>
                            {!ans.isCorrect && ans.correctAnswer && (
                              <p className="text-xs text-green-600">
                                <span className="font-semibold">Correct:</span> {ans.correctAnswer}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <button
                      onClick={() => setExpandedId(null)}
                      className="mt-4 text-sm text-slate-500 hover:text-slate-700"
                    >
                      ← Close details
                    </button>
                  </div>
                )}

                {isExpanded && (!resultDetails || !resultDetails.hasSubmitted) && (
                  <div className="border-t border-slate-100 p-6 bg-slate-50 text-center text-slate-500 text-sm">
                    {resultDetails?.message || "No submission found for your child on this assignment."}
                    <br />
                    <button
                      onClick={() => setExpandedId(null)}
                      className="mt-2 text-slate-500 hover:text-slate-700"
                    >
                      ← Close
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </DashboardShell>
  );
}
