"use client";

import { useEffect, useState } from "react";

interface LearnerSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  assignmentCount: number;
  quizAttemptCount: number;
  completedQuizCount: number;
  gradedCount: number;
  average: number;
}

interface AssignmentActivity {
  id: string;
  title: string;
  status: string;
  score: number | null;
  maxScore: number | null;
  percentage: number | null;
  submittedAt: string | null;
  gradedAt: string | null;
  dueDate: string | null;
  assignmentStatus: string;
  className: string | null;
  subjectName: string | null;
}

interface QuizActivity {
  id: string;
  title: string;
  score: number | null;
  maxScore: number;
  percentage: number;
  startedAt: string;
  completedAt: string | null;
  className: string | null;
  subjectName: string | null;
}

interface Grade {
  id: string;
  type: "assignment" | "quiz";
  title: string;
  score: number | null;
  maxScore: number | null;
  percentage: number | null;
  gradedAt: string | null;
  subjectName: string | null;
  className: string | null;
}

interface LearnerReport {
  learner: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    classes: (string | null)[];
  };
  summary: {
    assignmentsSubmitted: number;
    assignmentsGraded: number;
    quizAttempts: number;
    completedQuizzes: number;
    totalGrades: number;
    overallAverage: number;
    totalScore: number;
    totalMax: number;
  };
  assignments: AssignmentActivity[];
  quizzes: QuizActivity[];
  grades: Grade[];
}

interface ReportsResponse {
  learners: LearnerSummary[];
  report: LearnerReport | null;
}

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Not submitted";
}

function statusLabel(status: string) {
  return status.replace("_", " ");
}

function statusClass(status: string) {
  if (status === "graded") return "bg-green-100 text-green-700";
  if (status === "submitted" || status === "completed") return "bg-blue-100 text-blue-700";
  if (status === "late") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

export default function LearnerProgressPanel() {
  const [learners, setLearners] = useState<LearnerSummary[]>([]);
  const [selectedLearnerId, setSelectedLearnerId] = useState("");
  const [report, setReport] = useState<LearnerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadLearners();
  }, []);

  async function loadLearners() {
    setLoading(true);
    setError("");
    const token = localStorage.getItem("el_token");
    try {
      const response = await fetch("/api/learner-reports", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await response.json()) as { success?: boolean; data?: ReportsResponse; error?: string };
      if (!response.ok || !data.success || !data.data) {
        throw new Error(data.error || "Could not load learners");
      }
      setLearners(data.data.learners);
    } catch (loadError) {
      console.error(loadError);
      setError("Learners could not be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function selectLearner(learnerId: string) {
    setSelectedLearnerId(learnerId);
    setReport(null);
    setReportLoading(true);
    setError("");
    const token = localStorage.getItem("el_token");
    try {
      const response = await fetch(`/api/learner-reports?learnerId=${encodeURIComponent(learnerId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await response.json()) as { success?: boolean; data?: ReportsResponse; error?: string };
      if (!response.ok || !data.success || !data.data?.report) {
        throw new Error(data.error || "Could not load this learner's report");
      }
      setReport(data.data.report);
    } catch (loadError) {
      console.error(loadError);
      setError("This learner's report could not be loaded. Please try again.");
    } finally {
      setReportLoading(false);
    }
  }

  const selectedSummary = learners.find((learner) => learner.id === selectedLearnerId);

  return (
    <section className="mt-8 bg-slate-50 rounded-3xl border border-slate-200 p-4 md:p-6">
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <span>🎓</span> Learners &amp; Individual Reports
          </h2>
          <p className="text-sm text-slate-500 mt-1">See who has submitted assignments, attempted quizzes, and review each learner&apos;s grades.</p>
        </div>
        <button
          type="button"
          onClick={() => void loadLearners()}
          disabled={loading}
          className="px-3 py-2 rounded-xl bg-white border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh learners"}
        </button>
      </div>

      {error && <div className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="grid lg:grid-cols-[280px_1fr] gap-5 animate-pulse">
          <div className="h-64 rounded-2xl bg-white" />
          <div className="h-64 rounded-2xl bg-white" />
        </div>
      ) : learners.length === 0 ? (
        <div className="rounded-2xl bg-white border border-slate-200 py-12 text-center">
          <div className="text-5xl mb-3">📚</div>
          <h3 className="font-semibold text-slate-700">No learners in your reporting scope</h3>
          <p className="text-sm text-slate-500 mt-1">Learners will appear here after they are enrolled or interact with an assignment or quiz.</p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[280px_1fr] gap-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-3 h-fit lg:sticky lg:top-4">
            <div className="flex items-center justify-between px-2 pb-2 border-b border-slate-100">
              <h3 className="font-bold text-slate-800">Learner list</h3>
              <span className="text-xs text-slate-400">{learners.length}</span>
            </div>
            <div className="mt-2 space-y-1 max-h-[460px] overflow-y-auto">
              {learners.map((learner) => (
                <button
                  key={learner.id}
                  type="button"
                  onClick={() => void selectLearner(learner.id)}
                  className={`w-full text-left rounded-xl px-3 py-3 transition-colors ${
                    selectedLearnerId === learner.id ? "bg-primary-50 ring-1 ring-primary-200" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-slate-700 truncate">{learner.firstName} {learner.lastName}</span>
                    <span className="text-xs font-bold text-primary-600">{learner.average}%</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400">
                    <span>📝 {learner.assignmentCount} submitted</span>
                    <span>✅ {learner.completedQuizCount} quiz{learner.completedQuizCount === 1 ? "" : "zes"} completed</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-0">
            {!selectedLearnerId ? (
              <div className="bg-white rounded-2xl border border-slate-200 py-20 text-center">
                <div className="text-5xl mb-3">👈</div>
                <h3 className="font-semibold text-slate-700">Select a learner</h3>
                <p className="text-sm text-slate-500 mt-1">Choose a learner to view their activity, report, and grades.</p>
              </div>
            ) : reportLoading ? (
              <div className="bg-white rounded-2xl border border-slate-200 py-20 text-center text-slate-500">Loading individual report...</div>
            ) : report ? (
              <div className="space-y-5">
                <div className="bg-white rounded-2xl border border-slate-200 p-5 flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-xs uppercase tracking-wide font-bold text-primary-600">Individual learner report</p>
                    <h3 className="text-2xl font-bold text-slate-800 mt-1">{report.learner.firstName} {report.learner.lastName}</h3>
                    <p className="text-sm text-slate-500 mt-1">{report.learner.email || "No email recorded"}</p>
                    {report.learner.classes.length > 0 && <p className="text-xs text-slate-400 mt-2">Class: {report.learner.classes.filter(Boolean).join(", ")}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-400">Overall average</p>
                    <p className="text-4xl font-bold text-primary-600">{report.summary.overallAverage}%</p>
                    <p className="text-xs text-slate-400">{report.summary.totalGrades} graded item{report.summary.totalGrades === 1 ? "" : "s"}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                  <div className="bg-blue-50 rounded-2xl p-4 border border-blue-100">
                    <p className="text-xs text-blue-600">Assignments done</p>
                    <p className="text-2xl font-bold text-blue-800 mt-1">{report.summary.assignmentsSubmitted}</p>
                    <p className="text-[11px] text-blue-600">{report.summary.assignmentsGraded} graded</p>
                  </div>
                  <div className="bg-purple-50 rounded-2xl p-4 border border-purple-100">
                    <p className="text-xs text-purple-600">Quiz attempts</p>
                    <p className="text-2xl font-bold text-purple-800 mt-1">{report.summary.quizAttempts}</p>
                    <p className="text-[11px] text-purple-600">{report.summary.completedQuizzes} completed</p>
                  </div>
                  <div className="bg-green-50 rounded-2xl p-4 border border-green-100">
                    <p className="text-xs text-green-600">Total score</p>
                    <p className="text-2xl font-bold text-green-800 mt-1">{report.summary.totalScore}</p>
                    <p className="text-[11px] text-green-600">out of {report.summary.totalMax}</p>
                  </div>
                  <div className="bg-amber-50 rounded-2xl p-4 border border-amber-100">
                    <p className="text-xs text-amber-600">Graded items</p>
                    <p className="text-2xl font-bold text-amber-800 mt-1">{report.summary.totalGrades}</p>
                    <p className="text-[11px] text-amber-600">assignments + quizzes</p>
                  </div>
                </div>

                <div className="grid xl:grid-cols-2 gap-5">
                  <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                    <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                      <h3 className="font-bold text-slate-800">📝 Assignment activity</h3>
                      <span className="text-xs text-slate-400">{report.assignments.length} submitted</span>
                    </div>
                    {report.assignments.length === 0 ? (
                      <p className="p-6 text-sm text-slate-500 text-center">No assignments submitted yet.</p>
                    ) : (
                      <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                        {report.assignments.map((assignment) => (
                          <div key={assignment.id} className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-semibold text-sm text-slate-700 truncate">{assignment.title}</p>
                                <p className="text-xs text-slate-400 mt-1">{assignment.subjectName || "No subject"} · Submitted {dateLabel(assignment.submittedAt)}</p>
                              </div>
                              <span className={`shrink-0 px-2 py-1 rounded-full text-[11px] font-semibold capitalize ${statusClass(assignment.status)}`}>{statusLabel(assignment.status)}</span>
                            </div>
                            <div className="flex items-center justify-between mt-2 text-xs">
                              <span className="text-slate-400">{assignment.className || "No class"}</span>
                              <span className="font-bold text-slate-700">{assignment.score !== null ? `${assignment.score}/${assignment.maxScore || 0}` : "Not graded"}{assignment.percentage !== null ? ` · ${assignment.percentage}%` : ""}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                    <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                      <h3 className="font-bold text-slate-800">❓ Quiz activity</h3>
                      <span className="text-xs text-slate-400">{report.quizzes.length} attempt{report.quizzes.length === 1 ? "" : "s"}</span>
                    </div>
                    {report.quizzes.length === 0 ? (
                      <p className="p-6 text-sm text-slate-500 text-center">No quiz attempts yet.</p>
                    ) : (
                      <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                        {report.quizzes.map((quiz) => (
                          <div key={quiz.id} className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-semibold text-sm text-slate-700 truncate">{quiz.title}</p>
                                <p className="text-xs text-slate-400 mt-1">{quiz.subjectName || "No subject"} · Started {dateLabel(quiz.startedAt)}</p>
                              </div>
                              <span className={`shrink-0 px-2 py-1 rounded-full text-[11px] font-semibold ${quiz.completedAt ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>{quiz.completedAt ? "Completed" : "In progress"}</span>
                            </div>
                            <div className="flex items-center justify-between mt-2 text-xs">
                              <span className="text-slate-400">{quiz.className || "No class"}</span>
                              <span className="font-bold text-slate-700">{quiz.completedAt ? `${quiz.score ?? 0}/${quiz.maxScore} · ${quiz.percentage}%` : "Not completed"}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="font-bold text-slate-800">📊 Individual grades</h3>
                    <span className="text-xs text-slate-400">{report.grades.length} result{report.grades.length === 1 ? "" : "s"}</span>
                  </div>
                  {report.grades.length === 0 ? (
                    <p className="p-6 text-sm text-slate-500 text-center">No grades recorded yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                          <tr>
                            <th className="text-left px-4 py-3">Activity</th>
                            <th className="text-left px-4 py-3">Type</th>
                            <th className="text-left px-4 py-3">Subject</th>
                            <th className="text-right px-4 py-3">Grade</th>
                            <th className="text-right px-4 py-3">Date</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {report.grades.map((grade) => (
                            <tr key={grade.id} className="hover:bg-slate-50">
                              <td className="px-4 py-3 font-semibold text-slate-700">{grade.title}</td>
                              <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-semibold ${grade.type === "quiz" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>{grade.type}</span></td>
                              <td className="px-4 py-3 text-slate-500">{grade.subjectName || "—"}</td>
                              <td className="px-4 py-3 text-right font-bold text-slate-700">{grade.score ?? 0}/{grade.maxScore ?? 0} <span className="text-primary-600">({grade.percentage ?? 0}%)</span></td>
                              <td className="px-4 py-3 text-right text-slate-400">{dateLabel(grade.gradedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            ) : selectedSummary ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">No report data for {selectedSummary.firstName} yet.</div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
