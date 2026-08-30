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
  className: string | null;
  subjectName: string | null;
  createdAt: string;
}

interface Question {
  questionType: string;
  questionText: string;
  options: string[];
  correctAnswer: string;
  points: number;
  imageUrl: string;
}

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "My Classes", href: "/dashboard/teacher/classes", icon: "🏫" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "📚" },
  { name: "Attendance", href: "/dashboard/teacher/attendance", icon: "✅" },
];

export default function TeacherQuizzesPage() {
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    classId: "",
    subjectId: "",
    timeLimitMinutes: 30,
    shuffleQuestions: false,
    shuffleAnswers: false,
    maxAttempts: 1,
    isPublished: true,
  });
  const [questions, setQuestions] = useState<Question[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    if (!token) return;

    try {
      const [quizRes, classRes, subjectRes] = await Promise.all([
        fetch("/api/quizzes", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/classes", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/subjects", { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const quizData = await quizRes.json();
      const classData = await classRes.json();
      const subjectData = await subjectRes.json();

      if (quizData.success) setQuizzes(quizData.data);
      if (classData.success) setClasses(classData.data);
      if (subjectData.success) setSubjects(subjectData.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function addQuestion() {
    setQuestions([
      ...questions,
      { questionType: "mcq", questionText: "", options: ["", "", "", ""], correctAnswer: "", points: 1, imageUrl: "" },
    ]);
  }

  function updateQuestion(index: number, field: keyof Question, value: string | string[] | number) {
    const updated = [...questions];
    if (field === "questionType" || field === "questionText" || field === "correctAnswer" || field === "imageUrl") {
      updated[index][field] = value as string;
    } else if (field === "options") {
      updated[index][field] = value as string[];
    } else if (field === "points") {
      updated[index][field] = value as number;
    }
    setQuestions(updated);
  }

  function updateOption(qIndex: number, oIndex: number, value: string) {
    const updated = [...questions];
    updated[qIndex].options[oIndex] = value;
    setQuestions(updated);
  }

  function removeQuestion(index: number) {
    setQuestions(questions.filter((_, i) => i !== index));
  }

  async function togglePublish(quiz: Quiz, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isPublished: !quiz.isPublished }),
      });
      const data = await res.json();
      if (data.success) {
        setQuizzes((prev) => prev.map((q) => (q.id === quiz.id ? { ...q, isPublished: !q.isPublished } : q)));
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (questions.length === 0) {
      alert("Please add at least one question");
      return;
    }
    setSaving(true);

    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/quizzes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          questions: questions.map((q) => ({ ...q, imageUrl: q.imageUrl.trim() || null })),
        }),
      });

      const data = await res.json();
      if (data.success) {
        setShowForm(false);
        setFormData({
          title: "",
          description: "",
          classId: "",
          subjectId: "",
          timeLimitMinutes: 30,
          shuffleQuestions: false,
          shuffleAnswers: false,
          maxAttempts: 1,
          isPublished: true,
        });
        setQuestions([]);
        loadData();
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Quizzes</h1>
          <p className="text-sm text-slate-500">Create quizzes with auto-grading</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-5 py-2.5 rounded-xl gradient-secondary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center gap-2"
        >
          <span>+</span> Create Quiz
        </button>
      </div>

      {/* Create Quiz Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto animate-scale-in">
            <div className="p-6 border-b border-slate-100 sticky top-0 bg-white z-10">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-800">Create Quiz</h2>
                <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
              </div>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-6">
              {/* Quiz Details */}
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Quiz Title *</label>
                  <input
                    type="text"
                    required
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                    placeholder="e.g., Science Quiz - Chapter 3"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Class *</label>
                  <select
                    required
                    value={formData.classId}
                    onChange={(e) => setFormData({ ...formData, classId: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="">Select class</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Subject *</label>
                  <select
                    required
                    value={formData.subjectId}
                    onChange={(e) => setFormData({ ...formData, subjectId: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="">Select subject</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Time Limit (minutes)</label>
                  <input
                    type="number"
                    value={formData.timeLimitMinutes}
                    onChange={(e) => setFormData({ ...formData, timeLimitMinutes: parseInt(e.target.value) || 30 })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Max Attempts</label>
                  <input
                    type="number"
                    min={1}
                    value={formData.maxAttempts}
                    onChange={(e) => setFormData({ ...formData, maxAttempts: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isPublished}
                    onChange={(e) => setFormData({ ...formData, isPublished: e.target.checked })}
                    className="w-5 h-5 mt-0.5 rounded border-slate-300"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-700">Publish to learners immediately</span>
                    <span className="block text-xs text-slate-500">
                      Learners only see published quizzes. Leave this off to keep the quiz as a draft and publish it later.
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={formData.shuffleQuestions}
                    onChange={(e) => setFormData({ ...formData, shuffleQuestions: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300"
                  />
                  Shuffle questions
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={formData.shuffleAnswers}
                    onChange={(e) => setFormData({ ...formData, shuffleAnswers: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300"
                  />
                  Shuffle answers
                </label>
              </div>

              {/* Questions */}
              <div className="border-t border-slate-200 pt-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-lg text-slate-800">Questions ({questions.length})</h3>
                  <button
                    type="button"
                    onClick={addQuestion}
                    className="px-4 py-2 rounded-xl bg-secondary-100 text-secondary-600 font-semibold text-sm hover:bg-secondary-200"
                  >
                    + Add Question
                  </button>
                </div>

                {questions.length === 0 ? (
                  <div className="text-center py-8 bg-slate-50 rounded-xl text-slate-500">
                    Click &ldquo;Add Question&rdquo; to start building your quiz
                  </div>
                ) : (
                  <div className="space-y-4">
                    {questions.map((q, qIdx) => (
                      <div key={qIdx} className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-semibold text-slate-500">Question {qIdx + 1}</span>
                          <div className="flex items-center gap-2">
                            <select
                              value={q.questionType}
                              onChange={(e) => updateQuestion(qIdx, "questionType", e.target.value)}
                              className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm"
                            >
                              <option value="mcq">Multiple Choice</option>
                              <option value="true_false">True/False</option>
                              <option value="fill_blank">Fill in the Blank</option>
                              <option value="short_answer">Short Answer</option>
                            </select>
                            <input
                              type="number"
                              min={1}
                              value={q.points}
                              onChange={(e) => updateQuestion(qIdx, "points", parseInt(e.target.value) || 1)}
                              className="w-16 px-2 py-1.5 rounded-lg border border-slate-200 text-sm text-center"
                              title="Points"
                            />
                            <button
                              type="button"
                              onClick={() => removeQuestion(qIdx)}
                              className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"
                            >
                              🗑️
                            </button>
                          </div>
                        </div>

                        <textarea
                          value={q.questionText}
                          onChange={(e) => updateQuestion(qIdx, "questionText", e.target.value)}
                          placeholder="Enter question text..."
                          rows={2}
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm resize-none mb-3"
                        />

                        <input
                          type="url"
                          value={q.imageUrl}
                          onChange={(e) => updateQuestion(qIdx, "imageUrl", e.target.value)}
                          placeholder="Question image URL (optional) — shown above the question"
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm mb-3"
                        />

                        {q.questionType === "mcq" && (
                          <div className="space-y-2">
                            <label className="text-xs font-medium text-slate-500">Options (click to set correct answer):</label>
                            {q.options.map((opt, oIdx) => (
                              <div key={oIdx} className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => updateQuestion(qIdx, "correctAnswer", String.fromCharCode(65 + oIdx))}
                                  className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold transition-colors ${
                                    q.correctAnswer === String.fromCharCode(65 + oIdx)
                                      ? "bg-green-500 text-white"
                                      : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                                  }`}
                                >
                                  {String.fromCharCode(65 + oIdx)}
                                </button>
                                <input
                                  type="text"
                                  value={opt}
                                  onChange={(e) => updateOption(qIdx, oIdx, e.target.value)}
                                  placeholder={`Option ${String.fromCharCode(65 + oIdx)}`}
                                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                />
                              </div>
                            ))}
                          </div>
                        )}

                        {q.questionType === "true_false" && (
                          <div className="flex gap-3">
                            <button
                              type="button"
                              onClick={() => updateQuestion(qIdx, "correctAnswer", "true")}
                              className={`flex-1 py-2 rounded-lg font-semibold text-sm ${
                                q.correctAnswer === "true" ? "bg-green-500 text-white" : "bg-slate-200 text-slate-600"
                              }`}
                            >
                              True
                            </button>
                            <button
                              type="button"
                              onClick={() => updateQuestion(qIdx, "correctAnswer", "false")}
                              className={`flex-1 py-2 rounded-lg font-semibold text-sm ${
                                q.correctAnswer === "false" ? "bg-green-500 text-white" : "bg-slate-200 text-slate-600"
                              }`}
                            >
                              False
                            </button>
                          </div>
                        )}

                        {(q.questionType === "fill_blank" || q.questionType === "short_answer") && (
                          <div>
                            <label className="text-xs font-medium text-slate-500 block mb-1">Correct Answer:</label>
                            <input
                              type="text"
                              value={q.correctAnswer}
                              onChange={(e) => updateQuestion(qIdx, "correctAnswer", e.target.value)}
                              placeholder="Enter correct answer"
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-4 border-t border-slate-200">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-secondary text-white font-semibold shadow-lg disabled:opacity-50">
                  {saving ? "Creating..." : "Create Quiz"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Quizzes List */}
      {loading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse">
              <div className="h-5 bg-slate-200 rounded w-1/3 mb-3" />
              <div className="h-4 bg-slate-100 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : quizzes.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">❓</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No quizzes yet</h3>
          <p className="text-slate-500 text-sm mb-6">Create your first quiz with auto-grading</p>
          <button onClick={() => setShowForm(true)} className="px-6 py-3 rounded-xl gradient-secondary text-white font-semibold">
            Create Quiz
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {quizzes.map((quiz) => (
            <div
              key={quiz.id}
              className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md hover:border-secondary-200 transition-all group"
            >
              <div className="flex items-start justify-between gap-4">
                <Link href={`/dashboard/teacher/quizzes/${quiz.id}`} className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-bold text-lg text-slate-800 group-hover:text-secondary-600 transition-colors">
                      {quiz.title}
                    </h3>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                      quiz.isPublished ? "bg-green-100 text-green-600" : "bg-slate-100 text-slate-600"
                    }`}>
                      {quiz.isPublished ? "Published" : "Draft"}
                    </span>
                  </div>
                  <p className="text-slate-500 text-sm mb-3 line-clamp-2">{quiz.description || "No description"}</p>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <span>🏫</span> {quiz.className}
                    </span>
                    <span className="flex items-center gap-1">
                      <span>📚</span> {quiz.subjectName}
                    </span>
                    <span className="flex items-center gap-1">
                      <span>❓</span> {quiz.questionCount} questions
                    </span>
                    {quiz.timeLimitMinutes && (
                      <span className="flex items-center gap-1">
                        <span>⏱️</span> {quiz.timeLimitMinutes} min
                      </span>
                    )}
                  </div>
                </Link>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={(e) => togglePublish(quiz, e)}
                    title={quiz.isPublished ? "Hide from learners" : "Show to learners"}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                      quiz.isPublished
                        ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                        : "bg-green-600 text-white hover:bg-green-700"
                    }`}
                  >
                    {quiz.isPublished ? "Unpublish" : "Publish"}
                  </button>
                  <Link
                    href={`/dashboard/teacher/quizzes/${quiz.id}`}
                    className="px-3 py-2 rounded-xl bg-secondary-50 text-secondary-700 text-sm font-semibold hover:bg-secondary-100 transition-colors"
                  >
                    Edit
                  </Link>
                  <Link
                    href={`/dashboard/teacher/quizzes/${quiz.id}`}
                    className="text-slate-300 group-hover:text-secondary-400 transition-colors text-xl px-1"
                    aria-label={`Open ${quiz.title}`}
                  >
                    →
                  </Link>
                </div>
              </div>

              {!quiz.isPublished && (
                <p className="mt-3 text-xs text-amber-600">
                  Draft — learners cannot see this quiz yet. Publish it to make it appear in their Quizzes list.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
