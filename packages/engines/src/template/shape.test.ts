import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchingPlantTemplate } from './fixtures.ts';
import { isTemplateContent, LIMITS } from './shape.ts';

test('accepts the example template and an empty draft', () => {
  assert.equal(isTemplateContent(batchingPlantTemplate()), true);
  assert.equal(isTemplateContent({ pages: [] }), true);
});

test('rejects malformed structures that would crash the engines', () => {
  const bad: unknown[] = [
    null, 'x', [], {}, { pages: 'x' },
    { pages: [{ id: 1, title: {}, items: [] }] },
    { pages: [{ id: 'p', title: { en: 5 }, items: [] }] },
    { pages: [{ id: 'p', title: {}, items: 'x' }] },
    { pages: [{ id: 'p', title: {}, items: [{ kind: 'weird', id: 'x' }] }] },
    { pages: [{ id: 'p', title: {}, items: [{ kind: 'question', id: 'q', title: {}, responseType: 5 }] }] },
    { pages: [{ id: 'p', title: {}, visibleWhen: { all: 'x' }, items: [] }] },
    { pages: [{ id: 'p', title: {}, visibleWhen: { questionId: 'a', op: 'eq', value: { evil: 1 } }, items: [] }] },
    { pages: [{ id: 'p', title: {}, items: [{ kind: 'question', id: 'q', title: {}, responseType: 'text', scoring: { optionScores: { a: 'x' } } }] }] },
    { pages: [{ id: 'p', title: {}, items: [{ kind: 'question', id: 'q', title: {}, responseType: 'text', flagRules: [1] }] }] },
    { pages: [{ id: 'p', title: {}, items: [{ kind: 'table', id: 't', title: {}, columns: [{ id: 1 }] }] }] },
    { pages: [{ id: 'p', title: {}, items: [{ kind: 'section', id: 's', title: {}, items: [{ kind: 'section' }] }] }] },
  ];
  bad.forEach((b, i) => assert.equal(isTemplateContent(b), false, `case ${i}`));
});

test('enforces size limits', () => {
  const many = (n: number) => ({
    pages: [{ id: 'p', title: { en: 'P' }, items: Array.from({ length: n }, (_, i) => ({ kind: 'question', id: `q${i}`, title: { en: 'Q' }, responseType: 'text' })) }],
  });
  assert.equal(isTemplateContent(many(LIMITS.questions)), true);
  assert.equal(isTemplateContent(many(LIMITS.questions + 1)), false);
  let deep: unknown = { questionId: 'a', op: 'empty' };
  for (let i = 0; i < LIMITS.conditionDepth + 2; i++) deep = { not: deep };
  assert.equal(isTemplateContent({ pages: [{ id: 'p', title: {}, visibleWhen: deep, items: [] }] }), false);
});
