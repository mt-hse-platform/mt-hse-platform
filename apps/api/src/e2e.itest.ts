// Integration tests: real PostgreSQL (migration + 2 bootstrapped orgs) + the real PgIdentityStore + the HTTP API.
// Run by CI (.github/workflows/ci.yml) or manually with DATABASE_URL set to the app_user connection.
// Firebase token verification is replaced by a fake verifier (it needs Google's servers).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { PgIdentityStore } from './pgIdentityStore.ts';
import { createApi } from './server.ts';
import { PgWorkRepo } from './pgWorkRepo.ts';
import { DiskBlobStore } from './blobStore.ts';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { TokenVerifier } from './ports.ts';
import { batchingPlantTemplate } from '../../../packages/engines/src/template/fixtures.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL is not set';
const UID_A = 'CI_ORG_A_ADMIN_UID_0000001';
const UID_B = 'CI_ORG_B_ADMIN_UID_0000002';

const pool = new pg.Pool({ connectionString: url, max: 4 });
after(async () => { await pool.end(); });
const store = new PgIdentityStore(pool);

const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'tok-a') return { uid: UID_A };
    if (token === 'tok-b') return { uid: UID_B };
    if (token === 'tok-ghost') return { uid: 'CI_UNKNOWN_FIREBASE_UID_000' };
    throw new Error('invalid');
  },
};

const canon = (g: { permission: string; scope: string }[]) => g.map((x) => `${x.permission}:${x.scope}`).sort();

test('resolveByFirebaseUid: finds the admin of each org; unknown uid finds nothing', { skip }, async () => {
  const a = await store.resolveByFirebaseUid(UID_A);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.userActive && a[0]!.membershipActive, true);
  assert.deepEqual(await store.resolveByFirebaseUid('CI_UNKNOWN_FIREBASE_UID_000'), []);
});

test('loadUser / loadGrants / loadSiteIds return the bootstrapped admin data', { skip }, async () => {
  const [a] = await store.resolveByFirebaseUid(UID_A);
  assert.equal((await store.loadUser(a!)).fullName, 'Admin A');
  assert.deepEqual(canon(await store.loadGrants(a!)), canon(DEFAULT_ROLE_GRANTS.org_admin));
  assert.deepEqual(await store.loadSiteIds(a!), []);
});

test('RLS through the real adapter: org A context cannot read org B role permissions', { skip }, async () => {
  const [a] = await store.resolveByFirebaseUid(UID_A);
  const [b] = await store.resolveByFirebaseUid(UID_B);
  assert.notEqual(a!.orgId, b!.orgId);
  const forged = { ...a!, roleId: b!.roleId }; // org A context + org B role id
  assert.deepEqual(await store.loadGrants(forged), []);
});

test('HTTP /auth/session end-to-end against PostgreSQL', { skip }, async () => {
  const server = createApi({ verifier, store, logger: { error: () => undefined } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (token: string) => {
    const res = await fetch(`${base}/auth/session`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const a = await get('tok-a');
    const b = await get('tok-b');
    assert.equal(a.status, 200);
    assert.equal(a.body.user.fullName, 'Admin A');
    assert.equal(a.body.grants.length, DEFAULT_ROLE_GRANTS.org_admin.length);
    assert.equal(b.status, 200);
    assert.equal(b.body.user.fullName, 'Admin B');
    assert.notEqual(a.body.orgId, b.body.orgId);
    assert.equal((await get('tok-ghost')).status, 403);
    assert.equal((await get('garbage')).status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('issues and actions end-to-end against PostgreSQL (RLS, constraints, timeline, pagination)', { skip }, async () => {
  const server = createApi({
    verifier, store, work: new PgWorkRepo(pool), logger: { error: (m, e) => console.error(m, e) },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const me = (await call('tok-a', 'GET', '/auth/session')).body.user.id as string;

    const created = await call('tok-a', 'POST', '/issues', { title: 'Leaking hose', type: 'hazard', priority: 'high', dueDate: '2026-10-10' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as string;
    const fetched = await call('tok-a', 'GET', `/issues/${id}`);
    assert.equal(fetched.body.dueDate, '2026-10-10');
    assert.equal(fetched.body.status, 'open');

    // organization isolation
    assert.equal((await call('tok-b', 'GET', `/issues/${id}`)).status, 404);
    assert.deepEqual((await call('tok-b', 'GET', '/issues')).body.items, []);

    // lifecycle + optimistic locking
    const assigned = await call('tok-a', 'PATCH', `/issues/${id}`, { version: 1, assigneeId: me, status: 'assigned' });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.version, 2);
    assert.equal((await call('tok-a', 'PATCH', `/issues/${id}`, { version: 1, priority: 'low' })).status, 409);

    // actions: link to the issue, complete (completed_at constraint), reopen
    const action = await call('tok-a', 'POST', '/actions', { title: 'Replace hose', type: 'corrective', priority: 'high', issueId: id, assigneeId: me });
    assert.equal(action.status, 201, JSON.stringify(action.body));
    const aid = action.body.id as string;
    assert.equal((await call('tok-a', 'PATCH', `/actions/${aid}`, { version: 1, status: 'in_progress' })).status, 200);
    const done = await call('tok-a', 'PATCH', `/actions/${aid}`, { version: 2, status: 'completed' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.completedAt);
    const reopened = await call('tok-a', 'PATCH', `/actions/${aid}`, { version: 3, status: 'in_progress' });
    assert.equal(reopened.body.completedAt, null);

    // comments and timeline
    const c1 = await call('tok-a', 'POST', `/actions/${aid}/comments`, { body: 'Parts ordered' });
    assert.equal(c1.status, 201);
    assert.equal((await call('tok-a', 'POST', `/actions/${aid}/comments`, { body: 'Thanks', parentId: c1.body.id })).status, 201);
    assert.equal((await call('tok-b', 'POST', `/actions/${aid}/comments`, { body: 'intruder' })).status, 404);
    assert.deepEqual((await call('tok-a', 'GET', `/actions/${aid}/comments`)).body.items.map((x: any) => x.body), ['Parts ordered', 'Thanks']);
    const tl = (await call('tok-a', 'GET', `/issues/${id}/timeline`)).body.items;
    assert.deepEqual(tl.map((e: any) => e.event), ['created', 'status_changed', 'assigned']);
    assert.equal(tl[2].newValue, me);

    // foreign key / reference errors become clean 422s
    const badSite = await call('tok-a', 'POST', '/issues', { title: 'Bad site', type: 'hazard', priority: 'low', siteId: '00000000-0000-0000-0000-00000000ffff' });
    assert.equal(badSite.status, 422);
    assert.equal(badSite.body.errors.reference[0].code, 'invalid_reference');

    // pagination without duplicates
    for (const n of [1, 2, 3]) await call('tok-a', 'POST', '/issues', { title: `Page issue ${n}`, type: 'observation', priority: 'low' });
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { status: number; body: any } = await call('tok-a', 'GET', `/issues?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(page.status, 200);
      for (const i of page.body.items) { assert.ok(!seen.has(i.id), 'duplicate across pages'); seen.add(i.id); }
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.ok(seen.size >= 4);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('templates end-to-end against PostgreSQL (versions, immutability trigger, RLS, evaluate)', { skip }, async () => {
  const server = createApi({
    verifier, store, work: new PgWorkRepo(pool), logger: { error: (m, e) => console.error(m, e) },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const created = await call('tok-a', 'POST', '/templates', { name: { ar: 'تفتيش', en: 'Batching plant' }, category: 'Concrete', content: batchingPlantTemplate() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.template.id as string;
    assert.deepEqual(created.body.template.name, { ar: 'تفتيش', en: 'Batching plant' });

    // other organization cannot see it
    assert.equal((await call('tok-b', 'GET', `/templates/${id}`)).status, 404);
    assert.deepEqual((await call('tok-b', 'GET', '/templates')).body.items, []);

    // invalid draft cannot be published; valid one can
    const bad = batchingPlantTemplate(); bad.pages[0]!.items = [];
    const saved = await call('tok-a', 'PUT', `/templates/${id}/draft`, { version: created.body.draftVersion, content: bad });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const blocked = await call('tok-a', 'POST', `/templates/${id}/publish`, { version: saved.body.version.version });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.code, 'template_invalid');
    const fixed = await call('tok-a', 'PUT', `/templates/${id}/draft`, { version: saved.body.version.version, content: batchingPlantTemplate() });
    const pub = await call('tok-a', 'POST', `/templates/${id}/publish`, { version: fixed.body.version.version });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.template.status, 'published');
    const v1 = pub.body.version.id as string;

    // the database itself refuses to change or delete a published version (even though the app never tries)
    const client = await pool.connect();
    try {
      const me = (await call('tok-a', 'GET', '/auth/session')).body;
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [me.orgId, me.user.id]);
      await assert.rejects(client.query("UPDATE template_versions SET content = '{\"pages\":[]}'::jsonb WHERE id = $1", [v1]), (e: any) => e.code === '55000');
      await client.query('ROLLBACK');
    } finally { client.release(); }

    // version 2 draft, v1 untouched, second draft refused
    const d2 = await call('tok-a', 'POST', `/templates/${id}/drafts`);
    assert.equal(d2.status, 201, JSON.stringify(d2.body));
    assert.equal(d2.body.version.versionNo, 2);
    assert.equal((await call('tok-a', 'POST', `/templates/${id}/drafts`)).body.code, 'draft_exists');
    const v1Read = await call('tok-a', 'GET', `/templates/${id}/versions/${v1}`);
    assert.equal(v1Read.body.version.status, 'published');
    assert.equal(v1Read.body.version.content.pages.length, 3);

    // evaluation against the real stored version
    const ev = await call('tok-a', 'POST', `/templates/${id}/versions/${v1}/evaluate`, {
      answers: { q_helmet: 'yes', q_vest: 'yes', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 },
    });
    assert.equal(ev.body.scores.total.pct, 100);

    // timeline + archive/restore
    const tl = await call('tok-a', 'GET', `/templates/${id}/timeline`);
    assert.deepEqual(tl.body.items.map((e: any) => e.event), ['created', 'published', 'draft_created']);
    const cur = (await call('tok-a', 'GET', `/templates/${id}`)).body.template;
    const arch = await call('tok-a', 'PATCH', `/templates/${id}`, { version: cur.version, status: 'archived' });
    assert.equal(arch.body.template.status, 'archived');
    const rest = await call('tok-a', 'PATCH', `/templates/${id}`, { version: arch.body.template.version, status: 'published' });
    assert.equal(rest.body.template.status, 'published');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('inspections end-to-end against PostgreSQL (version pinning, autosave conflicts, completion, freeze triggers)', { skip }, async () => {
  const server = createApi({
    verifier, store, work: new PgWorkRepo(pool), logger: { error: (m, e) => console.error(m, e) },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const put = (id: string, q: string, value: unknown, baseVersion: number) =>
    call('tok-a', 'PUT', `/inspections/${id}/responses/${q}`, { value, baseVersion });
  try {
    const t = await call('tok-a', 'POST', '/templates', { name: { en: 'Plant' }, content: batchingPlantTemplate() });
    const pub = await call('tok-a', 'POST', `/templates/${t.body.template.id}/publish`, { version: t.body.draftVersion });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));

    const started = await call('tok-a', 'POST', '/inspections', { templateId: t.body.template.id, title: 'Morning round' });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const id = started.body.inspection.id as string;
    assert.equal(started.body.inspection.templateVersionId, pub.body.version.id);

    // another organization cannot see or touch it
    assert.equal((await call('tok-b', 'GET', `/inspections/${id}`)).status, 404);
    assert.equal((await call('tok-b', 'PUT', `/inspections/${id}/responses/q_helmet`, { value: 'yes', baseVersion: 0 })).status, 404);

    // autosave with per-question versions and conflict reporting
    assert.equal((await put(id, 'q_helmet', 'yes', 0)).body.response.version, 1);
    assert.equal((await put(id, 'q_helmet', 'no', 1)).body.response.version, 2);
    const stale = await put(id, 'q_helmet', 'na', 1);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.errors.current.value, 'no');
    assert.equal((await put(id, 'q_helmet', 'yes', 0)).status, 409, 'insert over existing');
    assert.equal((await put(id, 'q_helmet', 'maybe', 2)).status, 422);

    // q_helmet is the only required question and it is answered, so completion succeeds with partial answers
    const early = await call('tok-a', 'POST', `/inspections/${id}/complete`);
    assert.equal(early.status, 200, JSON.stringify(early.body));
    assert.equal(early.body.inspection.status, 'completed');
    assert.equal(early.body.inspection.scorePct, 0, 'helmet = no => 0 of 100');
    assert.deepEqual(early.body.flags.map((f: any) => f.questionId), ['q_helmet']);

    // one-tap action from the flagged item: context copied from the inspection, flag linked exactly once
    const flagId = early.body.flags[0].id as string;
    const fromFlag = await call('tok-a', 'POST', `/inspections/${id}/flags/${flagId}/action`);
    assert.equal(fromFlag.status, 201, JSON.stringify(fromFlag.body));
    assert.equal(fromFlag.body.action.inspectionId, id);
    assert.equal(fromFlag.body.action.templateVersionId, pub.body.version.id);
    assert.equal(fromFlag.body.action.questionId, 'q_helmet');
    assert.equal(fromFlag.body.action.priority, 'high');
    assert.equal(fromFlag.body.flag.actionId, fromFlag.body.action.id);
    assert.equal((await call('tok-a', 'POST', `/inspections/${id}/flags/${flagId}/action`)).body.code, 'already_linked');
    const asIssue = await call('tok-a', 'POST', `/inspections/${id}/flags/${flagId}/issue`);
    assert.equal(asIssue.status, 201, JSON.stringify(asIssue.body));
    assert.equal((await call('tok-b', 'POST', `/inspections/${id}/flags/${flagId}/action`)).status, 404);

    // frozen at the API level and at the database level
    assert.equal((await put(id, 'q_vest', 'yes', 0)).body.code, 'not_editable');
    const client = await pool.connect();
    try {
      const me = (await call('tok-a', 'GET', '/auth/session')).body;
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [me.orgId, me.user.id]);
      await assert.rejects(client.query('UPDATE inspections SET score_pct = 100 WHERE id = $1', [id]), (e: any) => e.code === '55000');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [me.orgId, me.user.id]);
      await assert.rejects(
        client.query("INSERT INTO inspection_responses (org_id, inspection_id, question_id, value, updated_by) VALUES (app_org_id(), $1, 'q_new', '\"x\"', $2)", [id, me.user.id]),
        (e: any) => e.code === '55000');
      await client.query('ROLLBACK');
    } finally { client.release(); }

    // a second inspection pinned to v1 after v2 is published
    const second = await call('tok-a', 'POST', '/inspections', { templateId: t.body.template.id });
    const d = await call('tok-a', 'POST', `/templates/${t.body.template.id}/drafts`);
    const v2 = batchingPlantTemplate(); v2.pages = v2.pages.slice(0, 1);
    const sv = await call('tok-a', 'PUT', `/templates/${t.body.template.id}/draft`, { version: d.body.version.version, content: v2 });
    assert.equal((await call('tok-a', 'POST', `/templates/${t.body.template.id}/publish`, { version: sv.body.version.version })).status, 200);
    const reread = await call('tok-a', 'GET', `/inspections/${second.body.inspection.id}`);
    assert.equal(reread.body.inspection.templateVersionId, pub.body.version.id);
    const third = await call('tok-a', 'POST', '/inspections', { templateId: t.body.template.id });
    assert.notEqual(third.body.inspection.templateVersionId, pub.body.version.id);

    // cancel + list + timeline
    assert.equal((await call('tok-a', 'POST', `/inspections/${third.body.inspection.id}/cancel`)).body.inspection.status, 'cancelled');
    const list = await call('tok-a', 'GET', '/inspections?status=cancelled');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 1);
    assert.deepEqual((await call('tok-a', 'GET', `/inspections/${id}/timeline`)).body.items.map((e: any) => e.event), ['started', 'completed', 'action_created_from_flag', 'issue_created_from_flag']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('offline start against PostgreSQL: client-chosen id, safe replay, id collision across organizations, pinned version', { skip }, async () => {
  const server = createApi({
    verifier, store, work: new PgWorkRepo(pool), logger: { error: (m, e) => console.error(m, e) },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
  try {
    const t = await call('tok-a', 'POST', '/templates', { name: { en: 'Offline start' }, content: batchingPlantTemplate() });
    const pub = await call('tok-a', 'POST', `/templates/${t.body.template.id}/publish`, { version: t.body.draftVersion });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const v1 = pub.body.version.id as string;

    const first = await call('tok-a', 'POST', '/inspections', { id: CLIENT_ID, templateId: t.body.template.id, templateVersionId: v1, title: 'Offline round' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.inspection.id, CLIENT_ID);
    assert.equal(first.body.inspection.templateVersionId, v1);

    // the same request again (the first answer was lost): same row back, nothing duplicated
    const again = await call('tok-a', 'POST', '/inspections', { id: CLIENT_ID, templateId: t.body.template.id, templateVersionId: v1, title: 'Offline round' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.inspection.id, CLIENT_ID);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM inspections WHERE id = $1', [CLIENT_ID]);
    assert.equal(rows[0].n, 1);
    const timeline = (await call('tok-a', 'GET', `/inspections/${CLIENT_ID}/timeline`)).body.items.map((e: any) => e.event);
    assert.deepEqual(timeline, ['started'], 'a replay writes no second "started" event');

    // another organization using the same id: refused (ON CONFLICT), and it learns nothing
    const tb = await call('tok-b', 'POST', '/templates', { name: { en: 'Other org' }, content: batchingPlantTemplate() });
    assert.equal((await call('tok-b', 'POST', `/templates/${tb.body.template.id}/publish`, { version: tb.body.draftVersion })).status, 200);
    const clash = await call('tok-b', 'POST', '/inspections', { id: CLIENT_ID, templateId: tb.body.template.id });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal((await call('tok-b', 'GET', `/inspections/${CLIENT_ID}`)).status, 404, 'still invisible to the other organization');

    // a version that belongs to another template is refused
    const bad = await call('tok-a', 'POST', '/inspections', { id: '44444444-4444-4444-8444-444444444444', templateId: t.body.template.id, templateVersionId: tb.body.draftVersionId });
    assert.equal(bad.status, 422, JSON.stringify(bad.body));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('user management end-to-end against PostgreSQL (invitation, claim by verified e-mail, roles, sites, deactivation)', { skip }, async () => {
  // a verifier whose tokens carry an e-mail and its verification state, like Firebase ID tokens
  const accounts: Record<string, { uid: string; email: string; verified: boolean }> = {
    'tok-a': { uid: UID_A, email: 'a@example.com', verified: true },
    'tok-b': { uid: UID_B, email: 'b@example.com', verified: true },
    'tok-new': { uid: 'CI_NEW_PERSON_UID_000000003', email: 'invited.person@example.com', verified: false },
    'tok-stranger': { uid: 'CI_STRANGER_UID_00000000004', email: 'stranger@example.com', verified: true },
  };
  const emailVerifier: TokenVerifier = {
    async verify(token) {
      const a = accounts[token];
      if (!a) throw new Error('invalid');
      return { uid: a.uid, email: a.email, emailVerified: a.verified };
    },
  };
  const server = createApi({ verifier: emailVerifier, store, work: new PgWorkRepo(pool), logger: { error: (m, e) => console.error(m, e) } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const roles = (await call('tok-a', 'GET', '/roles')).body.items as { id: string; key: string }[];
    assert.ok(roles.length >= 5 && !roles.some((r) => r.key === 'super_admin'));
    const inspectorRole = roles.find((r) => r.key === 'inspector')!.id;
    const adminRole = roles.find((r) => r.key === 'org_admin')!.id;

    const site = (await call('tok-a', 'POST', '/sites', { name: `Plant ${Date.now()}` })).body.site.id as string;

    // only administrators manage users; the other organization cannot see these members or roles
    assert.deepEqual((await call('tok-b', 'GET', '/users')).body.members.map((m: any) => m.email), ['b@example.com']);
    assert.equal((await call('tok-b', 'POST', '/users/invitations', { email: 'x@example.com', fullName: 'X Y', roleId: inspectorRole })).status, 422, 'role of another organization');

    const inv = await call('tok-a', 'POST', '/users/invitations', { email: 'Invited.Person@Example.com', fullName: 'Invited Person', roleId: inspectorRole, siteIds: [site] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(inv.body.invitation.email, 'invited.person@example.com');
    assert.equal((await call('tok-a', 'POST', '/users/invitations', { email: 'invited.person@example.com', fullName: 'Dup Dup', roleId: inspectorRole })).body.code, 'already_invited');
    assert.equal((await call('tok-a', 'POST', '/users/invitations', { email: 'a@example.com', fullName: 'Admin Again', roleId: inspectorRole })).body.code, 'already_member');

    // first sign-in: an unverified e-mail cannot claim; a verified stranger gets nothing; the invited person gets in
    assert.equal((await call('tok-new', 'GET', '/auth/session')).body.code, 'email_not_verified');
    assert.equal((await call('tok-stranger', 'GET', '/auth/session')).body.code, 'forbidden');
    accounts['tok-new']!.verified = true;
    const session = await call('tok-new', 'GET', '/auth/session');
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(session.body.user.fullName, 'Invited Person');
    assert.deepEqual(session.body.siteIds, [site]);
    assert.equal(session.body.orgId, (await call('tok-a', 'GET', '/auth/session')).body.orgId);
    assert.equal((await call('tok-new', 'GET', '/users')).status, 403, 'an inspector cannot manage users');
    assert.equal((await call('tok-a', 'GET', '/users')).body.invitations.filter((i: any) => i.email === 'invited.person@example.com').length, 0, 'no longer pending');

    // role change applies at once; deactivation locks the person out; reactivation lets them back in
    const member = (await call('tok-a', 'GET', '/users')).body.members.find((m: any) => m.email === 'invited.person@example.com');
    const promoted = await call('tok-a', 'PATCH', `/users/${member.membershipId}`, { version: member.version, roleId: adminRole, siteIds: [] });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.member.roleKey, 'org_admin');
    assert.deepEqual(promoted.body.member.siteIds, []);
    assert.equal((await call('tok-new', 'GET', '/users')).status, 200, 'now an administrator');
    const off = await call('tok-a', 'PATCH', `/users/${member.membershipId}`, { version: promoted.body.member.version, status: 'inactive' });
    assert.equal(off.body.member.status, 'inactive');
    assert.equal((await call('tok-new', 'GET', '/auth/session')).status, 403);
    assert.equal((await call('tok-a', 'PATCH', `/users/${member.membershipId}`, { version: promoted.body.member.version, status: 'active' })).status, 409, 'stale version');

    // safety rules in the real database
    const me = (await call('tok-a', 'GET', '/users')).body.members.find((m: any) => m.email === 'a@example.com');
    assert.equal((await call('tok-a', 'PATCH', `/users/${me.membershipId}`, { version: me.version, status: 'inactive' })).body.code, 'cannot_modify_self');

    // revoke
    const inv2 = await call('tok-a', 'POST', '/users/invitations', { email: 'later@example.com', fullName: 'Later Person', roleId: inspectorRole });
    assert.equal((await call('tok-a', 'POST', `/users/invitations/${inv2.body.invitation.id}/revoke`)).body.invitation.status, 'revoked');
    assert.equal((await call('tok-b', 'POST', `/users/invitations/${inv2.body.invitation.id}/revoke`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('filters, dashboard counters and people picker against PostgreSQL', { skip }, async () => {
  const mk = (today: string) => createApi({
    verifier, store, work: new PgWorkRepo(pool), logger: { error: (m, e) => console.error(m, e) },
    clock: { now: () => new Date(`${today}T10:00:00Z`), today: () => today },
  });
  const early = mk('2026-10-03');
  const late = mk('2026-10-10');
  for (const s of [early, late]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const urlOf = (s: ReturnType<typeof mk>) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const call = async (s: ReturnType<typeof mk>, token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(urlOf(s) + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const me = (await call(early, 'tok-a', 'GET', '/auth/session')).body.user.id as string;
    const action = await call(early, 'tok-a', 'POST', '/actions', { title: 'Fix the guard', type: 'corrective', priority: 'high', dueDate: '2026-10-05', assigneeId: me });
    assert.equal(action.status, 201, JSON.stringify(action.body));
    const issue = await call(early, 'tok-a', 'POST', '/issues', { title: 'Loose cable', type: 'hazard', priority: 'medium', dueDate: '2026-10-05' });
    assert.equal(issue.status, 201, JSON.stringify(issue.body));
    const has = (r: { body: any }, id: string) => r.body.items.some((x: any) => x.id === id);

    assert.ok(has(await call(early, 'tok-a', 'GET', '/actions?mine=1'), action.body.id), 'assigned to me');
    assert.ok(!has(await call(early, 'tok-b', 'GET', '/actions?mine=1'), action.body.id), 'other organization');
    assert.ok(!has(await call(early, 'tok-a', 'GET', '/actions?overdue=1'), action.body.id), 'not overdue on the 3rd');
    assert.ok(has(await call(late, 'tok-a', 'GET', '/actions?overdue=1'), action.body.id), 'overdue on the 10th');
    assert.ok(has(await call(late, 'tok-a', 'GET', '/issues?overdue=1'), issue.body.id));
    assert.ok(!has(await call(late, 'tok-a', 'GET', '/actions?overdue=1&status=completed'), action.body.id));
    assert.equal((await call(late, 'tok-a', 'GET', '/actions?overdue=1&mine=1&status=todo&limit=5')).status, 200);

    const dash = (await call(late, 'tok-a', 'GET', '/dashboard')).body;
    assert.ok(dash.actions.overdue >= 1 && dash.actions.mine >= 1 && dash.issues.overdue >= 1, JSON.stringify(dash));
    assert.ok(dash.actions.byStatus.todo >= 1);
    assert.notEqual(dash.inspections, null);
    const dashB = (await call(late, 'tok-b', 'GET', '/dashboard')).body;
    assert.equal(dashB.actions.overdue, 0, 'the other organization sees its own numbers only');
    assert.equal(dashB.actions.mine, 0);

    const people = (await call(early, 'tok-a', 'GET', '/people')).body.items.map((p: any) => p.fullName);
    assert.ok(people.includes('Admin A') && !people.includes('Admin B'));
  } finally {
    for (const s of [early, late]) await new Promise((r) => s.close(r));
  }
});

test('media against PostgreSQL and a real folder: upload, download, signatures, report, soft delete, isolation', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mthse-it-media-'));
  const server = createApi({
    verifier, store, work: new PgWorkRepo(pool), blobs: new DiskBlobStore(root), logger: { error: (m, e) => console.error(m, e) },
    clock: { now: () => new Date(), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const upload = async (token: string, query: Record<string, string>, bytes: Buffer, type: string) => {
    const res = await fetch(`${base}/media?${new URLSearchParams(query)}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: new Uint8Array(bytes) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('integration-test-photo-bytes')]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('integration-signature')]);
  try {
    const content = { pages: [{ id: 'p', title: { en: 'P' }, items: [
      { kind: 'question', id: 'q_photo', title: { en: 'Photo' }, responseType: 'photo' },
      { kind: 'question', id: 'q_note', title: { en: 'Note' }, responseType: 'text', required: true },
    ] }] };
    const t = await json('tok-a', 'POST', '/templates', { name: { en: 'Media IT' }, content });
    assert.equal((await json('tok-a', 'POST', `/templates/${t.body.template.id}/publish`, { version: t.body.draftVersion })).status, 200);
    const insp = (await json('tok-a', 'POST', '/inspections', { templateId: t.body.template.id })).body.inspection.id as string;

    const up = await upload('tok-a', { ownerType: 'inspection', ownerId: insp, kind: 'photo', questionId: 'q_photo', caption: 'Test photo', lat: '30.04', lng: '31.23' }, JPEG, 'image/jpeg');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const m = up.body.media;
    assert.equal(m.storageKey, undefined);
    assert.equal(readdirSync(join(root)).length, 1, 'the file is on disk under the organization folder');

    const dl = await fetch(`${base}/media/${m.id}`, { headers: { authorization: 'Bearer tok-a' } });
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), JPEG);
    assert.equal(dl.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${base}/media/${m.id}`, { headers: { authorization: 'Bearer tok-b' } })).status, 404, 'other organization');
    assert.equal((await upload('tok-b', { ownerType: 'inspection', ownerId: insp, kind: 'photo', questionId: 'q_photo' }, JPEG, 'image/jpeg')).status, 404);
    assert.equal((await upload('tok-a', { ownerType: 'inspection', ownerId: insp, kind: 'photo', questionId: 'q_photo' }, Buffer.from('<script>x</script>........'), 'image/jpeg')).status, 422);

    // signature + answers + completion + report with the real bytes
    const sig = (await upload('tok-a', { ownerType: 'inspection', ownerId: insp, kind: 'signature' }, PNG, 'image/png')).body.media;
    const signed = await json('tok-a', 'POST', `/inspections/${insp}/signatures`, { mediaId: sig.id, signerName: 'Admin A', signerRole: 'Inspector' });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.equal((await json('tok-a', 'POST', `/inspections/${insp}/signatures`, { mediaId: sig.id, signerName: 'Again Again' })).status, 409);
    await json('tok-a', 'PUT', `/inspections/${insp}/responses/q_note`, { value: 'fine', baseVersion: 0 });
    assert.equal((await json('tok-a', 'PUT', `/inspections/${insp}/responses/q_photo`, { value: [m.id], baseVersion: 0 })).status, 200);
    assert.equal((await json('tok-a', 'POST', `/inspections/${insp}/complete`)).status, 200);
    const rep = await fetch(`${base}/inspections/${insp}/report?lang=en`, { headers: { authorization: 'Bearer tok-a' } });
    const html = await rep.text();
    assert.equal(rep.status, 200, html.slice(0, 300));
    assert.ok(html.includes(`data:image/jpeg;base64,${JPEG.toString('base64')}`) && html.includes('<img class="sign"') && html.includes('alt="Test photo"'));

    // a finished inspection keeps its photos
    assert.equal((await json('tok-a', 'DELETE', `/media/${m.id}`)).body.code, 'not_editable');
    assert.equal((await json('tok-a', 'DELETE', `/media/${sig.id}`)).status, 403);

    // soft delete while editable
    const insp2 = (await json('tok-a', 'POST', '/inspections', { templateId: t.body.template.id })).body.inspection.id as string;
    const p2 = (await upload('tok-a', { ownerType: 'inspection', ownerId: insp2, kind: 'photo', questionId: 'q_photo' }, JPEG, 'image/jpeg')).body.media;
    assert.equal((await json('tok-a', 'DELETE', `/media/${p2.id}`)).status, 200);
    assert.equal((await fetch(`${base}/media/${p2.id}`, { headers: { authorization: 'Bearer tok-a' } })).status, 404);
    assert.deepEqual((await json('tok-a', 'GET', `/media?ownerType=inspection&ownerId=${insp2}`)).body.items, []);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('notifications against PostgreSQL: assignment, privacy (row security), read, overdue sweep', { skip }, async () => {
  const accounts: Record<string, { uid: string; email: string }> = {
    'tok-a': { uid: UID_A, email: 'a@example.com' },
    'tok-b': { uid: UID_B, email: 'b@example.com' },
    'tok-c': { uid: 'CI_NOTIF_PERSON_UID_00000005', email: 'notif.person@example.com' },
  };
  const emailVerifier: TokenVerifier = {
    async verify(token) { const a = accounts[token]; if (!a) throw new Error('invalid'); return { uid: a.uid, email: a.email, emailVerified: true }; },
  };
  const work = new PgWorkRepo(pool);
  const server = createApi({ verifier: emailVerifier, store, work, logger: { error: (m, e) => console.error(m, e) }, clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const roles = (await call('tok-a', 'GET', '/roles')).body.items as { id: string; key: string }[];
    const inv = await call('tok-a', 'POST', '/users/invitations', { email: 'notif.person@example.com', fullName: 'Notified Person', roleId: roles.find((r) => r.key === 'inspector')!.id });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const personId = (await call('tok-c', 'GET', '/auth/session')).body.user.id as string;

    const title = `Replace the guard ${Date.now()}`;
    const action = await call('tok-a', 'POST', '/actions', { title, type: 'corrective', priority: 'high', dueDate: '2026-10-05', assigneeId: personId });
    assert.equal(action.status, 201, JSON.stringify(action.body));

    // the assignee is notified; the assigner is not; the other organization sees nothing
    const inbox = (await call('tok-c', 'GET', '/notifications')).body.items as any[];
    const mine = inbox.find((n) => n.type === 'action_assigned' && n.entityId === action.body.id);
    assert.ok(mine, JSON.stringify(inbox));
    assert.equal(mine.data.entityTitle, title);
    assert.equal(mine.data.actorName.length > 0, true);
    assert.equal(mine.readAt, null);
    const countC = (await call('tok-c', 'GET', '/notifications/unread-count')).body.count as number;
    assert.ok(countC >= 1);
    assert.ok(!(await call('tok-a', 'GET', '/notifications')).body.items.some((n: any) => n.entityId === action.body.id), 'the assigner has no notification about it');
    assert.deepEqual((await call('tok-b', 'GET', '/notifications')).body.items.filter((n: any) => n.entityId === action.body.id), []);

    // row security: another person cannot mark it as read, the owner can
    assert.equal((await call('tok-a', 'POST', '/notifications/read', { ids: [mine.id] })).body.changed, 0);
    const read = await call('tok-c', 'POST', '/notifications/read', { ids: [mine.id] });
    assert.equal(read.body.changed, 1);
    assert.equal(read.body.unread, countC - 1);

    // comment from the assignee reaches the owner
    assert.equal((await call('tok-c', 'POST', `/actions/${action.body.id}/comments`, { body: 'Ordered the parts' })).status, 201);
    const ownerInbox = (await call('tok-a', 'GET', '/notifications?unread=1')).body.items as any[];
    assert.ok(ownerInbox.some((n) => n.type === 'comment_added' && n.entityId === action.body.id));

    // overdue sweep (database function across organizations): once per item
    const first = await work.sweepOverdue('2026-12-31');
    assert.ok(first >= 1, `the late action must be found, got ${first}`);
    assert.equal(await work.sweepOverdue('2026-12-31'), 0, 'idempotent');
    const overdue = (await call('tok-c', 'GET', '/notifications')).body.items.find((n: any) => n.type === 'action_overdue' && n.entityId === action.body.id);
    assert.ok(overdue);
    assert.equal(overdue.actorUserId, null);
    assert.equal(overdue.data.dueDate, '2026-10-05');

    assert.equal((await call('tok-c', 'POST', '/notifications/read', { all: true })).body.unread, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
