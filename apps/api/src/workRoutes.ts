// Issues, Actions, action comments and per-entity timelines.
// Rule of thumb in every handler: authenticate (done by the server) -> object-level permission -> validation ->
// transaction -> timeline events. A record the caller may not read is reported as 404 (existence is not leaked).
import { AppError } from './ports.ts';
import type { PdfRenderer } from './ports.ts';
import type { BlobStore } from './blobStore.ts';
import type { AuthContext } from './auth.ts';
import type { ActionRow, Clock, IssueRow, NewNotification, WorkRepo, WorkTx } from './workTypes.ts';
import { decide, listFilter } from '../../../packages/engines/src/permission.ts';
import type { Resource, Subject } from '../../../packages/engines/src/permission.ts';
import { validateField, validateForm } from '../../../packages/engines/src/validation.ts';
import type { FormResult, ValidationError } from '../../../packages/engines/src/validation.ts';
import {
  ACTION_STATUSES, ISSUE_STATUSES, applyActionTransition, checkActionTransition, checkIssueTransition,
  effectiveActionStatus, isIssueOverdue,
} from '../../../packages/engines/src/workflow.ts';
import type { ActionStatus, IssueStatus } from '../../../packages/engines/src/workflow.ts';
import { diffEntity } from '../../../packages/engines/src/activity.ts';
import { actionCreateRules, issueCreateRules } from '../../../packages/engines/src/entityRules.ts';

export type WorkDeps = { work: WorkRepo; clock: Clock; pdf?: PdfRenderer; blobs?: BlobStore };
export type WorkRequest = { method: string; path: string; query: URLSearchParams; body: unknown; ctx: AuthContext; raw?: Buffer; contentType?: string };
export type Out = { status: number; body: unknown; raw?: { contentType: string; data: string | Buffer; headers?: Record<string, string> } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const CURSOR_RE = /^[0-9T:.\-Z]+\|[0-9a-f-]{36}$/i;

export const fail = (name: string, code: string): AppError => new AppError(422, 'validation', { [name]: [{ code }] });
export const invalidRef = (name: string) => fail(name, 'invalid_reference');

export function assertValid(r: FormResult): void {
  if (!r.ok) throw new AppError(422, 'validation', r.errors);
}

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AppError(400, 'invalid_body');
  return body as Record<string, unknown>;
}

export function optUuid(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (!isUuid(v)) throw fail(name, 'invalid_type');
  return v;
}

export const normText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function parseSource(v: unknown) {
  const empty = { inspectionId: null, templateId: null, templateVersionId: null, questionId: null };
  if (v === undefined || v === null) return empty;
  const o = asObject(v);
  return {
    inspectionId: optUuid(o.inspectionId, 'source'), templateId: optUuid(o.templateId, 'source'),
    templateVersionId: optUuid(o.templateVersionId, 'source'), questionId: optUuid(o.questionId, 'source'),
  };
}

function parseList(q: URLSearchParams, statuses: readonly string[]) {
  const status = q.get('status') ?? undefined;
  if (status && !statuses.includes(status)) throw fail('status', 'invalid_option');
  const limit = Number(q.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('limit', 'invalid_number');
  const cursor = q.get('cursor') ?? undefined;
  if (cursor && !CURSOR_RE.test(cursor)) throw fail('cursor', 'invalid_type');
  const flag = (name: string) => {
    const v = q.get(name);
    if (v !== null && v !== '0' && v !== '1') throw fail(name, 'invalid_option');
    return v === '1';
  };
  return { status, limit, cursor, mine: flag('mine'), overdue: flag('overdue') };
}

export const txCtx = (ctx: AuthContext) => ({ orgId: ctx.orgId, userId: ctx.user.id });
const issueRes = (ctx: AuthContext, i: IssueRow): Resource => ({ orgId: ctx.orgId, siteId: i.siteId, ownerId: i.reporterId, assigneeId: i.assigneeId });
const actionRes = (ctx: AuthContext, a: ActionRow): Resource => ({ orgId: ctx.orgId, siteId: a.siteId, ownerId: a.ownerId, assigneeId: a.assigneeId });

const presentIssue = (i: IssueRow, today: string) => ({ ...i, overdue: isIssueOverdue(i, today) });
const presentAction = (a: ActionRow, today: string) => ({ ...a, effectiveStatus: effectiveActionStatus(a, today) });

function transitionError(reason: string): AppError {
  if (reason === 'invalid_transition' || reason === 'missing_assignee' || reason === 'self_verification') {
    return new AppError(422, reason);
  }
  return new AppError(403, 'forbidden');
}

function fieldErrors(cur: Record<string, unknown>, b: Record<string, unknown>, rules: Record<string, import('../../../packages/engines/src/validation.ts').FieldRule>, required: string[]) {
  const errors: Record<string, ValidationError[]> = {};
  for (const key of ['title', 'description', 'type', 'priority', 'dueDate']) {
    if (key in b && b[key] !== cur[key]) {
      const e = validateField(b[key], { ...rules[key]!, required: required.includes(key) });
      if (e.length) errors[key] = e;
    }
  }
  if (Object.keys(errors).length) throw new AppError(422, 'validation', errors);
}

/** Tells people about something that concerns them. Never notifies the person who did it; always in the same transaction. */
export async function notify(tx: WorkTx, ctx: AuthContext, items: Omit<NewNotification, 'actorUserId'>[]): Promise<void> {
  const rows = items
    .filter((i) => i.userId !== ctx.user.id)
    .map((i) => ({ ...i, actorUserId: ctx.user.id, data: { ...i.data, actorName: ctx.user.fullName } }));
  if (rows.length > 0) await tx.insertNotifications(rows);
}

// ======================= Issues =======================

async function createIssue(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  const today = deps.clock.today();
  assertValid(validateForm(b, issueCreateRules(today)));
  const siteId = optUuid(b.siteId, 'siteId');
  const assetId = optUuid(b.assetId, 'assetId');
  const assigneeId = optUuid(b.assigneeId, 'assigneeId');
  if (!decide(ctx.subject, 'issue.create', { orgId: ctx.orgId, siteId, ownerId: ctx.user.id }).allowed) throw new AppError(403, 'forbidden');
  const source = parseSource(b.source);

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    if (assigneeId && !(await tx.isActiveMember(assigneeId))) throw invalidRef('assigneeId');
    const row = await tx.insertIssue({
      orgId: ctx.orgId, title: String(b.title).trim(), description: normText(b.description),
      type: b.type as string, priority: b.priority as string, status: 'open',
      reporterId: ctx.user.id, assigneeId, siteId, assetId, dueDate: normText(b.dueDate), ...source,
    });
    await tx.appendTimeline([{ entityType: 'issue', entityId: row.id, event: 'created', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { status: row.status, priority: row.priority } }]);
    if (assigneeId) await notify(tx, ctx, [{ userId: assigneeId, type: 'issue_assigned', entityType: 'issue', entityId: row.id, data: { entityTitle: row.title } }]);
    return { status: 201, body: presentIssue(row, today) };
  });
}

async function getReadableIssue(tx: WorkTx, ctx: AuthContext, id: string): Promise<IssueRow> {
  const row = await tx.getIssue(id);
  if (!row || !decide(ctx.subject, 'issue.read', issueRes(ctx, row)).allowed) throw new AppError(404, 'not_found');
  return row;
}

async function listIssues(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const filter = listFilter(req.ctx.subject, 'issue.read');
  if (!filter) throw new AppError(403, 'forbidden');
  const { status, limit, cursor, mine, overdue } = parseList(req.query, ISSUE_STATUSES);
  const today = deps.clock.today();
  return deps.work.transaction(txCtx(req.ctx), async (tx) => {
    const rows = await tx.listIssues({ filter, status, limit: limit + 1, cursor, assigneeOnly: mine ? req.ctx.user.id : undefined, overdueBefore: overdue ? today : undefined });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { status: 200, body: { items: items.map((i) => presentIssue(i, today)), nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null } };
  });
}

const ISSUE_PATCHABLE = ['version', 'title', 'description', 'type', 'priority', 'dueDate', 'assigneeId', 'status'];

async function patchIssue(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  for (const k of Object.keys(b)) if (!ISSUE_PATCHABLE.includes(k)) throw fail(k, 'unknown_field');
  if (!Number.isInteger(b.version)) throw fail('version', 'required');
  const today = deps.clock.today();

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const cur = await getReadableIssue(tx, ctx, id);
    if (cur.version !== b.version) throw new AppError(409, 'conflict');
    const res = issueRes(ctx, cur);

    fieldErrors(cur as unknown as Record<string, unknown>, b, issueCreateRules(today), ['title', 'type', 'priority']);
    const changed: Partial<IssueRow> = {};
    if ('title' in b) changed.title = String(b.title).trim();
    if ('description' in b) changed.description = normText(b.description);
    if ('type' in b) changed.type = b.type as string;
    if ('priority' in b) changed.priority = b.priority as string;
    if ('dueDate' in b) changed.dueDate = normText(b.dueDate);
    if ('assigneeId' in b) {
      const a = optUuid(b.assigneeId, 'assigneeId');
      if (a !== cur.assigneeId && a && !(await tx.isActiveMember(a))) throw invalidRef('assigneeId');
      changed.assigneeId = a;
    }
    for (const k of Object.keys(changed) as (keyof IssueRow)[]) if (changed[k] === cur[k]) delete changed[k];

    if (Object.keys(changed).length > 0 && !decide(ctx.subject, 'issue.edit', res).allowed) throw new AppError(403, 'forbidden');

    const next: IssueRow = { ...cur, ...changed };
    if (b.status !== undefined && b.status !== cur.status) {
      if (!(ISSUE_STATUSES as readonly string[]).includes(b.status as string)) throw fail('status', 'invalid_option');
      const r = checkIssueTransition(ctx.subject, res, { status: cur.status, assigneeId: next.assigneeId }, b.status as IssueStatus);
      if (!r.ok) throw transitionError(r.reason);
      changed.status = b.status as IssueStatus;
      next.status = b.status as IssueStatus;
    }

    const events = diffEntity(cur as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (events.length === 0) return { status: 200, body: presentIssue(cur, today) };

    const updated = await tx.updateIssue(id, changed, cur.version);
    if (!updated) throw new AppError(409, 'conflict');
    await tx.appendTimeline(events.map((e) => ({ entityType: 'issue' as const, entityId: id, event: e.event, field: e.field, actorUserId: ctx.user.id, oldValue: e.oldValue, newValue: e.newValue })));
    if (changed.assigneeId) await notify(tx, ctx, [{ userId: changed.assigneeId, type: 'issue_assigned', entityType: 'issue', entityId: id, data: { entityTitle: updated.title } }]);
    return { status: 200, body: presentIssue(updated, today) };
  });
}

// ======================= Actions =======================

async function createAction(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  const today = deps.clock.today();
  assertValid(validateForm(b, actionCreateRules(today)));
  const siteId = optUuid(b.siteId, 'siteId');
  const assetId = optUuid(b.assetId, 'assetId');
  const assigneeId = optUuid(b.assigneeId, 'assigneeId');
  const issueId = optUuid(b.issueId, 'issueId');
  if (!decide(ctx.subject, 'action.create', { orgId: ctx.orgId, siteId, ownerId: ctx.user.id }).allowed) throw new AppError(403, 'forbidden');
  if (assigneeId && !decide(ctx.subject, 'action.assign', { orgId: ctx.orgId, siteId, ownerId: ctx.user.id }).allowed) throw new AppError(403, 'forbidden');
  const source = parseSource(b.source);

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    if (assigneeId && !(await tx.isActiveMember(assigneeId))) throw invalidRef('assigneeId');
    if (issueId) {
      const issue = await tx.getIssue(issueId);
      if (!issue || !decide(ctx.subject, 'issue.read', issueRes(ctx, issue)).allowed) throw invalidRef('issueId');
    }
    const row = await tx.insertAction({
      orgId: ctx.orgId, title: String(b.title).trim(), description: normText(b.description),
      type: b.type as string, priority: b.priority as string, status: 'todo',
      ownerId: ctx.user.id, assigneeId, siteId, assetId, dueDate: normText(b.dueDate), completedAt: null, issueId, ...source,
    });
    await tx.appendTimeline([{ entityType: 'action', entityId: row.id, event: 'created', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { status: row.status, priority: row.priority } }]);
    if (assigneeId) await notify(tx, ctx, [{ userId: assigneeId, type: 'action_assigned', entityType: 'action', entityId: row.id, data: { entityTitle: row.title } }]);
    return { status: 201, body: presentAction(row, today) };
  });
}

async function getReadableAction(tx: WorkTx, ctx: AuthContext, id: string): Promise<ActionRow> {
  const row = await tx.getAction(id);
  if (!row || !decide(ctx.subject, 'action.read', actionRes(ctx, row)).allowed) throw new AppError(404, 'not_found');
  return row;
}

async function listActions(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const filter = listFilter(req.ctx.subject, 'action.read');
  if (!filter) throw new AppError(403, 'forbidden');
  const { status, limit, cursor, mine, overdue } = parseList(req.query, ACTION_STATUSES);
  const today = deps.clock.today();
  return deps.work.transaction(txCtx(req.ctx), async (tx) => {
    const rows = await tx.listActions({ filter, status, limit: limit + 1, cursor, assigneeOnly: mine ? req.ctx.user.id : undefined, overdueBefore: overdue ? today : undefined });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { status: 200, body: { items: items.map((a) => presentAction(a, today)), nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null } };
  });
}

const ACTION_PATCHABLE = ['version', 'title', 'description', 'type', 'priority', 'dueDate', 'assigneeId', 'status'];

async function patchAction(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  for (const k of Object.keys(b)) if (!ACTION_PATCHABLE.includes(k)) throw fail(k, 'unknown_field');
  if (!Number.isInteger(b.version)) throw fail('version', 'required');
  const today = deps.clock.today();

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const cur = await getReadableAction(tx, ctx, id);
    if (cur.version !== b.version) throw new AppError(409, 'conflict');
    const res = actionRes(ctx, cur);

    fieldErrors(cur as unknown as Record<string, unknown>, b, actionCreateRules(today), ['title', 'type', 'priority']);
    const changed: Partial<ActionRow> = {};
    if ('title' in b) changed.title = String(b.title).trim();
    if ('description' in b) changed.description = normText(b.description);
    if ('type' in b) changed.type = b.type as string;
    if ('priority' in b) changed.priority = b.priority as string;
    if ('dueDate' in b) changed.dueDate = normText(b.dueDate);
    if ('assigneeId' in b) {
      const a = optUuid(b.assigneeId, 'assigneeId');
      if (a !== cur.assigneeId && a && !(await tx.isActiveMember(a))) throw invalidRef('assigneeId');
      changed.assigneeId = a;
    }
    for (const k of Object.keys(changed) as (keyof ActionRow)[]) if (changed[k] === cur[k]) delete changed[k];

    const { assigneeId: assigneeChange, ...otherChanges } = changed;
    if (Object.keys(otherChanges).length > 0 && !decide(ctx.subject, 'action.edit', res).allowed) throw new AppError(403, 'forbidden');
    if ('assigneeId' in changed && !decide(ctx.subject, 'action.assign', res).allowed) throw new AppError(403, 'forbidden');
    void assigneeChange;

    const next: ActionRow = { ...cur, ...changed };
    if (b.status !== undefined && b.status !== cur.status) {
      if (!(ACTION_STATUSES as readonly string[]).includes(b.status as string)) throw fail('status', 'invalid_option');
      const r = checkActionTransition(ctx.subject, res, cur.status, b.status as ActionStatus);
      if (!r.ok) throw transitionError(r.reason);
      const t = applyActionTransition(b.status as ActionStatus, deps.clock.now().toISOString());
      changed.status = t.status; changed.completedAt = t.completedAt;
      next.status = t.status; next.completedAt = t.completedAt;
    }

    const events = diffEntity(cur as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (events.length === 0) return { status: 200, body: presentAction(cur, today) };

    const updated = await tx.updateAction(id, changed, cur.version);
    if (!updated) throw new AppError(409, 'conflict');
    await tx.appendTimeline(events.map((e) => ({ entityType: 'action' as const, entityId: id, event: e.event, field: e.field, actorUserId: ctx.user.id, oldValue: e.oldValue, newValue: e.newValue })));
    if (changed.assigneeId) await notify(tx, ctx, [{ userId: changed.assigneeId, type: 'action_assigned', entityType: 'action', entityId: id, data: { entityTitle: updated.title } }]);
    // someone submitted work for verification: the person who owns the action must check it
    if (changed.status === 'pending_verification') await notify(tx, ctx, [{ userId: cur.ownerId, type: 'action_pending_verification', entityType: 'action', entityId: id, data: { entityTitle: updated.title } }]);
    return { status: 200, body: presentAction(updated, today) };
  });
}

async function addComment(req: WorkRequest, deps: WorkDeps, actionId: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  const errs = validateField(b.body, { type: 'long_text', required: true, maxLength: 5000 });
  if (errs.length) throw new AppError(422, 'validation', { body: errs });
  const parentId = optUuid(b.parentId, 'parentId');
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const action = await getReadableAction(tx, ctx, actionId);
    if (parentId) {
      const parent = await tx.getComment(parentId);
      if (!parent || parent.actionId !== actionId) throw invalidRef('parentId');
    }
    const row = await tx.insertComment({ orgId: ctx.orgId, actionId, authorId: ctx.user.id, parentId, body: String(b.body).trim() });
    await tx.appendTimeline([{ entityType: 'action', entityId: actionId, event: 'comment_added', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { commentId: row.id } }]);
    const people = [...new Set([action.ownerId, action.assigneeId].filter((x): x is string => !!x))];
    await notify(tx, ctx, people.map((userId) => ({ userId, type: 'comment_added' as const, entityType: 'action' as const, entityId: actionId, data: { entityTitle: action.title } })));
    return { status: 201, body: row };
  });
}

// ======================= Router =======================

export const isWorkPath = (path: string) => /^\/(issues|actions)(\/|$)/.test(path);

/** Returns null when no route matches (the server answers 404). */
export async function handleWork(req: WorkRequest, deps: WorkDeps): Promise<Out | null> {
  const [kind, id, sub] = req.path.split('/').filter(Boolean);
  const n = req.path.split('/').filter(Boolean).length;
  const m = req.method;
  if (id !== undefined && !isUuid(id)) return null;

  if (kind === 'issues') {
    if (n === 1 && m === 'POST') return createIssue(req, deps);
    if (n === 1 && m === 'GET') return listIssues(req, deps);
    if (n === 2 && m === 'GET') return deps.work.transaction(txCtx(req.ctx), async (tx) => ({ status: 200, body: presentIssue(await getReadableIssue(tx, req.ctx, id!), deps.clock.today()) }));
    if (n === 2 && m === 'PATCH') return patchIssue(req, deps, id!);
    if (n === 3 && sub === 'timeline' && m === 'GET') {
      return deps.work.transaction(txCtx(req.ctx), async (tx) => {
        await getReadableIssue(tx, req.ctx, id!);
        return { status: 200, body: { items: await tx.listTimeline('issue', id!) } };
      });
    }
  }
  if (kind === 'actions') {
    if (n === 1 && m === 'POST') return createAction(req, deps);
    if (n === 1 && m === 'GET') return listActions(req, deps);
    if (n === 2 && m === 'GET') return deps.work.transaction(txCtx(req.ctx), async (tx) => ({ status: 200, body: presentAction(await getReadableAction(tx, req.ctx, id!), deps.clock.today()) }));
    if (n === 2 && m === 'PATCH') return patchAction(req, deps, id!);
    if (n === 3 && sub === 'comments' && m === 'POST') return addComment(req, deps, id!);
    if (n === 3 && sub === 'comments' && m === 'GET') {
      return deps.work.transaction(txCtx(req.ctx), async (tx) => {
        await getReadableAction(tx, req.ctx, id!);
        return { status: 200, body: { items: await tx.listComments(id!) } };
      });
    }
    if (n === 3 && sub === 'timeline' && m === 'GET') {
      return deps.work.transaction(txCtx(req.ctx), async (tx) => {
        await getReadableAction(tx, req.ctx, id!);
        return { status: 200, body: { items: await tx.listTimeline('action', id!) } };
      });
    }
  }
  return null;
}

export type { Subject };
