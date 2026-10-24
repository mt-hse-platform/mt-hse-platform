import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickResumable } from './resume.ts';
import type { InspectionDto } from './types.ts';

const insp = (id: string, over: Partial<InspectionDto> = {}): InspectionDto => ({
  id, templateId: 't', templateVersionId: 'v', title: null, status: 'in_progress', startedBy: 'me', siteId: null,
  startedAt: '2026-10-20T08:00:00Z', completedAt: null, scorePct: null, passed: null, flaggedRate: null, version: 1, ...over,
});

test('only my in-progress inspections are offered, newest first', () => {
  const list = [
    insp('old', { startedAt: '2026-10-01T08:00:00Z' }),
    insp('new', { startedAt: '2026-10-23T08:00:00Z' }),
    insp('theirs', { startedBy: 'other' }),
    insp('done', { status: 'completed' }),
    insp('cancelled', { status: 'cancelled' }),
    insp('archived', { status: 'archived' }),
  ];
  assert.deepEqual(pickResumable(list, 'me').map((i) => i.id), ['new', 'old']);
});

test('the list is capped, and a bad cap never throws', () => {
  const list = Array.from({ length: 9 }, (_, n) => insp(`i${n}`, { startedAt: `2026-10-${10 + n}T08:00:00Z` }));
  assert.equal(pickResumable(list, 'me').length, 5);
  assert.equal(pickResumable(list, 'me', 2).length, 2);
  assert.deepEqual(pickResumable(list, 'me', 0), []);
  assert.deepEqual(pickResumable(list, 'me', -3), []);
});

test('same start time keeps a stable order; nothing to resume gives an empty list', () => {
  const a = insp('a'); const b = insp('b');
  assert.deepEqual(pickResumable([b, a], 'me').map((i) => i.id), ['a', 'b']);
  assert.deepEqual(pickResumable([], 'me'), []);
});

test('does not change the list it is given', () => {
  const list = [insp('x', { startedAt: '2026-10-01T00:00:00Z' }), insp('y', { startedAt: '2026-10-02T00:00:00Z' })];
  pickResumable(list, 'me');
  assert.deepEqual(list.map((i) => i.id), ['x', 'y']);
});
