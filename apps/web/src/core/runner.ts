// View model of the inspection screen: which pages/questions are shown, their state, errors and progress.
// Built from the template version and the current answers with the SAME engines the server uses.
import type { Question, TemplateContent, LocalizedText } from '../../../../packages/engines/src/template/types.ts';
import { forEachQuestion } from '../../../../packages/engines/src/template/types.ts';
import { evaluateInspection } from '../../../../packages/engines/src/template/scoring.ts';
import type { Evaluation } from '../../../../packages/engines/src/template/scoring.ts';
import { progressOf, validateAnswers } from '../../../../packages/engines/src/template/validate.ts';
import type { Progress } from '../../../../packages/engines/src/template/validate.ts';
import type { ValidationError } from '../../../../packages/engines/src/validation.ts';

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

export type QuestionVM = {
  id: string; question: Question; value: unknown;
  required: boolean; disabled: boolean; computed: boolean; answered: boolean; errors: ValidationError[];
};
export type SectionVM = { id: string | null; title: LocalizedText | null; questions: QuestionVM[] };
export type PageVM = { id: string; title: LocalizedText; sections: SectionVM[]; answered: number; total: number };
export type RunnerVM = {
  pages: PageVM[]; progress: Progress; errors: Record<string, ValidationError[]>;
  ready: boolean; scorePct: number | null; flagsCount: number; evaluation: Evaluation;
};

/** Reads every question's current value through `getValue` (local answers first), dropping empty ones. */
export function collectValues(content: TemplateContent, getValue: (questionId: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  forEachQuestion(content, ({ question }) => {
    const v = getValue(question.id);
    if (v !== undefined && v !== null) out[question.id] = v;
  });
  return out;
}

export function buildRunner(content: TemplateContent, values: Record<string, unknown>): RunnerVM {
  const ev = evaluateInspection(content, values);
  const errors = validateAnswers(content, ev.answers, ev.state);
  const vmOf = (q: Question): QuestionVM => ({
    id: q.id, question: q, value: ev.answers[q.id] ?? null,
    required: ev.state.required[q.id] === true, disabled: ev.state.disabled[q.id] === true,
    computed: q.responseType === 'formula', answered: !isBlank(ev.answers[q.id]), errors: errors[q.id] ?? [],
  });

  const pages: PageVM[] = [];
  for (const page of content.pages) {
    if (!ev.state.visible[page.id]) continue;
    const sections: SectionVM[] = [];
    let loose: QuestionVM[] = [];
    const flush = () => { if (loose.length) sections.push({ id: null, title: null, questions: loose }); loose = []; };
    for (const item of page.items) {
      if (item.kind === 'question') { if (ev.state.visible[item.id]) loose.push(vmOf(item)); }
      else if (item.kind === 'section') {
        if (!ev.state.visible[item.id]) continue;
        flush();
        const qs = item.items.filter((x): x is Question => x.kind === 'question' && !!ev.state.visible[x.id]).map(vmOf);
        if (qs.length) sections.push({ id: item.id, title: item.title, questions: qs });
      }
    }
    flush();
    const all = sections.flatMap((s) => s.questions).filter((q) => !q.computed && !q.disabled);
    if (sections.length) pages.push({ id: page.id, title: page.title, sections, answered: all.filter((q) => q.answered).length, total: all.length });
  }

  return {
    pages, progress: progressOf(content, ev.answers, ev.state), errors, ready: Object.keys(errors).length === 0,
    scorePct: ev.scores.total.pct, flagsCount: ev.flags.length, evaluation: ev,
  };
}

export function pageNav(vm: RunnerVM, pageId: string): { index: number; total: number; prev: string | null; next: string | null } {
  const i = vm.pages.findIndex((p) => p.id === pageId);
  const at = i === -1 ? 0 : i;
  return { index: at, total: vm.pages.length, prev: at > 0 ? vm.pages[at - 1]!.id : null, next: at < vm.pages.length - 1 ? vm.pages[at + 1]!.id : null };
}

/** First question (in screen order) that blocks completion. */
export function firstProblem(vm: RunnerVM): { pageId: string; questionId: string } | null {
  for (const p of vm.pages) for (const s of p.sections) for (const q of s.questions) if (q.errors.length) return { pageId: p.id, questionId: q.id };
  return null;
}
