import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchingPlantTemplate } from './fixtures.ts';
import { applyFormulas, computeState, conditionRefs, evalCondition } from './conditions.ts';
import { evalFormula, parseFormula } from './formula.ts';
import { evaluateInspection } from './scoring.ts';
import { validateAnswers, validateTemplate } from './validate.ts';
import {
  TEMPLATE_STATUS_TRANSITIONS, createDraftFromPublished, fingerprintOf, isEditable, publishVersion, stableStringify, verifyIntegrity,
} from './versioning.ts';
import type { TemplateVersion } from './versioning.ts';
import type { Condition, Question, TemplateContent } from './types.ts';

const codes = (c: TemplateContent) => validateTemplate(c).map((i) => i.code);

// ---------- conditions ----------

test('condition operators', () => {
  const ans: Record<string, unknown> = { a: 'no', n: 12, m: ['x', 'y'], e: '', z: 0 };
  const get = (id: string) => ans[id];
  const t = (c: Condition) => evalCondition(c, get);
  assert.equal(t({ questionId: 'a', op: 'eq', value: 'no' }), true);
  assert.equal(t({ questionId: 'a', op: 'neq', value: 'yes' }), true);
  assert.equal(t({ questionId: 'missing', op: 'neq', value: 'yes' }), true, 'unanswered is "not equal"');
  assert.equal(t({ questionId: 'missing', op: 'eq', value: 'yes' }), false);
  assert.equal(t({ questionId: 'a', op: 'in', value: ['no', 'na'] }), true);
  assert.equal(t({ questionId: 'm', op: 'in', value: ['y'] }), true, 'multi-select intersects');
  assert.equal(t({ questionId: 'a', op: 'not_in', value: ['yes'] }), true);
  assert.equal(t({ questionId: 'n', op: 'gt', value: 8 }), true);
  assert.equal(t({ questionId: 'n', op: 'lte', value: 12 }), true);
  assert.equal(t({ questionId: 'a', op: 'gt', value: 1 }), false, 'non-numeric never compares');
  assert.equal(t({ questionId: 'z', op: 'lt', value: 1 }), true, 'zero is a value');
  assert.equal(t({ questionId: 'e', op: 'empty' }), true);
  assert.equal(t({ questionId: 'a', op: 'not_empty' }), true);
  assert.equal(t({ questionId: 'm', op: 'contains', value: 'x' }), true);
  assert.equal(t({ all: [{ questionId: 'a', op: 'eq', value: 'no' }, { not: { questionId: 'n', op: 'lt', value: 5 } }] }), true);
  assert.equal(t({ any: [{ questionId: 'a', op: 'eq', value: 'yes' }, { questionId: 'n', op: 'gt', value: 100 }] }), false);
  assert.deepEqual(conditionRefs({ all: [{ questionId: 'a', op: 'empty' }, { not: { questionId: 'b', op: 'empty' } }] }), ['a', 'b']);
});

test('visibility cascades: hidden parent hides children, hidden question answers do not count', () => {
  const content: TemplateContent = {
    pages: [{
      id: 'p', title: { en: 'P' }, items: [
        { kind: 'question', id: 'a', title: { en: 'A' }, responseType: 'yes_no' },
        { kind: 'question', id: 'b', title: { en: 'B' }, responseType: 'yes_no', visibleWhen: { questionId: 'a', op: 'eq', value: 'no' } },
        { kind: 'question', id: 'c', title: { en: 'C' }, responseType: 'yes_no', visibleWhen: { questionId: 'b', op: 'eq', value: 'yes' } },
        { kind: 'section', id: 's', title: { en: 'S' }, visibleWhen: { questionId: 'a', op: 'eq', value: 'no' }, items: [
          { kind: 'question', id: 'd', title: { en: 'D' }, responseType: 'text' },
        ] },
      ],
    }],
  };
  const s1 = computeState(content, { a: 'yes', b: 'yes' });
  assert.deepEqual([s1.visible.b, s1.visible.c, s1.visible.s, s1.visible.d], [false, false, false, false], 'b hidden => its answer ignored => c hidden');
  const s2 = computeState(content, { a: 'no', b: 'yes' });
  assert.deepEqual([s2.visible.b, s2.visible.c, s2.visible.s, s2.visible.d], [true, true, true, true]);
});

test('runtime cycle does not hang and hides the nodes involved', () => {
  const content: TemplateContent = {
    pages: [{ id: 'p', title: { en: 'P' }, items: [
      { kind: 'question', id: 'a', title: { en: 'A' }, responseType: 'text', visibleWhen: { questionId: 'b', op: 'not_empty' } },
      { kind: 'question', id: 'b', title: { en: 'B' }, responseType: 'text', visibleWhen: { questionId: 'a', op: 'not_empty' } },
    ] }],
  };
  const s = computeState(content, { a: 'x', b: 'y' });
  assert.equal(s.visible.a, false);
  assert.equal(s.visible.b, false);
});

// ---------- formulas ----------

test('formula parser and evaluator', () => {
  const run = (src: string, vars: Record<string, number | null> = {}) => {
    const p = parseFormula(src);
    return p.ok ? evalFormula(p.ast, (id) => vars[id] ?? null) : 'PARSE_ERROR';
  };
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('-{a} + 10', { a: 4 }), 6);
  assert.equal(run('{a} / {b}', { a: 9, b: 3 }), 3);
  assert.equal(run('{a} / 0', { a: 9 }), null, 'division by zero');
  assert.equal(run('{a} + 1'), null, 'missing reference');
  for (const bad of ['', '1 +', '(1', '1 2', '{a', 'process.exit()', '{a}; alert(1)', '1 + * 2', 'Math.max(1,2)']) {
    assert.equal(run(bad), 'PARSE_ERROR', bad);
  }
  assert.deepEqual((parseFormula('{a} + {b} * {a}') as { refs: string[] }).refs, ['a', 'b']);
});

test('formula questions are computed, and ignore hidden inputs', () => {
  const content = batchingPlantTemplate();
  assert.equal(applyFormulas(content, { q_hours: 10, q_cost: 2.5 }).q_total, 25);
  assert.equal(applyFormulas(content, { q_hours: 10 }).q_total, null);
  assert.equal(applyFormulas(content, { q_hours: 10, q_cost: 2 }, (id) => id === 'q_cost').q_total, null);
});

// ---------- scoring and flags ----------

test('scoring: weights, N/A exclusion, hidden answers ignored, section/page/category buckets', () => {
  const ev = evaluateInspection(batchingPlantTemplate(), {
    q_helmet: 'yes', q_vest: 'no', q_ppe_type: 'general', q_welding_screen: 'no', // hidden: must be ignored
    q_fire_ext: 'na', q_condition: 'fair', q_rating: 4,
  });
  const s = ev.scores;
  assert.deepEqual(s.total, { earned: 154, possible: 405, pct: 38.02 });
  assert.deepEqual(s.pages.p_general, { earned: 100, possible: 300, pct: 33.33 });
  assert.deepEqual(s.pages.p_equipment, { earned: 54, possible: 105, pct: 51.43 });
  assert.deepEqual(s.sections.s_ppe, { earned: 100, possible: 300, pct: 33.33 });
  assert.deepEqual(s.categories.ppe, { earned: 100, possible: 300, pct: 33.33 });
  assert.equal(s.categories.fire, undefined, 'only N/A answers => no bucket');
  assert.equal(s.answeredScored, 4);
  assert.equal(s.excludedNa, 1);
  assert.equal(s.unansweredScored, 0);
  assert.equal(s.passed, false);
  assert.deepEqual(s.perQuestion.q_rating, { earned: 4, max: 5, weight: 1, pct: 80 });
  assert.equal(s.perQuestion.q_welding_screen, undefined);
});

test('scoring: nothing answered => null percentage; perfect answers pass the threshold', () => {
  const empty = evaluateInspection(batchingPlantTemplate(), {});
  assert.equal(empty.scores.total.pct, null);
  assert.equal(empty.scores.passed, null);
  assert.equal(empty.scores.unansweredScored, 5, 'helmet, vest, fire, condition, rating are visible and unanswered');
  const perfect = evaluateInspection(batchingPlantTemplate(), { q_helmet: 'yes', q_vest: 'yes', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 });
  assert.equal(perfect.scores.total.pct, 100);
  assert.equal(perfect.scores.passed, true);
  assert.equal(perfect.flags.length, 0);
  assert.equal(perfect.flaggedRate, 0);
});

test('custom option scores, maxScore and invalid answers', () => {
  const q: Question = { kind: 'question', id: 'q', title: { en: 'Q' }, responseType: 'multiple_choice',
    options: [{ value: 'a', label: { en: 'A' } }, { value: 'b', label: { en: 'B' } }, { value: 'c', label: { en: 'C' } }],
    scoring: { optionScores: { a: 10, b: 5, c: null }, weight: 3 } };
  const content: TemplateContent = { pages: [{ id: 'p', title: { en: 'P' }, items: [q] }] };
  assert.deepEqual(evaluateInspection(content, { q: 'b' }).scores.total, { earned: 15, possible: 30, pct: 50 });
  assert.equal(evaluateInspection(content, { q: 'c' }).scores.excludedNa, 1);
  assert.equal(evaluateInspection(content, { q: 'zzz' }).scores.answeredScored, 0, 'unknown option is not scored');
});

test('flags: rules, severity, hidden and unanswered never flag; flagged rate', () => {
  const base = { q_helmet: 'yes', q_vest: 'no', q_fire_ext: 'na', q_condition: 'fair', q_rating: 4 };
  const a = evaluateInspection(batchingPlantTemplate(), { ...base, q_ppe_type: 'general', q_welding_screen: 'no' });
  assert.deepEqual(a.flags.map((f) => [f.questionId, f.severity]), [['q_vest', 'medium']]);
  assert.equal(a.flaggedRate, 25);

  const b = evaluateInspection(batchingPlantTemplate(), { ...base, q_ppe_type: 'welding', q_welding_screen: 'no', q_condition: 'poor', q_pressure: 9 });
  assert.deepEqual(b.flags.map((f) => [f.questionId, f.severity]).sort(), [
    ['q_condition', 'medium'], ['q_pressure', 'high'], ['q_vest', 'medium'], ['q_welding_screen', 'critical'],
  ]);
  assert.equal(b.flags.find((f) => f.questionId === 'q_vest')!.sectionId, 's_ppe');
  assert.equal(b.state.visible.p_emergency, true);

  const rules = evaluateInspection(batchingPlantTemplate(), { q_helmet: 'no' });
  assert.equal(rules.flags[0]!.descriptions[0]!.en, 'Helmet missing');
});

// ---------- answer validation ----------

test('answers: required, conditional required, hidden skipped, type and range checks', () => {
  const content = batchingPlantTemplate();
  const check = (answers: Record<string, unknown>) => {
    const ev = evaluateInspection(content, answers);
    return validateAnswers(content, ev.answers, ev.state);
  };
  assert.deepEqual(Object.keys(check({})), ['q_helmet'], 'only the required, visible question');
  assert.deepEqual(check({ q_helmet: 'yes' }), {});
  assert.equal(check({ q_helmet: 'yes', q_condition: 'poor' }).q_notes![0]!.code, 'required', 'requiredWhen');
  assert.deepEqual(check({ q_helmet: 'yes', q_condition: 'poor', q_notes: 'Belt torn' }), {});
  assert.equal(check({ q_helmet: 'yes', q_pressure: 9 }).q_emergency_plan![0]!.code, 'required', 'page became visible');
  assert.deepEqual(check({ q_helmet: 'yes', q_emergency_plan: '' }), {}, 'page hidden => not validated');
  assert.equal(check({ q_helmet: 'maybe' }).q_helmet![0]!.code, 'invalid_option');
  assert.equal(check({ q_helmet: 'yes', q_pressure: 99 }).q_pressure![0]!.code, 'max');
  assert.equal(check({ q_helmet: 'yes', q_rating: 6 }).q_rating![0]!.code, 'max');
  assert.equal(check({ q_helmet: 'yes', q_hours: 1.5 }).q_hours![0]!.code, 'not_integer');
});

// ---------- publish validation ----------

test('the example template is valid', () => {
  assert.deepEqual(validateTemplate(batchingPlantTemplate()), []);
});

test('publish validation catches each class of mistake', () => {
  const mutate = (fn: (c: TemplateContent) => void) => { const c = batchingPlantTemplate(); fn(c); return codes(c); };
  const q = (c: TemplateContent, id: string): Question => {
    for (const p of c.pages) for (const i of p.items) {
      if (i.kind === 'question' && i.id === id) return i;
      if (i.kind === 'section') for (const s of i.items) if (s.kind === 'question' && s.id === id) return s;
    }
    throw new Error(id);
  };

  assert.ok(codes({ pages: [] }).includes('empty_template'));
  assert.ok(mutate((c) => { c.pages.push({ id: 'p_new', title: { en: 'Empty' }, items: [] }); }).includes('empty_page'));
  assert.ok(mutate((c) => { c.pages[0]!.title = {}; }).includes('missing_title'));
  assert.ok(mutate((c) => { q(c, 'q_vest').id = 'q_helmet'; }).includes('duplicate_id'));
  assert.ok(mutate((c) => { q(c, 'q_vest').id = 'bad id!'; }).includes('invalid_id'));
  assert.ok(mutate((c) => { q(c, 'q_ppe_type').options = []; }).includes('choice_without_options'));
  assert.ok(mutate((c) => { q(c, 'q_ppe_type').options![1]!.value = 'general'; }).includes('invalid_options'));
  assert.ok(mutate((c) => { (q(c, 'q_rating') as { ratingMax: number }).ratingMax = 7; }).includes('invalid_rating_max'));
  assert.ok(mutate((c) => { q(c, 'q_pressure').min = 20; }).includes('invalid_range'));
  assert.ok(mutate((c) => { c.passThresholdPct = 140; }).includes('invalid_threshold'));
  // scoring
  assert.ok(mutate((c) => { q(c, 'q_hours').scoring = {}; }).includes('unscorable_type'));
  assert.ok(mutate((c) => { q(c, 'q_helmet').scoring = { optionScores: { maybe: 50 } }; }).includes('unknown_option_score'));
  assert.ok(mutate((c) => { q(c, 'q_helmet').scoring = { weight: 0 }; }).includes('invalid_scoring'));
  assert.ok(mutate((c) => { q(c, 'q_helmet').scoring = { optionScores: { yes: -5 } }; }).includes('invalid_scoring'));
  assert.ok(mutate((c) => { q(c, 'q_ppe_type').scoring = {}; }).includes('invalid_scoring'), 'multiple_choice needs explicit scores');
  // flags
  assert.ok(mutate((c) => { q(c, 'q_helmet').flagRules = [{ when: { answerIn: ['sometimes'] }, severity: 'high' }]; }).includes('unknown_flag_option'));
  assert.ok(mutate((c) => { q(c, 'q_helmet').flagRules = [{ when: {}, severity: 'high' }]; }).includes('invalid_flag_rule'));
  assert.ok(mutate((c) => { q(c, 'q_pressure').flagRules = [{ when: { scoreBelowPct: 50 }, severity: 'low' }]; }).includes('flag_needs_scoring'));
  assert.ok(mutate((c) => { q(c, 'q_helmet').flagRules = [{ when: { numberGt: 3 }, severity: 'low' }]; }).includes('invalid_flag_rule'));
  // conditions
  assert.ok(mutate((c) => { q(c, 'q_welding_screen').visibleWhen = { questionId: 'ghost', op: 'eq', value: 'x' }; }).includes('invalid_condition_ref'));
  assert.ok(mutate((c) => { q(c, 'q_welding_screen').visibleWhen = { questionId: 'q_welding_screen', op: 'eq', value: 'x' }; }).includes('self_reference'));
  assert.ok(mutate((c) => { q(c, 'q_welding_screen').visibleWhen = { questionId: 'q_ppe_type', op: 'in', value: 'welding' as unknown as string[] }; }).includes('invalid_condition'));
  assert.ok(mutate((c) => { q(c, 'q_welding_screen').visibleWhen = { questionId: 'q_ppe_type', op: 'eq' }; }).includes('invalid_condition'));
  assert.ok(mutate((c) => {
    q(c, 'q_ppe_type').visibleWhen = { questionId: 'q_welding_screen', op: 'not_empty' }; // ppe_type <- welding_screen <- ppe_type
  }).includes('condition_cycle'));
  assert.ok(mutate((c) => { c.pages[2]!.visibleWhen = { questionId: 'q_emergency_plan', op: 'not_empty' }; }).includes('condition_cycle'), 'page depends on its own child');
  // formulas
  assert.ok(mutate((c) => { q(c, 'q_total').formula = '{q_hours} *'; }).includes('invalid_formula'));
  assert.ok(mutate((c) => { q(c, 'q_total').formula = '{q_helmet} + 1'; }).includes('invalid_formula_ref'));
  assert.ok(mutate((c) => { q(c, 'q_total').formula = '{q_total} + 1'; }).includes('formula_cycle'));
});

test('tables are validated structurally', () => {
  const c: TemplateContent = { pages: [{ id: 'p', title: { en: 'P' }, items: [
    { kind: 'table', id: 't', title: { en: 'T' }, columns: [], repeating: true },
  ] }] };
  assert.ok(codes(c).includes('invalid_table'));
  const ok: TemplateContent = { pages: [{ id: 'p', title: { en: 'P' }, items: [
    { kind: 'table', id: 't', title: { en: 'Items' }, repeating: true, minRows: 1, maxRows: 5,
      columns: [{ id: 'item', title: { en: 'Item' }, responseType: 'text' }, { id: 'qty', title: { en: 'Qty' }, responseType: 'number' }] },
  ] }] };
  assert.deepEqual(codes(ok), []);
});

// ---------- versioning ----------

const draft = (): TemplateVersion => ({
  id: 'v1', templateId: 't1', versionNo: 1, status: 'draft', content: batchingPlantTemplate(),
  fingerprint: null, publishedAt: null, publishedBy: null,
});

test('publishing: blocked while invalid; succeeds when valid and freezes a fingerprint', () => {
  const bad = draft();
  bad.content.pages[0]!.items = [];
  const blocked = publishVersion(bad, { userId: 'u1', now: '2026-10-03T10:00:00Z' });
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.issues.some((i) => i.code === 'empty_page'));

  const r = publishVersion(draft(), { userId: 'u1', now: '2026-10-03T10:00:00Z' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.version.status, 'published');
  assert.equal(r.version.publishedBy, 'u1');
  assert.ok(r.version.fingerprint);
  assert.equal(isEditable(r.version), false);
  assert.equal(verifyIntegrity(r.version), true);
  assert.equal(publishVersion(r.version, { userId: 'u1', now: 'x' }).ok, false, 'cannot publish twice');
});

test('integrity check detects tampering with a published version', () => {
  const r = publishVersion(draft(), { userId: 'u1', now: 'n' });
  assert.ok(r.ok);
  if (!r.ok) return;
  const tampered: TemplateVersion = JSON.parse(JSON.stringify(r.version));
  (tampered.content.pages[0]!.items[0] as { title: { en: string } }).title.en = 'Changed';
  assert.equal(verifyIntegrity(tampered), false);
});

test('editing a published template creates an independent draft; old inspections keep their scoring', () => {
  const r = publishVersion(draft(), { userId: 'u1', now: 'n' });
  assert.ok(r.ok);
  if (!r.ok) return;
  const v1 = r.version;
  const answers = { q_helmet: 'yes', q_vest: 'no', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 };
  const before = evaluateInspection(v1.content, answers).scores.total;

  const v2 = createDraftFromPublished(v1, 'v2');
  assert.equal(v2.versionNo, 2);
  assert.equal(v2.status, 'draft');
  assert.equal(v2.fingerprint, null);
  // change the draft heavily
  const vest = (v2.content.pages[0]!.items[0] as { items: { id: string; scoring?: { weight?: number } }[] }).items[1]!;
  vest.scoring = { weight: 10 };
  v2.content.pages.pop();

  assert.deepEqual(evaluateInspection(v1.content, answers).scores.total, before, 'v1 scoring is unchanged');
  assert.notDeepEqual(evaluateInspection(v2.content, answers).scores.total, before);
  assert.equal(verifyIntegrity(v1), true, 'v1 still intact');
  assert.equal(v1.content.pages.length, 3);
  assert.throws(() => createDraftFromPublished(draft(), 'x'), /published/);
});

test('fingerprint ignores key order; template status transitions are defined for every status', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const c1 = batchingPlantTemplate();
  const c2 = JSON.parse(JSON.stringify(c1)) as TemplateContent;
  assert.equal(fingerprintOf(c1), fingerprintOf(c2));
  (c2.pages[0] as { title: { en: string } }).title.en = 'Different';
  assert.notEqual(fingerprintOf(c1), fingerprintOf(c2));
  assert.deepEqual(Object.keys(TEMPLATE_STATUS_TRANSITIONS).sort(), ['archived', 'draft', 'published']);
});

// ---------- single-value validation and progress (used by inspection autosave) ----------

import { progressOf, validateQuestionValue } from './validate.ts';

test('validateQuestionValue: type checks regardless of required; empty is fine unless required', () => {
  const q = (over: Partial<Question>): Question => ({ kind: 'question', id: 'q', title: { en: 'Q' }, responseType: 'text', ...over } as Question);
  assert.deepEqual(validateQuestionValue(q({ responseType: 'yes_no' }), 'yes', false), []);
  assert.equal(validateQuestionValue(q({ responseType: 'yes_no' }), 'maybe', false)[0]!.code, 'invalid_option');
  assert.deepEqual(validateQuestionValue(q({ responseType: 'number' }), null, false), []);
  assert.equal(validateQuestionValue(q({ responseType: 'number' }), null, true)[0]!.code, 'required');
  assert.equal(validateQuestionValue(q({ responseType: 'checkbox' }), 'yes', false)[0]!.code, 'invalid_type');
  assert.deepEqual(validateQuestionValue(q({ responseType: 'checkbox' }), false, true), [], 'false is an answer');
  assert.deepEqual(validateQuestionValue(q({ responseType: 'gps' }), { lat: 30.04, lng: 31.23 }, false), []);
  assert.equal(validateQuestionValue(q({ responseType: 'gps' }), { lat: 130, lng: 31 }, false)[0]!.code, 'invalid_type');
  assert.equal(validateQuestionValue(q({ responseType: 'text', maxLength: 3 }), 'abcd', false)[0]!.code, 'max_length');
});

test('progress counts only visible, enabled, non-computed questions', () => {
  const content = batchingPlantTemplate();
  const p0 = evaluateInspection(content, {});
  assert.deepEqual(progressOf(content, p0.answers, p0.state), { answered: 0, total: 10, requiredMissing: 1 });
  const ev = evaluateInspection(content, { q_helmet: 'yes', q_vest: 'no', q_hours: 4, q_cost: 2, q_pressure: 9 });
  // total grows by 1 (emergency page appears because pressure > 8); formula q_total is not counted
  assert.deepEqual(progressOf(content, ev.answers, ev.state), { answered: 5, total: 11, requiredMissing: 1 });
});
