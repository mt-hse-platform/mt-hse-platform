// Templates: create, edit the draft, validate, publish (immutable), new draft from a published version, evaluate.
// Drafts are visible only to people who can edit templates; everyone with template.read sees published ones.
import { AppError } from './ports.ts';
import type { AuthContext } from './auth.ts';
import type { TemplateRow, TemplateVersionRow, WorkTx } from './workTypes.ts';
import { CURSOR_RE, asObject, fail, isUuid, normText, txCtx } from './workRoutes.ts';
import type { Out, WorkDeps, WorkRequest } from './workRoutes.ts';
import { decide } from '../../../packages/engines/src/permission.ts';
import { diffEntity } from '../../../packages/engines/src/activity.ts';
import { isTemplateContent } from '../../../packages/engines/src/template/shape.ts';
import { validateAnswers, validateTemplate } from '../../../packages/engines/src/template/validate.ts';
import { evaluateInspection } from '../../../packages/engines/src/template/scoring.ts';
import { TEMPLATE_STATUS_TRANSITIONS, createDraftFromPublished, publishVersion } from '../../../packages/engines/src/template/versioning.ts';
import type { TemplateStatus, TemplateVersion } from '../../../packages/engines/src/template/versioning.ts';
import type { LocalizedText, TemplateContent } from '../../../packages/engines/src/template/types.ts';

const STATUSES: readonly string[] = ['draft', 'published', 'archived'];
const orgRes = (ctx: AuthContext) => ({ orgId: ctx.orgId });
const can = (ctx: AuthContext, p: Parameters<typeof decide>[1]) => decide(ctx.subject, p, orgRes(ctx)).allowed;
const forbid = () => new AppError(403, 'forbidden');
const notFound = () => new AppError(404, 'not_found');

function parseLocalized(v: unknown, name: string, required: boolean): LocalizedText | null {
  if (v === undefined || v === null) { if (required) throw fail(name, 'required'); return null; }
  if (typeof v !== 'object' || Array.isArray(v)) throw fail(name, 'invalid_type');
  const o = v as Record<string, unknown>;
  const out: LocalizedText = {};
  for (const k of ['ar', 'en'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'string' || (o[k] as string).length > 200) throw fail(name, 'invalid_type');
    if ((o[k] as string).trim()) out[k] = (o[k] as string).trim();
  }
  if (!out.ar && !out.en) { if (required) throw fail(name, 'required'); return null; }
  return out;
}

function parseContent(v: unknown): TemplateContent {
  if (!isTemplateContent(v)) throw fail('content', 'invalid_type');
  return v;
}

const asVersion = (v: TemplateVersionRow): TemplateVersion => ({
  id: v.id, templateId: v.templateId, versionNo: v.versionNo, status: v.status, content: v.content,
  fingerprint: v.fingerprint, publishedAt: v.publishedAt, publishedBy: v.publishedBy,
});

async function readableTemplate(tx: WorkTx, ctx: AuthContext, id: string): Promise<TemplateRow> {
  const t = await tx.getTemplate(id);
  if (!t || !can(ctx, 'template.read')) throw notFound();
  if (!can(ctx, 'template.edit') && !(t.status === 'published' && t.publishedVersionId)) throw notFound();
  return t;
}

async function readableVersion(tx: WorkTx, ctx: AuthContext, templateId: string, versionId: string): Promise<TemplateVersionRow> {
  await readableTemplate(tx, ctx, templateId);
  const v = await tx.getVersion(versionId);
  if (!v || v.templateId !== templateId) throw notFound();
  if (v.status === 'draft' && !can(ctx, 'template.edit')) throw notFound();
  return v;
}

function requireVersionField(b: Record<string, unknown>): number {
  if (!Number.isInteger(b.version)) throw fail('version', 'required');
  return b.version as number;
}

async function createTemplate(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const { ctx } = req;
  if (!can(ctx, 'template.create')) throw forbid();
  const b = asObject(req.body);
  const name = parseLocalized(b.name, 'name', true)!;
  const description = parseLocalized(b.description, 'description', false);
  const category = normText(b.category);
  if (category && category.length > 100) throw fail('category', 'max_length');
  const content = b.content === undefined ? { pages: [] } : parseContent(b.content);

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const template = await tx.insertTemplate({ orgId: ctx.orgId, name, description, category, status: 'draft', publishedVersionId: null, createdBy: ctx.user.id });
    const draft = await tx.insertVersion({
      orgId: ctx.orgId, templateId: template.id, versionNo: 1, status: 'draft', content,
      fingerprint: null, publishedAt: null, publishedBy: null, createdBy: ctx.user.id,
    });
    await tx.appendTimeline([{ entityType: 'template', entityId: template.id, event: 'created', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { versionNo: 1 } }]);
    return { status: 201, body: { template, draftVersionId: draft.id, draftVersion: draft.version } };
  });
}

async function listTemplates(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const { ctx } = req;
  if (!can(ctx, 'template.read')) throw forbid();
  const status = req.query.get('status') ?? undefined;
  if (status && !STATUSES.includes(status)) throw fail('status', 'invalid_option');
  const limit = Number(req.query.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('limit', 'invalid_number');
  const cursor = req.query.get('cursor') ?? undefined;
  if (cursor && !CURSOR_RE.test(cursor)) throw fail('cursor', 'invalid_type');
  const onlyPublished = !can(ctx, 'template.edit');
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const rows = await tx.listTemplates({ status, onlyPublished, limit: limit + 1, cursor });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { status: 200, body: { items, nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null } };
  });
}

async function getTemplate(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const template = await readableTemplate(tx, ctx, id);
    const all = await tx.listVersionSummaries(id);
    const versions = can(ctx, 'template.edit') ? all : all.filter((v) => v.status === 'published');
    return { status: 200, body: { template, versions } };
  });
}

async function patchTemplate(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  for (const k of Object.keys(b)) if (!['version', 'name', 'description', 'category', 'status'].includes(k)) throw fail(k, 'unknown_field');
  const expected = requireVersionField(b);

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const cur = await readableTemplate(tx, ctx, id);
    if (cur.version !== expected) throw new AppError(409, 'conflict');

    const changed: Partial<TemplateRow> = {};
    if ('name' in b) changed.name = parseLocalized(b.name, 'name', true)!;
    if ('description' in b) changed.description = parseLocalized(b.description, 'description', false);
    if ('category' in b) {
      const c = normText(b.category);
      if (c && c.length > 100) throw fail('category', 'max_length');
      changed.category = c;
    }
    for (const k of Object.keys(changed) as (keyof TemplateRow)[]) if (JSON.stringify(changed[k]) === JSON.stringify(cur[k])) delete changed[k];
    if (Object.keys(changed).length > 0 && !can(ctx, 'template.edit')) throw forbid();

    if (b.status !== undefined && b.status !== cur.status) {
      const to = b.status as TemplateStatus;
      if (!STATUSES.includes(to as string)) throw fail('status', 'invalid_option');
      if (!TEMPLATE_STATUS_TRANSITIONS[cur.status].includes(to) || to === 'draft') throw new AppError(422, 'invalid_transition');
      if (to === 'published' && !cur.publishedVersionId) throw new AppError(422, 'no_published_version');
      if (!can(ctx, 'template.publish')) throw forbid();
      changed.status = to;
    }

    const next = { ...cur, ...changed };
    const events = diffEntity(cur as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, ['name', 'description', 'category', 'status']);
    if (events.length === 0) return { status: 200, body: { template: cur } };
    const updated = await tx.updateTemplate(id, changed, cur.version);
    if (!updated) throw new AppError(409, 'conflict');
    await tx.appendTimeline(events.map((e) => ({ entityType: 'template' as const, entityId: id, event: e.event, field: e.field, actorUserId: ctx.user.id, oldValue: e.oldValue, newValue: e.newValue })));
    return { status: 200, body: { template: updated } };
  });
}

async function getVersionRoute(req: WorkRequest, deps: WorkDeps, id: string, vid: string): Promise<Out> {
  return deps.work.transaction(txCtx(req.ctx), async (tx) => ({ status: 200, body: { version: await readableVersion(tx, req.ctx, id, vid) } }));
}

async function putDraft(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  for (const k of Object.keys(b)) if (!['version', 'content'].includes(k)) throw fail(k, 'unknown_field');
  const expected = requireVersionField(b);
  const content = parseContent(b.content);
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    await readableTemplate(tx, ctx, id);
    if (!can(ctx, 'template.edit')) throw forbid();
    const draft = await tx.getDraftVersion(id);
    if (!draft) throw notFound();
    if (draft.version !== expected) throw new AppError(409, 'conflict');
    const updated = await tx.updateDraftContent(draft.id, content, expected);
    if (!updated) throw new AppError(409, 'conflict');
    return { status: 200, body: { version: updated } };
  });
}

async function validateDraft(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    await readableTemplate(tx, ctx, id);
    if (!can(ctx, 'template.edit')) throw forbid();
    const draft = await tx.getDraftVersion(id);
    if (!draft) throw notFound();
    const issues = validateTemplate(draft.content);
    return { status: 200, body: { valid: issues.length === 0, issues } };
  });
}

async function publish(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  const expected = requireVersionField(b);
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const template = await readableTemplate(tx, ctx, id);
    if (!can(ctx, 'template.publish')) throw forbid();
    const draft = await tx.getDraftVersion(id);
    if (!draft) throw notFound();
    if (draft.version !== expected) throw new AppError(409, 'conflict');

    const nowIso = deps.clock.now().toISOString();
    const result = publishVersion(asVersion(draft), { userId: ctx.user.id, now: nowIso });
    if (!result.ok) throw new AppError(422, 'template_invalid', result.issues);

    const published = await tx.markVersionPublished(draft.id, { fingerprint: result.version.fingerprint!, publishedAt: nowIso, publishedBy: ctx.user.id }, expected);
    if (!published) throw new AppError(409, 'conflict');
    const updated = await tx.updateTemplate(id, { status: 'published', publishedVersionId: published.id }, template.version);
    if (!updated) throw new AppError(409, 'conflict');
    await tx.appendTimeline([{ entityType: 'template', entityId: id, event: 'published', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { versionNo: published.versionNo, fingerprint: published.fingerprint } }]);
    const { content: _c, ...summary } = published;
    return { status: 200, body: { template: updated, version: summary } };
  });
}

async function newDraft(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    await readableTemplate(tx, ctx, id);
    if (!can(ctx, 'template.edit')) throw forbid();
    if (await tx.getDraftVersion(id)) throw new AppError(409, 'draft_exists');
    const base = await tx.getLatestPublishedVersion(id);
    if (!base) throw new AppError(422, 'no_published_version');
    const d = createDraftFromPublished(asVersion(base), 'pending');
    const draft = await tx.insertVersion({
      orgId: ctx.orgId, templateId: id, versionNo: d.versionNo, status: 'draft', content: d.content,
      fingerprint: null, publishedAt: null, publishedBy: null, createdBy: ctx.user.id,
    });
    await tx.appendTimeline([{ entityType: 'template', entityId: id, event: 'draft_created', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { versionNo: draft.versionNo, basedOn: base.versionNo } }]);
    return { status: 201, body: { version: draft } };
  });
}

async function evaluate(req: WorkRequest, deps: WorkDeps, id: string, vid: string): Promise<Out> {
  const b = asObject(req.body);
  const answers = b.answers;
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) throw fail('answers', 'invalid_type');
  return deps.work.transaction(txCtx(req.ctx), async (tx) => {
    const v = await readableVersion(tx, req.ctx, id, vid);
    const ev = evaluateInspection(v.content, answers as Record<string, unknown>);
    const errors = validateAnswers(v.content, ev.answers, ev.state);
    return { status: 200, body: { answers: ev.answers, state: ev.state, scores: ev.scores, flags: ev.flags, flaggedRate: ev.flaggedRate, errors } };
  });
}

export const isTemplatePath = (path: string) => /^\/templates(\/|$)/.test(path);

export async function handleTemplates(req: WorkRequest, deps: WorkDeps): Promise<Out | null> {
  const segs = req.path.split('/').filter(Boolean);
  const [, id, sub, vid, action] = segs;
  const n = segs.length;
  const m = req.method;
  if (id !== undefined && !isUuid(id)) return null;
  if (vid !== undefined && !isUuid(vid)) return null;

  if (n === 1 && m === 'POST') return createTemplate(req, deps);
  if (n === 1 && m === 'GET') return listTemplates(req, deps);
  if (n === 2 && m === 'GET') return getTemplate(req, deps, id!);
  if (n === 2 && m === 'PATCH') return patchTemplate(req, deps, id!);
  if (n === 3 && sub === 'draft' && m === 'PUT') return putDraft(req, deps, id!);
  if (n === 3 && sub === 'validate' && m === 'POST') return validateDraft(req, deps, id!);
  if (n === 3 && sub === 'publish' && m === 'POST') return publish(req, deps, id!);
  if (n === 3 && sub === 'drafts' && m === 'POST') return newDraft(req, deps, id!);
  if (n === 3 && sub === 'timeline' && m === 'GET') {
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      await readableTemplate(tx, req.ctx, id!);
      if (!can(req.ctx, 'template.edit')) throw forbid();
      return { status: 200, body: { items: await tx.listTimeline('template', id!) } };
    });
  }
  if (n === 4 && sub === 'versions' && m === 'GET') return getVersionRoute(req, deps, id!, vid!);
  if (n === 5 && sub === 'versions' && action === 'evaluate' && m === 'POST') return evaluate(req, deps, id!, vid!);
  return null;
}
