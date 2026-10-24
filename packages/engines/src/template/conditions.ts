import type { Answers, Condition, Question, TemplateContent } from './types.ts';
import { forEachQuestion } from './types.ts';
import { evalFormula, parseFormula } from './formula.ts';

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

const str = (v: unknown) => String(v);

export function evalCondition(cond: Condition, getAnswer: (questionId: string) => unknown): boolean {
  if ('all' in cond) return cond.all.every((c) => evalCondition(c, getAnswer));
  if ('any' in cond) return cond.any.some((c) => evalCondition(c, getAnswer));
  if ('not' in cond) return !evalCondition(cond.not, getAnswer);

  const a = getAnswer(cond.questionId);
  const v = cond.value;
  const list = Array.isArray(v) ? v.map(str) : [];
  const inList = () => (Array.isArray(a) ? a.some((x) => list.includes(str(x))) : !isEmpty(a) && list.includes(str(a)));
  const num = (x: unknown): number | null => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '') ? (Number.isFinite(Number(x)) ? Number(x) : null) : null);

  switch (cond.op) {
    case 'eq': return !Array.isArray(a) && !isEmpty(a) && v !== undefined && !Array.isArray(v) && str(a) === str(v);
    case 'neq': return !(!Array.isArray(a) && !isEmpty(a) && v !== undefined && !Array.isArray(v) && str(a) === str(v));
    case 'in': return inList();
    case 'not_in': return !inList();
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const x = num(a); const y = typeof v === 'number' || typeof v === 'string' ? num(v) : null;
      if (x === null || y === null) return false;
      return cond.op === 'gt' ? x > y : cond.op === 'gte' ? x >= y : cond.op === 'lt' ? x < y : x <= y;
    }
    case 'empty': return isEmpty(a);
    case 'not_empty': return !isEmpty(a);
    case 'contains':
      return Array.isArray(a) ? a.map(str).includes(str(v)) : typeof a === 'string' && v !== undefined && a.includes(str(v));
  }
}

export function conditionRefs(cond: Condition): string[] {
  if ('all' in cond) return cond.all.flatMap(conditionRefs);
  if ('any' in cond) return cond.any.flatMap(conditionRefs);
  if ('not' in cond) return conditionRefs(cond.not);
  return [cond.questionId];
}

export type TemplateState = {
  visible: Record<string, boolean>;   // pages, sections, tables and questions by id
  required: Record<string, boolean>;  // questions
  disabled: Record<string, boolean>;  // questions
};

type Node = { parent: string | null; visibleWhen?: Condition };

/**
 * Visibility is hierarchical (page -> section -> question) and cascading: the answer of a hidden question counts as
 * "no answer" for every condition that depends on it. A dependency cycle makes the involved nodes hidden (publishing
 * a template with such a cycle is blocked by validateTemplate, this is only a runtime safety net).
 */
export function computeState(content: TemplateContent, answers: Answers): TemplateState {
  const nodes = new Map<string, Node>();
  const questions = new Map<string, Question>();
  for (const page of content.pages) {
    nodes.set(page.id, { parent: null, visibleWhen: page.visibleWhen });
    for (const item of page.items) {
      if (item.kind === 'section') {
        nodes.set(item.id, { parent: page.id, visibleWhen: item.visibleWhen });
        for (const sub of item.items) {
          nodes.set(sub.id, { parent: item.id, visibleWhen: sub.visibleWhen });
          if (sub.kind === 'question') questions.set(sub.id, sub);
        }
      } else {
        nodes.set(item.id, { parent: page.id, visibleWhen: item.visibleWhen });
        if (item.kind === 'question') questions.set(item.id, item);
      }
    }
  }

  const memo = new Map<string, boolean>();
  const inProgress = new Set<string>();
  const effective = (qid: string): unknown => (isVisible(qid) ? answers[qid] : undefined);

  function isVisible(id: string): boolean {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const node = nodes.get(id);
    if (!node) return false;
    if (inProgress.has(id)) return false; // cycle
    inProgress.add(id);
    const parentOk = node.parent ? isVisible(node.parent) : true;
    const v = parentOk && (node.visibleWhen ? evalCondition(node.visibleWhen, effective) : true);
    inProgress.delete(id);
    memo.set(id, v);
    return v;
  }

  const state: TemplateState = { visible: {}, required: {}, disabled: {} };
  for (const id of nodes.keys()) state.visible[id] = isVisible(id);
  for (const [id, q] of questions) {
    state.required[id] = q.required === true || (q.requiredWhen ? evalCondition(q.requiredWhen, effective) : false);
    state.disabled[id] = q.disabledWhen ? evalCondition(q.disabledWhen, effective) : false;
  }
  return state;
}

/** Fills formula questions. `getAnswer` lets callers mask hidden answers; formulas may depend on other formulas. */
export function applyFormulas(content: TemplateContent, answers: Answers, isHidden: (qid: string) => boolean = () => false): Answers {
  const out: Answers = { ...answers };
  const formulas: { id: string; ast: ReturnType<typeof parseFormula> }[] = [];
  forEachQuestion(content, ({ question }) => {
    if (question.responseType === 'formula' && question.formula) formulas.push({ id: question.id, ast: parseFormula(question.formula) });
  });
  const getNumber = (id: string): number | null => {
    if (isHidden(id)) return null;
    const v = out[id];
    return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
  };
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const f of formulas) {
      const value = f.ast.ok ? evalFormula(f.ast.ast, getNumber) : null;
      if (out[f.id] !== value) { out[f.id] = value; changed = true; }
    }
    if (!changed) break;
  }
  return out;
}
