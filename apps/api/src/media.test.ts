import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { MemoryBlobStore } from './blobStore.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import type { TemplateContent } from '../../../packages/engines/src/template/types.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const ORG_B = '00000000-0000-0000-0000-00000000bbbb';
const SITE_A = '00000000-0000-0000-0000-0000000051a1';
const USERS: Record<string, { id: string; org: string; role: RoleKey; sites: string[] }> = {
  manager:    { id: '00000000-0000-0000-0000-000000000001', org: ORG_A, role: 'hse_manager', sites: [] },
  supervisor: { id: '00000000-0000-0000-0000-000000000002', org: ORG_A, role: 'supervisor', sites: [SITE_A] },
  employee:   { id: '00000000-0000-0000-0000-000000000003', org: ORG_A, role: 'employee', sites: [SITE_A] },
  employee2:  { id: '00000000-0000-0000-0000-000000000004', org: ORG_A, role: 'employee', sites: [SITE_A] },
  viewer:     { id: '00000000-0000-0000-0000-000000000005', org: ORG_A, role: 'viewer', sites: [SITE_A] },
  inspector:  { id: '00000000-0000-0000-0000-000000000006', org: ORG_A, role: 'inspector', sites: [SITE_A] },
  inspector2: { id: '00000000-0000-0000-0000-000000000008', org: ORG_A, role: 'inspector', sites: [SITE_A] },
  managerB:   { id: '00000000-0000-0000-0000-000000000007', org: ORG_B, role: 'hse_manager', sites: [] },
};
const verifier: TokenVerifier = { async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); } };
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) { const u = USERS[uid]; return u ? [{ userId: u.id, orgId: u.org, membershipId: uid, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : []; },
  async loadUser(m) { return { fullName: m.userId, email: 'x@x.com', locale: 'en' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds(m) { return USERS[m.roleId]!.sites; },
};

const JPEG = (n = 300, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)]);
const PNG = (n = 120) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 3)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 1)]);

const CONTENT: TemplateContent = {
  pages: [{ id: 'p', title: { en: 'Page' }, items: [
    { kind: 'question', id: 'q_photo', title: { en: 'Photo of the guard' }, responseType: 'photo' },
    { kind: 'question', id: 'q_audio', title: { en: 'Voice note' }, responseType: 'audio' },
    { kind: 'question', id: 'q_file', title: { en: 'Certificate' }, responseType: 'file' },
    { kind: 'question', id: 'q_sig', title: { en: 'Sign-off' }, responseType: 'signature' },
    { kind: 'question', id: 'q_text', title: { en: 'Notes' }, responseType: 'text', required: true },
  ] }],
};

type R = { status: number; body: any; text: string; headers: Headers; buf: Buffer };
type Client = {
  json: (who: string | null, method: string, path: string, body?: unknown) => Promise<R>;
  up: (who: string | null, query: Record<string, string>, bytes: Buffer, type?: string) => Promise<R>;
  get: (who: string | null, path: string) => Promise<R>;
};

async function run(fn: (c: Client, w: { repo: MemoryWorkRepo; blobs: MemoryBlobStore }) => Promise<void>) {
  const repo = new MemoryWorkRepo(); const blobs = new MemoryBlobStore();
  for (const u of Object.values(USERS)) repo.addMember(u.org, u.id);
  repo.userNames[USERS.inspector!.id] = 'Mohamed Taher';
  const server = createApi({ verifier, store, work: repo, blobs, logger: { error: () => undefined }, clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const parse = async (res: Response): Promise<R> => {
    const buf = Buffer.from(await res.arrayBuffer());
    let body: any = null; try { body = JSON.parse(buf.toString('utf8')); } catch { /* binary or html */ }
    return { status: res.status, body, text: buf.toString('utf8'), headers: res.headers, buf };
  };
  const c: Client = {
    json: async (who, method, path, body) => parse(await fetch(base + path, { method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })),
    up: async (who, query, bytes, type = 'image/jpeg') => parse(await fetch(`${base}/media?${new URLSearchParams(query)}`, { method: 'POST', headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': type }, body: new Uint8Array(bytes) })),
    get: async (who, path) => parse(await fetch(base + path, { headers: who ? { authorization: `Bearer tok-${who}` } : {} })),
  };
  try { await fn(c, { repo, blobs }); } finally { await new Promise((r) => server.close(r)); }
}

async function inspection(c: Client) {
  const t = (await c.json('manager', 'POST', '/templates', { name: { en: 'Media template' }, content: CONTENT })).body;
  assert.equal((await c.json('manager', 'POST', `/templates/${t.template.id}/publish`, { version: t.draftVersion })).status, 200);
  const i = (await c.json('inspector', 'POST', '/inspections', { templateId: t.template.id, siteId: SITE_A })).body.inspection;
  return i.id as string;
}
const photoQuery = (id: string, extra: Record<string, string> = {}) => ({ ownerType: 'inspection', ownerId: id, kind: 'photo', questionId: 'q_photo', ...extra });

test('a photo is stored, listed and downloaded unchanged, with safe headers; the record never exposes the storage key', async () => {
  await run(async (c, w) => {
    const id = await inspection(c);
    const bytes = JPEG(500, 9);
    const up = await c.up('inspector', photoQuery(id, { caption: 'Missing guard', lat: '30.04', lng: '31.23', takenAt: '2026-10-03T09:00:00Z' }), bytes);
    assert.equal(up.status, 201, up.text);
    const m = up.body.media;
    assert.equal(m.kind, 'photo'); assert.equal(m.mimeType, 'image/jpeg'); assert.equal(m.sizeBytes, bytes.length);
    assert.equal(m.caption, 'Missing guard'); assert.equal(m.lat, 30.04); assert.equal(m.uploadedBy, USERS.inspector!.id);
    assert.equal(m.storageKey, undefined, 'internal storage path is not exposed');
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.equal(w.blobs.files.size, 1);
    assert.match([...w.blobs.files.keys()][0]!, new RegExp(`^${ORG_A}/2026/${m.id}$`));

    const list = await c.get('inspector', `/media?ownerType=inspection&ownerId=${id}&questionId=q_photo`);
    assert.deepEqual(list.body.items.map((x: any) => x.id), [m.id]);
    assert.deepEqual((await c.get('inspector', `/media?ownerType=inspection&ownerId=${id}&questionId=q_audio`)).body.items, []);

    const dl = await c.get('inspector', `/media/${m.id}`);
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.buf, bytes);
    assert.equal(dl.headers.get('content-type'), 'image/jpeg');
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dl.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(dl.headers.get('content-disposition'), `inline; filename="${m.id}.jpg"`);
    assert.equal(dl.headers.get('cache-control'), 'private, max-age=3600');
  });
});

test('what may be uploaded: real type, matching question, size, count and well-formed parameters', async () => {
  await run(async (c, w) => {
    const id = await inspection(c);
    const bad = async (r: Promise<R>, status: number, field: string, code: string) => {
      const x = await r; assert.equal(x.status, status, x.text); assert.equal(x.body.errors[field][0].code, code, x.text);
    };
    await bad(c.up('inspector', photoQuery(id), Buffer.from('<script>alert(1)</script>.........'), 'image/jpeg'), 422, 'file', 'file_type');
    await bad(c.up('inspector', photoQuery(id), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>......'), 'image/svg+xml'), 422, 'file', 'file_type');
    await bad(c.up('inspector', photoQuery(id), JPEG(), 'image/png'), 422, 'file', 'file_type');
    await bad(c.up('inspector', photoQuery(id), PDF, 'application/pdf'), 422, 'file', 'file_type');
    await bad(c.up('inspector', photoQuery(id), Buffer.alloc(0)), 422, 'file', 'required');
    const big = await c.up('inspector', photoQuery(id), JPEG(9 * 1024 * 1024));
    assert.equal(big.status, 422); assert.deepEqual(big.body.errors.file[0], { code: 'file_too_large', params: { maxMb: 8 } });
    await bad(c.up('inspector', photoQuery(id, { kind: 'video' }), JPEG()), 422, 'kind', 'invalid_option');
    await bad(c.up('inspector', photoQuery(id, { ownerType: 'asset' }), JPEG()), 422, 'ownerType', 'invalid_option');
    await bad(c.up('inspector', photoQuery(id, { ownerId: 'nope' }), JPEG()), 422, 'ownerId', 'invalid_type');
    await bad(c.up('inspector', photoQuery(id, { lat: '123' }), JPEG()), 422, 'lat', 'invalid_number');
    await bad(c.up('inspector', photoQuery(id, { takenAt: 'yesterday' }), JPEG()), 422, 'takenAt', 'invalid_datetime');
    await bad(c.up('inspector', photoQuery(id, { caption: 'x'.repeat(301) }), JPEG()), 422, 'caption', 'max_length');
    await bad(c.up('inspector', { ownerType: 'inspection', ownerId: id, kind: 'photo' }, JPEG()), 422, 'questionId', 'required');
    await bad(c.up('inspector', photoQuery(id, { questionId: 'nope' }), JPEG()), 422, 'questionId', 'invalid_reference');
    await bad(c.up('inspector', photoQuery(id, { questionId: 'q_text' }), JPEG()), 422, 'questionId', 'invalid_reference');
    await bad(c.up('inspector', photoQuery(id, { questionId: 'q_audio' }), JPEG()), 422, 'questionId', 'invalid_reference');
    assert.equal(w.blobs.files.size, 0, 'nothing was stored for any rejected upload');

    // other kinds on matching questions
    assert.equal((await c.up('inspector', { ownerType: 'inspection', ownerId: id, kind: 'file', questionId: 'q_file' }, PDF, 'application/pdf')).status, 201);
    const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(100)]);
    assert.equal((await c.up('inspector', { ownerType: 'inspection', ownerId: id, kind: 'audio', questionId: 'q_audio' }, m4a, 'audio/mp4')).status, 201);

    // per-question limit (20 photos)
    for (let n = 0; n < 20; n++) assert.equal((await c.up('inspector', photoQuery(id), JPEG(100, n))).status, 201);
    const over = await c.up('inspector', photoQuery(id), JPEG());
    assert.equal(over.status, 422); assert.deepEqual(over.body.errors.file[0], { code: 'too_many_selections', params: { max: 20 } });
  });
});

test('an upload that is far too large is refused early, before the body is read', async () => {
  const repo = new MemoryWorkRepo();
  for (const u of Object.values(USERS)) repo.addMember(u.org, u.id);
  const srv = createApi({ verifier, store, work: repo, blobs: new MemoryBlobStore(), logger: { error: () => undefined } });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/media?ownerType=inspection&ownerId=00000000-0000-0000-0000-00000000dead&kind=photo', method: 'POST',
        headers: { authorization: 'Bearer tok-inspector', 'content-type': 'image/jpeg', 'content-length': String(40 * 1024 * 1024) },
      }, (res) => { resolve(res.statusCode ?? 0); res.resume(); req.destroy(); });
      req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
      req.write(Buffer.alloc(1024));
    });
    assert.equal(status, 413);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('access follows the owner: only people who may edit the inspection upload; only people who may read it download', async () => {
  await run(async (c) => {
    const id = await inspection(c);
    assert.equal((await c.up(null, photoQuery(id), JPEG())).status, 401);
    assert.equal((await c.up('viewer', photoQuery(id), JPEG())).status, 403, 'can read, cannot edit');
    assert.equal((await c.up('inspector2', photoQuery(id), JPEG())).status, 404, 'cannot even see the inspection');
    assert.equal((await c.up('employee', photoQuery(id), JPEG())).status, 404);
    assert.equal((await c.up('managerB', photoQuery(id), JPEG())).status, 404, 'other organization');
    const ok = await c.up('supervisor', photoQuery(id), JPEG());
    assert.equal(ok.status, 201, 'supervisor of the site');

    const mid = ok.body.media.id;
    for (const [who, status] of [['inspector', 200], ['viewer', 200], ['manager', 200], ['inspector2', 404], ['employee', 404], ['managerB', 404]] as const) {
      assert.equal((await c.get(who, `/media/${mid}`)).status, status, who);
    }
    assert.equal((await c.get(null, `/media/${mid}`)).status, 401);
    assert.equal((await c.get('inspector2', `/media?ownerType=inspection&ownerId=${id}`)).status, 404);
    assert.equal((await c.get('inspector', '/media/00000000-0000-0000-0000-00000000dead')).status, 404);
    assert.equal((await c.get('inspector', '/media/not-a-uuid')).status, 404);
  });
});

test('issues and actions: reporters and assignees may attach evidence; strangers cannot; closed items are locked', async () => {
  await run(async (c) => {
    const issue = (await c.json('employee', 'POST', '/issues', { title: 'Leaking pipe', type: 'hazard', priority: 'high' })).body;
    const q = (type: string, id: string, extra: Record<string, string> = {}) => ({ ownerType: type, ownerId: id, kind: 'photo', ...extra });
    assert.equal((await c.up('employee', q('issue', issue.id), JPEG())).status, 201, 'the reporter attaches a photo');
    assert.equal((await c.up('employee2', q('issue', issue.id), JPEG())).status, 404, 'a colleague cannot see it');
    assert.equal((await c.up('viewer', q('issue', issue.id), JPEG())).status, 404, 'a viewer without access');
    assert.equal((await c.up('manager', q('issue', issue.id), JPEG())).status, 201, 'managers may too');
    assert.equal((await c.up('employee', q('issue', issue.id, { questionId: 'q1' }), JPEG())).body.errors.questionId[0].code, 'unknown_field');
    assert.equal((await c.up('employee', q('issue', issue.id, { kind: 'signature' }), PNG(), 'image/png')).body.errors.kind[0].code, 'invalid_option');

    const action = (await c.json('manager', 'POST', '/actions', { title: 'Replace pipe', type: 'corrective', priority: 'high', assigneeId: USERS.employee!.id })).body;
    assert.equal((await c.up('employee', q('action', action.id), JPEG())).status, 201, 'the assignee attaches proof');
    assert.equal((await c.up('employee2', q('action', action.id), JPEG())).status, 404);
    await c.json('manager', 'PATCH', `/actions/${action.id}`, { version: 1, status: 'in_progress' });
    await c.json('manager', 'PATCH', `/actions/${action.id}`, { version: 2, status: 'completed' });
    assert.equal((await c.up('employee', q('action', action.id), JPEG())).body.code, 'not_editable', 'completed actions are locked');

    // the issue is moved to a final state: no more files
    await c.json('manager', 'PATCH', `/issues/${issue.id}`, { version: 1, status: 'rejected' });
    assert.equal((await c.up('employee', q('issue', issue.id), JPEG())).body.code, 'not_editable');
  });
});

test('deleting: only while the owner is editable; files are soft-deleted, signatures never', async () => {
  await run(async (c) => {
    const id = await inspection(c);
    const m = (await c.up('inspector', photoQuery(id), JPEG())).body.media.id;
    assert.equal((await c.json('viewer', 'DELETE', `/media/${m}`)).status, 403);
    assert.equal((await c.json('inspector2', 'DELETE', `/media/${m}`)).status, 404);
    assert.equal((await c.json('inspector', 'DELETE', `/media/${m}`)).status, 200);
    assert.equal((await c.get('inspector', `/media/${m}`)).status, 404);
    assert.deepEqual((await c.get('inspector', `/media?ownerType=inspection&ownerId=${id}`)).body.items, []);
    assert.equal((await c.json('inspector', 'DELETE', `/media/${m}`)).status, 404, 'already gone');
    const events = (await c.get('inspector', `/inspections/${id}/timeline`)).body.items.map((e: any) => e.event);
    assert.ok(events.includes('media_removed'));

    const sig = (await c.up('inspector', { ownerType: 'inspection', ownerId: id, kind: 'signature' }, PNG(), 'image/png')).body.media.id;
    assert.equal((await c.json('inspector', 'DELETE', `/media/${sig}`)).status, 403, 'signatures are evidence');
    assert.equal((await c.json('manager', 'DELETE', `/media/${sig}`)).status, 403, 'not even managers');

    const kept = (await c.up('inspector', photoQuery(id), JPEG(100, 5))).body.media.id;
    await c.json('inspector', 'PUT', `/inspections/${id}/responses/q_text`, { value: 'ok', baseVersion: 0 });
    assert.equal((await c.json('inspector', 'POST', `/inspections/${id}/complete`)).status, 200);
    assert.equal((await c.json('inspector', 'DELETE', `/media/${kept}`)).body.code, 'not_editable', 'a finished inspection keeps its photos');
    assert.equal((await c.up('inspector', photoQuery(id), JPEG())).body.code, 'not_editable');
  });
});

test('if the record cannot be saved, the stored file is removed again (no orphans)', async () => {
  await run(async (c, w) => {
    const id = await inspection(c);
    Object.freeze(w.repo.media); // the next insert fails
    const r = await c.up('inspector', photoQuery(id), JPEG());
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { code: 'internal' });
    assert.equal(w.blobs.files.size, 0);
  });
});

test('signatures: drawn image + name, one per image, allowed until the inspection is archived, listed and recorded', async () => {
  await run(async (c) => {
    const id = await inspection(c);
    const other = await inspection(c);
    const sigImg = async (insp: string) => (await c.up('inspector', { ownerType: 'inspection', ownerId: insp, kind: 'signature' }, PNG(), 'image/png')).body.media.id as string;
    const photo = (await c.up('inspector', photoQuery(id), JPEG())).body.media.id;
    const a = await sigImg(id);

    const sign = (who: string, body: Record<string, unknown>, insp = id) => c.json(who, 'POST', `/inspections/${insp}/signatures`, body);
    assert.equal((await sign('viewer', { mediaId: a, signerName: 'Viewer Person' })).status, 403);
    assert.equal((await sign('inspector2', { mediaId: a, signerName: 'Nobody' })).status, 404);
    assert.equal((await sign('inspector', { mediaId: a, signerName: 'x' })).body.errors.signerName[0].code, 'min_length');
    assert.equal((await sign('inspector', { signerName: 'Mohamed Taher' })).body.errors.mediaId[0].code, 'required');
    assert.equal((await sign('inspector', { mediaId: photo, signerName: 'Mohamed Taher' })).body.errors.mediaId[0].code, 'invalid_reference', 'a photo is not a signature');
    assert.equal((await sign('inspector', { mediaId: await sigImg(other), signerName: 'Mohamed Taher' })).body.errors.mediaId[0].code, 'invalid_reference', 'signature of another inspection');
    assert.equal((await sign('inspector', { mediaId: a, signerName: 'Mohamed Taher', extra: 1 })).body.errors.extra[0].code, 'unknown_field');

    const ok = await sign('inspector', { mediaId: a, signerName: ' Mohamed Taher ', signerRole: 'Inspector' });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.signature.signerName, 'Mohamed Taher');
    assert.equal(ok.body.signature.signedBy, USERS.inspector!.id);
    assert.equal((await sign('inspector', { mediaId: a, signerName: 'Again Again' })).status, 409, 'an image is used once');

    await c.json('inspector', 'PUT', `/inspections/${id}/responses/q_text`, { value: 'ok', baseVersion: 0 });
    assert.equal((await c.json('inspector', 'POST', `/inspections/${id}/complete`)).status, 200);
    const later = await sigImg(id);
    assert.equal((await sign('supervisor', { mediaId: later, signerName: 'Site Supervisor', signerRole: 'Supervisor' })).status, 201, 'a sign-off after completion is allowed');

    const list = (await c.get('viewer', `/inspections/${id}/signatures`)).body.items;
    assert.deepEqual(list.map((s: any) => s.signerName), ['Mohamed Taher', 'Site Supervisor']);
    assert.equal((await c.get('inspector2', `/inspections/${id}/signatures`)).status, 404);
    const events = (await c.get('inspector', `/inspections/${id}/timeline`)).body.items.map((e: any) => e.event);
    assert.equal(events.filter((e: string) => e === 'signed').length, 2);
  });
});

test('the report embeds photos and signatures; a missing file blocks it; other people cannot read what they may not see', async () => {
  await run(async (c, w) => {
    const id = await inspection(c);
    const p1 = (await c.up('inspector', photoQuery(id, { caption: 'Guard missing' }), JPEG(400, 1))).body.media;
    const p2 = (await c.up('inspector', photoQuery(id), JPEG(400, 2))).body.media;
    const s = (await c.up('inspector', { ownerType: 'inspection', ownerId: id, kind: 'signature' }, PNG(), 'image/png')).body.media;
    await c.json('inspector', 'POST', `/inspections/${id}/signatures`, { mediaId: s.id, signerName: 'Mohamed Taher', signerRole: 'Inspector' });
    await c.json('inspector', 'PUT', `/inspections/${id}/responses/q_text`, { value: 'All fine', baseVersion: 0 });
    assert.equal((await c.json('inspector', 'PUT', `/inspections/${id}/responses/q_photo`, { value: [p1.id, p2.id], baseVersion: 0 })).status, 200);
    assert.equal((await c.json('inspector', 'POST', `/inspections/${id}/complete`)).status, 200);

    const rep = await c.get('inspector', `/inspections/${id}/report?lang=en`);
    assert.equal(rep.status, 200, rep.text);
    assert.equal((rep.text.match(/<img class="photo"/g) ?? []).length, 2);
    assert.ok(rep.text.includes(`data:image/jpeg;base64,${JPEG(400, 1).toString('base64')}`), 'the real bytes are embedded');
    assert.ok(rep.text.includes('alt="Guard missing"'));
    assert.ok(rep.text.includes('<img class="sign"') && rep.text.includes('Mohamed Taher') && rep.text.includes('Inspector'));
    assert.ok(!/https?:\/\//.test(rep.text.replace(/http:\/\/www\.w3\.org[^"]*/g, '')), 'no external resources');
    assert.equal((await c.get('inspector2', `/inspections/${id}/report`)).status, 404);

    // the file referenced by the answer disappears from storage: the report must not be produced half-empty
    for (const key of [...w.blobs.files.keys()]) if (key.endsWith(p2.id)) w.blobs.files.delete(key);
    const broken = await c.get('inspector', `/inspections/${id}/report?lang=en`);
    assert.equal(broken.status, 422);
    assert.equal(broken.body.code, 'report_invalid');
    assert.deepEqual(broken.body.errors, [{ code: 'missing_media', path: 'q_photo' }]);
  });
});
