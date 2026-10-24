import type { Answers, FlagRule, LocalizedText, Question, Severity, TemplateContent } from './types.ts';
import { DEFAULT_OPTION_SCORES, SEVERITY_ORDER, forEachQuestion } from './types.ts';
import { applyFormulas, computeState } from './conditions.ts';
import type { TemplateState } from './conditions.ts';

export type Bucket = { earned: number; possible: number; pct: number | null };
export type QuestionScore = { earned: number; max: number; weight: number; pct: number };

export type ScoreResult = {
  total: Bucket;
  pages: Record<string, Bucket>;
  sections: Record<string, Bucket>;
  categories: Record<string, Bucket>;
  perQuestion: Record<string, QuestionScore>;
  answeredScored: number;
  unansweredScored: number;
  excludedNa: number;
  passed: boolean | null;
};

export type Flag = { questionId: string; pageId: string; sectionId: string | null; severity: Severity; descriptions: LocalizedText[] };

const round2 = (n: number) => Math.round(n * 100) / 100;
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

type Points = { na: true } | { na: false; earned: number; max: number; weight: number } | null;

/** null = does not count (not scored, or unanswered / unknown answer). */
export function questionPoints(q: Question, answer: unknown): Points {
  if (!q.scoring || isBlank(answer)) return null;
  const weight = q.scoring.weight ?? 1;

  if (q.responseType === 'rating') {
    const n = Number(answer);
    if (!Number.isFinite(n)) return null;
    const map = q.scoring.optionScores;
    if (!map) return { na: false, earned: n, max: q.scoring.maxScore ?? q.ratingMax ?? 5, weight };
    const pts = map[String(n)];
    if (pts === undefined) return null;
    if (pts === null) return { na: true };
    const numeric = Object.values(map).filter((v): v is number => v !== null);
    return { na: false, earned: pts, max: q.scoring.maxScore ?? Math.max(...numeric, 0), weight };
  }

  const scores = { ...(DEFAULT_OPTION_SCORES[q.responseType] ?? {}), ...(q.scoring.optionScores ?? {}) };
  const key = String(answer);
  if (!(key in scores)) return null;
  const pts = scores[key];
  if (pts === null || pts === undefined) return { na: true };
  const numeric = Object.values(scores).filter((v): v is number => v !== null && v !== undefined);
  return { na: false, earned: pts, max: q.scoring.maxScore ?? Math.max(...numeric, 0), weight };
}

const newBucket = () => ({ earned: 0, possible: 0 });
const finish = (b: { earned: number; possible: number }): Bucket => ({
  earned: round2(b.earned), possible: round2(b.possible), pct: b.possible > 0 ? round2((b.earned / b.possible) * 100) : null,
});

/** Only answered, visible, applicable (non N/A) scored questions count, so the % is meaningful while in progress. */
export function computeScores(content: TemplateContent, answers: Answers, state: TemplateState): ScoreResult {
  const total = newBucket();
  const pages: Record<string, { earned: number; possible: number }> = {};
  const sections: Record<string, { earned: number; possible: number }> = {};
  const categories: Record<string, { earned: number; possible: number }> = {};
  const perQuestion: Record<string, QuestionScore> = {};
  let answeredScored = 0; let unansweredScored = 0; let excludedNa = 0;

  forEachQuestion(content, ({ question: q, pageId, sectionId }) => {
    if (!q.scoring || !state.visible[q.id]) return;
    const p = questionPoints(q, answers[q.id]);
    if (p === null) { if (isBlank(answers[q.id])) unansweredScored++; return; }
    if (p.na) { excludedNa++; return; }
    answeredScored++;
    const e = p.earned * p.weight; const m = p.max * p.weight;
    const add = (bucket: { earned: number; possible: number }) => { bucket.earned += e; bucket.possible += m; };
    add(total);
    add((pages[pageId] ??= newBucket()));
    if (sectionId) add((sections[sectionId] ??= newBucket()));
    if (q.category) add((categories[q.category] ??= newBucket()));
    perQuestion[q.id] = { earned: p.earned, max: p.max, weight: p.weight, pct: p.max > 0 ? round2((p.earned / p.max) * 100) : 0 };
  });

  const out = (m: Record<string, { earned: number; possible: number }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, finish(v)]));
  const t = finish(total);
  return {
    total: t, pages: out(pages), sections: out(sections), categories: out(categories), perQuestion,
    answeredScored, unansweredScored, excludedNa,
    passed: content.passThresholdPct !== undefined && t.pct !== null ? t.pct >= content.passThresholdPct : null,
  };
}

function ruleMatches(rule: FlagRule, answer: unknown, score: QuestionScore | undefined): boolean {
  const w = rule.when;
  const n = typeof answer === 'number' || (typeof answer === 'string' && answer.trim() !== '') ? Number(answer) : NaN;
  if (w.answerIn) {
    const hit = Array.isArray(answer) ? answer.some((x) => w.answerIn!.includes(String(x))) : w.answerIn.includes(String(answer));
    if (hit) return true;
  }
  if (Number.isFinite(n)) {
    if (w.numberLt !== undefined && n < w.numberLt) return true;
    if (w.numberLte !== undefined && n <= w.numberLte) return true;
    if (w.numberGt !== undefined && n > w.numberGt) return true;
    if (w.numberGte !== undefined && n >= w.numberGte) return true;
  }
  if (w.scoreBelowPct !== undefined && score && score.pct < w.scoreBelowPct) return true;
  return false;
}

export function computeFlags(content: TemplateContent, answers: Answers, state: TemplateState, scores: ScoreResult): { flags: Flag[]; flaggedRate: number | null } {
  const flags: Flag[] = [];
  let assessable = 0;
  forEachQuestion(content, ({ question: q, pageId, sectionId }) => {
    if (!state.visible[q.id] || isBlank(answers[q.id])) return;
    const p = q.scoring ? questionPoints(q, answers[q.id]) : null;
    if (p && p.na) return;
    const hasRules = (q.flagRules?.length ?? 0) > 0;
    if (!hasRules && !q.scoring) return;
    assessable++;
    if (!hasRules) return;
    const matched = q.flagRules!.filter((r) => ruleMatches(r, answers[q.id], scores.perQuestion[q.id]));
    if (matched.length === 0) return;
    const severity = matched.reduce<Severity>((max, r) => (SEVERITY_ORDER[r.severity] > SEVERITY_ORDER[max] ? r.severity : max), 'low');
    flags.push({ questionId: q.id, pageId, sectionId, severity, descriptions: matched.flatMap((r) => (r.description ? [r.description] : [])) });
  });
  return { flags, flaggedRate: assessable > 0 ? round2((flags.length / assessable) * 100) : null };
}

export type Evaluation = {
  answers: Answers;
  state: TemplateState;
  scores: ScoreResult;
  flags: Flag[];
  flaggedRate: number | null;
};

/** Single entry point used by the UI (live) and the server (on completion): formulas -> visibility -> scores -> flags. */
export function evaluateInspection(content: TemplateContent, raw: Answers): Evaluation {
  const pass1 = applyFormulas(content, raw);
  const state1 = computeState(content, pass1);
  const answers = applyFormulas(content, raw, (id) => state1.visible[id] === false);
  const state = computeState(content, answers);
  const scores = computeScores(content, answers, state);
  const { flags, flaggedRate } = computeFlags(content, answers, state, scores);
  return { answers, state, scores, flags, flaggedRate };
}
