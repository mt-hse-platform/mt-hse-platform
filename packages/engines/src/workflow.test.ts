import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTION_STATUSES, ACTION_TRANSITIONS, ACTION_TYPES, ISSUE_STATUSES, ISSUE_TRANSITIONS, ISSUE_TYPES, PRIORITIES,
  applyActionTransition, checkActionTransition, checkIssueTransition, effectiveActionStatus, isIssueOverdue,
} from './workflow.ts';
import { diffEntity, draftFromQuestion } from './activity.ts';
import { actionCreateRules, issueCreateRules } from './entityRules.ts';
import { validateForm } from './validation.ts';
import type { Subject } from './permission.ts';
import { DEFAULT_ROLE_GRANTS } from '../../shared/src/permissions.ts';
import type { RoleKey } from '../../shared/src/permissions.ts';

const ORG = 'org-1';
const subj = (role: RoleKey, over: Partial<Subject> = {}): Subject => ({
  userId: 'u1', orgId: ORG, active: true, grants: DEFAULT_ROLE_GRANTS[role], siteIds: ['siteA'], ...over,
});
const res = (over = {}) => ({ orgId: ORG, siteId: 'siteA', ownerId: 'owner', assigneeId: 'u1', ...over });

test('state machines: every transition target is a known status, and no state is a dead end', () => {
  for (const [from, tos] of Object.entries(ACTION_TRANSITIONS)) {
    assert.ok((ACTION_STATUSES as readonly string[]).includes(from));
    assert.ok(tos.length > 0, `action ${from} is a dead end`);
    for (const to of tos) assert.ok((ACTION_STATUSES as readonly string[]).includes(to));
  }
  for (const [from, tos] of Object.entries(ISSUE_TRANSITIONS)) {
    assert.ok((ISSUE_STATUSES as readonly string[]).includes(from));
    assert.ok(tos.length > 0, `issue ${from} is a dead end`);
    for (const to of tos) assert.ok((ISSUE_STATUSES as readonly string[]).includes(to));
  }
  assert.deepEqual(Object.keys(ACTION_TRANSITIONS).sort(), [...ACTION_STATUSES].sort());
  assert.deepEqual(Object.keys(ISSUE_TRANSITIONS).sort(), [...ISSUE_STATUSES].sort());
});

test('action: invalid jumps are rejected even for admins', () => {
  assert.deepEqual(checkActionTransition(subj('org_admin'), res(), 'todo', 'completed'), { ok: false, reason: 'invalid_transition' });
  assert.deepEqual(checkActionTransition(subj('org_admin'), res(), 'completed', 'cancelled'), { ok: false, reason: 'invalid_transition' });
});

test('action: assignee can progress their work but cannot cancel or reopen', () => {
  const emp = subj('employee');
  assert.deepEqual(checkActionTransition(emp, res(), 'todo', 'in_progress'), { ok: true });
  assert.deepEqual(checkActionTransition(emp, res(), 'in_progress', 'pending_verification'), { ok: true });
  assert.equal(checkActionTransition(emp, res(), 'in_progress', 'cancelled').ok, false);
  assert.equal(checkActionTransition(emp, res(), 'completed', 'in_progress').ok, false);
});

test('action: someone else assigned => employee denied', () => {
  const r = checkActionTransition(subj('employee'), res({ assigneeId: 'someone-else' }), 'todo', 'in_progress');
  assert.deepEqual(r, { ok: false, reason: 'scope_mismatch' });
});

test('action: nobody verifies their own work unless they have org-wide edit rights', () => {
  // supervisor (site scope) who is also the assignee
  assert.deepEqual(checkActionTransition(subj('supervisor'), res(), 'pending_verification', 'completed'), { ok: false, reason: 'self_verification' });
  // same supervisor verifying someone else's work
  assert.deepEqual(checkActionTransition(subj('supervisor'), res({ assigneeId: 'other' }), 'pending_verification', 'completed'), { ok: true });
  // HSE manager may verify even their own
  assert.deepEqual(checkActionTransition(subj('hse_manager'), res(), 'pending_verification', 'completed'), { ok: true });
});

test('action: cross-org and inactive subjects are denied', () => {
  assert.deepEqual(checkActionTransition(subj('org_admin'), res({ orgId: 'other-org' }), 'todo', 'in_progress'), { ok: false, reason: 'cross_org' });
  assert.deepEqual(checkActionTransition(subj('org_admin', { active: false }), res(), 'todo', 'in_progress'), { ok: false, reason: 'inactive' });
});

test('completion stamps completedAt; any other status clears it', () => {
  assert.deepEqual(applyActionTransition('completed', '2026-10-03T10:00:00Z'), { status: 'completed', completedAt: '2026-10-03T10:00:00Z' });
  assert.deepEqual(applyActionTransition('in_progress', '2026-10-03T10:00:00Z'), { status: 'in_progress', completedAt: null });
});

test('overdue is derived: only for open statuses with a past due date', () => {
  const today = '2026-10-03';
  assert.equal(effectiveActionStatus({ status: 'todo', dueDate: '2026-10-02' }, today), 'overdue');
  assert.equal(effectiveActionStatus({ status: 'in_progress', dueDate: '2026-10-02' }, today), 'overdue');
  assert.equal(effectiveActionStatus({ status: 'todo', dueDate: '2026-10-03' }, today), 'todo', 'due today is not overdue');
  assert.equal(effectiveActionStatus({ status: 'todo', dueDate: null }, today), 'todo');
  assert.equal(effectiveActionStatus({ status: 'completed', dueDate: '2020-01-01' }, today), 'completed');
  assert.equal(effectiveActionStatus({ status: 'cancelled', dueDate: '2020-01-01' }, today), 'cancelled');
  assert.equal(isIssueOverdue({ status: 'open', dueDate: '2026-10-01' }, today), true);
  assert.equal(isIssueOverdue({ status: 'closed', dueDate: '2026-10-01' }, today), false);
  assert.equal(isIssueOverdue({ status: 'resolved', dueDate: '2026-10-01' }, today), false);
});

test('issue: assigning needs an assignee; closing needs issue.close; transitions follow the table', () => {
  const mgr = subj('hse_manager');
  assert.deepEqual(checkIssueTransition(mgr, res(), { status: 'open' }, 'assigned'), { ok: false, reason: 'missing_assignee' });
  assert.deepEqual(checkIssueTransition(mgr, res(), { status: 'open', assigneeId: 'u2' }, 'assigned'), { ok: true });
  assert.deepEqual(checkIssueTransition(mgr, res(), { status: 'open' }, 'closed'), { ok: false, reason: 'invalid_transition' });
  assert.deepEqual(checkIssueTransition(mgr, res(), { status: 'resolved' }, 'closed'), { ok: true });
  // employee can create issues but not move them
  assert.equal(checkIssueTransition(subj('employee'), res({ ownerId: 'u1' }), { status: 'open' }, 'under_review').ok, false);
  // viewer never
  assert.equal(checkIssueTransition(subj('viewer'), res(), { status: 'resolved' }, 'closed').ok, false);
});

test('diffEntity: one event per changed field with old and new values', () => {
  const before = { status: 'todo', assigneeId: null, priority: 'low', dueDate: '2026-10-10', title: 'A' };
  const after = { status: 'in_progress', assigneeId: 'u2', priority: 'low', dueDate: '2026-10-12', title: 'A' };
  assert.deepEqual(diffEntity(before, after), [
    { event: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_progress' },
    { event: 'assigned', field: 'assigneeId', oldValue: null, newValue: 'u2' },
    { event: 'due_date_changed', field: 'dueDate', oldValue: '2026-10-10', newValue: '2026-10-12' },
  ]);
  assert.deepEqual(diffEntity(before, { ...before }), []);
  assert.deepEqual(diffEntity({ title: 'x' }, { title: 'y' }), [{ event: 'updated', field: 'title', oldValue: 'x', newValue: 'y' }]);
  assert.deepEqual(diffEntity({}, { status: null }), [], 'undefined and null are the same');
});

test('draftFromQuestion pre-fills everything from the inspection and question', () => {
  const d = draftFromQuestion(
    { inspectionId: 'i1', templateId: 't1', templateVersionId: 'tv2', siteId: 'siteA', assetId: null },
    { questionId: 'q18', title: '  Are fire extinguishers available?  ' }, 'u1',
  );
  assert.deepEqual(d, {
    title: 'Are fire extinguishers available?', siteId: 'siteA', assetId: null, createdBy: 'u1',
    source: { inspectionId: 'i1', templateId: 't1', templateVersionId: 'tv2', questionId: 'q18' },
  });
});

test('create rules: required fields, enums, no past due date', () => {
  const today = '2026-10-03';
  const ok = { title: 'Fix guard', type: 'hazard', priority: 'high', dueDate: '2026-10-10' };
  assert.deepEqual(validateForm(ok, issueCreateRules(today)), { ok: true, errors: {} });
  const bad = validateForm({ title: 'x', type: 'nope', priority: '', dueDate: '2026-10-01' }, issueCreateRules(today));
  assert.deepEqual(Object.keys(bad.errors).sort(), ['dueDate', 'priority', 'title', 'type']);
  assert.equal(validateForm({ title: 'Replace hose', type: 'corrective', priority: 'low' }, actionCreateRules(today)).ok, true);
  assert.equal(validateForm({ title: 'Replace hose', type: 'hazard', priority: 'low' }, actionCreateRules(today)).ok, false);
});

test('SQL CHECK lists in migration 0002 match the TypeScript constants', () => {
  const sql = readFileSync(new URL('../../../db/migrations/0002_issues_actions.sql', import.meta.url), 'utf8');
  const list = (table: string, column: string): string[] => {
    const block = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? '';
    const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(block);
    assert.ok(m, `${table}.${column} CHECK not found`);
    return m![1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
  };
  assert.deepEqual(list('issues', 'type'), [...ISSUE_TYPES]);
  assert.deepEqual(list('issues', 'priority'), [...PRIORITIES]);
  assert.deepEqual(list('issues', 'status'), [...ISSUE_STATUSES]);
  assert.deepEqual(list('actions', 'type'), [...ACTION_TYPES]);
  assert.deepEqual(list('actions', 'priority'), [...PRIORITIES]);
  assert.deepEqual(list('actions', 'status'), [...ACTION_STATUSES]);
});
