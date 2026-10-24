import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActivePath, parseRoute, pathOf, routePath } from './router.ts';
import type { Route } from './router.ts';
import { buildRunner, collectValues, firstProblem, pageNav } from './runner.ts';
import { createEndpoints } from './endpoints.ts';
import { batchingPlantTemplate } from '../../../../packages/engines/src/template/fixtures.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('router: parse, build and round-trip every route; unknown paths are not_found', () => {
  const routes: Route[] = [
    { name: 'home' }, { name: 'inspections' }, { name: 'inspection_new' }, { name: 'inspection', id: ID },
    { name: 'inspection_report', id: ID }, { name: 'templates' }, { name: 'users' }, { name: 'notifications' }, { name: 'settings' },
  ];
  for (const r of routes) assert.deepEqual(parseRoute(`#${routePath(r)}`), r, routePath(r));
  assert.deepEqual(parseRoute(''), { name: 'home' });
  assert.deepEqual(parseRoute('#'), { name: 'home' });
  assert.deepEqual(parseRoute('#/inspections/'), { name: 'inspections' }, 'trailing slash');
  assert.deepEqual(parseRoute(`#/inspections/${ID}?tab=2`), { name: 'inspection', id: ID }, 'query ignored');
  for (const bad of ['#/nope', '#/inspections/not-a-uuid', `#/inspections/${ID}/extra`, `#/inspections/${ID}/report/x`, '#/settings/x', '#/../etc']) {
    assert.deepEqual(parseRoute(bad), { name: 'not_found' }, bad);
  }
  assert.equal(pathOf('#/templates?x=1'), '/templates');
});

test('menu highlighting: home only on "/", other entries include their sub-pages but not look-alikes', () => {
  assert.equal(isActivePath('/', '/'), true);
  assert.equal(isActivePath('/inspections', '/'), false);
  assert.equal(isActivePath(`/inspections/${ID}`, '/inspections'), true);
  assert.equal(isActivePath('/inspections/new', '/inspections'), true);
  assert.equal(isActivePath('/inspections-archive', '/inspections'), false);
  assert.equal(isActivePath('/templates', '/inspections'), false);
});

test('runner: only visible pages and questions; required and progress follow the answers', () => {
  const content = batchingPlantTemplate();
  const vm = buildRunner(content, {});
  assert.deepEqual(vm.pages.map((p) => p.id), ['p_general', 'p_equipment'], 'emergency page is hidden');
  const ids = vm.pages.flatMap((p) => p.sections.flatMap((s) => s.questions.map((q) => q.id)));
  assert.ok(!ids.includes('q_welding_screen'));
  assert.equal(vm.ready, false);
  assert.deepEqual(vm.progress, { answered: 0, total: 10, requiredMissing: 1 });
  assert.equal(vm.pages[0]!.sections[0]!.id, 's_ppe');
  assert.equal(vm.pages[0]!.sections[0]!.questions[0]!.required, true);
  assert.equal(vm.pages[1]!.sections[0]!.id, null, 'loose questions form an unnamed block');

  const welding = buildRunner(content, { q_helmet: 'yes', q_ppe_type: 'welding' });
  assert.ok(welding.pages[0]!.sections[0]!.questions.some((q) => q.id === 'q_welding_screen'), 'condition revealed a question');
  assert.equal(welding.ready, true);

  const high = buildRunner(content, { q_helmet: 'yes', q_pressure: 9 });
  assert.deepEqual(high.pages.map((p) => p.id), ['p_general', 'p_equipment', 'p_emergency']);
  assert.equal(high.ready, false, 'the emergency plan question became required');
});

test('runner: computed fields, per-page counts, live score and flags', () => {
  const vm = buildRunner(batchingPlantTemplate(), { q_helmet: 'no', q_vest: 'yes', q_hours: 4, q_cost: 2.5, q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 });
  const total = vm.pages[1]!.sections[0]!.questions.find((q) => q.id === 'q_total')!;
  assert.equal(total.computed, true);
  assert.equal(total.value, 10);
  assert.equal(total.answered, true);
  assert.equal(vm.pages[1]!.total, 7, 'equipment page: 8 visible questions, the computed one is not counted');
  assert.equal(vm.pages[0]!.answered, 2);
  assert.equal(vm.scorePct, 80.2, '(0 + 200 + 100 + 100 + 5) / (100 + 200 + 100 + 100 + 5)');
  assert.equal(vm.flagsCount, 1);
});

test('runner: collectValues uses local answers first and drops empty ones; navigation and first problem', () => {
  const content = batchingPlantTemplate();
  const local: Record<string, unknown> = { q_helmet: 'yes' };
  const values = collectValues(content, (id) => (id in local ? local[id] : id === 'q_vest' ? 'no' : null));
  assert.deepEqual(values, { q_helmet: 'yes', q_vest: 'no' });

  const vm = buildRunner(content, {});
  assert.deepEqual(pageNav(vm, 'p_general'), { index: 0, total: 2, prev: null, next: 'p_equipment' });
  assert.deepEqual(pageNav(vm, 'p_equipment'), { index: 1, total: 2, prev: 'p_general', next: null });
  assert.deepEqual(pageNav(vm, 'unknown'), { index: 0, total: 2, prev: null, next: 'p_equipment' });
  assert.deepEqual(firstProblem(vm), { pageId: 'p_general', questionId: 'q_helmet' });
  assert.equal(firstProblem(buildRunner(content, { q_helmet: 'yes' })), null);
  // problem on a later page is found when the first page is fine
  const later = buildRunner(content, { q_helmet: 'yes', q_condition: 'poor' });
  assert.deepEqual(firstProblem(later), { pageId: 'p_equipment', questionId: 'q_notes' });
});

test('endpoints: paths, methods and bodies', async () => {
  const calls: { path: string; init?: { method?: string; body?: unknown } }[] = [];
  const api = createEndpoints({ async request(path: string, init?: { method?: string; body?: unknown }) { calls.push({ path, init }); return {} as never; } } as never);
  await api.listSites();
  await api.listTemplates({ status: 'published', limit: 50 });
  await api.listInspections({ cursor: 'a|b' });
  await api.startInspection({ templateId: 't1', siteId: 's1' });
  await api.completeInspection('i1');
  await api.fromFlag('i1', 'f1', 'action', { priority: 'low' });
  await api.publishTemplate('t1', 3);
  await api.importTemplate({ name: { en: 'X' }, content: { pages: [] } });
  await api.createSite('Station A');
  await api.deleteMedia('m1');
  await api.addSignature('i1', { mediaId: 'm1', signerName: 'A B' });
  await api.listUsers();
  await api.listNotifications({ unread: true, limit: 10 });
  await api.unreadCount();
  await api.markRead({ all: true });
  await api.inviteUser({ email: 'a@b.co', fullName: 'A B', roleId: 'r1', siteIds: [] });
  await api.updateMember('m1', { version: 2, status: 'inactive' });
  await api.revokeInvitation('i9');
  assert.deepEqual(calls.map((c) => [c.init?.method ?? 'GET', c.path]), [
    ['GET', '/sites'], ['GET', '/templates?status=published&limit=50'], ['GET', '/inspections?cursor=a%7Cb'],
    ['POST', '/inspections'], ['POST', '/inspections/i1/complete'], ['POST', '/inspections/i1/flags/f1/action'],
    ['POST', '/templates/t1/publish'], ['POST', '/templates'],
    ['POST', '/sites'], ['DELETE', '/media/m1'], ['POST', '/inspections/i1/signatures'], ['GET', '/users'], ['GET', '/notifications?unread=1&limit=10'], ['GET', '/notifications/unread-count'], ['POST', '/notifications/read'], ['POST', '/users/invitations'], ['PATCH', '/users/m1'], ['POST', '/users/invitations/i9/revoke'],
  ]);
  assert.deepEqual(calls[5]!.init!.body, { priority: 'low' });
  assert.deepEqual(calls[6]!.init!.body, { version: 3 });
});
