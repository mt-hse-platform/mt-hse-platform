// Rules and counters for actions and issues on the client. The permission/transition rules are the SAME engines the
// server uses, so a button is shown only when the server would accept the move.
import type { Grant } from '../../../../packages/shared/src/permissions.ts';
import { decide } from '../../../../packages/engines/src/permission.ts';
import type { Resource, Subject } from '../../../../packages/engines/src/permission.ts';
import {
  ACTION_TRANSITIONS, ISSUE_TRANSITIONS, checkActionTransition, checkIssueTransition,
} from '../../../../packages/engines/src/workflow.ts';
import type { ActionStatus, IssueStatus } from '../../../../packages/engines/src/workflow.ts';
import type { Counts, DashboardDto, WorkItemDto, WorkKind } from './types.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

export type SessionLike = { userId: string; orgId: string; grants: Grant[]; siteIds: string[]; name?: string };

export const subjectOf = (s: SessionLike): Subject => ({ userId: s.userId, orgId: s.orgId, active: true, grants: s.grants, siteIds: s.siteIds });

export const OPEN_STATUSES: Record<WorkKind, string[]> = {
  action: ['todo', 'in_progress', 'pending_verification'],
  issue: ['open', 'under_review', 'assigned', 'in_progress'],
};
export const ALL_STATUSES: Record<WorkKind, string[]> = {
  action: ['todo', 'in_progress', 'pending_verification', 'completed', 'cancelled'],
  issue: ['open', 'under_review', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected'],
};
export const TYPES: Record<WorkKind, string[]> = {
  action: ['corrective', 'preventive', 'other'],
  issue: ['hazard', 'observation', 'unsafe_condition', 'unsafe_act', 'maintenance', 'near_miss', 'quality_issue', 'environmental_issue', 'other'],
};
export const PRIORITIES = ['critical', 'high', 'medium', 'low', 'informational'];

export function resourceOf(kind: WorkKind, s: SessionLike, item: WorkItemDto): Resource {
  return { orgId: s.orgId, siteId: item.siteId, ownerId: kind === 'action' ? item.ownerId ?? null : item.reporterId ?? null, assigneeId: item.assigneeId };
}

/** Statuses this person may move the item to right now. */
export function allowedTransitions(kind: WorkKind, s: SessionLike, item: WorkItemDto): string[] {
  const subject = subjectOf(s);
  const res = resourceOf(kind, s, item);
  if (kind === 'action') {
    const from = item.status as ActionStatus;
    return (ACTION_TRANSITIONS[from] ?? []).filter((to) => checkActionTransition(subject, res, from, to).ok);
  }
  const from = item.status as IssueStatus;
  return (ISSUE_TRANSITIONS[from] ?? []).filter((to) => checkIssueTransition(subject, res, { status: from, assigneeId: item.assigneeId }, to).ok);
}

export const canEdit = (kind: WorkKind, s: SessionLike, item: WorkItemDto): boolean =>
  decide(subjectOf(s), kind === 'action' ? 'action.edit' : 'issue.edit', resourceOf(kind, s, item)).allowed;

export const canAssign = (kind: WorkKind, s: SessionLike, item: WorkItemDto): boolean =>
  decide(subjectOf(s), kind === 'action' ? 'action.assign' : 'issue.edit', resourceOf(kind, s, item)).allowed;

export const canCreate = (kind: WorkKind, s: SessionLike): boolean =>
  s.grants.some((g) => g.permission === (kind === 'action' ? 'action.create' : 'issue.create'));

export const canAssignAtCreate = (s: SessionLike): boolean => s.grants.some((g) => g.permission === 'action.assign' || g.permission === 'issue.edit');

export const sumOf = (c: Counts, statuses: string[]): number => statuses.reduce((n, st) => n + (c.byStatus[st] ?? 0), 0);

export type DashCard = { id: string; labelKey: MessageKey; value: number; target: string; tone: 'info' | 'danger' | 'success' };

/** Home-screen cards. A card exists only when the person may read that kind of record. */
export function dashboardCards(d: DashboardDto): DashCard[] {
  const cards: DashCard[] = [];
  if (d.actions) {
    cards.push({ id: 'my_actions', labelKey: 'dash.myActions', value: d.actions.mine, target: '/actions?filter=mine', tone: 'info' });
    cards.push({ id: 'open_actions', labelKey: 'dash.openActions', value: sumOf(d.actions, OPEN_STATUSES.action), target: '/actions', tone: 'info' });
    cards.push({ id: 'overdue_actions', labelKey: 'dash.overdueActions', value: d.actions.overdue, target: '/actions?filter=overdue', tone: d.actions.overdue > 0 ? 'danger' : 'success' });
  }
  if (d.issues) {
    cards.push({ id: 'open_issues', labelKey: 'dash.openIssues', value: sumOf(d.issues, OPEN_STATUSES.issue), target: '/issues', tone: 'info' });
    cards.push({ id: 'overdue_issues', labelKey: 'dash.overdueIssues', value: d.issues.overdue, target: '/issues?filter=overdue', tone: d.issues.overdue > 0 ? 'danger' : 'success' });
  }
  if (d.inspections) {
    cards.push({ id: 'active_inspections', labelKey: 'dash.activeInspections', value: d.inspections.byStatus.in_progress ?? 0, target: '/inspections', tone: 'info' });
  }
  return cards;
}
