import type { Answers, Condition, Question, TemplateContent } from './types.ts';
import { RESPONSE_TYPES, SCORABLE_TYPES, forEachQuestion, optionValues } from './types.ts';
import { conditionRefs } from './conditions.ts';
import type { TemplateState } from './conditions.ts';
import { parseFormula } from './formula.ts';
import { validateField } from '../validation.ts';
import type { ValidationError } from '../validation.ts';

export type TemplateIssue = { code: string; path: string; detail?: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const NUMERIC_TYPES = ['number', 'decimal', 'rating', 'formula'];
const CHOICE_TYPES = ['yes_no', 'yes_no_na', 'pass_fail_na', 'good_fair_poor_na', 'multiple_choice', 'multiple_select'];
const VALUE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'];
const LIST_OPS = ['in', 'not_in'];
const NO_VALUE_OPS = ['empty', 'not_empty'];

const blank = (t?: { ar?: string; en?: string }) => !((t?.ar ?? '').trim() || (t?.en ?? '').trim());

type Node = { id: string; parent: string | null; cond?: Condition; isQuestion: boolean };

/** Publish gate: every problem is reported with a stable code and the id of the offending element. */
export function validateTemplate(content: TemplateContent): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (code: string, path: string, detail?: string) => issues.push({ code, path, detail });

  if (content.pages.length === 0) add('empty_template', '');
  if (content.passThresholdPct !== undefined && !(content.passThresholdPct >= 0 && content.passThresholdPct <= 100)) add('invalid_threshold', '');

  const nodes = new Map<string, Node>();
  const seen = new Set<string>();
  const register = (id: string, parent: string | null, cond: Condition | undefined, isQuestion: boolean) => {
    if (!ID_RE.test(id)) add('invalid_id', id);
    if (seen.has(id)) add('duplicate_id', id);
    seen.add(id);
    nodes.set(id, { id, parent, cond, isQuestion });
  };

  const checkTable = (t: import('./types.ts').Table) => {
    if (blank(t.title)) add('missing_title', t.id);
    if (t.columns.length === 0) add('invalid_table', t.id, 'no_columns');
    const cols = new Set<string>();
    for (const c of t.columns) {
      if (!ID_RE.test(c.id) || cols.has(c.id)) add('invalid_table', t.id, `column:${c.id}`);
      cols.add(c.id);
      if (blank(c.title)) add('missing_title', `${t.id}.${c.id}`);
      if (!(RESPONSE_TYPES as readonly string[]).includes(c.responseType) || c.responseType === 'formula') add('invalid_table', t.id, `column_type:${c.id}`);
    }
    if (t.minRows !== undefined && t.maxRows !== undefined && t.minRows > t.maxRows) add('invalid_table', t.id, 'rows_range');
  };

  for (const page of content.pages) {
    register(page.id, null, page.visibleWhen, false);
    if (blank(page.title)) add('missing_title', page.id);
    if (page.items.length === 0) add('empty_page', page.id);
    for (const item of page.items) {
      if (item.kind === 'section') {
        register(item.id, page.id, item.visibleWhen, false);
        if (blank(item.title)) add('missing_title', item.id);
        if (item.items.length === 0) add('empty_section', item.id);
        for (const sub of item.items) {
          register(sub.id, item.id, sub.visibleWhen, sub.kind === 'question');
          if (sub.kind === 'table') checkTable(sub);
        }
      } else {
        register(item.id, page.id, item.visibleWhen, item.kind === 'question');
        if (item.kind === 'table') checkTable(item);
      }
    }
  }

  const questions = new Map<string, Question>();
  forEachQuestion(content, ({ question }) => questions.set(question.id, question));

  const checkCondition = (c: Condition, owner: string) => {
    if ('all' in c) { if (c.all.length === 0) add('invalid_condition', owner, 'empty_all'); c.all.forEach((x) => checkCondition(x, owner)); return; }
    if ('any' in c) { if (c.any.length === 0) add('invalid_condition', owner, 'empty_any'); c.any.forEach((x) => checkCondition(x, owner)); return; }
    if ('not' in c) { checkCondition(c.not, owner); return; }
    if (!questions.has(c.questionId)) add('invalid_condition_ref', owner, c.questionId);
    if (c.questionId === owner) add('self_reference', owner);
    if (VALUE_OPS.includes(c.op) && (c.value === undefined || Array.isArray(c.value))) add('invalid_condition', owner, `value:${c.op}`);
    else if (LIST_OPS.includes(c.op) && !Array.isArray(c.value)) add('invalid_condition', owner, `list:${c.op}`);
    else if (!NO_VALUE_OPS.includes(c.op) && !VALUE_OPS.includes(c.op) && !LIST_OPS.includes(c.op)) add('invalid_condition', owner, `op:${String(c.op)}`);
  };

  for (const q of questions.values()) {
    if (blank(q.title)) add('missing_title', q.id);
    if (!(RESPONSE_TYPES as readonly string[]).includes(q.responseType)) { add('invalid_response_type', q.id); continue; }

    if (q.responseType === 'multiple_choice' || q.responseType === 'multiple_select') {
      if (!q.options || q.options.length === 0) add('choice_without_options', q.id);
      else {
        const vals = q.options.map((o) => o.value);
        if (vals.some((v) => v.trim() === '') || new Set(vals).size !== vals.length) add('invalid_options', q.id);
        if (q.options.some((o) => blank(o.label))) add('invalid_options', q.id, 'label');
      }
    }
    if (q.responseType === 'rating' && q.ratingMax !== undefined && q.ratingMax !== 5 && q.ratingMax !== 10) add('invalid_rating_max', q.id);
    if (q.min !== undefined && q.max !== undefined && q.min > q.max) add('invalid_range', q.id);

    const opts = q.responseType === 'rating' ? Array.from({ length: q.ratingMax ?? 5 }, (_, i) => String(i + 1)) : optionValues(q);

    if (q.scoring) {
      const s = q.scoring;
      if (!SCORABLE_TYPES.includes(q.responseType)) add('unscorable_type', q.id);
      if (s.weight !== undefined && !(s.weight > 0)) add('invalid_scoring', q.id, 'weight');
      if (s.maxScore !== undefined && !(s.maxScore > 0)) add('invalid_scoring', q.id, 'maxScore');
      if (q.responseType === 'multiple_choice' && !s.optionScores) add('invalid_scoring', q.id, 'optionScores_required');
      for (const [k, v] of Object.entries(s.optionScores ?? {})) {
        if (!opts.includes(k)) add('unknown_option_score', q.id, k);
        if (v !== null && !(typeof v === 'number' && v >= 0)) add('invalid_scoring', q.id, `score:${k}`);
      }
    }

    for (const [i, r] of (q.flagRules ?? []).entries()) {
      const keys = Object.keys(r.when);
      if (keys.length === 0) add('invalid_flag_rule', q.id, `rule:${i}`);
      if (!SEVERITIES.includes(r.severity)) add('invalid_flag_rule', q.id, `severity:${i}`);
      if (r.when.answerIn) {
        if (CHOICE_TYPES.includes(q.responseType) || q.responseType === 'rating') {
          for (const v of r.when.answerIn) if (!opts.includes(String(v))) add('unknown_flag_option', q.id, String(v));
        }
      }
      if (['numberLt', 'numberLte', 'numberGt', 'numberGte'].some((k) => k in r.when) && !NUMERIC_TYPES.includes(q.responseType)) add('invalid_flag_rule', q.id, `numeric:${i}`);
      if (r.when.scoreBelowPct !== undefined) {
        if (!q.scoring) add('flag_needs_scoring', q.id);
        if (!(r.when.scoreBelowPct >= 0 && r.when.scoreBelowPct <= 100)) add('invalid_flag_rule', q.id, `pct:${i}`);
      }
    }

    if (q.requiredWhen) checkCondition(q.requiredWhen, q.id);
    if (q.disabledWhen) checkCondition(q.disabledWhen, q.id);
  }
  for (const n of nodes.values()) if (n.cond) checkCondition(n.cond, n.id);

  // formulas
  const formulaRefs = new Map<string, string[]>();
  for (const q of questions.values()) {
    if (q.responseType !== 'formula') { if (q.formula) add('invalid_formula', q.id, 'not_a_formula_question'); continue; }
    const p = q.formula ? parseFormula(q.formula) : ({ ok: false } as const);
    if (!p.ok) { add('invalid_formula', q.id); continue; }
    formulaRefs.set(q.id, p.refs);
    for (const r of p.refs) {
      const t = questions.get(r);
      if (!t || !NUMERIC_TYPES.includes(t.responseType)) add('invalid_formula_ref', q.id, r);
    }
  }

  // visibility dependency cycles: node -> parent, node -> questions its condition reads
  const edges = new Map<string, string[]>();
  for (const n of nodes.values()) {
    const e: string[] = [];
    if (n.parent) e.push(n.parent);
    if (n.cond) for (const r of conditionRefs(n.cond)) if (nodes.has(r) && r !== n.id) e.push(r);
    edges.set(n.id, e);
  }
  const cycle = findCycle(edges);
  if (cycle) add('condition_cycle', cycle);
  const fcycle = findCycle(formulaRefs);
  if (fcycle) add('formula_cycle', fcycle);

  return issues;
}

function findCycle(edges: Map<string, string[]>): string | null {
  const state = new Map<string, 1 | 2>();
  let found: string | null = null;
  const visit = (id: string): void => {
    if (found) return;
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const s = state.get(next);
      if (s === 1) { found = next; return; }
      if (!s) visit(next);
      if (found) return;
    }
    state.set(id, 2);
  };
  for (const id of edges.keys()) if (!state.get(id)) visit(id);
  return found;
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Checks one value against its question's type/limits. `required` decides whether an empty value is an error. */
export function validateQuestionValue(q: Question, v: unknown, required: boolean): ValidationError[] {
  let e: ValidationError[] = [];
  switch (q.responseType) {
    case 'text': e = validateField(v, { type: 'text', required, maxLength: q.maxLength ?? 500 }); break;
    case 'long_text': e = validateField(v, { type: 'long_text', required, maxLength: q.maxLength ?? 5000 }); break;
    case 'number': e = validateField(v, { type: 'number', required, min: q.min, max: q.max }); break;
    case 'decimal': e = validateField(v, { type: 'decimal', required, min: q.min, max: q.max }); break;
    case 'rating': e = validateField(v, { type: 'number', required, min: 1, max: q.ratingMax ?? 5 }); break;
    case 'yes_no': case 'yes_no_na': case 'pass_fail_na': case 'good_fair_poor_na': case 'multiple_choice':
      e = validateField(v, { type: 'single_select', required, options: optionValues(q) }); break;
    case 'multiple_select': e = validateField(v, { type: 'multi_select', required, options: optionValues(q) }); break;
    case 'date': e = validateField(v, { type: 'date', required }); break;
    case 'time': e = validateField(v, { type: 'time', required }); break;
    case 'datetime': e = validateField(v, { type: 'datetime', required }); break;
    case 'photo': case 'video': case 'audio': case 'file': e = validateField(v, { type: 'multi_select', required }); break;
    case 'checkbox':
      if (isBlank(v)) { if (required) e = [{ code: 'required' }]; } else if (typeof v !== 'boolean') e = [{ code: 'invalid_type' }];
      break;
    case 'location': case 'gps': {
      if (isBlank(v)) { if (required) e = [{ code: 'required' }]; break; }
      const g = v as { lat?: unknown; lng?: unknown };
      const ok = typeof g === 'object' && typeof g.lat === 'number' && typeof g.lng === 'number' && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180;
      if (!ok) e = [{ code: 'invalid_type' }];
      break;
    }
    default: e = validateField(v, { type: 'text', required, maxLength: 200 }); // signature + selectors: a reference string
  }
  return e;
}

/** Validates the answers of the questions that are currently visible, enabled and non-computed. */
export function validateAnswers(content: TemplateContent, answers: Answers, state: TemplateState): Record<string, ValidationError[]> {
  const errors: Record<string, ValidationError[]> = {};
  forEachQuestion(content, ({ question: q }) => {
    if (!state.visible[q.id] || state.disabled[q.id] || q.responseType === 'formula') return;
    const e = validateQuestionValue(q, answers[q.id], state.required[q.id] === true);
    if (e.length) errors[q.id] = e;
  });
  return errors;
}

export type Progress = { answered: number; total: number; requiredMissing: number };

/** Progress over the questions the user must/can answer right now (visible, enabled, not computed). */
export function progressOf(content: TemplateContent, answers: Answers, state: TemplateState): Progress {
  let answered = 0; let total = 0; let requiredMissing = 0;
  forEachQuestion(content, ({ question: q }) => {
    if (!state.visible[q.id] || state.disabled[q.id] || q.responseType === 'formula') return;
    total++;
    if (isBlank(answers[q.id])) { if (state.required[q.id]) requiredMissing++; } else answered++;
  });
  return { answered, total, requiredMissing };
}
