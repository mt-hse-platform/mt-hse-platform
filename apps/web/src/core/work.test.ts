import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTransitions, canAssign, canAssignAtCreate, canCreate, canEdit, dashboardCards, sumOf } from './work.ts';
import type { SessionLike } from './work.ts';
import type { DashboardDto, WorkItemDto } from './types.ts';
import { parseRoute, routePath } from './router.ts';
import type { Route } from './router.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../../packages/shared/src/permissions.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const sess = (role: RoleKey, over: Partial<SessionLike> = {}): SessionLike => ({ userId: 'me', orgId: 'org', grants: DEFAULT_ROLE_GRANTS[role], siteIds: ['siteA'], ...over });
const action = (over: Partial<WorkItemDto> = {}): WorkItemDto => ({
  id: 'a1', title: 'Fix', description: null, type: 'corrective', priority: 'high', status: 'todo', assigneeId: 'me', siteId: 'siteA', dueDate: null,
  version: 1, inspectionId: null, questionId: null, createdAt: '2026-10-01T00:00:00Z', ownerId: 'boss', ...over,
});
const issue = (over: Partial<WorkItemDto> = {}): WorkItemDto => action({ type: 'hazard', status: 'open', reporterId: 'rep', ownerId: undefined, assigneeId: null, ...over });

test('the assignee can move their action forward but not cancel it; managers get the full set', () => {
  assert.deepEqual(allowedTransitions('action', sess('employee'), action()), ['in_progress'], 'start only (cancel needs edit rights)');
  assert.deepEqual(allowedTransitions('action', sess('employee'), action({ status: 'in_progress' })), ['pending_verification', 'completed', ]);
  assert.deepEqual(allowedTransitions('action', sess('hse_manager'), action({ status: 'in_progress' })).sort(), ['cancelled', 'completed', 'pending_verification', 'todo']);
  assert.deepEqual(allowedTransitions('action', sess('employee'), action({ assigneeId: 'someone-else' })), [], 'not assigned to me');
  assert.deepEqual(allowedTransitions('action', sess('viewer'), action()), []);
  assert.deepEqual(allowedTransitions('action', sess('employee'), action({ status: 'completed' })), [], 'reopening needs edit rights');
});

test('nobody verifies their own work unless they manage the whole organization', () => {
  const pending = action({ status: 'pending_verification', assigneeId: 'me' });
  assert.ok(!allowedTransitions('action', sess('supervisor'), pending).includes('completed'));
  assert.ok(allowedTransitions('action', sess('hse_manager'), pending).includes('completed'));
  assert.ok(allowedTransitions('action', sess('supervisor'), { ...pending, assigneeId: 'other' }).includes('completed'));
});

test('issue transitions: assigning needs an assignee; closing needs the close permission', () => {
  const mgr = sess('hse_manager');
  assert.ok(!allowedTransitions('issue', mgr, issue()).includes('assigned'), 'no assignee yet');
  assert.ok(allowedTransitions('issue', mgr, issue({ assigneeId: 'x' })).includes('assigned'));
  assert.deepEqual(allowedTransitions('issue', mgr, issue({ status: 'resolved' })).sort(), ['closed', 'in_progress']);
  assert.deepEqual(allowedTransitions('issue', sess('employee'), issue({ status: 'resolved', reporterId: 'me' })), [], 'employees cannot move issues');
  assert.deepEqual(allowedTransitions('issue', sess('supervisor', { siteIds: ['other'] }), issue()), [], 'outside their site');
});

test('editing, assigning and creating follow the permissions and scopes', () => {
  assert.equal(canEdit('action', sess('hse_manager'), action()), true);
  assert.equal(canEdit('action', sess('employee'), action()), false);
  assert.equal(canEdit('action', sess('supervisor'), action({ siteId: 'siteA' })), true);
  assert.equal(canEdit('action', sess('supervisor'), action({ siteId: 'siteZ' })), false);
  assert.equal(canAssign('action', sess('inspector'), action({ ownerId: 'me' })), false, 'inspectors cannot assign');
  assert.equal(canAssign('action', sess('hse_manager'), action()), true);
  assert.equal(canCreate('action', sess('employee')), false);
  assert.equal(canCreate('issue', sess('employee')), true);
  assert.equal(canAssignAtCreate(sess('inspector')), true, 'inspectors may edit their own issues, which includes picking someone');
  assert.equal(canAssignAtCreate(sess('employee')), false);
});

test('home cards exist only for what the person may read, and mirror the counters', () => {
  const dash: DashboardDto = {
    today: '2026-10-03',
    actions: { byStatus: { todo: 3, in_progress: 2, completed: 5, cancelled: 1 }, overdue: 2, mine: 4 },
    issues: { byStatus: { open: 1, resolved: 7, assigned: 2 }, overdue: 0, mine: 0 },
    inspections: { byStatus: { in_progress: 3, completed: 9 }, overdue: 0, mine: 1 },
  };
  const cards = dashboardCards(dash);
  assert.deepEqual(cards.map((c) => [c.id, c.value]), [
    ['my_actions', 4], ['open_actions', 5], ['overdue_actions', 2], ['open_issues', 3], ['overdue_issues', 0], ['active_inspections', 3],
  ]);
  assert.equal(cards.find((c) => c.id === 'overdue_actions')!.tone, 'danger');
  assert.equal(cards.find((c) => c.id === 'overdue_issues')!.tone, 'success');
  assert.deepEqual(dashboardCards({ ...dash, actions: null, inspections: null }).map((c) => c.id), ['open_issues', 'overdue_issues']);
  assert.deepEqual(dashboardCards({ ...dash, actions: null, issues: null, inspections: null }), []);
  assert.equal(sumOf(dash.actions!, ['todo', 'nothing']), 3);
});

test('routes for actions and issues: filters, new-item pages and ids round-trip', () => {
  const routes: Route[] = [
    { name: 'actions', filter: null }, { name: 'actions', filter: 'mine' }, { name: 'actions', filter: 'overdue' }, { name: 'action', id: ID }, { name: 'action_new' },
    { name: 'issues', filter: null }, { name: 'issues', filter: 'overdue' }, { name: 'issue', id: ID }, { name: 'issue_new', type: null }, { name: 'issue_new', type: 'near_miss' },
  ];
  for (const r of routes) assert.deepEqual(parseRoute(`#${routePath(r)}`), r, routePath(r));
  assert.deepEqual(parseRoute('#/actions?filter=bogus'), { name: 'actions', filter: null }, 'unknown filters are ignored');
  assert.deepEqual(parseRoute('#/actions/not-a-uuid'), { name: 'not_found' });
  assert.deepEqual(parseRoute(`#/issues/${ID}/x`), { name: 'not_found' });
});
