"use client";

import { useEffect, useState, use } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import AttachmentList from "@/components/dashboard/AttachmentList";
import FileUploader, { type StoredAttachment } from "@/components/dashboard/FileUploader";
import { storedAttachments } from "@/lib/uploads";
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

interface Answer {
  id?: string;
  questionId: string;
  answer: string;
  isCorrect: boolean;
  pointsAwarded: number;
  pointsPossible: number;
  correctAnswer: string | null;
  explanation: string | null;
}

interface AiCriterion {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  comment: string;
}

interface AiReport {
  engine: string;
  mode: string;
  percentage: number;
  summary: string;
  criteria: AiCriterion[];
  strengths: string[];
  improvements: string[];
  metrics?: { words: number; sentences: number; paragraphs: number; attachments: number };
}

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  dueDate: string | null;
  maxScore: number;
  allowLate: boolean;
  allowFileUploads: boolean | null;
  attachments: unknown | null;
  aiGradingEnabled: boolean | null;
  aiMaxMarks: number | null;
  className: string | null;
  subjectName: string | null;
  teacherFirstName: string | null;
  teacherLastName: string | null;
  mySubmission: {
    id: string;
    content: string | null;
    attachments: unknown | null;
    status: string;
    score: number | null;
    maxScore: number | null;
    percentage: number | null;
    feedback: string | null;
    gradedBy: string | null;
    aiReport: AiReport | null;
    submittedAt: string | null;
  } | null;
  questions: Question[];
  myAnswers: Answer[];
  corrections: {
    id: string;
    questionId: string | null;
    correctionText: string;
    postedAt: string;
    teacherName: string | null;
    teacherLastName: string | null;
  }[];
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "" },
];

export default function LearnerAssignmentPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeContent, setFreeContent] = useState("");
  const [results, setResults] = useState<any>(null);
  const [showCorrections, setShowCorrections] = useState(false);
  const [attachments, setAttachments] = useState<StoredAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);

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
          setFreeContent(data.data.mySubmission.content);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function setAnswer(questionId: string, value: string) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const hasQuestions = assignment?.questions && assignment.questions.length > 0;

    if (hasQuestions) {
      // Check all questions are answered
      const unanswered = assignment!.questions.filter((q) => !answers[q.id]?.trim());
      if (unanswered.length > 0) {
        if (!confirm(`${unanswered.length} question(s) unanswered. Submit anyway?`)) {
          return;
        }
      }
    } else {
      const hasFiles = attachments.length > 0;
      if (!freeContent.trim() && !hasFiles) {
        alert("Please enter your answer or attach a file");
        return;
      }
    }

    setSubmitting(true);
    const token = localStorage.getItem("el_token");

    try {
      const res = await fetch(`/api/assignments/${resolvedParams.id}/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          answers: hasQuestions ? answers : undefined,
          content: hasQuestions ? undefined : freeContent,
          attachments: attachments.length > 0 ? attachments : undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setAttachments([]);
        setResults(data.data.results);
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
  const hasQuestions = assignment.questions && assignment.questions.length > 0;
  const totalQuestionPoints = assignment.questions?.reduce((sum, q) => sum + (q.points || 1), 0) || 0;

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
                  <span> {assignment.subjectName}</span>
                  <span>🏫 {assignment.className}</span>
                  <span>👩‍🏫 {assignment.teacherFirstName} {assignment.teacherLastName}</span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className="px-3 py-1.5 rounded-xl bg-accent-100 text-accent-700 font-bold text-lg">
                  {hasQuestions ? `${totalQuestionPoints} pts` : `${assignment.aiGradingEnabled ? assignment.aiMaxMarks : assignment.maxScore} pts`}
                </span>
                {assignment.aiGradingEnabled && (
                  <span
                    title="Your submission will be evaluated instantly by EasyAI"
                    className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-violet-100 text-violet-700 border border-violet-200"
                  >
                    ✨ Graded by EasyAI
                  </span>
                )}
              </div>
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

            {storedAttachments(assignment.attachments).length > 0 && (
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 mt-4">
                <h3 className="font-semibold text-slate-700 mb-3 flex items-center gap-2">
                  <span>📎</span> Assignment Files
                  <span className="text-xs font-normal text-slate-400">
                    ({storedAttachments(assignment.attachments).length} file
                    {storedAttachments(assignment.attachments).length === 1 ? "" : "s"})
                  </span>
                </h3>
                <AttachmentList attachments={assignment.attachments} />
              </div>
            )}
          </div>

          {/* Results - graded free-text submission (e.g. graded by EasyAI or the teacher) */}
          {isGraded && !hasQuestions ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                <span>📊</span> Your Results
                {assignment.mySubmission?.gradedBy === "easyai" && (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-violet-100 text-violet-700 border border-violet-200">
                    ✨ Graded by EasyAI
                  </span>
                )}
              </h2>

              <div className="flex items-center justify-center gap-4 mb-6 p-6 rounded-xl bg-gradient-to-br from-violet-50 to-indigo-50 border border-violet-200">
                <div className="text-center">
                  <p className="text-4xl font-bold text-violet-600">
                    {assignment.mySubmission?.score}/{assignment.mySubmission?.maxScore}
                  </p>
                  <p className="text-sm text-violet-500">{assignment.mySubmission?.percentage}%</p>
                </div>
                <div className="text-6xl">
                  {(assignment.mySubmission?.percentage || 0) >= 90 ? "" :
                   (assignment.mySubmission?.percentage || 0) >= 70 ? "⭐" :
                   (assignment.mySubmission?.percentage || 0) >= 50 ? "👍" : ""}
                </div>
              </div>

              <p className="text-sm text-slate-500 text-center mb-6">
                Submitted on {assignment.mySubmission?.submittedAt ? new Date(assignment.mySubmission.submittedAt).toLocaleString() : "N/A"}
                {assignment.mySubmission?.gradedBy === "easyai" ? " · graded instantly by EasyAI" : ""}
              </p>

              {assignment.mySubmission?.feedback && (
                <div className={`p-4 rounded-xl border mb-4 ${
                  assignment.mySubmission?.gradedBy === "easyai"
                    ? "bg-violet-50 border-violet-200"
                    : "bg-slate-50 border-slate-200"
                }`}>
                  <h3 className="font-semibold text-slate-700 mb-2">
                    {assignment.mySubmission?.gradedBy === "easyai" ? "✨ EasyAI Feedback" : "Teacher Feedback"}
                  </h3>
                  <p className="text-slate-600 text-sm whitespace-pre-wrap">{assignment.mySubmission.feedback}</p>
                </div>
              )}

              {assignment.mySubmission?.aiReport && (assignment.mySubmission.aiReport.criteria || []).length > 0 && (
                <div className="space-y-3 mb-4">
                  <h3 className="font-semibold text-slate-700">EasyAI Marking Breakdown</h3>
                  {assignment.mySubmission.aiReport.criteria.map((c) => {
                    const ratio = c.maxScore > 0 ? c.score / c.maxScore : 0;
                    return (
                      <div key={c.key} className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-slate-700">{c.label}</span>
                          <span className={`px-2 py-1 rounded-lg text-xs font-bold ${
                            ratio >= 0.75 ? "bg-green-200 text-green-700" :
                            ratio >= 0.5 ? "bg-yellow-100 text-yellow-700" :
                            "bg-red-100 text-red-700"
                          }`}>
                            {c.score}/{c.maxScore}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-200 overflow-hidden mb-2">
                          <div
                            className={`h-full rounded-full ${ratio >= 0.75 ? "bg-green-500" : ratio >= 0.5 ? "bg-yellow-500" : "bg-red-400"}`}
                            style={{ width: `${Math.round(ratio * 100)}%` }}
                          />
                        </div>
                        <p className="text-xs text-slate-500">{c.comment}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              {assignment.mySubmission?.aiReport && (assignment.mySubmission.aiReport.improvements || []).length > 0 && (
                <div className="p-4 rounded-xl bg-blue-50 border border-blue-100 mb-4">
                  <h3 className="font-semibold text-blue-800 mb-2">💡 How to Improve</h3>
                  <ul className="text-sm text-blue-700 space-y-1 list-disc list-inside">
                    {assignment.mySubmission.aiReport.improvements.map((tip, i) => (
                      <li key={i}>{tip}</li>
                    ))}
                  </ul>
                </div>
              )}

              {assignment.mySubmission?.content && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <h3 className="font-semibold text-slate-700 mb-2">Your Answer</h3>
                  <p className="text-slate-600 text-sm whitespace-pre-wrap">{assignment.mySubmission.content}</p>
                </div>
              )}

              {storedAttachments(assignment.mySubmission?.attachments).length > 0 && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 mt-4">
                  <h3 className="font-semibold text-slate-700 mb-2">
                    📎 Your uploaded files ({storedAttachments(assignment.mySubmission?.attachments).length})
                  </h3>
                  <AttachmentList attachments={assignment.mySubmission?.attachments} compact />
                </div>
              )}
            </div>
          ) : isSubmitted && hasQuestions ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                <span>📊</span> Your Results
                {assignment.mySubmission?.gradedBy === "easyai" && (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-violet-100 text-violet-700 border border-violet-200">
                    ✨ Graded by EasyAI
                  </span>
                )}
              </h2>

              <div className="flex items-center justify-center gap-4 mb-6 p-6 rounded-xl bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200">
                <div className="text-center">
                  <p className="text-4xl font-bold text-green-600">
                    {assignment.mySubmission?.score}/{assignment.mySubmission?.maxScore}
                  </p>
                  <p className="text-sm text-green-500">{assignment.mySubmission?.percentage}%</p>
                </div>
                <div className="text-6xl">
                  {(assignment.mySubmission?.percentage || 0) >= 90 ? "" :
                   (assignment.mySubmission?.percentage || 0) >= 70 ? "⭐" :
                   (assignment.mySubmission?.percentage || 0) >= 50 ? "👍" : ""}
                </div>
              </div>

              {assignment.mySubmission?.feedback && (
                <div className={`p-4 rounded-xl border mb-4 ${
                  assignment.mySubmission?.gradedBy === "easyai"
                    ? "bg-violet-50 border-violet-200"
                    : "bg-slate-50 border-slate-200"
                }`}>
                  <h3 className="font-semibold text-slate-700 mb-2">
                    {assignment.mySubmission?.gradedBy === "easyai" ? "✨ EasyAI Feedback" : "Teacher Feedback"}
                  </h3>
                  <p className="text-slate-600 text-sm whitespace-pre-wrap">{assignment.mySubmission.feedback}</p>
                </div>
              )}

              {/* Per-question breakdown */}
              {(assignment.myAnswers || []).length > 0 ? (
                <div className="space-y-3">
                  <h3 className="font-semibold text-slate-700">Question Breakdown</h3>
                  {(assignment.myAnswers || []).map((ans, i) => {
                    const q = assignment.questions?.find((qq) => qq.id === ans.questionId);
                    return (
                      <div
                        key={ans.id || i}
                        className={`p-4 rounded-xl border ${
                          ans.isCorrect ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-600 text-xs font-semibold">
                              Q{i + 1}
                            </span>
                            <span className="text-xs text-slate-500">{q?.questionType}</span>
                          </div>
                          <span className={`px-2 py-1 rounded-lg text-xs font-bold ${
                            ans.isCorrect ? "bg-green-200 text-green-700" : "bg-red-200 text-red-700"
                          }`}>
                            {ans.isCorrect ? "✓ Correct" : "✗ Wrong"} ({ans.pointsAwarded}/{ans.pointsPossible})
                          </span>
                        </div>
                        <p className="text-sm font-medium text-slate-700 mb-2">{q?.questionText}</p>
                        <p className="text-xs text-slate-600 mb-1">
                          <span className="font-semibold">Your answer:</span> {ans.answer || "(no answer)"}
                        </p>
                        {!ans.isCorrect && (
                          <>
                            <p className="text-xs text-green-600 mb-1">
                              <span className="font-semibold">Correct answer:</span> {ans.correctAnswer}
                            </p>
                            {ans.explanation && (
                              <p className="text-xs text-blue-600">
                                <span className="font-semibold">Explanation:</span> {ans.explanation}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : isSubmitted && hasQuestions ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <div className="text-center py-8">
                <div className="text-6xl mb-4">✅</div>
                <h2 className="text-xl font-bold text-slate-800 mb-2">Assignment Auto-Graded!</h2>
                <p className="text-slate-500 text-sm mb-4">
                  Submitted on {assignment.mySubmission?.submittedAt ? new Date(assignment.mySubmission.submittedAt).toLocaleString() : "N/A"}
                </p>
                <div className="inline-block p-4 rounded-xl bg-green-50 border border-green-200">
                  <p className="text-3xl font-bold text-green-600">
                    {assignment.mySubmission?.score}/{assignment.mySubmission?.maxScore}
                  </p>
                  <p className="text-sm text-green-500">{assignment.mySubmission?.percentage}%</p>
                </div>
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
              {assignment.mySubmission?.content && (
                <div className="mt-4 p-4 rounded-xl bg-slate-50">
                  <h3 className="font-semibold text-slate-700 mb-2">Your Answer</h3>
                  <p className="text-slate-600 text-sm whitespace-pre-wrap">{assignment.mySubmission.content}</p>
                </div>
              )}
              {storedAttachments(assignment.mySubmission?.attachments).length > 0 && (
                <div className="mt-4 p-4 rounded-xl bg-slate-50">
                  <h3 className="font-semibold text-slate-700 mb-2">
                    📎 Your uploaded files ({storedAttachments(assignment.mySubmission?.attachments).length})
                  </h3>
                  <AttachmentList attachments={assignment.mySubmission?.attachments} compact />
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
                <span>✏️</span> {hasQuestions ? "Answer the Questions" : "Your Answer"}
              </h2>

              {!canSubmit && (
                <div className="mb-4 p-4 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
                  ⚠️ This assignment is overdue and late submissions are not allowed.
                </div>
              )}

              {hasQuestions ? (
                /* Question-based form */
                <div className="space-y-6">
                  {assignment.questions
                    .sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0))
                    .map((q, i) => (
                      <div key={q.id} className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="px-2 py-0.5 rounded bg-accent-100 text-accent-700 text-xs font-bold">Q{i + 1}</span>
                          <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-600 text-xs">{q.questionType}</span>
                          <span className="px-2 py-0.5 rounded bg-green-100 text-green-600 text-xs">{q.points} pts</span>
                        </div>
                        <p className="font-medium text-slate-700 mb-3">{q.questionText}</p>

                        {q.questionType === "mcq" && q.options && (
                          <div className="space-y-2">
                            {q.options.map((opt, j) => (
                              <label key={j} className="flex items-center gap-3 p-3 rounded-lg bg-white border border-slate-200 cursor-pointer hover:border-accent-300 transition-colors">
                                <input
                                  type="radio"
                                  name={`question-${q.id}`}
                                  value={opt}
                                  checked={answers[q.id] === opt}
                                  onChange={() => setAnswer(q.id, opt)}
                                  className="w-4 h-4 text-accent-500"
                                />
                                <span className="text-sm text-slate-700">{opt}</span>
                              </label>
                            ))}
                          </div>
                        )}

                        {q.questionType === "true_false" && (
                          <div className="flex gap-3">
                            {["true", "false"].map((val) => (
                              <label key={val} className={`flex-1 p-3 rounded-lg border text-center cursor-pointer transition-colors ${
                                answers[q.id] === val
                                  ? "bg-accent-50 border-accent-300 text-accent-700 font-semibold"
                                  : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                              }`}>
                                <input
                                  type="radio"
                                  name={`question-${q.id}`}
                                  value={val}
                                  checked={answers[q.id] === val}
                                  onChange={() => setAnswer(q.id, val)}
                                  className="hidden"
                                />
                                {val === "true" ? "✓ True" : "✗ False"}
                              </label>
                            ))}
                          </div>
                        )}

                        {(q.questionType === "fill_blank" || q.questionType === "short_answer") && (
                          <input
                            type="text"
                            value={answers[q.id] || ""}
                            onChange={(e) => setAnswer(q.id, e.target.value)}
                            disabled={!canSubmit}
                            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-accent-500 focus:border-transparent outline-none disabled:bg-slate-100"
                            placeholder={q.questionType === "fill_blank" ? "Fill in the blank..." : "Type your answer..."}
                          />
                        )}

                        {q.questionType === "essay" && (
                          <textarea
                            value={answers[q.id] || ""}
                            onChange={(e) => setAnswer(q.id, e.target.value)}
                            rows={4}
                            disabled={!canSubmit}
                            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-accent-500 focus:border-transparent outline-none resize-none disabled:bg-slate-100"
                            placeholder="Type your answer here..."
                          />
                        )}
                      </div>
                    ))}
                </div>
              ) : (
                /* Free-text form */
                <div>
                  {assignment.aiGradingEnabled && (
                    <div className="mb-4 p-4 rounded-xl bg-violet-50 border border-violet-200 text-sm text-violet-700">
                      ✨ <span className="font-semibold">EasyAI will grade this the moment you submit</span> — out of{" "}
                      {assignment.aiMaxMarks ?? assignment.maxScore} total marks set by your teacher.
                    </div>
                  )}
                  <textarea
                    value={freeContent}
                    onChange={(e) => setFreeContent(e.target.value)}
                    rows={10}
                    disabled={!canSubmit}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-accent-500 focus:border-transparent outline-none resize-none disabled:bg-slate-100 disabled:text-slate-400"
                    placeholder="Type your answer here..."
                  />
                </div>
              )}

              {/* File uploads: only when the teacher explicitly enabled them */}
              {assignment.allowFileUploads ? (
                <div className="mt-4 p-4 rounded-xl border border-slate-200 bg-slate-50/60">
                  <p className="text-sm font-semibold text-slate-800 mb-0.5">📎 Attach files (optional)</p>
                  <p className="text-xs text-slate-500 mb-3">
                    Upload documents, PDFs, images, audio or videos from your device. Videos: max 100 MB · other files: max 50 MB.
                  </p>
                  <FileUploader
                    purpose="submission"
                    assignmentId={assignment.id}
                    value={attachments}
                    onChange={setAttachments}
                    onUploadingChange={setUploadingFiles}
                    disabled={!canSubmit}
                  />
                </div>
              ) : (
                <div className="mt-4 p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-700">
                  📎 Your teacher has <span className="font-semibold">not enabled file uploads</span> for this
                  assignment, so you can only submit a written answer.
                </div>
              )}

              <div className="mt-4 flex gap-3">
                <button
                  type="submit"
                  disabled={!canSubmit || submitting || uploadingFiles}
                  className="flex-1 py-3 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white font-semibold shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting
                    ? "Submitting..."
                    : uploadingFiles
                      ? "Uploading files..."
                      : hasQuestions
                        ? "Submit & Auto-Grade 🚀"
                        : assignment.aiGradingEnabled
                          ? "Submit & Get AI Marks ✨"
                          : "Submit Assignment 🚀"}
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
          <div className={`p-5 rounded-2xl text-white ${assignment.aiGradingEnabled ? "bg-gradient-to-br from-violet-500 to-indigo-600" : "bg-gradient-to-br from-accent-500 to-accent-600"}`}>
            <h3 className={`font-semibold text-sm mb-1 ${assignment.aiGradingEnabled ? "text-violet-100" : "text-accent-100"}`}>
              {hasQuestions ? "Total Points" : assignment.aiGradingEnabled ? "EasyAI Total Marks" : "Maximum Points"}
            </h3>
            <p className="font-bold text-3xl">
              {hasQuestions ? totalQuestionPoints : assignment.aiGradingEnabled ? (assignment.aiMaxMarks ?? assignment.maxScore) : assignment.maxScore}
            </p>
            {assignment.aiGradingEnabled && (
              <p className="text-xs text-violet-100 mt-1">
                ✨ Marks awarded instantly by EasyAI
              </p>
            )}
            {hasQuestions && !assignment.aiGradingEnabled && (
              <p className="text-xs text-accent-100 mt-1">
                {assignment.questions?.length || 0} question{assignment.questions?.length !== 1 ? "s" : ""}
              </p>
            )}
          </div>

          {/* Corrections */}
          {assignment.corrections && assignment.corrections.length > 0 && (
            <div className="p-5 rounded-2xl bg-amber-50 border border-amber-200">
              <h3 className="font-semibold text-amber-800 mb-2 flex items-center gap-2 cursor-pointer" onClick={() => setShowCorrections(!showCorrections)}>
                <span></span> Teacher Corrections ({assignment.corrections.length})
              </h3>
              {showCorrections && (
                <div className="space-y-3 mt-3">
                  {assignment.corrections.map((c) => (
                    <div key={c.id} className="p-3 rounded-lg bg-white border border-amber-100">
                      <p className="text-sm text-slate-700 whitespace-pre-wrap">{c.correctionText}</p>
                      <p className="text-xs text-slate-400 mt-1">
                        {c.teacherName} {c.teacherLastName} · {new Date(c.postedAt).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tips Card */}
          <div className="p-5 rounded-2xl bg-yellow-50 border border-yellow-200">
            <h3 className="font-semibold text-slate-700 mb-2 flex items-center gap-2">
              <span>💡</span> Tips
            </h3>
            <ul className="text-sm text-slate-600 space-y-1">
              <li>• Read all instructions carefully</li>
              <li>• Answer all questions for full marks</li>
              <li>• Submit before the deadline</li>
              <li>• Results are instant for auto-graded questions</li>
            </ul>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
