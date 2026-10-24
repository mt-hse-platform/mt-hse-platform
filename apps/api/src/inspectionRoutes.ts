// Inspections: start from the published version of a template, autosave answers one question at a time,
// complete (server-side scoring + flagged items) or cancel. A completed inspection is frozen.
import { AppError } from './ports.ts';
import type { AuthContext } from './auth.ts';
import type { InspectionRow, TemplateVersionRow, WorkTx } from './workTypes.ts';
import { CURSOR_RE, asObject, assertValid, fail, invalidRef, isUuid, normText, optUuid, txCtx } from './workRoutes.ts';
import type { Out, WorkDeps, WorkRequest } from './workRoutes.ts';
import { decide, listFilter } from '../../../packages/engines/src/permission.ts';
import type { Resource } from '../../../packages/engines/src/permission.ts';
import { evaluateInspection } from '../../../packages/engines/src/template/scoring.ts';
import { progressOf, validateAnswers, validateQuestionValue } from '../../../packages/engines/src/template/validate.ts';
import { verifyIntegrity } from '../../../packages/engines/src/template/versioning.ts';
import { forEachQuestion, localized } from '../../../packages/engines/src/template/types.ts';
import type { LocalizedText } from '../../../packages/engines/src/template/types.ts';
import { validateForm } from '../../../packages/engines/src/validation.ts';
import { actionCreateRules, issueCreateRules } from '../../../packages/engines/src/entityRules.ts';
import { draftFromQuestion } from '../../../packages/engines/src/activity.ts';
import { buildReport } from '../../../packages/engines/src/report/model.ts';
import { renderReportHtml } from '../../../packages/engines/src/report/html.ts';
import { validateReportInput } from '../../../packages/engines/src/report/validate.ts';
import { label } from '../../../packages/engines/src/report/labels.ts';
import type { ReportInput, ReportLink, ReportPhoto, ReportSignature } from '../../../packages/engines/src/report/types.ts';
import type { MediaRow, SignatureRow } from './workTypes.ts';
import type { Question } from '../../../packages/engines/src/template/types.ts';

const STATUSES: readonly string[] = ['in_progress', 'completed', 'cancelled', 'archived'];
const QUESTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_VALUE_CHARS = 65_536;

const res = (ctx: AuthContext, i: InspectionRow): Resource => ({ orgId: ctx.orgId, siteId: i.siteId, ownerId: i.startedBy });
const notFound = () => new AppError(404, 'not_found');

async function readable(tx: WorkTx, ctx: AuthContext, id: string, lock?: 'update' | 'share'): Promise<InspectionRow> {
  const i = await tx.getInspection(id, lock);
  if (!i || !decide(ctx.subject, 'inspection.read', res(ctx, i)).allowed) throw notFound();
  return i;
}

function requireEdit(ctx: AuthContext, i: InspectionRow): void {
  if (!decide(ctx.subject, 'inspection.edit', res(ctx, i)).allowed) throw new AppError(403, 'forbidden');
}

function requireOpen(i: InspectionRow): void {
  if (i.status !== 'in_progress') throw new AppError(422, 'not_editable');
}

async function versionOf(tx: WorkTx, i: InspectionRow): Promise<TemplateVersionRow> {
  const v = await tx.getVersion(i.templateVersionId);
  if (!v) throw new Error('template version of an inspection is missing'); // data corruption: logged, generic 500
  return v;
}

async function load(tx: WorkTx, i: InspectionRow) {
  const v = await versionOf(tx, i);
  const rows = await tx.listResponses(i.id);
  const values: Record<string, unknown> = {};
  for (const r of rows) if (r.value !== null && r.value !== undefined) values[r.questionId] = r.value;
  return { v, rows, values, ev: evaluateInspection(v.content, values) };
}

async function startInspection(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  if (!isUuid(b.templateId)) throw fail('templateId', 'required');
  const siteId = optUuid(b.siteId, 'siteId');
  const assetId = optUuid(b.assetId, 'assetId');
  const title = normText(b.title);
  if (title && title.length > 200) throw fail('title', 'max_length');
  // Offline start: the app chooses the id (so sending the same request twice never makes two inspections) and says
  // which published version of the template it filled in (the template may have been re-published meanwhile).
  if (b.id !== undefined && b.id !== null && !isUuid(b.id)) throw fail('id', 'invalid_type');
  const clientId = isUuid(b.id) ? b.id : null;
  const wantedVersion = optUuid(b.templateVersionId, 'templateVersionId');
  if (!decide(ctx.subject, 'template.read', { orgId: ctx.orgId }).allowed) throw new AppError(403, 'forbidden');
  if (!decide(ctx.subject, 'inspection.create', { orgId: ctx.orgId, siteId, ownerId: ctx.user.id }).allowed) throw new AppError(403, 'forbidden');

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const template = await tx.getTemplate(b.templateId as string);
    if (!template) throw notFound();
    if (template.status !== 'published' || !template.publishedVersionId) throw new AppError(422, 'no_published_version');
    let versionId = template.publishedVersionId;
    if (wantedVersion) {
      const v = await tx.getVersion(wantedVersion);
      if (!v || v.templateId !== template.id || v.status !== 'published') throw fail('templateVersionId', 'invalid_reference');
      versionId = v.id;                                    // a published version never changes, so an older one is safe to use
    }
    if (clientId) {
      const existing = await tx.getInspection(clientId);
      if (existing) {
        // the same request sent again (the first answer was lost): hand back what exists, change nothing
        if (existing.startedBy === ctx.user.id && existing.templateId === template.id) return { status: 200, body: { inspection: existing } };
        throw new AppError(409, 'conflict');
      }
    }
    const inspection = await tx.insertInspection({
      id: clientId ?? undefined, orgId: ctx.orgId, templateId: template.id, templateVersionId: versionId, title, startedBy: ctx.user.id, siteId, assetId,
    });
    if (!inspection) throw new AppError(409, 'conflict');
    await tx.appendTimeline([{ entityType: 'inspection', entityId: inspection.id, event: 'started', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { templateVersionId: inspection.templateVersionId } }]);
    return { status: 201, body: { inspection } };
  });
}

async function listInspections(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const filter = listFilter(req.ctx.subject, 'inspection.read');
  if (!filter) throw new AppError(403, 'forbidden');
  const status = req.query.get('status') ?? undefined;
  if (status && !STATUSES.includes(status)) throw fail('status', 'invalid_option');
  const limit = Number(req.query.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('limit', 'invalid_number');
  const cursor = req.query.get('cursor') ?? undefined;
  if (cursor && !CURSOR_RE.test(cursor)) throw fail('cursor', 'invalid_type');
  return deps.work.transaction(txCtx(req.ctx), async (tx) => {
    const rows = await tx.listInspections({ filter, status, limit: limit + 1, cursor });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { status: 200, body: { items, nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null } };
  });
}

async function getInspection(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  return deps.work.transaction(txCtx(req.ctx), async (tx) => {
    const i = await readable(tx, req.ctx, id);
    const { v, rows, values, ev } = await load(tx, i);
    return {
      status: 200,
      body: {
        inspection: i,
        responses: Object.fromEntries(rows.map((r) => [r.questionId, { value: r.value, version: r.version }])),
        evaluation: { answers: ev.answers, state: ev.state, scores: ev.scores, flags: ev.flags, flaggedRate: ev.flaggedRate },
        errors: validateAnswers(v.content, ev.answers, ev.state),
        progress: progressOf(v.content, ev.answers, ev.state),
        answered: Object.keys(values).length,
      },
    };
  });
}

async function putResponse(req: WorkRequest, deps: WorkDeps, id: string, questionId: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  for (const k of Object.keys(b)) if (!['value', 'baseVersion'].includes(k)) throw fail(k, 'unknown_field');
  if (!('value' in b)) throw fail('value', 'required');
  if (!Number.isInteger(b.baseVersion) || (b.baseVersion as number) < 0) throw fail('baseVersion', 'required');
  const value = b.value === undefined ? null : b.value;
  if (JSON.stringify(value).length > MAX_VALUE_CHARS) throw fail('value', 'max_length');

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const i = await readable(tx, ctx, id, 'share');
    requireEdit(ctx, i);
    requireOpen(i);
    const v = await versionOf(tx, i);
    let q: Question | undefined;
    forEachQuestion(v.content, (c) => { if (c.question.id === questionId) q = c.question; });
    if (!q) throw notFound();
    if (q.responseType === 'formula') throw new AppError(422, 'computed_field');
    const errors = validateQuestionValue(q, value, false);
    if (errors.length) throw new AppError(422, 'validation', { value: errors });

    const r = await tx.upsertResponse(id, questionId, value, ctx.user.id, b.baseVersion as number);
    if (!r.ok) throw new AppError(409, 'conflict', { current: r.current });
    return { status: 200, body: { response: r.row } };
  });
}

async function complete(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const i = await readable(tx, ctx, id, 'update');
    requireEdit(ctx, i);
    requireOpen(i);
    const { v, ev } = await load(tx, i);
    if (!verifyIntegrity({ id: v.id, templateId: v.templateId, versionNo: v.versionNo, status: v.status, content: v.content, fingerprint: v.fingerprint, publishedAt: v.publishedAt, publishedBy: v.publishedBy })) {
      throw new AppError(409, 'template_integrity');
    }
    const errors = validateAnswers(v.content, ev.answers, ev.state);
    if (Object.keys(errors).length > 0) throw new AppError(422, 'incomplete', errors);

    const nowIso = deps.clock.now().toISOString();
    const updated = await tx.updateInspection(id, {
      status: 'completed', completedAt: nowIso,
      scoreEarned: ev.scores.total.earned, scorePossible: ev.scores.total.possible, scorePct: ev.scores.total.pct,
      passed: ev.scores.passed, flaggedRate: ev.flaggedRate,
    }, i.version);
    if (!updated) throw new AppError(409, 'conflict');
    const flags = await tx.insertFlags(id, ev.flags.map((f) => ({ questionId: f.questionId, pageId: f.pageId, sectionId: f.sectionId, severity: f.severity, descriptions: f.descriptions })));
    await tx.appendTimeline([{
      entityType: 'inspection', entityId: id, event: 'completed', field: null, actorUserId: ctx.user.id, oldValue: null,
      newValue: { scorePct: ev.scores.total.pct, passed: ev.scores.passed, flags: flags.length },
    }]);
    return { status: 200, body: { inspection: updated, scores: ev.scores, flags } };
  });
}

async function cancel(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const i = await readable(tx, ctx, id, 'update');
    requireEdit(ctx, i);
    requireOpen(i);
    const updated = await tx.updateInspection(id, { status: 'cancelled', cancelledAt: deps.clock.now().toISOString() }, i.version);
    if (!updated) throw new AppError(409, 'conflict');
    await tx.appendTimeline([{ entityType: 'inspection', entityId: id, event: 'cancelled', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: null }]);
    return { status: 200, body: { inspection: updated } };
  });
}

const FROM_FLAG_FIELDS = ['type', 'priority', 'title', 'description', 'assigneeId', 'dueDate'];

/**
 * One tap from a flagged item to an Issue or Action. Site, asset, template version, inspection and question are copied
 * from the inspection; title/priority/description default from the flag. The caller may override the editable fields.
 */
async function createFromFlag(req: WorkRequest, deps: WorkDeps, id: string, flagId: string, kind: 'issue' | 'action'): Promise<Out> {
  const { ctx } = req;
  const b = req.body === undefined ? {} : asObject(req.body);
  for (const k of Object.keys(b)) if (!FROM_FLAG_FIELDS.includes(k)) throw fail(k, 'unknown_field');
  const today = deps.clock.today();
  const assigneeId = optUuid(b.assigneeId, 'assigneeId');

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const i = await readable(tx, ctx, id);
    const flag = await tx.getFlag(flagId);
    if (!flag || flag.inspectionId !== id) throw notFound();
    if (kind === 'issue' ? flag.issueId : flag.actionId) throw new AppError(409, 'already_linked');

    const v = await versionOf(tx, i);
    let q: Question | undefined;
    forEachQuestion(v.content, (c) => { if (c.question.id === flag.questionId) q = c.question; });
    const draft = draftFromQuestion(
      { inspectionId: i.id, templateId: i.templateId, templateVersionId: i.templateVersionId, siteId: i.siteId, assetId: i.assetId },
      { questionId: flag.questionId, title: (q && localized(q.title, ctx.user.locale)) || flag.questionId }, ctx.user.id,
    );
    const firstNote = flag.descriptions[0] as LocalizedText | undefined;
    const payload = {
      title: b.title ?? draft.title,
      description: b.description ?? (firstNote ? localized(firstNote, ctx.user.locale) : undefined),
      type: b.type ?? (kind === 'issue' ? 'other' : 'corrective'),
      priority: b.priority ?? flag.severity,
      dueDate: b.dueDate,
    };
    assertValid(validateForm(payload, kind === 'issue' ? issueCreateRules(today) : actionCreateRules(today)));

    const res = { orgId: ctx.orgId, siteId: i.siteId, ownerId: ctx.user.id };
    if (!decide(ctx.subject, kind === 'issue' ? 'issue.create' : 'action.create', res).allowed) throw new AppError(403, 'forbidden');
    if (kind === 'action' && assigneeId && !decide(ctx.subject, 'action.assign', res).allowed) throw new AppError(403, 'forbidden');
    if (assigneeId && !(await tx.isActiveMember(assigneeId))) throw invalidRef('assigneeId');

    const common = {
      orgId: ctx.orgId, title: String(payload.title).trim(), description: normText(payload.description),
      type: payload.type as string, priority: payload.priority as string, assigneeId,
      siteId: draft.siteId, assetId: draft.assetId, dueDate: normText(payload.dueDate), ...draft.source,
    };
    const created = kind === 'issue'
      ? await tx.insertIssue({ ...common, status: 'open', reporterId: ctx.user.id })
      : await tx.insertAction({ ...common, status: 'todo', ownerId: ctx.user.id, completedAt: null, issueId: null });
    const linked = await tx.linkFlag(flagId, kind === 'issue' ? { issueId: created.id } : { actionId: created.id });
    if (!linked) throw new AppError(409, 'already_linked');

    await tx.appendTimeline([
      { entityType: kind, entityId: created.id, event: 'created', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { status: created.status, priority: created.priority, fromFlag: flagId } },
      { entityType: 'inspection', entityId: id, event: `${kind}_created_from_flag`, field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { flagId, [`${kind}Id`]: created.id } },
    ]);
    return { status: 201, body: { [kind]: created, flag: linked } };
  });
}

const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * Report (web view = the same HTML that becomes the PDF). Only for finished inspections, only for people who may view
 * reports of that inspection, and only from consistent data. Linked actions/issues the viewer cannot read are left out.
 */
async function report(req: WorkRequest, deps: WorkDeps, id: string, format: 'html' | 'pdf'): Promise<Out> {
  const { ctx } = req;
  const langQ = req.query.get('lang');
  if (langQ !== null && langQ !== 'ar' && langQ !== 'en') throw fail('lang', 'invalid_option');
  const lang: 'ar' | 'en' = (langQ as 'ar' | 'en' | null) ?? ctx.user.locale;
  const confQ = req.query.get('confidential');
  if (confQ !== null && confQ !== '0' && confQ !== '1') throw fail('confidential', 'invalid_option');
  const confidential = confQ !== '0';
  if (format === 'pdf' && !deps.pdf) throw new AppError(501, 'pdf_unavailable');

  const loaded = await deps.work.transaction(txCtx(ctx), async (tx) => {
    const i = await readable(tx, ctx, id);
    if (!decide(ctx.subject, 'report.view', res(ctx, i)).allowed) throw new AppError(403, 'forbidden');
    if (i.status !== 'completed' && i.status !== 'archived') throw new AppError(422, 'not_completed');

    const { v, ev } = await load(tx, i);
    if (!verifyIntegrity({ id: v.id, templateId: v.templateId, versionNo: v.versionNo, status: v.status, content: v.content, fingerprint: v.fingerprint, publishedAt: v.publishedAt, publishedBy: v.publishedBy })) {
      throw new AppError(409, 'template_integrity');
    }
    const template = await tx.getTemplate(i.templateId);
    const flags = await tx.listFlags(id);
    const actions = (await tx.listActionsByInspection(id)).filter((a) => decide(ctx.subject, 'action.read', { orgId: ctx.orgId, siteId: a.siteId, ownerId: a.ownerId, assigneeId: a.assigneeId }).allowed);
    const issues = (await tx.listIssuesByInspection(id)).filter((a) => decide(ctx.subject, 'issue.read', { orgId: ctx.orgId, siteId: a.siteId, ownerId: a.reporterId, assigneeId: a.assigneeId }).allowed);
    const ids = [...new Set([i.startedBy, ...actions.map((a) => a.assigneeId), ...issues.map((a) => a.assigneeId)].filter((x): x is string => !!x))];
    const names = await tx.getUserNames(ids);
    const link = (a: { id: string; title: string; status: string; priority: string; assigneeId: string | null; dueDate: string | null; questionId: string | null }): ReportLink => ({
      id: a.id, title: a.title, status: a.status, priority: a.priority, assigneeName: a.assigneeId ? (names[a.assigneeId] ?? null) : null, dueDate: a.dueDate, questionId: a.questionId,
    });

    const input: ReportInput = {
      orgName: await tx.getOrgName(),
      inspection: {
        id: i.id, title: i.title, status: i.status, startedAt: i.startedAt, completedAt: i.completedAt,
        siteName: i.siteId ? await tx.getSiteName(i.siteId) : null, startedByName: names[i.startedBy] ?? '—',
        scorePct: i.scorePct, scoreEarned: i.scoreEarned, scorePossible: i.scorePossible, passed: i.passed, flaggedRate: i.flaggedRate,
      },
      template: { name: template?.name ?? {}, versionNo: v.versionNo, content: v.content },
      answers: ev.answers,
      evaluation: { state: ev.state, scores: ev.scores, flags: ev.flags },
      flags: flags.map((f) => ({ questionId: f.questionId, severity: f.severity, issueId: f.issueId, actionId: f.actionId })),
      actions: actions.map(link), issues: issues.map(link), signatures: [], confidential,
    };

    // files referenced by photo answers, and the signatures; their bytes are read after the transaction
    const expected: Record<string, string[]> = {};
    forEachQuestion(v.content, ({ question }) => {
      const value = ev.answers[question.id];
      if (question.responseType === 'photo' && ev.state.visible[question.id] && Array.isArray(value)) expected[question.id] = value.filter((x): x is string => typeof x === 'string');
    });
    const photoRows = await tx.getMediaMany([...new Set(Object.values(expected).flat())]);
    const signatures = await tx.listSignatures(id);
    const signatureMedia = await tx.getMediaMany(signatures.map((s) => s.mediaId));
    return { input, expected, photoRows, signatures, signatureMedia };
  });

  const input = loaded.input;
  if (loaded.photoRows.length > 0 || loaded.signatures.length > 0) {
    if (!deps.blobs) throw new AppError(501, 'media_unavailable');
    const load = async (m: MediaRow) => {
      const bytes = await deps.blobs!.get(m.storageKey);
      return bytes ? { bytes, mime: m.mimeType } : null;
    };
    let total = 0;
    const toUri = (b: { bytes: Buffer; mime: string }) => { total += b.bytes.length; return `data:${b.mime};base64,${b.bytes.toString('base64')}`; };

    input.media = {};
    for (const [qid, ids] of Object.entries(loaded.expected)) {
      const photos: ReportPhoto[] = [];
      for (const mid of ids) {
        const row = loaded.photoRows.find((r) => r.id === mid && r.ownerType === 'inspection' && r.ownerId === id && r.kind === 'photo' && r.questionId === qid);
        const file = row ? await load(row) : null;
        if (row && file) photos.push({ dataUri: toUri(file), caption: row.caption });
      }
      input.media[qid] = { expected: ids.length, photos };
    }
    const sigs: ReportSignature[] = [];
    for (const s of loaded.signatures as SignatureRow[]) {
      const row = loaded.signatureMedia.find((m) => m.id === s.mediaId);
      const file = row ? await load(row) : null;
      sigs.push({ name: s.signerName, role: s.signerRole ?? undefined, signedAt: s.signedAt, imageDataUri: file ? toUri(file) : undefined });
    }
    input.signatures = sigs;
    if (total > 60 * 1024 * 1024) throw new AppError(422, 'report_too_large');
  }
  const problems = validateReportInput(input);
  if (problems.length > 0) throw new AppError(422, 'report_invalid', problems);

  const model = buildReport(input, lang);
  const html = renderReportHtml(model);
  if (format === 'html') {
    return { status: 200, body: null, raw: { contentType: 'text/html; charset=utf-8', data: html, headers: { 'content-security-policy': REPORT_CSP } } };
  }

  const pdf = await deps.pdf!.render(html, { locale: lang, footerText: confidential ? label(lang, 'report.confidential') : '' });
  await deps.work.transaction(txCtx(ctx), (tx) => tx.appendTimeline([{
    entityType: 'inspection', entityId: id, event: 'report_generated', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { format: 'pdf', lang },
  }]));
  return {
    status: 200, body: null,
    raw: { contentType: 'application/pdf', data: pdf, headers: { 'content-disposition': `attachment; filename="inspection-${model.cover.reportNo}.pdf"` } },
  };
}

async function addSignature(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  const { ctx } = req;
  const b = asObject(req.body);
  for (const k of Object.keys(b)) if (!['mediaId', 'signerName', 'signerRole'].includes(k)) throw fail(k, 'unknown_field');
  if (!isUuid(b.mediaId)) throw fail('mediaId', 'required');
  const signerName = typeof b.signerName === 'string' ? b.signerName.trim() : '';
  if (signerName.length < 2) throw fail('signerName', signerName ? 'min_length' : 'required');
  if (signerName.length > 200) throw fail('signerName', 'max_length');
  const signerRole = normText(b.signerRole);
  if (signerRole && signerRole.length > 100) throw fail('signerRole', 'max_length');

  return deps.work.transaction(txCtx(ctx), async (tx) => {
    const i = await readable(tx, ctx, id, 'share');
    requireEdit(ctx, i);
    if (i.status !== 'in_progress' && i.status !== 'completed') throw new AppError(422, 'not_editable');
    const m = await tx.getMedia(b.mediaId as string);
    if (!m || m.kind !== 'signature' || m.ownerType !== 'inspection' || m.ownerId !== id) throw fail('mediaId', 'invalid_reference');
    const signature = await tx.insertSignature({ inspectionId: id, mediaId: m.id, signerName, signerRole, signedBy: ctx.user.id });
    await tx.appendTimeline([{ entityType: 'inspection', entityId: id, event: 'signed', field: null, actorUserId: ctx.user.id, oldValue: null, newValue: { signerName, signerRole } }]);
    return { status: 201, body: { signature } };
  });
}

export const isInspectionPath = (path: string) => /^\/inspections(\/|$)/.test(path);

export async function handleInspections(req: WorkRequest, deps: WorkDeps): Promise<Out | null> {
  const segs = req.path.split('/').filter(Boolean);
  const [, id, sub, qid, tail] = segs;
  const n = segs.length;
  const m = req.method;
  if (id !== undefined && !isUuid(id)) return null;

  if (n === 1 && m === 'POST') return startInspection(req, deps);
  if (n === 1 && m === 'GET') return listInspections(req, deps);
  if (n === 2 && m === 'GET') return getInspection(req, deps, id!);
  if (n === 3 && sub === 'report' && m === 'GET') return report(req, deps, id!, 'html');
  if (n === 3 && sub === 'report.pdf' && m === 'GET') return report(req, deps, id!, 'pdf');
  if (n === 3 && sub === 'signatures' && m === 'POST') return addSignature(req, deps, id!);
  if (n === 3 && sub === 'signatures' && m === 'GET') {
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      await readable(tx, req.ctx, id!);
      return { status: 200, body: { items: await tx.listSignatures(id!) } };
    });
  }
  if (n === 3 && sub === 'complete' && m === 'POST') return complete(req, deps, id!);
  if (n === 3 && sub === 'cancel' && m === 'POST') return cancel(req, deps, id!);
  if (n === 3 && sub === 'flags' && m === 'GET') {
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      await readable(tx, req.ctx, id!);
      return { status: 200, body: { items: await tx.listFlags(id!) } };
    });
  }
  if (n === 3 && sub === 'timeline' && m === 'GET') {
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      await readable(tx, req.ctx, id!);
      return { status: 200, body: { items: await tx.listTimeline('inspection', id!) } };
    });
  }
  if (n === 5 && sub === 'flags' && isUuid(qid) && (tail === 'issue' || tail === 'action') && m === 'POST') {
    return createFromFlag(req, deps, id!, qid!, tail);
  }
  if (n === 4 && sub === 'responses' && m === 'PUT') {
    if (!QUESTION_ID_RE.test(qid!)) return null;
    return putResponse(req, deps, id!, qid!);
  }
  return null;
}
