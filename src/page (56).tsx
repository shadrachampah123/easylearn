"use client";

import { useEffect, useState, use } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Question {
  id: string;
  questionType: string;
  questionText: string;
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

export default function TakeQuizPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loading, setLoading] = useState(true);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    loadQuiz();
  }, [resolvedParams.id]);

  useEffect(() => {
    if (started && timeLeft !== null && timeLeft > 0) {
      const timer = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(timer);
            handleSubmit();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [started, timeLeft]);

  async function loadQuiz() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/quizzes/${resolvedParams.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setQuiz(data.data);
        if (data.data.timeLimitMinutes) {
          setTimeLeft(data.data.timeLimitMinutes * 60);
        }
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
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
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

  function formatTime(seconds: number) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
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

  // Show results
  if (result) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-3xl shadow-lg border border-slate-100 overflow-hidden">
            {/* Result Header */}
            <div className={`p-8 text-center ${
              result.percentage >= 80 ? "bg-gradient-to-br from-green-400 to-emerald-500" :
              result.percentage >= 60 ? "bg-gradient-to-br from-yellow-400 to-orange-500" :
              "bg-gradient-to-br from-red-400 to-pink-500"
            } text-white`}>
              <div className="text-6xl mb-4">
                {result.percentage >= 80 ? "🏆" : result.percentage >= 60 ? "⭐" : "📝"}
              </div>
              <h2 className="text-2xl font-bold mb-2">Quiz Completed!</h2>
              <div className="text-5xl font-extrabold mb-2">{result.percentage}%</div>
              <p className="text-white/80">
                You scored {result.score} out of {result.maxScore} points
              </p>
              {result.pointsEarned > 0 && (
                <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/20">
                  <span>⭐</span> +{result.pointsEarned} XP earned!
                </div>
              )}
            </div>

            {/* Review Answers */}
            {result.answers && quiz.showResults && (
              <div className="p-6">
                <h3 className="font-bold text-lg text-slate-800 mb-4">Review Your Answers</h3>
                <div className="space-y-4">
                  {quiz.questions.map((q, idx) => {
                    const answer = result.answers?.[q.id];
                    return (
                      <div
                        key={q.id}
                        className={`p-4 rounded-xl border-2 ${
                          answer?.correct
                            ? "bg-green-50 border-green-200"
                            : "bg-red-50 border-red-200"
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

            {/* Actions */}
            <div className="p-6 border-t border-slate-100">
              <Link
                href="/dashboard/learner/quizzes"
                className="block w-full py-3 text-center rounded-xl bg-accent-500 text-white font-semibold hover:bg-accent-600 transition-colors"
              >
                Back to Quizzes
              </Link>
            </div>
          </div>
        </div>
      </DashboardShell>
    );
  }

  // Show start screen
  if (!started) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="max-w-2xl mx-auto">
          <Link href="/dashboard/learner/quizzes" className="text-slate-500 text-sm hover:text-accent-600 mb-4 inline-block">
            ← Back to quizzes
          </Link>

          <div className="bg-white rounded-3xl shadow-lg border border-slate-100 p-8 text-center">
            <div className="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center text-white text-4xl mb-6">
              ❓
            </div>

            <h1 className="text-2xl font-bold text-slate-800 mb-2">{quiz.title}</h1>
            <p className="text-slate-500 mb-6">{quiz.description || "Test your knowledge!"}</p>

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
                <div className="text-xs text-slate-500">Time Limit</div>
                <div className="font-semibold text-sm text-slate-700">
                  {quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} min` : "No limit"}
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-yellow-50 border border-yellow-200 mb-6 text-left">
              <h3 className="font-semibold text-yellow-800 mb-2">⚠️ Before you start:</h3>
              <ul className="text-sm text-yellow-700 space-y-1">
                <li>• Read each question carefully</li>
                <li>• You cannot go back once you submit</li>
                {quiz.timeLimitMinutes && <li>• The quiz will auto-submit when time runs out</li>}
                <li>• Your score will be calculated automatically</li>
              </ul>
            </div>

            <button
              onClick={startQuiz}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 text-white font-bold text-lg shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all"
            >
              Start Quiz 🚀
            </button>
          </div>
        </div>
      </DashboardShell>
    );
  }

  // Quiz in progress
  const question = quiz.questions[currentQuestion];
  const progress = ((currentQuestion + 1) / quiz.questions.length) * 100;

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="max-w-3xl mx-auto">
        {/* Header with timer */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800">{quiz.title}</h2>
            {timeLeft !== null && (
              <div className={`px-4 py-2 rounded-xl font-mono font-bold ${
                timeLeft < 60 ? "bg-red-100 text-red-600 animate-pulse" : "bg-slate-100 text-slate-700"
              }`}>
                ⏱️ {formatTime(timeLeft)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent-400 to-accent-600 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-sm font-semibold text-slate-600">
              {currentQuestion + 1} / {quiz.questions.length}
            </span>
          </div>
        </div>

        {/* Question Card */}
        <div className="bg-white rounded-3xl shadow-lg border border-slate-100 p-8 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="px-3 py-1 rounded-full bg-accent-100 text-accent-600 text-xs font-semibold">
              {question.questionType === "mcq" ? "Multiple Choice" :
               question.questionType === "true_false" ? "True/False" :
               question.questionType === "fill_blank" ? "Fill in the Blank" : "Short Answer"}
            </span>
            <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold">
              {question.points} point{question.points > 1 ? "s" : ""}
            </span>
          </div>

          <h3 className="text-xl font-bold text-slate-800 mb-6">{question.questionText}</h3>

          {/* MCQ Options */}
          {question.questionType === "mcq" && question.options && (
            <div className="space-y-3">
              {question.options.map((opt, idx) => {
                const letter = String.fromCharCode(65 + idx);
                const isSelected = answers[question.id] === letter;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setAnswers({ ...answers, [question.id]: letter })}
                    className={`w-full p-4 rounded-xl text-left flex items-center gap-3 transition-all ${
                      isSelected
                        ? "bg-accent-100 border-2 border-accent-500 text-accent-700"
                        : "bg-slate-50 border-2 border-transparent hover:bg-slate-100"
                    }`}
                  >
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${
                      isSelected ? "bg-accent-500 text-white" : "bg-slate-200 text-slate-600"
                    }`}>
                      {letter}
                    </span>
                    <span className="font-medium">{opt}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* True/False */}
          {question.questionType === "true_false" && (
            <div className="flex gap-4">
              {["True", "False"].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setAnswers({ ...answers, [question.id]: opt.toLowerCase() })}
                  className={`flex-1 p-4 rounded-xl text-center font-bold transition-all ${
                    answers[question.id] === opt.toLowerCase()
                      ? "bg-accent-100 border-2 border-accent-500 text-accent-700"
                      : "bg-slate-50 border-2 border-transparent hover:bg-slate-100"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}

          {/* Fill in blank / Short answer */}
          {(question.questionType === "fill_blank" || question.questionType === "short_answer") && (
            <input
              type="text"
              value={answers[question.id] || ""}
              onChange={(e) => setAnswers({ ...answers, [question.id]: e.target.value })}
              className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-accent-500 outline-none text-lg"
              placeholder="Type your answer here..."
            />
          )}
        </div>

        {/* Navigation */}
        <div className="flex gap-3">
          <button
            onClick={() => setCurrentQuestion(Math.max(0, currentQuestion - 1))}
            disabled={currentQuestion === 0}
            className="px-6 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold disabled:opacity-50"
          >
            ← Previous
          </button>
          <div className="flex-1" />
          {currentQuestion < quiz.questions.length - 1 ? (
            <button
              onClick={() => setCurrentQuestion(currentQuestion + 1)}
              className="px-6 py-3 rounded-xl bg-accent-500 text-white font-semibold hover:bg-accent-600 transition-colors"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="px-8 py-3 rounded-xl bg-green-500 text-white font-bold hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit Quiz ✓"}
            </button>
          )}
        </div>

        {/* Question Navigator */}
        <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-4">
          <p className="text-xs font-semibold text-slate-500 mb-3">QUESTION NAVIGATOR</p>
          <div className="flex flex-wrap gap-2">
            {quiz.questions.map((q, idx) => (
              <button
                key={q.id}
                onClick={() => setCurrentQuestion(idx)}
                className={`w-9 h-9 rounded-lg text-sm font-bold transition-all ${
                  idx === currentQuestion
                    ? "bg-accent-500 text-white"
                    : answers[q.id]
                    ? "bg-green-100 text-green-600 border border-green-200"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
              >
                {idx + 1}
              </button>
            ))}
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
