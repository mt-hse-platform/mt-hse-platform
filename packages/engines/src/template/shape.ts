// Structural guard for untrusted template JSON (API input). The engines assume this shape; it also enforces size limits.
// It does NOT judge business correctness (that is validateTemplate's job at publish time): drafts may be incomplete.
import type { TemplateContent } from './types.ts';

export const LIMITS = { pages: 100, questions: 1000, options: 100, tableColumns: 50, conditionDepth: 10 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isText = (v: unknown): boolean => isObj(v) && (v.ar === undefined || isStr(v.ar)) && (v.en === undefined || isStr(v.en));
const optText = (v: unknown) => v === undefined || isText(v);

function isCondition(c: unknown, depth = 0): boolean {
  if (depth > LIMITS.conditionDepth || !isObj(c)) return false;
  if ('all' in c) return Array.isArray(c.all) && c.all.every((x) => isCondition(x, depth + 1));
  if ('any' in c) return Array.isArray(c.any) && c.any.every((x) => isCondition(x, depth + 1));
  if ('not' in c) return isCondition(c.not, depth + 1);
  const scalar = (v: unknown) => isStr(v) || typeof v === 'number' || typeof v === 'boolean';
  return isStr(c.questionId) && isStr(c.op) &&
    (c.value === undefined || scalar(c.value) || (Array.isArray(c.value) && c.value.every(scalar)));
}
const optCond = (c: unknown) => c === undefined || isCondition(c);

function isQuestion(q: unknown): boolean {
  if (!isObj(q) || q.kind !== 'question' || !isStr(q.id) || !isText(q.title) || !isStr(q.responseType)) return false;
  if (!optText(q.description) || !optText(q.helpText)) return false;
  if (q.options !== undefined) {
    if (!Array.isArray(q.options) || q.options.length > LIMITS.options) return false;
    if (!q.options.every((o) => isObj(o) && isStr(o.value) && isText(o.label))) return false;
  }
  if (q.formula !== undefined && !isStr(q.formula)) return false;
  if (q.category !== undefined && !isStr(q.category)) return false;
  if (q.scoring !== undefined) {
    if (!isObj(q.scoring)) return false;
    if (q.scoring.optionScores !== undefined &&
      !(isObj(q.scoring.optionScores) && Object.values(q.scoring.optionScores).every((v) => v === null || typeof v === 'number'))) return false;
    for (const k of ['maxScore', 'weight'] as const) if (q.scoring[k] !== undefined && typeof q.scoring[k] !== 'number') return false;
  }
  if (q.flagRules !== undefined) {
    if (!Array.isArray(q.flagRules)) return false;
    if (!q.flagRules.every((r) => isObj(r) && isObj(r.when) && isStr(r.severity) && optText(r.description))) return false;
  }
  for (const k of ['min', 'max', 'maxLength', 'ratingMax'] as const) if (q[k] !== undefined && typeof q[k] !== 'number') return false;
  return optCond(q.visibleWhen) && optCond(q.requiredWhen) && optCond(q.disabledWhen);
}

function isTable(t: unknown): boolean {
  return isObj(t) && t.kind === 'table' && isStr(t.id) && isText(t.title) && optCond(t.visibleWhen) &&
    Array.isArray(t.columns) && t.columns.length <= LIMITS.tableColumns &&
    t.columns.every((c) => isObj(c) && isStr(c.id) && isText(c.title) && isStr(c.responseType));
}

export function isTemplateContent(x: unknown): x is TemplateContent {
  if (!isObj(x) || !Array.isArray(x.pages) || x.pages.length > LIMITS.pages) return false;
  if (x.passThresholdPct !== undefined && typeof x.passThresholdPct !== 'number') return false;
  let questions = 0;
  for (const p of x.pages) {
    if (!isObj(p) || !isStr(p.id) || !isText(p.title) || !optText(p.description) || !optCond(p.visibleWhen) || !Array.isArray(p.items)) return false;
    for (const item of p.items) {
      if (isObj(item) && item.kind === 'section') {
        if (!isStr(item.id) || !isText(item.title) || !optCond(item.visibleWhen) || !Array.isArray(item.items)) return false;
        for (const sub of item.items) {
          if (isQuestion(sub)) questions++; else if (!isTable(sub)) return false;
        }
      } else if (isQuestion(item)) questions++;
      else if (!isTable(item)) return false;
    }
  }
  return questions <= LIMITS.questions;
}
