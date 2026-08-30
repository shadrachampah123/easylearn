"use client";

import { useEffect, useState, use } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Question {
  id: string;
  questionType: string;
  questionText: string;
  imageUrl?: string | null;
  options: string[] | null;
  points: number;
}

interface Quiz {
  id: string;
  title: string;
  description: string | null;
  timeLimitMinutes: number | null;
  showResults: boolean;
  className: string | null;
  subjectName: string | null;
  questions: Question[];
}

interface QuizResult {
  score: number;
  maxScore: number;
  percentage: number;
  pointsEarned: number;
  answers?: Record<string, { answer: string; correct: boolean; points: number; correctAnswer: string | null }>;
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
];

const KAHOOT_COLORS = [
  { bg: "bg-red-500 hover:bg-red-600 text-white", shape: "🔺", border: "border-red-600" },
  { bg: "bg-blue-500 hover:bg-blue-600 text-white", shape: "🔷", border: "border-blue-600" },
  { bg: "bg-amber-500 hover:bg-amber-600 text-white", shape: "🟡", border: "border-amber-600" },
  { bg: "bg-green-500 hover:bg-green-600 text-white", shape: "🟩", border: "border-green-600" },
];

export default function TakeQuizPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loading, setLoading] = useState(true);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [questionTimer, setQuestionTimer] = useState(30); // 30s per question Kahoot style
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [started, setStarted] = useState(false);
  const [feedbackState, setFeedbackState] = useState<"none" | "correct" | "incorrect">("none");
  const [showScoreboard, setShowScoreboard] = useState(false);

  useEffect(() => {
    loadQuiz();
  }, [resolvedParams.id]);

  // Question timer for Kahoot countdown bar
  useEffect(() => {
    if (started && !showScoreboard && !result && questionTimer > 0) {
      const timer = setInterval(() => {
        setQuestionTimer((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            handleNextOrSubmit();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [started, questionTimer, showScoreboard, result]);

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

  async function startQuiz() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/quizzes/${resolvedParams.id}/attempt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setAttemptId(data.data.attempt.id);
        setStarted(true);
        setQuestionTimer(30);
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    }
  }

  function handleSelectAnswer(questionId: string, answerValue: string) {
    setAnswers({ ...answers, [questionId]: answerValue });
    // Kahoot instant visual feedback trigger before scoreboard transition
    setFeedbackState("correct");
    setShowScoreboard(true);
    setTimeout(() => {
      setShowScoreboard(false);
      setFeedbackState("none");
      handleNextOrSubmit();
    }, 1500);
  }

  function handleNextOrSubmit() {
    if (!quiz) return;
    if (currentQuestion < quiz.questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
      setQuestionTimer(30);
    } else {
      handleSubmit();
    }
  }

  async function handleSubmit() {
    if (!attemptId) return;
    setSubmitting(true);

    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/quizzes/${resolvedParams.id}/attempt`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ attemptId, answers }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data.data.results);
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
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="w-8 h-8 border-3 border-accent-200 border-t-accent-600 rounded-full animate-spin" />
        </div>
      </DashboardShell>
    );
  }

  if (!quiz) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="text-center py-16">
          <h2 className="text-xl font-bold text-slate-800">Quiz not found</h2>
          <Link href="/dashboard/learner/quizzes" className="text-accent-600 mt-4 inline-block">
            ← Back to quizzes
          </Link>
        </div>
      </DashboardShell>
    );
  }

  // Show Results
  if (result) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-3xl shadow-lg border border-slate-100 overflow-hidden animate-scale-in">
            <div className={`p-8 text-center ${
              result.percentage >= 80 ? "bg-gradient-to-br from-green-500 to-emerald-600" :
              result.percentage >= 60 ? "bg-gradient-to-br from-yellow-500 to-orange-600" :
              "bg-gradient-to-br from-red-500 to-pink-600"
            } text-white`}>
              <div className="text-6xl mb-4">
                {result.percentage >= 80 ? "🏆" : result.percentage >= 60 ? "⭐" : "🎯"}
              </div>
              <h2 className="text-2xl font-bold mb-2">Kahoot! Scoreboard & Results</h2>
              <div className="text-5xl font-extrabold mb-2">{result.percentage}%</div>
              <p className="text-white/90">
                You scored {result.score} out of {result.maxScore} points
              </p>
              {result.pointsEarned > 0 && (
                <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/20 text-sm font-semibold">
                  <span>⭐</span> +{result.pointsEarned} XP earned!
                </div>
              )}
            </div>

            {/* Review Answers */}
            {result.answers && quiz.showResults && (
              <div className="p-6">
                <h3 className="font-bold text-lg text-slate-800 mb-4">Review Answers</h3>
                <div className="space-y-4">
                  {quiz.questions.map((q, idx) => {
                    const answer = result.answers?.[q.id];
                    return (
                      <div
                        key={q.id}
                        className={`p-4 rounded-xl border-2 ${
                          answer?.correct ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                            answer?.correct ? "bg-green-500" : "bg-red-500"
                          }`}>
                            {answer?.correct ? "✓" : "✗"}
                          </span>
                          <div className="flex-1">
                            <p className="font-medium text-slate-800 mb-2">
                              {idx + 1}. {q.questionText}
                            </p>
                            <p className="text-sm text-slate-600">
                              Your answer: <span className="font-semibold">{answer?.answer || "No answer"}</span>
                            </p>
                            {!answer?.correct && answer?.correctAnswer && (
                              <p className="text-sm text-green-600 mt-1">
                                Correct answer: <span className="font-semibold">{answer.correctAnswer}</span>
                              </p>
                            )}
                          </div>
                          <span className="text-sm font-bold text-slate-600">
                            {answer?.points}/{q.points}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="p-6 border-t border-slate-100">
              <Link
                href="/dashboard/learner/quizzes"
                className="block w-full py-3 text-center rounded-xl bg-accent-500 text-white font-semibold hover:bg-accent-600 transition-colors shadow-md"
              >
                Back to Quizzes
              </Link>
            </div>
          </div>
        </div>
      </DashboardShell>
    );
  }

  // Show Start Screen
  if (!started) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="max-w-2xl mx-auto">
          <Link href="/dashboard/learner/quizzes" className="text-slate-500 text-sm hover:text-accent-600 mb-4 inline-block">
            ← Back to quizzes
          </Link>

          <div className="bg-white rounded-3xl shadow-lg border border-slate-100 p-8 text-center">
            <div className="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white text-4xl mb-6 shadow-lg">
              🎮
            </div>

            <h1 className="text-2xl font-bold text-slate-800 mb-2">{quiz.title}</h1>
            <p className="text-slate-500 mb-6">{quiz.description || "Kahoot-style interactive quiz!"}</p>

            <div className="grid grid-cols-3 gap-4 mb-8">
              <div className="p-4 rounded-xl bg-slate-50">
                <div className="text-2xl mb-1">📚</div>
                <div className="text-xs text-slate-500">Subject</div>
                <div className="font-semibold text-sm text-slate-700">{quiz.subjectName}</div>
              </div>
              <div className="p-4 rounded-xl bg-slate-50">
                <div className="text-2xl mb-1">❓</div>
                <div className="text-xs text-slate-500">Questions</div>
                <div className="font-semibold text-sm text-slate-700">{quiz.questions.length}</div>
              </div>
              <div className="p-4 rounded-xl bg-slate-50">
                <div className="text-2xl mb-1">⏱️</div>
                <div className="text-xs text-slate-500">Timer</div>
                <div className="font-semibold text-sm text-slate-700">30s / q</div>
              </div>
            </div>

            <button
              onClick={startQuiz}
              className="w-full py-4 rounded-2xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-bold text-lg shadow-xl hover:scale-[1.02] transition-all"
            >
              Start Kahoot! Quiz 🚀
            </button>
          </div>
        </div>
      </DashboardShell>
    );
  }

  // Scoreboard / Feedback Slide between questions
  if (showScoreboard) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="max-w-2xl mx-auto py-16 text-center animate-scale-in">
          <div className="w-24 h-24 mx-auto rounded-full bg-green-500 text-white text-5xl flex items-center justify-center mb-6 shadow-lg animate-bounce">
            ✓
          </div>
          <h2 className="text-3xl font-extrabold text-slate-800 mb-2">Answer Recorded!</h2>
          <p className="text-slate-500 text-lg">Transitioning to next question...</p>
        </div>
      </DashboardShell>
    );
  }

  // Quiz in progress - Kahoot interactive layout
  const question = quiz.questions[currentQuestion];
  const progressPercent = (questionTimer / 30) * 100;

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="max-w-4xl mx-auto">
        {/* Animated Countdown Timer Bar at Top */}
        <div className="mb-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-slate-800">
              Question {currentQuestion + 1} of {quiz.questions.length}
            </span>
            <div className="px-4 py-1.5 rounded-full bg-purple-100 text-purple-700 font-mono font-bold text-sm">
              ⏱️ {questionTimer}s
            </div>
          </div>
          <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-green-400 via-yellow-400 to-red-500 transition-all duration-1000 linear"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Question Card with Image Banner & Question Text */}
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-8 mb-6 text-center">
          {question.imageUrl && (
            <div className="mb-6 rounded-2xl overflow-hidden max-h-80 bg-slate-100 border border-slate-200 shadow-sm">
              <img src={question.imageUrl} alt="Question banner" className="w-full h-full object-cover" />
            </div>
          )}

          <h2 className="text-2xl md:text-3xl font-extrabold text-slate-800 mb-8">
            {question.questionText}
          </h2>

          {/* 2x2 Grid of Large, Colorful, Rounded Cards for Multiple Choice */}
          {question.questionType === "mcq" && question.options && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {question.options.map((opt, idx) => {
                const color = KAHOOT_COLORS[idx % KAHOOT_COLORS.length];
                const letter = String.fromCharCode(65 + idx);
                const isSelected = answers[question.id] === letter;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSelectAnswer(question.id, letter)}
                    className={`p-6 rounded-2xl text-left flex items-center gap-4 shadow-md transition-all transform hover:scale-[1.02] active:scale-95 ${color.bg} ${
                      isSelected ? "ring-4 ring-white shadow-2xl scale-[1.02]" : ""
                    }`}
                  >
                    <span className="w-12 h-12 rounded-xl bg-black/20 flex items-center justify-center text-2xl font-extrabold shrink-0">
                      {color.shape}
                    </span>
                    <span className="text-lg font-bold flex-1">{opt}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* True / False */}
          {question.questionType === "true_false" && (
            <div className="grid grid-cols-2 gap-4">
              {["True", "False"].map((opt, idx) => {
                const color = KAHOOT_COLORS[idx];
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => handleSelectAnswer(question.id, opt.toLowerCase())}
                    className={`p-8 rounded-2xl text-center text-xl font-bold shadow-md transition-all transform hover:scale-[1.02] ${color.bg}`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          )}

          {/* Fill in blank / Short answer */}
          {(question.questionType === "fill_blank" || question.questionType === "short_answer") && (
            <div className="space-y-4 max-w-lg mx-auto">
              <input
                type="text"
                value={answers[question.id] || ""}
                onChange={(e) => setAnswers({ ...answers, [question.id]: e.target.value })}
                placeholder="Type your answer here..."
                className="w-full px-6 py-4 rounded-2xl border-2 border-slate-300 focus:border-purple-600 outline-none text-xl text-center font-semibold"
              />
              <button
                type="button"
                onClick={() => handleNextOrSubmit()}
                className="px-8 py-4 rounded-2xl bg-purple-600 text-white font-bold text-lg shadow-lg hover:bg-purple-700 transition-colors w-full"
              >
                Submit Answer ➔
              </button>
            </div>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
