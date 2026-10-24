import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import { batchingPlantTemplate } from '../../../packages/engines/src/template/fixtures.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const ORG_B = '00000000-0000-0000-0000-00000000bbbb';

const USERS: Record<string, { id: string; org: string; role: RoleKey }> = {
  manager:    { id: '00000000-0000-0000-0000-000000000001', org: ORG_A, role: 'hse_manager' },
  supervisor: { id: '00000000-0000-0000-0000-000000000002', org: ORG_A, role: 'supervisor' },
  employee:   { id: '00000000-0000-0000-0000-000000000003', org: ORG_A, role: 'employee' },
  managerB:   { id: '00000000-0000-0000-0000-000000000007', org: ORG_B, role: 'hse_manager' },
};
const verifier: TokenVerifier = { async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); } };
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) {
    const u = USERS[uid];
    return u ? [{ userId: u.id, orgId: u.org, membershipId: `m-${uid}`, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : [];
  },
  async loadUser(m) { return { fullName: m.userId, email: `${m.userId}@x.com`, locale: 'ar' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds() { return []; },
};

type R = { status: number; body: any };
type Client = (who: string | null, method: string, path: string, body?: unknown, raw?: string) => Promise<R>;

async function run(fn: (c: Client, repo: MemoryWorkRepo) => Promise<void>) {
  const repo = new MemoryWorkRepo();
  const server = createApi({
    verifier, store, work: repo, logger: { error: () => undefined },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c: Client = async (who, method, path, body, raw) => {
    const res = await fetch(base + path, {
      method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn(c, repo); } finally { await new Promise((r) => server.close(r)); }
}

const NAME = { name: { ar: 'تفتيش محطة الخرسانة', en: 'Batching plant inspection' } };
const create = async (c: Client, extra: Record<string, unknown> = {}) =>
  (await c('manager', 'POST', '/templates', { ...NAME, content: batchingPlantTemplate(), ...extra })).body as { template: any; draftVersionId: string; draftVersion: number };

test('requires authentication', async () => {
  await run(async (c) => {
    assert.equal((await c(null, 'GET', '/templates')).status, 401);
    assert.equal((await c(null, 'POST', '/templates', NAME)).status, 401);
  });
});

test('create: who can, validation, malformed content', async () => {
  await run(async (c) => {
    const r = await c('manager', 'POST', '/templates', { ...NAME, category: 'Concrete', content: batchingPlantTemplate() });
    assert.equal(r.status, 201);
    assert.equal(r.body.template.status, 'draft');
    assert.equal(r.body.template.publishedVersionId, null);
    assert.equal(r.body.template.createdBy, USERS.manager!.id);

    assert.equal((await c('supervisor', 'POST', '/templates', NAME)).status, 403);
    assert.equal((await c('employee', 'POST', '/templates', NAME)).status, 403);
    assert.equal((await c('manager', 'POST', '/templates', { name: { ar: '  ' } })).body.errors.name[0].code, 'required');
    assert.equal((await c('manager', 'POST', '/templates', { ...NAME, content: { pages: 'nope' } })).body.errors.content[0].code, 'invalid_type');
    assert.equal((await c('manager', 'POST', '/templates', undefined, '{oops')).status, 400);
    const empty = await c('manager', 'POST', '/templates', NAME);
    assert.equal(empty.status, 201, 'content is optional (empty draft)');
  });
});

test('drafts are invisible to people who cannot edit; published templates become visible', async () => {
  await run(async (c) => {
    const t = await create(c);
    const id = t.template.id;
    assert.deepEqual((await c('supervisor', 'GET', '/templates')).body.items, []);
    assert.equal((await c('supervisor', 'GET', `/templates/${id}`)).status, 404);
    assert.equal((await c('supervisor', 'GET', `/templates/${id}/versions/${t.draftVersionId}`)).status, 404);
    assert.equal((await c('managerB', 'GET', `/templates/${id}`)).status, 404, 'other organization');
    assert.equal((await c('manager', 'GET', '/templates')).body.items.length, 1);

    assert.equal((await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion })).status, 200);
    const list = await c('supervisor', 'GET', '/templates');
    assert.equal(list.body.items.length, 1);
    const detail = await c('supervisor', 'GET', `/templates/${id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.versions.map((v: any) => v.status), ['published']);
    assert.equal((await c('employee', 'GET', `/templates/${id}`)).status, 404, 'employee has no template.read');
    assert.equal((await c('employee', 'GET', '/templates')).status, 403);
  });
});

test('draft editing: shape check, optimistic locking, only editors', async () => {
  await run(async (c) => {
    const t = await create(c);
    const id = t.template.id;
    const content = batchingPlantTemplate();
    content.pages.pop();

    const ok = await c('manager', 'PUT', `/templates/${id}/draft`, { version: t.draftVersion, content });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.version.version, t.draftVersion + 1);
    assert.equal(ok.body.version.content.pages.length, 2);

    assert.equal((await c('manager', 'PUT', `/templates/${id}/draft`, { version: t.draftVersion, content })).status, 409, 'stale');
    assert.equal((await c('manager', 'PUT', `/templates/${id}/draft`, { version: ok.body.version.version, content: { pages: [{}] } })).status, 422);
    assert.equal((await c('manager', 'PUT', `/templates/${id}/draft`, { version: ok.body.version.version, content, extra: 1 })).body.errors.extra[0].code, 'unknown_field');
    // an incomplete draft can be saved (publish is where validity is enforced)
    assert.equal((await c('manager', 'PUT', `/templates/${id}/draft`, { version: ok.body.version.version, content: { pages: [{ id: 'p', title: {}, items: [] }] } })).status, 200);
  });
});

test('validate reports issues; publish is blocked until the draft is valid', async () => {
  await run(async (c) => {
    const bad = batchingPlantTemplate();
    bad.pages[0]!.items = [];
    const t = await create(c, { content: bad });
    const id = t.template.id;

    const v = await c('manager', 'POST', `/templates/${id}/validate`);
    assert.equal(v.body.valid, false);
    assert.ok(v.body.issues.some((i: any) => i.code === 'empty_page' && i.path === 'p_general'));

    const blocked = await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.code, 'template_invalid');
    assert.ok(blocked.body.errors.some((i: any) => i.code === 'empty_page'));
    assert.equal((await c('manager', 'GET', `/templates/${id}`)).body.template.status, 'draft');

    const fixed = await c('manager', 'PUT', `/templates/${id}/draft`, { version: t.draftVersion, content: batchingPlantTemplate() });
    assert.equal((await c('manager', 'POST', `/templates/${id}/validate`)).body.valid, true);
    assert.equal((await c('manager', 'POST', `/templates/${id}/publish`, { version: fixed.body.version.version })).status, 200);
  });
});

test('publish: permissions, stale version, freezes the version, cannot publish twice', async () => {
  await run(async (c) => {
    const t = await create(c);
    const id = t.template.id;
    assert.equal((await c('manager', 'POST', `/templates/${id}/publish`, { version: 99 })).status, 409);
    assert.equal((await c('manager', 'POST', `/templates/${id}/publish`, {})).body.errors.version[0].code, 'required');

    const r = await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion });
    assert.equal(r.status, 200);
    assert.equal(r.body.template.status, 'published');
    assert.equal(r.body.template.publishedVersionId, r.body.version.id);
    assert.equal(r.body.version.status, 'published');
    assert.ok(r.body.version.fingerprint);
    assert.equal(r.body.version.publishedBy, USERS.manager!.id);
    assert.equal(r.body.version.content, undefined, 'summary only');

    assert.equal((await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion })).status, 404, 'no draft left');
    assert.equal((await c('supervisor', 'POST', `/templates/${id}/publish`, { version: 1 })).status, 403);
    // the published version can no longer be edited
    assert.equal((await c('manager', 'PUT', `/templates/${id}/draft`, { version: 2, content: { pages: [] } })).status, 404);
    const v1 = await c('manager', 'GET', `/templates/${id}/versions/${r.body.version.id}`);
    assert.equal(v1.body.version.content.pages.length, 3);
  });
});

test('editing a published template creates version 2; version 1 stays exactly as published', async () => {
  await run(async (c) => {
    const t = await create(c);
    const id = t.template.id;
    const pub = (await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion })).body;
    const v1Id = pub.version.id;
    const fp1 = pub.version.fingerprint;

    assert.equal((await c('supervisor', 'POST', `/templates/${id}/drafts`)).status, 403);
    const d = await c('manager', 'POST', `/templates/${id}/drafts`);
    assert.equal(d.status, 201);
    assert.equal(d.body.version.versionNo, 2);
    assert.equal(d.body.version.status, 'draft');
    assert.equal((await c('manager', 'POST', `/templates/${id}/drafts`)).body.code, 'draft_exists');

    const changed = batchingPlantTemplate();
    changed.pages = changed.pages.slice(0, 1);
    await c('manager', 'PUT', `/templates/${id}/draft`, { version: d.body.version.version, content: changed });

    const v1 = (await c('manager', 'GET', `/templates/${id}/versions/${v1Id}`)).body.version;
    assert.equal(v1.content.pages.length, 3, 'v1 untouched');
    assert.equal(v1.fingerprint, fp1);
    // supervisors still only see v1
    const sup = (await c('supervisor', 'GET', `/templates/${id}`)).body;
    assert.deepEqual(sup.versions.map((v: any) => v.versionNo), [1]);

    const pub2 = await c('manager', 'POST', `/templates/${id}/publish`, { version: (await c('manager', 'GET', `/templates/${id}`)).body.versions.find((v: any) => v.versionNo === 2).version });
    assert.equal(pub2.status, 200);
    assert.equal(pub2.body.template.publishedVersionId, pub2.body.version.id);
    assert.notEqual(pub2.body.version.fingerprint, fp1);
    assert.equal((await c('manager', 'GET', `/templates/${id}`)).body.versions.length, 2);
  });
});

test('evaluate: scores/flags/errors from a published version; drafts only for editors', async () => {
  await run(async (c) => {
    const t = await create(c);
    const id = t.template.id;
    const draftEval = await c('manager', 'POST', `/templates/${id}/versions/${t.draftVersionId}/evaluate`, { answers: { q_helmet: 'yes' } });
    assert.equal(draftEval.status, 200, 'editors may preview drafts');
    const pub = (await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion })).body;
    const vid = pub.version.id;

    const perfect = await c('supervisor', 'POST', `/templates/${id}/versions/${vid}/evaluate`, {
      answers: { q_helmet: 'yes', q_vest: 'yes', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 },
    });
    assert.equal(perfect.status, 200);
    assert.equal(perfect.body.scores.total.pct, 100);
    assert.equal(perfect.body.scores.passed, true);
    assert.deepEqual(perfect.body.errors, {});

    const poor = await c('supervisor', 'POST', `/templates/${id}/versions/${vid}/evaluate`, { answers: { q_helmet: 'no', q_condition: 'poor', q_pressure: 9 } });
    assert.deepEqual(poor.body.flags.map((f: any) => f.questionId).sort(), ['q_condition', 'q_helmet', 'q_pressure']);
    assert.equal(poor.body.errors.q_notes[0].code, 'required');
    assert.equal(poor.body.errors.q_emergency_plan[0].code, 'required');
    assert.equal(poor.body.state.visible.p_emergency, true);

    assert.equal((await c('supervisor', 'POST', `/templates/${id}/versions/${vid}/evaluate`, { answers: [] })).status, 422);
    assert.equal((await c('employee', 'POST', `/templates/${id}/versions/${vid}/evaluate`, { answers: {} })).status, 404);
    // a version id from another template is not reachable through this one
    const other = await create(c);
    assert.equal((await c('manager', 'GET', `/templates/${id}/versions/${other.draftVersionId}`)).status, 404);
  });
});

test('metadata, archive and restore have their own permissions', async () => {
  await run(async (c) => {
    const t = await create(c);
    const id = t.template.id;
    await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion });
    const cur = (await c('manager', 'GET', `/templates/${id}`)).body.template;

    assert.equal((await c('supervisor', 'PATCH', `/templates/${id}`, { version: cur.version, name: { en: 'Hacked' } })).status, 403);
    const renamed = await c('manager', 'PATCH', `/templates/${id}`, { version: cur.version, name: { en: 'Renamed', ar: 'اسم جديد' }, category: 'Safety' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.template.name.en, 'Renamed');
    assert.equal((await c('manager', 'PATCH', `/templates/${id}`, { version: cur.version, category: 'x' })).status, 409, 'stale');
    assert.equal((await c('manager', 'PATCH', `/templates/${id}`, { version: renamed.body.template.version, owner: 'x' })).status, 422);

    const archived = await c('manager', 'PATCH', `/templates/${id}`, { version: renamed.body.template.version, status: 'archived' });
    assert.equal(archived.body.template.status, 'archived');
    assert.deepEqual((await c('supervisor', 'GET', '/templates')).body.items, [], 'archived templates are hidden from non-editors');
    assert.equal((await c('manager', 'PATCH', `/templates/${id}`, { version: archived.body.template.version, status: 'draft' })).body.code, 'invalid_transition');
    const restored = await c('manager', 'PATCH', `/templates/${id}`, { version: archived.body.template.version, status: 'published' });
    assert.equal(restored.body.template.status, 'published');

    const fresh = await create(c);
    assert.equal((await c('manager', 'PATCH', `/templates/${fresh.template.id}`, { version: 1, status: 'published' })).body.code, 'no_published_version', 'a template is published through its version, not by PATCH');
  });
});

test('template timeline records who did what; only editors can read it', async () => {
  await run(async (c) => {
    const t = await create(c);
    const id = t.template.id;
    await c('manager', 'POST', `/templates/${id}/publish`, { version: t.draftVersion });
    await c('manager', 'POST', `/templates/${id}/drafts`);
    const tl = (await c('manager', 'GET', `/templates/${id}/timeline`)).body.items;
    assert.deepEqual(tl.map((e: any) => e.event), ['created', 'published', 'draft_created']);
    assert.ok(tl.every((e: any) => e.actorUserId === USERS.manager!.id));
    assert.equal(tl[1].newValue.versionNo, 1);
    assert.equal((await c('supervisor', 'GET', `/templates/${id}/timeline`)).status, 403);
  });
});

test('pagination and malformed ids', async () => {
  await run(async (c) => {
    for (let i = 0; i < 5; i++) await c('manager', 'POST', '/templates', { name: { en: `T${i}` } });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: R = await c('manager', 'GET', `/templates?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.body.items.map((x: any) => x.name.en));
      cursor = r.body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ['T4', 'T3', 'T2', 'T1', 'T0']);
    assert.equal((await c('manager', 'GET', '/templates?status=weird')).status, 422);
    assert.equal((await c('manager', 'GET', '/templates/not-a-uuid')).status, 404);
    assert.equal((await c('manager', 'DELETE', '/templates/00000000-0000-0000-0000-000000000009')).status, 404);
  });
});
