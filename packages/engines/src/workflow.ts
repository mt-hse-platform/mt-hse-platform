// Issue and Action lifecycles: allowed transitions, who may perform them, derived "overdue", completion stamping.
// Pure functions, shared by API and UI. Overdue is DERIVED (never stored) so it can never go stale.
import { decide } from './permission.ts';
import type { Resource, Subject } from './permission.ts';
import type { Permission } from '../../shared/src/permissions.ts';

export const PRIORITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ISSUE_TYPES = [
  'hazard', 'observation', 'unsafe_condition', 'unsafe_act', 'maintenance', 'near_miss',
  'quality_issue', 'environmental_issue', 'other',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_STATUSES = ['open', 'under_review', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ACTION_TYPES = ['corrective', 'preventive', 'other'] as const;
export const ACTION_STATUSES = ['todo', 'in_progress', 'pending_verification', 'completed', 'cancelled'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type EffectiveActionStatus = ActionStatus | 'overdue';

export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['pending_verification', 'completed', 'todo', 'cancelled'],
  pending_verification: ['completed', 'in_progress', 'cancelled'],
  completed: ['in_progress'], // reopen
  cancelled: ['todo'],        // reopen
};

export const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['under_review', 'assigned', 'rejected'],
  under_review: ['open', 'assigned', 'rejected'],
  assigned: ['in_progress', 'under_review'],
  in_progress: ['resolved', 'assigned'],
  resolved: ['closed', 'in_progress'],
  closed: ['in_progress'],   // reopen
  rejected: ['open'],        // reopen
};

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_transition' | 'missing_assignee' | 'self_verification' | 'inactive' | 'cross_org' | 'no_grant' | 'scope_mismatch' };

// ---------- Actions ----------

/** Work-progress moves may be done by the assignee (action.complete); everything else needs action.edit. */
export function actionTransitionPermission(from: ActionStatus, to: ActionStatus): Permission {
  const progress =
    (from === 'todo' && to === 'in_progress') ||
    (from === 'in_progress' && (to === 'pending_verification' || to === 'completed'));
  return progress ? 'action.complete' : 'action.edit';
}

export function checkActionTransition(subject: Subject, resource: Resource, from: ActionStatus, to: ActionStatus): TransitionResult {
  if (!ACTION_TRANSITIONS[from]?.includes(to)) return { ok: false, reason: 'invalid_transition' };
  const d = decide(subject, actionTransitionPermission(from, to), resource);
  if (!d.allowed) return { ok: false, reason: d.reason };
  // Separation of duties: nobody verifies their own work, unless they hold org-wide edit rights (managers).
  if (from === 'pending_verification' && to === 'completed' && resource.assigneeId === subject.userId && d.scope !== 'org') {
    return { ok: false, reason: 'self_verification' };
  }
  return { ok: true };
}

export function applyActionTransition(to: ActionStatus, nowIso: string): { status: ActionStatus; completedAt: string | null } {
  return { status: to, completedAt: to === 'completed' ? nowIso : null };
}

const OPEN_ACTION: readonly ActionStatus[] = ['todo', 'in_progress', 'pending_verification'];

/** `today` is a YYYY-MM-DD date in the organization's timezone, supplied by the caller. */
export function effectiveActionStatus(a: { status: ActionStatus; dueDate?: string | null }, today: string): EffectiveActionStatus {
  return OPEN_ACTION.includes(a.status) && a.dueDate && a.dueDate < today ? 'overdue' : a.status;
}

// ---------- Issues ----------

export function issueTransitionPermission(to: IssueStatus): Permission {
  return to === 'closed' || to === 'rejected' ? 'issue.close' : 'issue.edit';
}

export function checkIssueTransition(
  subject: Subject, resource: Resource, issue: { status: IssueStatus; assigneeId?: string | null }, to: IssueStatus,
): TransitionResult {
  if (!ISSUE_TRANSITIONS[issue.status]?.includes(to)) return { ok: false, reason: 'invalid_transition' };
  if (to === 'assigned' && !issue.assigneeId) return { ok: false, reason: 'missing_assignee' };
  const d = decide(subject, issueTransitionPermission(to), resource);
  return d.allowed ? { ok: true } : { ok: false, reason: d.reason };
}

const OPEN_ISSUE: readonly IssueStatus[] = ['open', 'under_review', 'assigned', 'in_progress'];

export function isIssueOverdue(i: { status: IssueStatus; dueDate?: string | null }, today: string): boolean {
  return OPEN_ISSUE.includes(i.status) && !!i.dueDate && i.dueDate < today;
}
