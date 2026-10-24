import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENABLED_MODULES, NAV_ITEMS, QUICK_ACTIONS, mobileNav, visibleNav, visibleQuickActions } from './navigation.ts';
import type { ModuleId } from './navigation.ts';
import { DEFAULT_PREFERENCES, documentAttributes, parsePreferences, resolveTheme } from './preferences.ts';
import { NetworkError, wrapTokenGetter } from './apiClient.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../../packages/shared/src/permissions.ts';
import { dictionaries } from '../../../../packages/i18n/src/index.ts';

const ALL = new Set<ModuleId>(NAV_ITEMS.map((i) => i.id));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test('today only implemented modules are visible (no dummy menu entries)', () => {
  assert.deepEqual(ids(visibleNav(DEFAULT_ROLE_GRANTS.org_admin)), ['home', 'inspections', 'templates', 'issues', 'actions', 'notifications', 'users', 'settings']);
  assert.deepEqual(ids(visibleQuickActions(DEFAULT_ROLE_GRANTS.org_admin)),
    ['start_inspection', 'report_hazard', 'report_observation', 'report_near_miss', 'create_issue', 'create_action'], 'incidents and assets are not built yet');
  assert.deepEqual(visibleQuickActions(DEFAULT_ROLE_GRANTS.viewer), [], 'viewers cannot start inspections');
  assert.deepEqual(ids(visibleNav(DEFAULT_ROLE_GRANTS.employee)), ['home', 'issues', 'actions', 'notifications', 'settings'], 'employees have no inspections or templates');
  assert.deepEqual(ids(visibleQuickActions(DEFAULT_ROLE_GRANTS.employee)), ['report_hazard', 'report_observation', 'report_near_miss', 'create_issue']);
  assert.ok(!ids(visibleNav(DEFAULT_ROLE_GRANTS.hse_manager)).includes('users'), 'only administrators see the Users page');
});

test('with every module enabled, visibility follows permissions', () => {
  const admin = ids(visibleNav(DEFAULT_ROLE_GRANTS.org_admin, ALL));
  assert.equal(admin.length, NAV_ITEMS.length);

  const employee = ids(visibleNav(DEFAULT_ROLE_GRANTS.employee, ALL));
  assert.ok(employee.includes('incidents') && employee.includes('assets') && employee.includes('actions'));
  for (const hidden of ['templates', 'inspections', 'analytics', 'reports', 'library']) assert.ok(!employee.includes(hidden), hidden);

  const viewerQuick = visibleQuickActions(DEFAULT_ROLE_GRANTS.viewer, ALL);
  assert.deepEqual(viewerQuick, []);
  const inspectorQuick = ids(visibleQuickActions(DEFAULT_ROLE_GRANTS.inspector, ALL));
  assert.ok(inspectorQuick.includes('start_inspection') && inspectorQuick.includes('create_action'));
  assert.ok(!inspectorQuick.includes('add_asset'));
});

test('mobile nav: 4 primary slots, rest under More; single leftover is promoted', () => {
  const full = mobileNav(visibleNav(DEFAULT_ROLE_GRANTS.org_admin, ALL));
  assert.deepEqual(ids(full.primary), ['home', 'inspections', 'actions', 'issues']);
  assert.equal(full.more.length, NAV_ITEMS.length - 4);
  const today = mobileNav(visibleNav(DEFAULT_ROLE_GRANTS.org_admin));
  assert.deepEqual(ids(today.primary), ['home', 'inspections', 'actions', 'issues']);
  assert.deepEqual(ids(today.more), ['templates', 'notifications', 'users', 'settings']);
  const few = mobileNav(NAV_ITEMS.filter((i) => i.id === 'home' || i.id === 'settings'));
  assert.deepEqual(ids(few.primary), ['home', 'settings'], 'a single leftover entry is promoted instead of a More menu');
  const small = mobileNav(visibleNav(DEFAULT_ROLE_GRANTS.employee));
  assert.deepEqual([ids(small.primary), ids(small.more)], [['home', 'actions', 'issues'], ['notifications', 'settings']]);
});

test('every nav and quick-action label key exists in both languages', () => {
  for (const key of [...NAV_ITEMS.map((i) => i.labelKey), ...QUICK_ACTIONS.map((a) => a.labelKey)]) {
    assert.ok(key in dictionaries.en && key in dictionaries.ar, key);
  }
  assert.ok(ENABLED_MODULES.has('home'));
});

test('preferences: defaults, partial and corrupted input', () => {
  assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences('{bad'), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences('{"locale":"en"}'), { locale: 'en', theme: 'dark' });
  assert.deepEqual(parsePreferences('{"locale":"xx","theme":"neon"}'), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences('42'), DEFAULT_PREFERENCES);
});

test('theme resolution and document attributes (real RTL for Arabic)', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.deepEqual(documentAttributes({ locale: 'ar', theme: 'dark' }, false), { lang: 'ar', dir: 'rtl', theme: 'dark' });
  assert.deepEqual(documentAttributes({ locale: 'en', theme: 'system' }, false), { lang: 'en', dir: 'ltr', theme: 'light' });
});

test('token getter: offline refresh failure becomes NetworkError; other errors pass through', async () => {
  const offline = wrapTokenGetter(async () => { throw Object.assign(new Error('x'), { code: 'auth/network-request-failed' }); });
  await assert.rejects(offline(), (e) => e instanceof NetworkError);
  const other = wrapTokenGetter(async () => { throw Object.assign(new Error('x'), { code: 'auth/user-disabled' }); });
  await assert.rejects(other(), (e) => !(e instanceof NetworkError));
  assert.equal(await wrapTokenGetter(async () => 'T')(), 'T');
});
