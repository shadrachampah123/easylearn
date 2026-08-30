/**
 * EasyAI — EasyLearn's automated grading engine.
 *
 * When a teacher enables EasyAI on an assignment and sets the total maximum
 * marks the AI may allocate (`assignments.ai_max_marks`), every learner
 * submission is evaluated instantly, server-side, with no external API calls:
 *
 *   • Free-text / file submissions  → EasyAI analyses the written answer
 *     (and any attached files it can inspect metadata for) against the
 *     assignment brief and awards marks out of the teacher's total.
 *   • Question-based assignments    → objective questions keep exact-match
 *     grading while EasyAI gives partial credit on subjective answers
 *     (essays / short answers); the result is then scaled to the teacher's
 *     total, so the learner always sees `score / aiMaxMarks`.
 *
 * The engine is deterministic: the same submission always earns the same
 * marks, and grading is instant because everything runs in-process.
 */

/* ── Public types ── */

export interface EasyAICriterion {
  key: "relevance" | "depth" | "structure" | "language" | "vocabulary";
  label: string;
  score: number;
  maxScore: number;
  comment: string;
}

export interface EasyAIReport {
  engine: "easyai";
  version: 1;
  mode: "free_response" | "question_set";
  /** Quality score 0–100 used to derive marks out of the teacher's total. */
  percentage: number;
  criteria: EasyAICriterion[];
  strengths: string[];
  improvements: string[];
  summary: string;
  metrics: {
    words: number;
    sentences: number;
    paragraphs: number;
    attachments: number;
  };
}

export interface EasyAIFreeResponseInput {
  title: string;
  description?: string | null;
  instructions?: string | null;
  content?: string | null;
  attachments?: unknown;
}

export interface EasyAISubjectiveInput {
  question: string;
  answer: string;
  reference?: string | null;
}

export const EASYAI_MAX_MARKS_MIN = 1;
export const EASYAI_MAX_MARKS_MAX = 1000;

/** Whether EasyAI auto-grading is switched on for an assignment row. */
export function isEasyAiEnabled(assignment: {
  aiGradingEnabled?: boolean | null;
}): boolean {
  return assignment.aiGradingEnabled === true;
}

/** The total maximum marks EasyAI may allocate, with a sane fallback. */
export function getAiMaxMarks(assignment: {
  aiGradingEnabled?: boolean | null;
  aiMaxMarks?: number | null;
  maxScore?: number | null;
}): number {
  const marks = Number(assignment.aiMaxMarks);
  if (Number.isFinite(marks) && marks >= EASYAI_MAX_MARKS_MIN) {
    return Math.min(Math.round(marks), EASYAI_MAX_MARKS_MAX);
  }
  const fallback = Number(assignment.maxScore);
  return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : 100;
}

/** Map a 0–100 quality score onto the teacher's total marks. */
export function marksFromPercentage(percentage: number, maxMarks: number): number {
  const safeMax = Math.max(EASYAI_MAX_MARKS_MIN, Math.round(maxMarks || 0));
  const marks = Math.round((clamp(percentage, 0, 100) / 100) * safeMax);
  return clamp(marks, 0, safeMax);
}

/* ── Text analysis helpers ── */

const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","than","so","because","as","of","at","by","for","with",
  "about","against","between","into","through","during","before","after","above","below","to","from",
  "up","down","in","out","on","off","over","under","again","further","once","here","there","when",
  "where","why","how","all","any","both","each","few","more","most","other","some","such","no","nor",
  "not","only","own","same","too","very","can","will","just","should","now","i","me","my","myself",
  "we","our","ours","you","your","yours","he","him","his","she","her","hers","it","its","they",
  "them","their","theirs","what","which","who","whom","this","that","these","those","am","is","are",
  "was","were","be","been","being","have","has","had","having","do","does","did","doing","would",
  "could","ought","also","please","using","use","used","your","youre","must","may","might","shall",
  "following","example","examples","ie","eg","etc","within","upon","across","per","via",
]);

const CONNECTORS = [
  "because","therefore","however","although","moreover","furthermore","consequently","for example",
  "for instance","in addition","as a result","on the other hand","in conclusion","to summarize",
  "first","second","third","finally","next","then","similarly","in contrast","thus","hence",
];

/** Very light stem so "growing/grows/grow" and "reaction/reactions" match. */
function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ["ing", "ies", "ed", "es", "s"]) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      if (suffix === "ies") return `${token.slice(0, -3)}y`;
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function sentencesOf(text: string): string[] {
  return (text || "")
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function paragraphsOf(text: string): string[] {
  return (text || "")
    .split(/\n\s*\n|\r\n\s*\r\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Count attachments in the jsonb blob submissions store (name/url metadata). */
function countAttachments(attachments: unknown): number {
  if (Array.isArray(attachments)) return attachments.length;
  if (attachments && typeof attachments === "object") return Object.keys(attachments).length;
  return 0;
}

/* ── Free-response evaluation (no question set) ── */

/**
 * Evaluate a free-text (+ files) submission against the assignment brief.
 * Returns a deterministic 0–100 quality score with a transparent breakdown.
 */
export function evaluateFreeResponse(input: EasyAIFreeResponseInput): EasyAIReport {
  const content = (input.content || "").trim();

  const answerTokens = tokenize(content);
  const answerSet = new Set(answerTokens);
  const words = (content.match(/\S+/g) || []).length;
  const sentences = sentencesOf(content);
  const paragraphs = Math.max(paragraphsOf(content).length, content.split(/\n/).filter((l) => l.trim()).length);
  const attachments = countAttachments(input.attachments);

  const criteria: EasyAICriterion[] = [];
  const strengths: string[] = [];
  const improvements: string[] = [];

  if (words === 0 && attachments === 0) {
    return {
      engine: "easyai",
      version: 1,
      mode: "free_response",
      percentage: 0,
      criteria: [],
      strengths: [],
      improvements: ["Submit a written answer (and any required files) so EasyAI can grade your work."],
      summary: "Nothing was submitted for EasyAI to evaluate.",
      metrics: { words: 0, sentences: 0, paragraphs: 0, attachments: 0 },
    };
  }

  /* 1. Relevance to the brief — 40 points.
     Terms are weighted by where they appear: title ×3, description ×2,
     instructions ×1, so an answer covering the actual topic scores well even
     if it ignores boilerplate instruction wording. */
  const weightedBrief = new Map<string, number>();
  const addWeighted = (text: string, weight: number) => {
    for (const token of tokenize(text)) {
      weightedBrief.set(token, Math.max(weightedBrief.get(token) || 0, weight));
    }
  };
  addWeighted(input.title || "", 3);
  addWeighted(input.description || "", 2);
  addWeighted(input.instructions || "", 1);

  const totalWeight = [...weightedBrief.values()].reduce((sum, w) => sum + w, 0);
  const matchedWeight =
    totalWeight === 0
      ? 0
      : [...weightedBrief.entries()]
          .filter(([token]) => answerSet.has(token))
          .reduce((sum, [, w]) => sum + w, 0);
  const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0.5;
  // Answering a brief rarely echoes every instruction word; 50% weighted
  // coverage already reads as "fully on topic".
  const relevanceScore = words === 0 ? 0 : Math.round(40 * clamp(coverage / 0.5, 0, 1));
  criteria.push({
    key: "relevance",
    label: "Relevance to the assignment",
    score: relevanceScore,
    maxScore: 40,
    comment:
      words === 0
        ? "No written answer to compare with the brief."
        : coverage >= 0.65
          ? "Your answer stays on topic and addresses the brief."
          : coverage >= 0.3
            ? "Partly on topic — touch on more of the key points from the instructions."
            : "The answer covers few of the key ideas in the assignment brief.",
  });

  /* 2. Depth & detail — 25 points */
  const briefWordCount = ((input.description || "") + " " + (input.instructions || ""))
    .match(/\S+/g)?.length || 0;
  const expectedWords = clamp(Math.round(briefWordCount * 1.2) + 60, 80, 400);
  const lengthRatio = words / expectedWords;
  const depthScore =
    words === 0
      ? 0
      : Math.round(25 * Math.pow(clamp(lengthRatio, 0, 1.15) / 1.15, 0.75));
  criteria.push({
    key: "depth",
    label: "Depth & detail",
    score: depthScore,
    maxScore: 25,
    comment:
      words === 0
        ? "No written content."
        : lengthRatio >= 1
          ? `Well developed (${words} words) — ideas are explained in depth.`
          : lengthRatio >= 0.5
            ? `Reasonable length (${words} words) — expand your explanations for full depth.`
            : `Quite brief (${words} words) — develop each point with more explanation and examples.`,
  });

  /* 3. Structure & organisation — 15 points */
  let structureScore = 0;
  if (words > 0) {
    if (paragraphs >= 3 || (paragraphs >= 2 && sentences.length >= 4)) structureScore += 5;
    else if (paragraphs >= 2 || sentences.length >= 3) structureScore += 3;
    const lower = content.toLowerCase();
    const connectorHits = CONNECTORS.filter((c) => lower.includes(c)).length;
    structureScore += Math.min(6, connectorHits * 2);
    if (/\n\s*[-*•]|\n\s*\d+[.)]/.test(content)) structureScore += 2; // lists
    if (sentences.length >= 3 && sentences.length / Math.max(paragraphs, 1) <= 8) structureScore += 2; // not a wall of text
  }
  structureScore = clamp(structureScore, 0, 15);
  criteria.push({
    key: "structure",
    label: "Structure & organisation",
    score: structureScore,
    maxScore: 15,
    comment:
      words === 0
        ? "No written content to assess."
        : structureScore >= 10
          ? "Clearly organised with paragraphs and connecting words."
          : structureScore >= 5
            ? "Some structure — split ideas into paragraphs and link them (e.g. “because”, “for example”)."
            : "Hard to follow — organise your answer into clear, connected paragraphs.",
  });

  /* 4. Language quality — 10 points */
  let languageScore = 0;
  if (words > 0 && sentences.length > 0) {
    const capitalised = sentences.filter((s) => /^[A-Z]/.test(s)).length / sentences.length;
    const punctuated = sentences.filter((s) => /[.!?]$/.test(s)).length / sentences.length;
    const avgSentenceWords = words / sentences.length;
    const sentenceSanity = avgSentenceWords >= 5 && avgSentenceWords <= 35 ? 1 : 0.5;
    const shouty = (content.match(/[A-Z]{6,}/g) || []).length > 1 ? 0.5 : 1;
    languageScore = Math.round(10 * clamp(capitalised * 0.4 + punctuated * 0.4 + sentenceSanity * 0.1 + shouty * 0.1, 0, 1));
  }
  criteria.push({
    key: "language",
    label: "Language & mechanics",
    score: languageScore,
    maxScore: 10,
    comment:
      words === 0
        ? "No written content."
        : languageScore >= 7
          ? "Sentences are well formed with correct punctuation."
          : "Check capitalisation at the start of sentences and end each one with punctuation.",
  });

  /* 5. Vocabulary & originality — 10 points */
  let vocabularyScore = 0;
  if (words > 0) {
    const uniqueRatio = answerTokens.length / Math.max(words, 1); // content-word diversity
    const longShare = answerTokens.filter((t) => t.length >= 7).length / Math.max(answerTokens.length, 1);
    vocabularyScore = Math.round(10 * clamp(uniqueRatio * 1.1 + longShare * 0.8, 0, 1));
  }
  criteria.push({
    key: "vocabulary",
    label: "Vocabulary & expression",
    score: vocabularyScore,
    maxScore: 10,
    comment:
      words === 0
        ? "No written content."
        : vocabularyScore >= 7
          ? "Expressive, varied wording."
          : "Vary your word choice and use subject terminology for a stronger answer.",
  });

  /* Total + attachment evidence bonus */
  let percentage = criteria.reduce((sum, c) => sum + c.score, 0);
  if (attachments > 0 && words > 0) {
    const bonus = Math.min(5, 2 + attachments); // files support the answer
    percentage = clamp(percentage + bonus, 0, 100);
  }
  // A submission that barely touches the topic fails regardless of how polished
  // its prose is — cap it, like a teacher would.
  if (words > 0 && totalWeight > 0 && coverage < 0.15) {
    percentage = Math.min(percentage, 40);
  }

  /* Strengths / improvements narrative */
  for (const c of criteria) {
    if (c.score / c.maxScore >= 0.75) strengths.push(c.label);
    else if (c.score / c.maxScore < 0.5) improvements.push(c.comment);
  }
  if (attachments > 0) strengths.push(`${attachments} supporting file${attachments > 1 ? "s" : ""} attached`);
  if (strengths.length === 0 && words > 0) strengths.push("You submitted a complete answer");

  const summary =
    words === 0 && attachments > 0
      ? `Files received, but no written answer — EasyAI graded the submission ${percentage}/100 on evidence available.`
      : `EasyAI evaluated your ${words}-word answer against the assignment brief and scored it ${percentage}/100.`;

  return {
    engine: "easyai",
    version: 1,
    mode: "free_response",
    percentage,
    criteria,
    strengths,
    improvements: improvements.slice(0, 3),
    summary,
    metrics: { words, sentences: sentences.length, paragraphs, attachments },
  };
}

/* ── Subjective answer evaluation (question sets) ── */

/**
 * Grade a subjective answer (essay / short answer) against the expected
 * reference and/or the question itself. Returns partial credit between 0–1.
 */
export function evaluateSubjectiveAnswer(input: EasyAISubjectiveInput): number {
  const answer = (input.answer || "").trim();
  if (!answer) return 0;

  const words = (answer.match(/\S+/g) || []).length;
  const answerTokens = tokenize(answer);
  const answerSet = new Set(answerTokens);

  let coverage = 0;
  let referenceWords = 0;

  if (input.reference && input.reference.trim()) {
    const referenceTokens = tokenize(input.reference);
    referenceWords = (input.reference.match(/\S+/g) || []).length;
    const uniqueReference = [...new Set(referenceTokens)];
    if (uniqueReference.length > 0) {
      const matched = uniqueReference.filter((t) => answerSet.has(t)).length;
      coverage = matched / uniqueReference.length;
    }
    // An answer far shorter than the reference can rarely cover it fully.
    const lengthFactor = clamp((words / Math.max(referenceWords, 1)) / 0.5, 0.2, 1);
    return clamp(coverage * 1.25 * lengthFactor, 0, 1);
  }

  // No reference answer provided: judge how well the answer addresses the question.
  const questionTokens = [...new Set(tokenize(input.question || ""))];
  if (questionTokens.length > 0) {
    const matched = questionTokens.filter((t) => answerSet.has(t)).length;
    coverage = matched / questionTokens.length;
  }
  const substance = clamp(words / 60, 0, 1); // a substantive paragraph reads better than one line
  return clamp(coverage * 0.6 + substance * 0.4, 0, 0.85); // cap: nothing to confirm against
}

/* ── Feedback text ── */

export function buildLearnerFeedback(
  report: EasyAIReport,
  marks: { score: number; maxMarks: number }
): string {
  const parts: string[] = [];
  parts.push(`EasyAI awarded ${marks.score}/${marks.maxMarks} marks.`);

  if (report.mode === "free_response") {
    const criteriaLine = report.criteria
      .map((c) => `${c.label} ${c.score}/${c.maxScore}`)
      .join(" · ");
    if (criteriaLine) parts.push(criteriaLine);
    if (report.strengths.length > 0) parts.push(`Strengths: ${report.strengths.join(", ").toLowerCase()}.`);
    if (report.improvements.length > 0) parts.push(`To improve: ${report.improvements[0]}`);
  } else {
    parts.push(report.summary);
  }

  return parts.join(" ");
}

/** Round partial credit of a question to whole points, min 0, max points. */
export function partialPoints(partialCredit: number, points: number): number {
  return clamp(Math.round(partialCredit * points), 0, Math.max(points, 0));
}
