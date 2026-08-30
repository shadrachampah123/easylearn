"use client";

import { use, useEffect, useState } from "react";
import type { FormEvent } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";
import { useRouter } from "next/navigation";

const QUESTION_TYPES = ["mcq", "true_false", "fill_blank", "matching", "short_answer", "essay"] as const;
type QuestionType = (typeof QUESTION_TYPES)[number];
type QuizTab = "details" | "questions";

interface Question {
  id: string;
  questionType: string;
  questionText: string;
  imageUrl?: string | null;
  options: unknown;
  correctAnswer: string | null;
  points: number | null;
}

interface EditableQuestion {
  id?: string;
  questionType: QuestionType;
  questionText: string;
  options: string[];
  correctAnswer: string;
  points: number;
  imageUrl: string;
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
  classId: string;
  subjectId: string;
  className: string | null;
  subjectName: string | null;
  questions: Question[];
  attemptsUsed: number;
  isOwner: boolean;
}

interface QuizEditForm {
  title: string;
  description: string;
  classId: string;
  subjectId: string;
  timeLimitMinutes: number;
  shuffleQuestions: boolean;
  shuffleAnswers: boolean;
  showResults: boolean;
  maxAttempts: number;
  isPublished: boolean;
}

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "My Classes", href: "/dashboard/teacher/classes", icon: "🏫" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "📚" },
  { name: "Attendance", href: "/dashboard/teacher/attendance", icon: "✅" },
];

const questionTypeLabels: Record<QuestionType, string> = {
  mcq: "Multiple Choice",
  true_false: "True/False",
  fill_blank: "Fill in the Blank",
  matching: "Matching",
  short_answer: "Short Answer",
  essay: "Essay",
};

function newQuestion(): EditableQuestion {
  return {
    questionType: "mcq",
    questionText: "",
    options: ["", "", "", ""],
    correctAnswer: "",
    points: 1,
    imageUrl: "",
  };
}

function normaliseQuestion(question: Question): EditableQuestion {
  const questionType = QUESTION_TYPES.includes(question.questionType as QuestionType)
    ? question.questionType as QuestionType
    : "mcq";
  const options = Array.isArray(question.options)
    ? question.options.map((option) => String(option ?? ""))
    : [];

  while (options.length < 4) options.push("");

  return {
    id: question.id,
    questionType,
    questionText: question.questionText || "",
    options,
    correctAnswer: question.correctAnswer || "",
    points: question.points || 1,
    imageUrl: question.imageUrl || "",
  };
}

export default function TeacherQuizDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const router = useRouter();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [editError, setEditError] = useState("");
  const [activeTab, setActiveTab] = useState<QuizTab>("details");
  const [editForm, setEditForm] = useState<QuizEditForm | null>(null);
  const [editQuestions, setEditQuestions] = useState<EditableQuestion[]>([]);

  useEffect(() => {
    void loadQuiz();
  }, [resolvedParams.id]);

  async function loadQuiz(showSpinner = true) {
    if (showSpinner) setLoading(true);
    const token = localStorage.getItem("el_token");
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const [quizRes, classRes, subjectRes] = await Promise.all([
        fetch(`/api/quizzes/${resolvedParams.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch("/api/classes", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/subjects", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const [quizData, classData, subjectData] = await Promise.all([
        quizRes.json(),
        classRes.json(),
        subjectRes.json(),
      ]);

      if (quizData.success) setQuiz(quizData.data);
      if (classData.success) setClasses(classData.data);
      if (subjectData.success) setSubjects(subjectData.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function openEditForm() {
    if (!quiz) return;

    setEditForm({
      title: quiz.title,
      description: quiz.description || "",
      classId: quiz.classId,
      subjectId: quiz.subjectId,
      timeLimitMinutes: quiz.timeLimitMinutes || 0,
      shuffleQuestions: quiz.shuffleQuestions,
      shuffleAnswers: quiz.shuffleAnswers,
      showResults: quiz.showResults,
      maxAttempts: Math.max(1, quiz.maxAttempts || 1, quiz.attemptsUsed || 0),
      isPublished: quiz.isPublished,
    });
    setEditQuestions(quiz.questions.map(normaliseQuestion));
    setEditError("");
    setShowEditForm(true);
  }

  function closeEditForm() {
    if (saving) return;
    setShowEditForm(false);
    setEditError("");
  }

  function addEditQuestion() {
    setEditQuestions((current) => [...current, newQuestion()]);
  }

  function updateEditQuestion(index: number, changes: Partial<EditableQuestion>) {
    setEditQuestions((current) => current.map((question, questionIndex) => (
      questionIndex === index ? { ...question, ...changes } : question
    )));
  }

  function updateEditOption(questionIndex: number, optionIndex: number, value: string) {
    setEditQuestions((current) => current.map((question, index) => {
      if (index !== questionIndex) return question;
      const options = [...question.options];
      options[optionIndex] = value;
      return { ...question, options };
    }));
  }

  function removeEditQuestion(index: number) {
    setEditQuestions((current) => current.filter((_, questionIndex) => questionIndex !== index));
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quiz || !editForm) return;

    const canEditQuestions = quiz.attemptsUsed === 0;
    if (!editForm.title.trim()) {
      setEditError("Quiz title is required.");
      return;
    }
    if (!editForm.classId || !editForm.subjectId) {
      setEditError("Class and subject are required.");
      return;
    }
    if (canEditQuestions && editQuestions.length === 0) {
      setEditError("Add at least one question before saving this quiz.");
      return;
    }
    if (canEditQuestions && editQuestions.some((question) => !question.questionText.trim())) {
      setEditError("Complete every question or remove the empty question before saving.");
      return;
    }

    setSaving(true);
    setEditError("");
    const token = localStorage.getItem("el_token");

    try {
      const body: Record<string, unknown> = {
        title: editForm.title.trim(),
        description: editForm.description.trim() || null,
        classId: editForm.classId,
        subjectId: editForm.subjectId,
        timeLimitMinutes: editForm.timeLimitMinutes > 0 ? editForm.timeLimitMinutes : null,
        shuffleQuestions: editForm.shuffleQuestions,
        shuffleAnswers: editForm.shuffleAnswers,
        showResults: editForm.showResults,
        maxAttempts: Math.max(1, editForm.maxAttempts),
        isPublished: editForm.isPublished,
      };

      // The API protects existing results by rejecting a question replacement after the
      // first attempt. Do not send `questions` in that case so teachers can still update
      // the title, instructions, timing, and publication settings.
      if (canEditQuestions) {
        body.questions = editQuestions.map((question) => ({
          ...question,
          imageUrl: question.imageUrl.trim() || null,
          options: question.questionType === "mcq" ? question.options : question.options.length ? question.options : null,
        }));
      }

      const response = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!data.success) {
        setEditError(data.error || "The quiz could not be updated.");
        return;
      }

      setShowEditForm(false);
      await loadQuiz(false);
    } catch (err) {
      console.error(err);
      setEditError("The quiz could not be updated. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish() {
    if (!quiz) return;
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const response = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // Send only the flag so a quick publish toggle cannot overwrite quiz content.
        body: JSON.stringify({ isPublished: !quiz.isPublished }),
      });
      const data = await response.json();
      if (data.success) {
        setQuiz((current) => current ? { ...current, isPublished: !current.isPublished } : current);
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
      const response = await fetch(`/api/quizzes/${resolvedParams.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
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

  const questionEditingLocked = quiz.attemptsUsed > 0;
  const availableClasses = classes.some((item) => item.id === quiz.classId)
    ? classes
    : [{ id: quiz.classId, name: quiz.className || "Current class" }, ...classes];
  const availableSubjects = subjects.some((item) => item.id === quiz.subjectId)
    ? subjects
    : [{ id: quiz.subjectId, name: quiz.subjectName || "Current subject" }, ...subjects];

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
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <button
            type="button"
            onClick={openEditForm}
            className="px-4 py-2 rounded-xl bg-secondary-600 text-white font-semibold text-sm hover:bg-secondary-700 transition-colors"
          >
            Edit Quiz
          </button>
          <button
            type="button"
            onClick={togglePublish}
            disabled={saving}
            className={`px-4 py-2 rounded-xl font-semibold text-sm transition-colors ${
              quiz.isPublished ? "bg-amber-100 text-amber-700 hover:bg-amber-200" : "bg-green-600 text-white hover:bg-green-700"
            }`}
          >
            {quiz.isPublished ? "Unpublish Quiz" : "Publish Quiz"}
          </button>
          <button
            type="button"
            onClick={deleteQuiz}
            className="px-4 py-2 rounded-xl bg-red-100 text-red-600 font-semibold text-sm hover:bg-red-200 transition-colors"
          >
            Delete Quiz
          </button>
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-200 mb-6">
        {[
          { key: "details" as const, label: "Overview", icon: "📋" },
          { key: "questions" as const, label: `Questions (${quiz.questions.length})`, icon: "❓" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
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
              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-slate-600">Learner Attempts</span>
                <span className="font-semibold text-slate-800">{quiz.attemptsUsed}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "questions" && (
        <div className="space-y-4">
          {quiz.questions.map((question, index) => (
            <div key={question.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 rounded-xl bg-secondary-100 text-secondary-600 flex items-center justify-center font-bold text-sm">
                    {index + 1}
                  </span>
                  <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold">
                    {question.questionType.replace("_", " ").toUpperCase()}
                  </span>
                </div>
                <span className="text-sm font-bold text-slate-600">
                  {question.points || 1} pt{(question.points || 1) > 1 ? "s" : ""}
                </span>
              </div>

              {question.imageUrl && (
                <div className="mb-4 rounded-xl overflow-hidden max-h-64 bg-slate-100 border border-slate-200">
                  <img src={question.imageUrl} alt="Question banner" className="w-full h-full object-cover" />
                </div>
              )}

              <p className="font-semibold text-slate-800 text-lg mb-4">{question.questionText}</p>

              {question.questionType === "mcq" && Array.isArray(question.options) && (
                <div className="grid grid-cols-2 gap-2">
                  {question.options.map((option, optionIndex) => {
                    const letter = String.fromCharCode(65 + optionIndex);
                    const isCorrect = question.correctAnswer === letter;
                    return (
                      <div
                        key={optionIndex}
                        className={`p-3 rounded-xl border flex items-center gap-3 ${
                          isCorrect ? "bg-green-50 border-green-300 text-green-800 font-semibold" : "bg-slate-50 border-slate-200 text-slate-700"
                        }`}
                      >
                        <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold ${
                          isCorrect ? "bg-green-500 text-white" : "bg-slate-200 text-slate-600"
                        }`}>
                          {letter}
                        </span>
                        <span>{String(option)}</span>
                        {isCorrect && <span className="ml-auto text-green-600 text-xs">✓ Correct</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {question.correctAnswer && question.questionType !== "mcq" && (
                <p className="text-sm text-green-600 font-semibold mt-2">
                  Correct Answer: {question.correctAnswer}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {showEditForm && editForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto animate-scale-in">
            <div className="p-6 border-b border-slate-100 sticky top-0 bg-white z-10">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-slate-800">Edit Quiz</h2>
                  <p className="text-sm text-slate-500 mt-1">Update the quiz details, settings, and questions.</p>
                </div>
                <button
                  type="button"
                  onClick={closeEditForm}
                  disabled={saving}
                  className="text-slate-400 hover:text-slate-600 text-2xl disabled:opacity-50"
                  aria-label="Close edit quiz form"
                >
                  &times;
                </button>
              </div>
            </div>

            <form onSubmit={handleEditSubmit} className="p-6 space-y-6">
              {editError && (
                <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700" role="alert">
                  {editError}
                </div>
              )}

              {questionEditingLocked && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                  <strong>Questions are locked.</strong> Learners have already attempted this quiz, so changing its questions would make their results inaccurate. You can still edit the quiz details and settings below.
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="edit-quiz-title">Quiz Title *</label>
                  <input
                    id="edit-quiz-title"
                    type="text"
                    required
                    value={editForm.title}
                    onChange={(event) => setEditForm({ ...editForm, title: event.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="edit-quiz-description">Description / Instructions</label>
                  <textarea
                    id="edit-quiz-description"
                    rows={3}
                    value={editForm.description}
                    onChange={(event) => setEditForm({ ...editForm, description: event.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none resize-none"
                    placeholder="Tell learners what this quiz covers"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="edit-quiz-class">Class *</label>
                  <select
                    id="edit-quiz-class"
                    required
                    value={editForm.classId}
                    onChange={(event) => setEditForm({ ...editForm, classId: event.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="">Select class</option>
                    {availableClasses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="edit-quiz-subject">Subject *</label>
                  <select
                    id="edit-quiz-subject"
                    required
                    value={editForm.subjectId}
                    onChange={(event) => setEditForm({ ...editForm, subjectId: event.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="">Select subject</option>
                    {availableSubjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="edit-time-limit">Time Limit (minutes)</label>
                  <input
                    id="edit-time-limit"
                    type="number"
                    min={0}
                    value={editForm.timeLimitMinutes}
                    onChange={(event) => setEditForm({ ...editForm, timeLimitMinutes: Number(event.target.value) || 0 })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                  <span className="text-xs text-slate-400">Use 0 for no time limit.</span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="edit-max-attempts">Max Attempts</label>
                  <input
                    id="edit-max-attempts"
                    type="number"
                    min={Math.max(1, quiz.attemptsUsed)}
                    value={editForm.maxAttempts}
                    onChange={(event) => setEditForm({ ...editForm, maxAttempts: Number(event.target.value) || 1 })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editForm.isPublished}
                    onChange={(event) => setEditForm({ ...editForm, isPublished: event.target.checked })}
                    className="w-5 h-5 mt-0.5 rounded border-slate-300"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-700">Published to learners</span>
                    <span className="block text-xs text-slate-500">Turn this off to save the quiz as a draft without removing it.</span>
                  </span>
                </label>
                <div className="flex flex-wrap gap-6 pt-2 border-t border-slate-200">
                  <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.shuffleQuestions}
                      onChange={(event) => setEditForm({ ...editForm, shuffleQuestions: event.target.checked })}
                      className="w-4 h-4 rounded border-slate-300"
                    />
                    Shuffle questions
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.shuffleAnswers}
                      onChange={(event) => setEditForm({ ...editForm, shuffleAnswers: event.target.checked })}
                      className="w-4 h-4 rounded border-slate-300"
                    />
                    Shuffle answers
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.showResults}
                      onChange={(event) => setEditForm({ ...editForm, showResults: event.target.checked })}
                      className="w-4 h-4 rounded border-slate-300"
                    />
                    Show results to learners
                  </label>
                </div>
              </div>

              <div className={`border-t border-slate-200 pt-6 ${questionEditingLocked ? "opacity-75" : ""}`}>
                <div className="flex items-center justify-between mb-4 gap-3">
                  <div>
                    <h3 className="font-bold text-lg text-slate-800">Questions ({editQuestions.length})</h3>
                    <p className="text-xs text-slate-500">Click an answer choice to mark it as correct.</p>
                  </div>
                  <button
                    type="button"
                    onClick={addEditQuestion}
                    disabled={questionEditingLocked}
                    className="px-4 py-2 rounded-xl bg-secondary-100 text-secondary-600 font-semibold text-sm hover:bg-secondary-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    + Add Question
                  </button>
                </div>

                <div className="space-y-4">
                  {editQuestions.map((question, questionIndex) => (
                    <div key={question.id || questionIndex} className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                      <div className="flex items-center justify-between mb-3 gap-3">
                        <span className="text-sm font-semibold text-slate-500">Question {questionIndex + 1}</span>
                        <div className="flex items-center gap-2">
                          <select
                            value={question.questionType}
                            disabled={questionEditingLocked}
                            onChange={(event) => updateEditQuestion(questionIndex, { questionType: event.target.value as QuestionType })}
                            className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm disabled:bg-slate-100"
                          >
                            {QUESTION_TYPES.map((type) => <option key={type} value={type}>{questionTypeLabels[type]}</option>)}
                          </select>
                          <input
                            type="number"
                            min={1}
                            value={question.points}
                            disabled={questionEditingLocked}
                            onChange={(event) => updateEditQuestion(questionIndex, { points: Number(event.target.value) || 1 })}
                            className="w-16 px-2 py-1.5 rounded-lg border border-slate-200 text-sm text-center disabled:bg-slate-100"
                            title="Points"
                          />
                          <button
                            type="button"
                            onClick={() => removeEditQuestion(questionIndex)}
                            disabled={questionEditingLocked}
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={`Remove question ${questionIndex + 1}`}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>

                      <textarea
                        value={question.questionText}
                        disabled={questionEditingLocked}
                        onChange={(event) => updateEditQuestion(questionIndex, { questionText: event.target.value })}
                        placeholder="Enter question text..."
                        rows={2}
                        className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm resize-none mb-3 disabled:bg-slate-100"
                      />

                      <input
                        type="url"
                        value={question.imageUrl}
                        disabled={questionEditingLocked}
                        onChange={(event) => updateEditQuestion(questionIndex, { imageUrl: event.target.value })}
                        placeholder="Question image URL (optional)"
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm mb-3 disabled:bg-slate-100"
                      />

                      {question.questionType === "mcq" && (
                        <div className="space-y-2">
                          <label className="text-xs font-medium text-slate-500">Options (click a letter to set the correct answer):</label>
                          {question.options.map((option, optionIndex) => {
                            const letter = String.fromCharCode(65 + optionIndex);
                            return (
                              <div key={optionIndex} className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={questionEditingLocked}
                                  onClick={() => updateEditQuestion(questionIndex, { correctAnswer: letter })}
                                  className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold transition-colors disabled:cursor-not-allowed ${
                                    question.correctAnswer === letter
                                      ? "bg-green-500 text-white"
                                      : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                                  }`}
                                >
                                  {letter}
                                </button>
                                <input
                                  type="text"
                                  value={option}
                                  disabled={questionEditingLocked}
                                  onChange={(event) => updateEditOption(questionIndex, optionIndex, event.target.value)}
                                  placeholder={`Option ${letter}`}
                                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm disabled:bg-slate-100"
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {question.questionType === "true_false" && (
                        <div className="flex gap-3">
                          {(["true", "false"] as const).map((answer) => (
                            <button
                              key={answer}
                              type="button"
                              disabled={questionEditingLocked}
                              onClick={() => updateEditQuestion(questionIndex, { correctAnswer: answer })}
                              className={`flex-1 py-2 rounded-lg font-semibold text-sm capitalize disabled:cursor-not-allowed ${
                                question.correctAnswer === answer ? "bg-green-500 text-white" : "bg-slate-200 text-slate-600"
                              }`}
                            >
                              {answer}
                            </button>
                          ))}
                        </div>
                      )}

                      {question.questionType !== "mcq" && question.questionType !== "true_false" && question.questionType !== "essay" && (
                        <div>
                          <label className="text-xs font-medium text-slate-500 block mb-1">Correct Answer:</label>
                          <input
                            type="text"
                            value={question.correctAnswer}
                            disabled={questionEditingLocked}
                            onChange={(event) => updateEditQuestion(questionIndex, { correctAnswer: event.target.value })}
                            placeholder="Enter correct answer"
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm disabled:bg-slate-100"
                          />
                        </div>
                      )}
                      {question.questionType === "essay" && (
                        <p className="text-xs text-slate-500 bg-white rounded-lg border border-slate-200 px-3 py-2">
                          Essay questions are graded manually. Learners will submit a written response.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={closeEditForm}
                  disabled={saving}
                  className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-3 rounded-xl gradient-secondary text-white font-semibold shadow-lg disabled:opacity-50"
                >
                  {saving ? "Saving..." : questionEditingLocked ? "Save Details" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
