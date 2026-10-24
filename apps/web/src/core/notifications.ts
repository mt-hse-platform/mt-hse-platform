// How a notification is shown: which message, with which values, and where tapping it leads.
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

export type NotificationDto = {
  id: string; type: string; entityType: string; entityId: string; actorUserId: string | null;
  data: { entityTitle?: string; actorName?: string; dueDate?: string }; createdAt: string; readAt: string | null;
};

const MESSAGES: Record<string, MessageKey> = {
  action_assigned: 'notif.action_assigned',
  issue_assigned: 'notif.issue_assigned',
  comment_added: 'notif.comment_added',
  action_pending_verification: 'notif.action_pending_verification',
  action_overdue: 'notif.action_overdue',
  issue_overdue: 'notif.issue_overdue',
};

const TARGETS: Record<string, string> = { action: '/actions', issue: '/issues', inspection: '/inspections' };

export type NotificationView = { messageKey: MessageKey; params: { actor: string; title: string; date: string }; target: string; unread: boolean };

/** Unknown types (a newer server) still render, as a generic message. `someone` is the translated word for a missing actor. */
export function notificationView(n: NotificationDto, someone: string): NotificationView {
  const base = TARGETS[n.entityType];
  return {
    messageKey: MESSAGES[n.type] ?? 'notif.unknown',
    params: { actor: n.data?.actorName?.trim() || someone, title: n.data?.entityTitle?.trim() || '—', date: n.data?.dueDate ?? '—' },
    target: base ? `${base}/${n.entityId}` : '/',
    unread: n.readAt === null,
  };
}

/** Shown on the bell: "99+" instead of huge numbers; nothing for zero. */
export const badgeText = (count: number): string => (count <= 0 ? '' : count > 99 ? '99+' : String(count));
