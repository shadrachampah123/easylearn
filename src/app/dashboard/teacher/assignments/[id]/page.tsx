"use client";

import { useEffect, useState, use } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Question {
  id: string;
  questionType: string;
  questionText: string;
  options: string[] | null;
  correctAnswer: string | null;
  points: number;
  orderIndex: number;
  explanation: string | null;
}

interface Submission {
  id: string;
  status: string;
  score: number | null;
  maxScore: number | null;
  percentage: number | null;
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
  questions: Question[];
}

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "" },
];

export default function AssignmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [grading, setGrading] = useState<string | null>(null);
  const [gradeForm, setGradeForm] = useState({ score: 0, feedback: "" });
  const [showQuestionBuilder, setShowQuestionBuilder] = useState(false);
  const [questionForm, setQuestionForm] = useState({
    questionType: "mcq",
    questionText: "",
    options: ["", "", "", ""],
    correctAnswer: "",
    points: 1,
    explanation: "",
  });
  const [viewingResults, setViewingResults] = useState<string | null>(null);
  const [results, setResults] = useState<any>(null);
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [correctionForm, setCorrectionForm] = useState({ questionId: "", correctionText: "" });

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

  async function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    if (!questionForm.questionText.trim()) {
      alert("Question text is required");
      return;
    }

    const token = localStorage.getItem("el_token");
    const options = questionForm.questionType === "mcq" || questionForm.questionType === "true_false"
      ? questionForm.options.filter((o) => o.trim())
      : null;

    try {
      const res = await fetch(`/api/assignments/${resolvedParams.id}/questions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          questionType: questionForm.questionType,
          questionText: questionForm.questionText,
          options,
          correctAnswer: questionForm.correctAnswer,
          points: questionForm.points,
          explanation: questionForm.explanation || null,
          orderIndex: (assignment?.questions.length || 0),
        }),
      });

      const data = await res.json();
      if (data.success) {
        setQuestionForm({
          questionType: "mcq",
          questionText: "",
          options: ["", "", "", ""],
          correctAnswer: "",
          points: 1,
          explanation: "",
        });
        setShowQuestionBuilder(false);
        loadAssignment();
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDeleteQuestion(questionId: string) {
    if (!confirm("Delete this question?")) return;
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/assignments/${resolvedParams.id}/questions?questionId=${questionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) loadAssignment();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleViewResults(learnerId: string) {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/assignments/${resolvedParams.id}/results?learnerId=${learnerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setResults(data.data);
        setViewingResults(learnerId);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handlePostCorrection(e: React.FormEvent) {
    e.preventDefault();
    if (!correctionForm.correctionText.trim()) {
      alert("Correction text is required");
      return;
    }

    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/assignments/${resolvedParams.id}/corrections`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(correctionForm),
      });

      const data = await res.json();
      if (data.success) {
        setCorrectionForm({ questionId: "", correctionText: "" });
        setShowCorrectionForm(false);
        alert("Correction posted successfully!");
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
  const avgScore = gradedCount > 0
    ? Math.round(assignment.submissions.filter((s) => s.status === "graded").reduce((sum, s) => sum + (s.percentage || 0), 0) / gradedCount)
    : 0;

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
          <div className="flex gap-2">
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

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
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
        <div className="bg-white rounded-2xl p-4 border border-slate-100">
          <div className="text-3xl font-bold text-purple-600">{avgScore}%</div>
          <div className="text-sm text-slate-500">Avg Score</div>
        </div>
      </div>

      {/* Questions Section */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 mb-6">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
            <span>❓</span> Questions ({assignment.questions?.length || 0})
          </h2>
          {assignment.status !== "published" && (
            <button
              onClick={() => setShowQuestionBuilder(!showQuestionBuilder)}
              className="px-4 py-2 rounded-xl bg-secondary-500 text-white text-sm font-semibold hover:bg-secondary-600"
            >
              {showQuestionBuilder ? "Close" : "+ Add Question"}
            </button>
          )}
        </div>

        {showQuestionBuilder && (
          <div className="p-6 border-b border-slate-100 bg-slate-50">
            <form onSubmit={handleAddQuestion} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Question Type</label>
                <select
                  value={questionForm.questionType}
                  onChange={(e) => setQuestionForm({ ...questionForm, questionType: e.target.value, options: ["", "", "", ""], correctAnswer: "" })}
                  className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                >
                  <option value="mcq">Multiple Choice</option>
                  <option value="true_false">True / False</option>
                  <option value="fill_blank">Fill in the Blank</option>
                  <option value="short_answer">Short Answer</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Question Text</label>
                <textarea
                  value={questionForm.questionText}
                  onChange={(e) => setQuestionForm({ ...questionForm, questionText: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                  placeholder="Type your question..."
                />
              </div>

              {(questionForm.questionType === "mcq" || questionForm.questionType === "true_false") && (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">
                    Options (select the correct one)
                  </label>
                  {questionForm.options.map((opt, i) => (
                    <div key={i} className="flex items-center gap-2 mb-2">
                      <input
                        type="radio"
                        name="correctAnswer"
                        checked={questionForm.correctAnswer === opt || (questionForm.questionType === "true_false" && (i === 0 ? questionForm.correctAnswer === "true" : questionForm.correctAnswer === "false"))}
                        onChange={() => {
                          const val = questionForm.questionType === "true_false" ? (i === 0 ? "true" : "false") : opt;
                          setQuestionForm({ ...questionForm, correctAnswer: val });
                        }}
                      />
                      {questionForm.questionType === "true_false" ? (
                        <span className="text-sm font-medium">{i === 0 ? "True" : "False"}</span>
                      ) : (
                        <input
                          type="text"
                          value={opt}
                          onChange={(e) => {
                            const newOpts = [...questionForm.options];
                            newOpts[i] = e.target.value;
                            setQuestionForm({ ...questionForm, options: newOpts });
                          }}
                          placeholder={`Option ${i + 1}`}
                          className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {questionForm.questionType === "fill_blank" && (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Correct Answer</label>
                  <input
                    type="text"
                    value={questionForm.correctAnswer}
                    onChange={(e) => setQuestionForm({ ...questionForm, correctAnswer: e.target.value })}
                    className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                    placeholder="The correct answer..."
                  />
                </div>
              )}

              {questionForm.questionType === "short_answer" && (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Expected Answer</label>
                  <input
                    type="text"
                    value={questionForm.correctAnswer}
                    onChange={(e) => setQuestionForm({ ...questionForm, correctAnswer: e.target.value })}
                    className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                    placeholder="The expected answer..."
                  />
                  <p className="text-xs text-slate-400 mt-1">Exact match required for auto-grading</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Points</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={questionForm.points}
                    onChange={(e) => setQuestionForm({ ...questionForm, points: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Explanation (optional)</label>
                  <input
                    type="text"
                    value={questionForm.explanation}
                    onChange={(e) => setQuestionForm({ ...questionForm, explanation: e.target.value })}
                    className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                    placeholder="Why is this the answer?"
                  />
                </div>
              </div>

              <div className="flex gap-3">
                <button type="submit" className="px-6 py-2 rounded-xl bg-secondary-500 text-white text-sm font-semibold hover:bg-secondary-600">
                  Add Question
                </button>
                <button type="button" onClick={() => setShowQuestionBuilder(false)} className="px-6 py-2 rounded-xl bg-slate-200 text-slate-600 text-sm">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Questions List */}
        {(assignment.questions || []).length === 0 ? (
          <div className="p-8 text-center text-slate-500">
            <div className="text-4xl mb-2">❓</div>
            <p>No questions added yet. Add questions to enable auto-grading.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {(assignment.questions || []).map((q, i) => (
              <div key={q.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs font-semibold">
                        Q{i + 1}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-600 text-xs font-semibold">
                        {q.questionType}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-green-100 text-green-600 text-xs font-semibold">
                        {q.points} pts
                      </span>
                    </div>
                    <p className="text-slate-700 font-medium">{q.questionText}</p>
                    {q.options && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {q.options.map((opt: string, j: number) => (
                          <span
                            key={j}
                            className={`px-3 py-1 rounded-lg text-xs font-medium ${
                              q.correctAnswer === opt
                                ? "bg-green-100 text-green-700 border border-green-200"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {opt} {q.correctAnswer === opt && "✓"}
                          </span>
                        ))}
                      </div>
                    )}
                    {q.correctAnswer && q.questionType !== "mcq" && q.questionType !== "true_false" && (
                      <p className="mt-2 text-xs text-green-600">Answer: {q.correctAnswer}</p>
                    )}
                  </div>
                  {assignment.status !== "published" && (
                    <button
                      onClick={() => handleDeleteQuestion(q.id)}
                      className="text-red-400 hover:text-red-600 text-sm ml-4"
                    >
                      ️
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Correction Section */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 mb-6">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
            <span></span> Post-Deadline Corrections
          </h2>
          {assignment.status === "closed" && (
            <button
              onClick={() => setShowCorrectionForm(!showCorrectionForm)}
              className="px-4 py-2 rounded-xl bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600"
            >
              {showCorrectionForm ? "Close" : "+ Post Correction"}
            </button>
          )}
        </div>

        {showCorrectionForm && (
          <div className="p-6 border-b border-slate-100 bg-orange-50">
            <form onSubmit={handlePostCorrection} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Question (optional)</label>
                <select
                  value={correctionForm.questionId}
                  onChange={(e) => setCorrectionForm({ ...correctionForm, questionId: e.target.value })}
                  className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                >
                  <option value="">General correction (all questions)</option>
                  {(assignment.questions || []).map((q, i) => (
                    <option key={q.id} value={q.id}>Q{i + 1}: {q.questionText.substring(0, 60)}...</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Correction / Explanation</label>
                <textarea
                  value={correctionForm.correctionText}
                  onChange={(e) => setCorrectionForm({ ...correctionForm, correctionText: e.target.value })}
                  rows={4}
                  className="w-full px-4 py-2 rounded-xl border border-slate-200 outline-none text-sm"
                  placeholder="Explain the correct approach, common mistakes, etc..."
                />
              </div>
              <div className="flex gap-3">
                <button type="submit" className="px-6 py-2 rounded-xl bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600">
                  Post Correction
                </button>
                <button type="button" onClick={() => setShowCorrectionForm(false)} className="px-6 py-2 rounded-xl bg-slate-200 text-slate-600 text-sm">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {assignment.status !== "closed" && (
          <div className="p-4 text-sm text-slate-500">
            ℹ️ Corrections can be posted after the assignment is <strong>closed</strong>.
          </div>
        )}
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
                    <div className="flex items-center gap-2">
                      <span className="px-3 py-1.5 rounded-lg bg-green-100 text-green-700 font-bold text-sm">
                        {sub.score}/{sub.maxScore} ({sub.percentage}%)
                      </span>
                      <button
                        onClick={() => handleViewResults(sub.learnerId)}
                        className="px-3 py-1.5 rounded-lg bg-blue-100 text-blue-600 text-sm font-semibold hover:bg-blue-200"
                      >
                        View Details
                      </button>
                    </div>
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

      {/* Results Modal */}
      {viewingResults && results && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setViewingResults(null)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800">
                 {results.learner?.firstName} {results.learner?.lastName}&apos;s Results
              </h3>
              <button onClick={() => setViewingResults(null)} className="text-slate-400 hover:text-slate-600 text-xl">✕</button>
            </div>

            <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl p-4 mb-4 text-center border border-green-200">
              <p className="text-4xl font-bold text-green-600">{results.score}/{results.maxScore}</p>
              <p className="text-green-500">{results.percentage}%</p>
            </div>

            <div className="space-y-3">
              {(results.answers || []).map((ans: any, i: number) => (
                <div key={i} className={`p-3 rounded-xl border ${ans.isCorrect ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-slate-700">Q{i + 1}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${ans.isCorrect ? "bg-green-200 text-green-700" : "bg-red-200 text-red-700"}`}>
                      {ans.pointsAwarded}/{ans.pointsPossible} pts
                    </span>
                  </div>
                  <p className="text-sm text-slate-700 mb-1">{ans.questionText}</p>
                  <p className="text-xs text-slate-600">
                    <span className="font-semibold">Answer:</span> {ans.answer || "(no answer)"}
                  </p>
                  {!ans.isCorrect && (
                    <p className="text-xs text-green-600 mt-1">
                      <span className="font-semibold">Correct:</span> {ans.correctAnswer}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
