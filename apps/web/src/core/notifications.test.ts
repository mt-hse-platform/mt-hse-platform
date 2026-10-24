import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, notificationView } from './notifications.ts';
import type { NotificationDto } from './notifications.ts';
import { dictionaries } from '../../../../packages/i18n/src/index.ts';

const n = (over: Partial<NotificationDto> = {}): NotificationDto => ({
  id: 'n1', type: 'action_assigned', entityType: 'action', entityId: 'a1', actorUserId: 'u1',
  data: { entityTitle: 'Fix the guard', actorName: 'Manager Mona' }, createdAt: '2026-10-03T10:00:00Z', readAt: null, ...over,
});

test('each notification type has a message, the right values, and leads to the right screen', () => {
  assert.deepEqual(notificationView(n(), 'Someone'), {
    messageKey: 'notif.action_assigned', params: { actor: 'Manager Mona', title: 'Fix the guard', date: '—' }, target: '/actions/a1', unread: true,
  });
  assert.equal(notificationView(n({ type: 'issue_assigned', entityType: 'issue', entityId: 'i9' }), 's').target, '/issues/i9');
  assert.equal(notificationView(n({ type: 'comment_added' }), 's').messageKey, 'notif.comment_added');
  assert.equal(notificationView(n({ type: 'action_pending_verification' }), 's').messageKey, 'notif.action_pending_verification');
  const overdue = notificationView(n({ type: 'action_overdue', actorUserId: null, data: { entityTitle: 'Late', dueDate: '2026-10-01' } }), 'Someone');
  assert.deepEqual([overdue.messageKey, overdue.params.date, overdue.params.actor], ['notif.action_overdue', '2026-10-01', 'Someone']);
  assert.equal(notificationView(n({ entityType: 'inspection', entityId: 'x' }), 's').target, '/inspections/x');
  assert.equal(notificationView(n({ readAt: '2026-10-03T11:00:00Z' }), 's').unread, false);
});

test('unknown or incomplete notifications still render safely', () => {
  const v = notificationView(n({ type: 'from_the_future', entityType: 'robot', data: {} }), 'Someone');
  assert.equal(v.messageKey, 'notif.unknown');
  assert.equal(v.target, '/');
  assert.deepEqual(v.params, { actor: 'Someone', title: '—', date: '—' });
  const noData = notificationView({ ...n(), data: undefined as unknown as NotificationDto['data'] }, 'S');
  assert.equal(noData.params.title, '—');
});

test('every notification message exists in both languages and uses the values we pass', () => {
  for (const type of ['action_assigned', 'issue_assigned', 'comment_added', 'action_pending_verification', 'action_overdue', 'issue_overdue']) {
    const key = notificationView(n({ type }), 's').messageKey;
    for (const locale of ['ar', 'en'] as const) {
      const text = dictionaries[locale][key];
      assert.ok(text && text.length > 0, `${locale}:${key}`);
      for (const [, name] of text.matchAll(/\{(\w+)\}/g)) assert.ok(['actor', 'title', 'date'].includes(name!), `${key} uses {${name}}`);
    }
  }
});

test('bell badge text', () => {
  assert.equal(badgeText(0), ''); assert.equal(badgeText(-3), ''); assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99'); assert.equal(badgeText(100), '99+'); assert.equal(badgeText(5000), '99+');
});
