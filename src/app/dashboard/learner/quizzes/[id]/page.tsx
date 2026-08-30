"use client";

import { useCallback, useEffect, useMemo, useRef, useState, use } from "react";
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
  attemptsUsed?: number;
  maxAttempts?: number | null;
}

interface PodiumEntry {
  rank: number;
  name: string;
  score: number;
  isMe: boolean;
}

interface QuizResult {
  score: number;
  maxScore: number;
  percentage: number;
  pointsEarned: number;
  answers?: Record<string, { answer: string; correct: boolean; points: number; correctAnswer: string | null }>;
  podium?: PodiumEntry[];
  rank?: number | null;
}

interface CheckResult {
  correct: boolean;
  pointsAwarded: number;
  pointsPossible: number;
  kahootPoints: number;
  correctAnswer: string | null;
  reveal: boolean;
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
];

/** Kahoot's four answer tiles: red triangle, blue diamond, yellow circle, green square. */
const KAHOOT_TILES = [
  { bg: "bg-red-500 hover:bg-red-600", shape: "▲", label: "A" },
  { bg: "bg-blue-500 hover:bg-blue-600", shape: "◆", label: "B" },
  { bg: "bg-amber-400 hover:bg-amber-500", shape: "●", label: "C" },
  { bg: "bg-green-500 hover:bg-green-600", shape: "■", label: "D" },
];

const REVEAL_MS = 2400;

/** How long each question stays on screen, in seconds. */
function secondsPerQuestion(quiz: Quiz): number {
  const total = quiz.questions.length || 1;
  if (quiz.timeLimitMinutes && quiz.timeLimitMinutes > 0) {
    const derived = Math.round((quiz.timeLimitMinutes * 60) / total);
    return Math.min(60, Math.max(10, derived));
  }
  return 20;
}

export default function TakeQuizPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"lobby" | "question" | "reveal" | "finished">("lobby");
  const [index, setIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const [result, setResult] = useState<QuizResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [lockedAnswer, setLockedAnswer] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  // Kahoot running tally (game points), separate from the graded score.
  const [gameScore, setGameScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);

  // Refs so the timer callback and the final submit never read a stale copy of the answers.
  const answersRef = useRef<Record<string, string>>({});
  const lockRef = useRef(false);
  const finishedRef = useRef(false);
  const startedAtRef = useRef(0);

  const perQuestion = useMemo(() => (quiz ? secondsPerQuestion(quiz) : 20), [quiz]);
  const question = quiz?.questions[index];

  const authHeaders = useCallback(() => {
    const token = typeof window === "undefined" ? null : localStorage.getItem("el_token");
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/quizzes/${resolvedParams.id}`, { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) setQuiz(data.data);
        else setLoadError(data.error || "This quiz could not be loaded.");
      })
      .catch(() => !cancelled && setLoadError("This quiz could not be loaded."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [resolvedParams.id, authHeaders]);

  const submitAttempt = useCallback(async () => {
    if (!attemptId || finishedRef.current) return;
    finishedRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/quizzes/${resolvedParams.id}/attempt`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ attemptId, answers: answersRef.current }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data.data.results);
        setPhase("finished");
      } else {
        setLoadError(data.error || "Your answers could not be submitted.");
        finishedRef.current = false;
      }
    } catch {
      setLoadError("Your answers could not be submitted.");
      finishedRef.current = false;
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, resolvedParams.id, authHeaders]);

  /** Ask the server whether the answer was right - the learner payload has no answer key. */
  const lockIn = useCallback(async (answer: string) => {
    if (lockRef.current || !question || !attemptId) return;
    lockRef.current = true;
    setLockedAnswer(answer || null);
    if (answer) answersRef.current[question.id] = answer;
    setPhase("reveal");

    const elapsedMs = Math.max(0, Math.round(Date.now() - startedAtRef.current));
    try {
      const res = await fetch(`/api/quizzes/${resolvedParams.id}/check`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          attemptId,
          questionId: question.id,
          answer,
          elapsedMs,
          windowMs: perQuestion * 1000,
        }),
      });
      const data = await res.json();
      if (!data.success) return;
      const outcome = data.data as CheckResult;
      setCheck(outcome);
      if (outcome.correct) {
        const nextStreak = streak + 1;
        setGameScore((s) => s + outcome.kahootPoints);
        setCorrectCount((c) => c + 1);
        setStreak(nextStreak);
        setBestStreak((b) => Math.max(b, nextStreak));
      } else {
        setStreak(0);
      }
    } catch {
      // Feedback is a nicety; the grade is decided by the submit call.
    }
  }, [question, attemptId, streak, perQuestion, resolvedParams.id, authHeaders]);

  // Per-question countdown. Stamping the clock and ticking both happen outside the render
  // path, so nothing here writes state synchronously during the effect body.
  useEffect(() => {
    if (phase !== "question") return;
    startedAtRef.current = Date.now();
    const timer = setInterval(() => {
      const remaining = perQuestion - Math.floor((Date.now() - startedAtRef.current) / 1000);
      if (remaining <= 0) {
        clearInterval(timer);
        setSecondsLeft(0);
        void lockIn("");
      } else {
        setSecondsLeft(remaining);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [phase, index, perQuestion, lockIn]);

  // Advance automatically once the reveal slide has been on screen long enough.
  useEffect(() => {
    if (phase !== "reveal") return;
    const timer = setTimeout(() => {
      lockRef.current = false;
      setCheck(null);
      setLockedAnswer(null);
      setTyped("");
      if (!quiz) return;
      if (index < quiz.questions.length - 1) {
        setIndex((i) => i + 1);
        setSecondsLeft(perQuestion);
        setPhase("question");
      } else {
        void submitAttempt();
      }
    }, REVEAL_MS);
    return () => clearTimeout(timer);
  }, [phase, index, quiz, perQuestion, submitAttempt]);

  async function startQuiz() {
    const res = await fetch(`/api/quizzes/${resolvedParams.id}/attempt`, {
      method: "POST",
      headers: authHeaders(),
    });
    const data = await res.json();
    if (data.success) {
      answersRef.current = {};
      finishedRef.current = false;
      setTyped("");
      setAttemptId(data.data.attempt.id);
      setIndex(0);
      setSecondsLeft(perQuestion);
      setGameScore(0);
      setStreak(0);
      setBestStreak(0);
      setCorrectCount(0);
      setPhase("question");
    } else {
      setLoadError(data.error || "This quiz could not be started.");
    }
  }

  /** Map a stored MCQ answer ("B") back onto its tile. */
  function tileIndexOf(q: Question, answer: string | null | undefined): number {
    if (!answer) return -1;
    const asLetter = answer.trim().toUpperCase();
    if (/^[A-D]$/.test(asLetter)) return "ABCD".indexOf(asLetter);
    const opts = q.options || [];
    return opts.findIndex((o) => o.trim().toLowerCase() === String(answer).trim().toLowerCase());
  }

  if (loading) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="w-8 h-8 border-4 border-accent-200 border-t-accent-600 rounded-full animate-spin" />
        </div>
      </DashboardShell>
    );
  }

  if (!quiz || loadError) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="text-center py-16 bg-white rounded-2xl border border-slate-100">
          <div className="text-5xl mb-4">🚫</div>
          <h2 className="text-xl font-bold text-slate-800">Quiz unavailable</h2>
          <p className="text-slate-500 text-sm mt-2 max-w-md mx-auto">
            {loadError || "This quiz could not be found."}
          </p>
          <Link href="/dashboard/learner/quizzes" className="text-accent-600 mt-4 inline-block font-semibold">
            ← Back to quizzes
          </Link>
        </div>
      </DashboardShell>
    );
  }

  if (quiz.questions.length === 0) {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="text-center py-16 bg-white rounded-2xl border border-slate-100">
          <div className="text-5xl mb-4">📭</div>
          <h2 className="text-xl font-bold text-slate-800">No questions yet</h2>
          <p className="text-slate-500 text-sm mt-2">Your teacher has not added any questions to this quiz.</p>
          <Link href="/dashboard/learner/quizzes" className="text-accent-600 mt-4 inline-block font-semibold">
            ← Back to quizzes
          </Link>
        </div>
      </DashboardShell>
    );
  }

  /* ── Lobby ── */
  if (phase === "lobby") {
    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="max-w-2xl mx-auto">
          <Link href="/dashboard/learner/quizzes" className="text-slate-500 text-sm hover:text-accent-600 mb-4 inline-block">
            ← Back to quizzes
          </Link>

          <div className="rounded-3xl shadow-xl overflow-hidden border border-slate-100 bg-white">
            <div className="bg-gradient-to-br from-purple-600 via-indigo-600 to-blue-600 p-8 text-center text-white">
              <div className="text-5xl mb-3">🎮</div>
              <h1 className="text-3xl font-extrabold mb-2">{quiz.title}</h1>
              <p className="text-white/85">{quiz.description || "Kahoot-style live quiz"}</p>
            </div>

            <div className="p-8">
              <div className="grid grid-cols-3 gap-3 mb-6 text-center">
                <div className="p-4 rounded-2xl bg-slate-50">
                  <div className="text-2xl mb-1">❓</div>
                  <div className="text-xs text-slate-500">Questions</div>
                  <div className="font-bold text-slate-800">{quiz.questions.length}</div>
                </div>
                <div className="p-4 rounded-2xl bg-slate-50">
                  <div className="text-2xl mb-1">⏱️</div>
                  <div className="text-xs text-slate-500">Per question</div>
                  <div className="font-bold text-slate-800">{perQuestion}s</div>
                </div>
                <div className="p-4 rounded-2xl bg-slate-50">
                  <div className="text-2xl mb-1">📚</div>
                  <div className="text-xs text-slate-500">Subject</div>
                  <div className="font-bold text-slate-800 truncate">{quiz.subjectName || "—"}</div>
                </div>
              </div>

              <ul className="text-sm text-slate-600 space-y-2 mb-8">
                <li className="flex gap-2"><span>🔺</span> Tap the tile with your answer before the bar runs out.</li>
                <li className="flex gap-2"><span>⚡</span> Answer fast for a bigger speed bonus.</li>
                <li className="flex gap-2"><span>🏆</span> Climb the class podium when you finish.</li>
              </ul>

              <button
                onClick={startQuiz}
                className="w-full py-4 rounded-2xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-extrabold text-lg shadow-xl hover:scale-[1.02] active:scale-[0.99] transition-all"
              >
                Start Game 🚀
              </button>
            </div>
          </div>
        </div>
      </DashboardShell>
    );
  }

  /* ── Podium + review ── */
  if (phase === "finished" && result) {
    const tone =
      result.percentage >= 80 ? "from-green-500 to-emerald-600"
      : result.percentage >= 60 ? "from-amber-500 to-orange-600"
      : "from-rose-500 to-pink-600";
    const podium = result.podium || [];

    return (
      <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className={`rounded-3xl shadow-xl overflow-hidden bg-gradient-to-br ${tone} text-white`}>
            <div className="p-8 text-center">
              <div className="text-6xl mb-3">
                {result.percentage >= 80 ? "🏆" : result.percentage >= 60 ? "⭐" : "🎯"}
              </div>
              <h2 className="text-2xl font-bold mb-1">Game Over!</h2>
              <div className="text-6xl font-extrabold my-3">{result.percentage}%</div>
              <p className="text-white/90">
                {result.score} of {result.maxScore} points · {correctCount}/{quiz.questions.length} correct
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <span className="px-4 py-2 rounded-full bg-white/20 text-sm font-bold">⚡ {gameScore.toLocaleString()} game points</span>
                <span className="px-4 py-2 rounded-full bg-white/20 text-sm font-bold">🔥 Best streak {bestStreak}</span>
                {result.rank ? (
                  <span className="px-4 py-2 rounded-full bg-white/20 text-sm font-bold">
                    {result.rank === 1 ? "🥇" : result.rank === 2 ? "🥈" : result.rank === 3 ? "🥉" : "🎖️"} Rank {result.rank}
                  </span>
                ) : null}
              </div>
              {result.pointsEarned > 0 && (
                <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/25 text-sm font-semibold">
                  <span>⭐</span> +{result.pointsEarned} XP earned
                </div>
              )}
            </div>
          </div>

          {podium.length > 0 && (
            <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6">
              <h3 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">🏅 Podium</h3>
              <div className="space-y-2">
                {podium.map((entry) => (
                  <div
                    key={`${entry.rank}-${entry.name}`}
                    className={`flex items-center gap-3 px-4 py-3 rounded-2xl ${entry.isMe ? "bg-purple-50 border border-purple-200" : "bg-slate-50"}`}
                  >
                    <span className="text-xl w-8 text-center">
                      {entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : `#${entry.rank}`}
                    </span>
                    <span className={`flex-1 font-semibold ${entry.isMe ? "text-purple-700" : "text-slate-700"}`}>
                      {entry.name}{entry.isMe ? " (you)" : ""}
                    </span>
                    <span className="font-bold text-slate-800">{entry.score} pts</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.answers && quiz.showResults && (
            <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6">
              <h3 className="font-bold text-lg text-slate-800 mb-4">Review answers</h3>
              <div className="space-y-3">
                {quiz.questions.map((q, idx) => {
                  const answer = result.answers?.[q.id];
                  const chosen = tileIndexOf(q, answer?.answer);
                  const right = tileIndexOf(q, answer?.correctAnswer);
                  return (
                    <div
                      key={q.id}
                      className={`p-4 rounded-2xl border-2 ${answer?.correct ? "bg-green-50 border-green-200" : "bg-rose-50 border-rose-200"}`}
                    >
                      <div className="flex items-start gap-3">
                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 ${answer?.correct ? "bg-green-500" : "bg-rose-500"}`}>
                          {answer?.correct ? "✓" : "✗"}
                        </span>
                        <div className="flex-1">
                          <p className="font-semibold text-slate-800 mb-2">{idx + 1}. {q.questionText}</p>

                          {q.options && q.options.length > 0 ? (
                            <div className="grid sm:grid-cols-2 gap-2 mb-2">
                              {q.options.map((opt, oIdx) => {
                                const isChosen = chosen === oIdx;
                                const isRight = right === oIdx;
                                return (
                                  <div
                                    key={oIdx}
                                    className={`px-3 py-2 rounded-xl text-sm font-medium border ${
                                      isRight ? "bg-green-100 border-green-400 text-green-800"
                                      : isChosen ? "bg-rose-100 border-rose-400 text-rose-800"
                                      : "bg-white border-slate-200 text-slate-600"
                                    }`}
                                  >
                                    {String.fromCharCode(65 + oIdx)}. {opt}
                                    {isRight ? " ✓" : isChosen ? " ← your answer" : ""}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-sm text-slate-700">
                              Your answer: <span className="font-semibold">{answer?.answer || "No answer"}</span>
                              {answer?.correctAnswer ? (
                                <> · Correct: <span className="font-semibold text-green-700">{answer.correctAnswer}</span></>
                              ) : null}
                            </p>
                          )}

                          <span className="text-xs font-bold text-slate-500">
                            {answer?.points ?? 0}/{q.points} pts
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <Link
            href="/dashboard/learner/quizzes"
            className="block w-full py-3 text-center rounded-2xl bg-accent-500 text-white font-semibold hover:bg-accent-600 transition-colors shadow-md"
          >
            Back to Quizzes
          </Link>
        </div>
      </DashboardShell>
    );
  }

  /* ── Question / reveal ── */
  const total = quiz.questions.length;
  const pct = total > 0 ? ((index + (phase === "reveal" ? 1 : 0)) / total) * 100 : 0;
  const timePct = perQuestion > 0 ? (secondsLeft / perQuestion) * 100 : 0;
  const isMcq = question?.questionType === "mcq" && (question.options?.length || 0) > 0;
  const isTrueFalse = question?.questionType === "true_false";
  const typedOptions = isTrueFalse ? ["True", "False"] : (question?.options || []);
  const revealedIndex = check?.reveal ? tileIndexOf(question!, check.correctAnswer) : -1;

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="max-w-4xl mx-auto">
        {/* HUD */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 mb-5">
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="font-bold text-slate-800">
              Question {index + 1} <span className="text-slate-400 font-medium">/ {total}</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full bg-purple-100 text-purple-700 font-bold">⚡ {gameScore.toLocaleString()}</span>
              {streak > 1 && (
                <span className="px-3 py-1 rounded-full bg-orange-100 text-orange-600 font-bold">🔥 {streak}</span>
              )}
              <span className={`px-3 py-1 rounded-full font-mono font-bold ${secondsLeft <= 5 ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-700"}`}>
                ⏱️ {phase === "reveal" ? 0 : secondsLeft}s
              </span>
            </div>
          </div>
          <div className="w-full h-2.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <div className="w-full h-1.5 rounded-full bg-slate-100 overflow-hidden mt-2">
            <div
              className={`h-full rounded-full transition-all duration-200 ${secondsLeft <= 5 ? "bg-rose-500" : "bg-green-500"}`}
              style={{ width: `${phase === "reveal" ? 0 : timePct}%` }}
            />
          </div>
        </div>

        {/* Question card */}
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-6 md:p-8 mb-5">
          {question?.imageUrl && (
            <div className="mb-6 rounded-2xl overflow-hidden max-h-72 bg-slate-100 border border-slate-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={question.imageUrl} alt="" className="w-full h-full object-cover" />
            </div>
          )}

          <h2 className="text-2xl md:text-3xl font-extrabold text-slate-800 text-center mb-6">
            {question?.questionText}
          </h2>

          {(isMcq || isTrueFalse) && (
            <div className={`grid gap-3 ${typedOptions.length > 2 ? "sm:grid-cols-2" : "grid-cols-2"}`}>
              {typedOptions.map((opt, idx) => {
                const tile = KAHOOT_TILES[idx % KAHOOT_TILES.length];
                const value = isTrueFalse ? opt.toLowerCase() : tile.label;
                const isLocked = lockedAnswer === value;
                const isCorrectTile = revealedIndex === idx;
                const dimmed = phase === "reveal" && check?.reveal === true && !isCorrectTile && !isLocked;
                return (
                  <button
                    key={`${value}-${idx}`}
                    type="button"
                    disabled={phase === "reveal"}
                    onClick={() => lockIn(value)}
                    className={`p-5 md:p-6 rounded-2xl text-left flex items-center gap-4 shadow-md transition-all
                      ${phase === "reveal" ? "cursor-default" : "hover:scale-[1.02] active:scale-95"}
                      ${isCorrectTile ? "bg-green-500 ring-4 ring-green-300" : tile.bg}
                      ${dimmed ? "opacity-40" : ""}
                      ${isLocked && phase === "reveal" && !isCorrectTile ? "ring-4 ring-rose-300" : ""}
                      text-white`}
                  >
                    <span className="w-11 h-11 rounded-xl bg-black/20 flex items-center justify-center text-2xl font-extrabold shrink-0">
                      {isCorrectTile ? "✓" : isLocked && phase === "reveal" && !isCorrectTile ? "✗" : tile.shape}
                    </span>
                    <span className="text-lg md:text-xl font-bold flex-1 break-words">{opt}</span>
                  </button>
                );
              })}
            </div>
          )}

          {!isMcq && !isTrueFalse && (
            <div className="space-y-4 max-w-lg mx-auto">
              <input
                type="text"
                value={typed}
                disabled={phase === "reveal"}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") lockIn(typed); }}
                placeholder="Type your answer…"
                className="w-full px-6 py-4 rounded-2xl border-2 border-slate-300 focus:border-purple-600 outline-none text-xl text-center font-semibold disabled:bg-slate-50"
              />
              <button
                type="button"
                disabled={phase === "reveal"}
                onClick={() => lockIn(typed)}
                className="w-full px-8 py-4 rounded-2xl bg-purple-600 text-white font-bold text-lg shadow-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                Lock answer ➔
              </button>
            </div>
          )}
        </div>

        {/* Reveal overlay */}
        {phase === "reveal" && (
          <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
            <div
              className={`px-10 py-8 rounded-3xl shadow-2xl text-center text-white animate-scale-in ${
                check === null ? "bg-slate-800"
                : check.correct ? "bg-green-500"
                : check.reveal ? "bg-rose-500"
                : "bg-slate-700"
              }`}
            >
              {check === null ? (
                <div className="text-3xl font-extrabold">Checking…</div>
              ) : check.correct ? (
                <>
                  <div className="text-5xl mb-2">🎉</div>
                  <div className="text-3xl font-extrabold">Correct!</div>
                  <div className="text-lg font-semibold mt-1">+{check.kahootPoints} points</div>
                </>
              ) : check.reveal ? (
                <>
                  <div className="text-5xl mb-2">😞</div>
                  <div className="text-3xl font-extrabold">
                    {lockedAnswer ? "Not quite" : "Time's up"}
                  </div>
                  {check.correctAnswer && (
                    <div className="text-lg font-semibold mt-1">
                      Answer: {
                        isMcq && /^[A-D]$/i.test(check.correctAnswer.trim())
                          ? (question?.options || [])["ABCD".indexOf(check.correctAnswer.trim().toUpperCase())]
                          : check.correctAnswer
                      }
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-5xl mb-2">🔒</div>
                  <div className="text-3xl font-extrabold">Answer locked</div>
                  <div className="text-base font-medium mt-1 opacity-90">Your teacher has hidden the results.</div>
                </>
              )}
            </div>
          </div>
        )}

        {submitting && (
          <div className="fixed inset-0 z-50 bg-white/80 flex items-center justify-center">
            <div className="text-center">
              <div className="w-10 h-10 mx-auto border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin mb-3" />
              <p className="font-semibold text-slate-700">Tallying your score…</p>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
