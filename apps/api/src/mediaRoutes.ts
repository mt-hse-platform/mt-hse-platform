// Uploads (photos, audio, PDFs, signatures) attached to an inspection question, an issue or an action.
// Rules: the file's real bytes decide its type; access follows the owner record (a file is as private as the
// inspection/issue/action it belongs to); files are never hard-deleted through the API; signatures are permanent.
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './ports.ts';
import type { AuthContext } from './auth.ts';
import type { MediaOwner, MediaRow, WorkTx } from './workTypes.ts';
import { asObject, fail, isUuid, txCtx } from './workRoutes.ts';
import type { Out, WorkDeps, WorkRequest } from './workRoutes.ts';
import { decide } from '../../../packages/engines/src/permission.ts';
import { EXTENSIONS, MEDIA_KINDS, MEDIA_RULES, checkUpload } from '../../../packages/engines/src/media/rules.ts';
import type { MediaKind } from '../../../packages/engines/src/media/rules.ts';
import { forEachQuestion } from '../../../packages/engines/src/template/types.ts';
import type { Question } from '../../../packages/engines/src/template/types.ts';

export const isMediaPath = (path: string) => /^\/media(\/|$)/.test(path);

const OWNERS: readonly string[] = ['inspection', 'issue', 'action'];
const RESPONSE_TYPE: Record<string, string> = { photo: 'photo', audio: 'audio', file: 'file', signature: 'signature' };
const FILE_CSP = "default-src 'none'; sandbox";

const present = ({ storageKey: _k, ...rest }: MediaRow) => rest;

type OwnerInfo = { question?: Question };

/** Object-level authorization through the owner record. `write` also checks that the owner can still be changed. */
async function ownerAccess(tx: WorkTx, ctx: AuthContext, ownerType: MediaOwner, ownerId: string, mode: 'read' | 'write', kind: MediaKind, questionId: string | null): Promise<OwnerInfo> {
  const notFound = () => new AppError(404, 'not_found');
  if (ownerType === 'inspection') {
    const i = await tx.getInspection(ownerId, mode === 'write' ? 'share' : undefined);
    const res = i && { orgId: ctx.orgId, siteId: i.siteId, ownerId: i.startedBy };
    if (!i || !res || !decide(ctx.subject, 'inspection.read', res).allowed) throw notFound();
    if (mode === 'read') return {};
    if (!decide(ctx.subject, 'inspection.edit', res).allowed) throw new AppError(403, 'forbidden');
    const open = kind === 'signature' ? i.status === 'in_progress' || i.status === 'completed' : i.status === 'in_progress';
    if (!open) throw new AppError(422, 'not_editable');
    const v = await tx.getVersion(i.templateVersionId);
    let question: Question | undefined;
    if (questionId && v) forEachQuestion(v.content, (c) => { if (c.question.id === questionId) question = c.question; });
    if (kind === 'signature') {
      if (questionId && question?.responseType !== 'signature') throw fail('questionId', 'invalid_reference');
    } else {
      if (!questionId) throw fail('questionId', 'required');
      if (!question || question.responseType !== RESPONSE_TYPE[kind]) throw fail('questionId', 'invalid_reference');
    }
    return { question };
  }

  if (kind === 'signature') throw fail('kind', 'invalid_option'); // signatures belong to inspections only
  if (questionId) throw fail('questionId', 'unknown_field');
  if (ownerType === 'issue') {
    const row = await tx.getIssue(ownerId);
    const res = row && { orgId: ctx.orgId, siteId: row.siteId, ownerId: row.reporterId, assigneeId: row.assigneeId };
    if (!row || !res || !decide(ctx.subject, 'issue.read', res).allowed) throw notFound();
    if (mode === 'write') {
      if (!(decide(ctx.subject, 'issue.edit', res).allowed || row.reporterId === ctx.user.id)) throw new AppError(403, 'forbidden');
      if (row.status === 'closed' || row.status === 'rejected') throw new AppError(422, 'not_editable');
    }
    return {};
  }
  const row = await tx.getAction(ownerId);
  const res = row && { orgId: ctx.orgId, siteId: row.siteId, ownerId: row.ownerId, assigneeId: row.assigneeId };
  if (!row || !res || !decide(ctx.subject, 'action.read', res).allowed) throw notFound();
  if (mode === 'write') {
    if (!(decide(ctx.subject, 'action.edit', res).allowed || row.assigneeId === ctx.user.id)) throw new AppError(403, 'forbidden');
    if (row.status === 'completed' || row.status === 'cancelled') throw new AppError(422, 'not_editable');
  }
  return {};
}

const UPLOAD_ERRORS: Record<string, { code: string; params?: (kind: string) => Record<string, number> }> = {
  empty: { code: 'required' },
  too_large: { code: 'file_too_large', params: (k) => ({ maxMb: Math.round(MEDIA_RULES[k as MediaKind].maxBytes / 1048576) }) },
  unsupported_type: { code: 'file_type' },
  type_mismatch: { code: 'file_type' },
  invalid_kind: { code: 'invalid_option' },
};

function parseOwner(q: URLSearchParams): { ownerType: MediaOwner; ownerId: string } {
  const ownerType = q.get('ownerType');
  const ownerId = q.get('ownerId');
  if (!ownerType || !OWNERS.includes(ownerType)) throw fail('ownerType', 'invalid_option');
  if (!isUuid(ownerId)) throw fail('ownerId', 'invalid_type');
  return { ownerType: ownerType as MediaOwner, ownerId };
}

async function upload(req: WorkRequest, deps: WorkDeps): Promise<Out> {
  const { ctx } = req;
  if (!deps.blobs) throw new AppError(501, 'media_unavailable');
  const q = req.query;
  const { ownerType, ownerId } = parseOwner(q);
  const kind = q.get('kind') ?? '';
  if (!(MEDIA_KINDS as readonly string[]).includes(kind)) throw fail('kind', 'invalid_option');
  const questionId = q.get('questionId');
  if (questionId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(questionId)) throw fail('questionId', 'invalid_type');
  const caption = q.get('caption')?.trim() || null;
  if (caption && caption.length > 300) throw fail('caption', 'max_length');
  const takenRaw = q.get('takenAt');
  if (takenRaw !== null && Number.isNaN(Date.parse(takenRaw))) throw fail('takenAt', 'invalid_datetime');
  const num = (name: string, lo: number, hi: number) => {
    const v = q.get(name);
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw fail(name, 'invalid_number');
    return n;
  };
  const lat = num('lat', -90, 90);
  const lng = num('lng', -180, 180);

  const bytes = req.raw;
  if (!bytes) throw new AppError(400, 'invalid_body');
  const check = checkUpload(kind, req.contentType ?? '', bytes);
  if (!check.ok) {
    const e = UPLOAD_ERRORS[check.code]!;
    throw new AppError(422, 'validation', { file: [{ code: e.code, ...(e.params ? { params: e.params(kind) } : {}) }] });
  }

  const id = randomUUID();
  const storageKey = `${ctx.orgId}/${deps.clock.now().getUTCFullYear()}/${id}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let stored = false;

  try {
    return await deps.work.transaction(txCtx(ctx), async (tx) => {
      await ownerAccess(tx, ctx, ownerType, ownerId, 'write', kind as MediaKind, questionId);
      const max = MEDIA_RULES[kind as MediaKind].maxPerQuestion;
      if ((await tx.countMedia(ownerType, ownerId, questionId, kind as MediaKind)) >= max) {
        throw new AppError(422, 'validation', { file: [{ code: 'too_many_selections', params: { max } }] });
      }
      await deps.blobs!.put(storageKey, bytes);
      stored = true;
      const row = await tx.insertMedia({
        id, orgId: ctx.orgId, ownerType, ownerId, questionId, kind: kind as MediaKind, mimeType: check.mime, sizeBytes: bytes.length, sha256, storageKey,
        caption, takenAt: takenRaw ? new Date(takenRaw).toISOString() : null, lat, lng, uploadedBy: ctx.user.id,
      });
      return { status: 201, body: { media: present(row) } };
    });
  } catch (err) {
    if (stored) await deps.blobs!.delete(storageKey).catch(() => undefined); // no orphan file when the record was not saved
    throw err;
  }
}

async function download(req: WorkRequest, deps: WorkDeps, id: string): Promise<Out> {
  if (!deps.blobs) throw new AppError(501, 'media_unavailable');
  const row = await deps.work.transaction(txCtx(req.ctx), async (tx) => {
    const m = await tx.getMedia(id);
    if (!m) throw new AppError(404, 'not_found');
    await ownerAccess(tx, req.ctx, m.ownerType, m.ownerId, 'read', m.kind, null);
    return m;
  });
  const data = await deps.blobs.get(row.storageKey);
  if (!data) throw new AppError(404, 'not_found');
  return {
    status: 200, body: null,
    raw: {
      contentType: row.mimeType, data,
      headers: {
        'content-disposition': `inline; filename="${row.id}.${EXTENSIONS[row.mimeType] ?? 'bin'}"`,
        'content-security-policy': FILE_CSP,
        'cache-control': 'private, max-age=3600',
      },
    },
  };
}

export async function handleMedia(req: WorkRequest, deps: WorkDeps): Promise<Out | null> {
  const segs = req.path.split('/').filter(Boolean);
  const [, id] = segs;
  if (segs.length === 1 && req.method === 'POST') return upload(req, deps);
  if (segs.length === 1 && req.method === 'GET') {
    const { ownerType, ownerId } = parseOwner(req.query);
    const questionId = req.query.get('questionId') ?? undefined;
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      await ownerAccess(tx, req.ctx, ownerType, ownerId, 'read', 'photo', null);
      return { status: 200, body: { items: (await tx.listMedia(ownerType, ownerId, questionId)).map(present) } };
    });
  }
  if (segs.length === 2 && isUuid(id) && req.method === 'GET') return download(req, deps, id);
  if (segs.length === 2 && isUuid(id) && req.method === 'DELETE') {
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      const m = await tx.getMedia(id!);
      if (!m) throw new AppError(404, 'not_found');
      if (m.kind === 'signature') throw new AppError(403, 'forbidden'); // signatures are evidence: never removed
      await ownerAccess(tx, req.ctx, m.ownerType, m.ownerId, 'write', m.kind, m.questionId);
      await tx.softDeleteMedia(m.id);
      if (m.ownerType === 'inspection') {
        await tx.appendTimeline([{ entityType: 'inspection', entityId: m.ownerId, event: 'media_removed', field: m.questionId, actorUserId: req.ctx.user.id, oldValue: { mediaId: m.id, kind: m.kind }, newValue: null }]);
      }
      return { status: 200, body: { ok: true } };
    });
  }
  return null;
}

export { asObject };
