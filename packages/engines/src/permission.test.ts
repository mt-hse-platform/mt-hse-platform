import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, hasPermission, listFilter } from './permission.ts';
import type { Subject } from './permission.ts';
import { DEFAULT_ROLE_GRANTS, PERMISSIONS } from '../../shared/src/permissions.ts';
import type { RoleKey } from '../../shared/src/permissions.ts';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

const subject = (role: RoleKey, over: Partial<Subject> = {}): Subject => ({
  userId: 'u1',
  orgId: ORG,
  active: true,
  grants: DEFAULT_ROLE_GRANTS[role],
  siteIds: ['siteA'],
  ...over,
});

test('cross-organization access is always denied, even for org_admin', () => {
  const d = decide(subject('org_admin'), 'inspection.read', { orgId: OTHER_ORG });
  assert.deepEqual(d, { allowed: false, reason: 'cross_org' });
});

test('inactive users are denied everything', () => {
  const d = decide(subject('org_admin', { active: false }), 'inspection.read', { orgId: ORG });
  assert.deepEqual(d, { allowed: false, reason: 'inactive' });
  assert.equal(hasPermission(subject('org_admin', { active: false }), 'inspection.read'), false);
});

test('org-scope role can access any record in own org', () => {
  const d = decide(subject('hse_manager'), 'issue.close', { orgId: ORG, siteId: 'siteZ' });
  assert.equal(d.allowed, true);
});

test('supervisor: allowed on own site, denied on another site or when site is missing', () => {
  const s = subject('supervisor');
  assert.equal(decide(s, 'inspection.read', { orgId: ORG, siteId: 'siteA' }).allowed, true);
  assert.deepEqual(decide(s, 'inspection.read', { orgId: ORG, siteId: 'siteB' }), { allowed: false, reason: 'scope_mismatch' });
  assert.deepEqual(decide(s, 'inspection.read', { orgId: ORG }), { allowed: false, reason: 'scope_mismatch' });
});

test('inspector reads only own inspections', () => {
  const s = subject('inspector');
  assert.equal(decide(s, 'inspection.read', { orgId: ORG, ownerId: 'u1' }).allowed, true);
  assert.equal(decide(s, 'inspection.read', { orgId: ORG, ownerId: 'u2' }).allowed, false);
});

test('employee can complete an action only when assigned to them', () => {
  const s = subject('employee');
  assert.equal(decide(s, 'action.complete', { orgId: ORG, assigneeId: 'u1' }).allowed, true);
  assert.equal(decide(s, 'action.complete', { orgId: ORG, assigneeId: 'u9' }).allowed, false);
});

test('missing permission is denied (deny by default)', () => {
  assert.deepEqual(decide(subject('viewer'), 'issue.create', { orgId: ORG }), { allowed: false, reason: 'no_grant' });
  assert.deepEqual(decide(subject('employee'), 'template.publish', { orgId: ORG }), { allowed: false, reason: 'no_grant' });
});

test('only admin roles can manage users and settings', () => {
  for (const role of ['super_admin', 'org_admin'] as const) {
    assert.equal(hasPermission(subject(role), 'user.manage'), true);
    assert.equal(hasPermission(subject(role), 'settings.manage'), true);
  }
  for (const role of ['hse_manager', 'supervisor', 'inspector', 'employee', 'viewer'] as const) {
    assert.equal(hasPermission(subject(role), 'user.manage'), false, role);
    assert.equal(hasPermission(subject(role), 'settings.manage'), false, role);
  }
});

test('viewer has no write permission at all', () => {
  const writeVerbs = ['create', 'edit', 'delete', 'publish', 'close', 'assign', 'complete', 'investigate', 'manage', 'export'];
  const s = subject('viewer');
  for (const p of PERMISSIONS) {
    const verb = p.split('.')[1]!;
    if (writeVerbs.includes(verb)) assert.equal(hasPermission(s, p), false, p);
  }
});

test('listFilter: org-wide, site-limited, own+assigned, none', () => {
  assert.deepEqual(listFilter(subject('hse_manager'), 'issue.read'), { orgWide: true, siteIds: [] });
  assert.deepEqual(listFilter(subject('supervisor'), 'issue.read'), { orgWide: false, siteIds: ['siteA'] });
  assert.deepEqual(listFilter(subject('inspector'), 'action.read'), { orgWide: false, siteIds: [], ownerId: 'u1', assigneeId: 'u1' });
  assert.equal(listFilter(subject('viewer'), 'user.manage'), null);
  assert.equal(listFilter(subject('org_admin', { active: false }), 'issue.read'), null);
});

test('every role grant references a real permission, no duplicates per (permission, scope)', () => {
  for (const [role, grants] of Object.entries(DEFAULT_ROLE_GRANTS)) {
    const seen = new Set<string>();
    for (const g of grants) {
      assert.ok((PERMISSIONS as readonly string[]).includes(g.permission), `${role}: ${g.permission}`);
      const k = `${g.permission}:${g.scope}`;
      assert.ok(!seen.has(k), `${role} duplicate ${k}`);
      seen.add(k);
    }
  }
});
