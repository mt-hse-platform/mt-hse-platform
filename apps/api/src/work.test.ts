import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const ORG_B = '00000000-0000-0000-0000-00000000bbbb';
const SITE_A = '00000000-0000-0000-0000-0000000051a1';
const SITE_X = '00000000-0000-0000-0000-0000000051b2';

type U = { id: string; org: string; role: RoleKey; sites: string[] };
const USERS: Record<string, U> = {
  manager:    { id: '00000000-0000-0000-0000-000000000001', org: ORG_A, role: 'hse_manager', sites: [] },
  supervisor: { id: '00000000-0000-0000-0000-000000000002', org: ORG_A, role: 'supervisor', sites: [SITE_A] },
  employee:   { id: '00000000-0000-0000-0000-000000000003', org: ORG_A, role: 'employee', sites: [SITE_A] },
  employee2:  { id: '00000000-0000-0000-0000-000000000004', org: ORG_A, role: 'employee', sites: [SITE_A] },
  viewer:     { id: '00000000-0000-0000-0000-000000000005', org: ORG_A, role: 'viewer', sites: [SITE_A] },
  inspector:  { id: '00000000-0000-0000-0000-000000000006', org: ORG_A, role: 'inspector', sites: [SITE_A] },
  managerB:   { id: '00000000-0000-0000-0000-000000000007', org: ORG_B, role: 'hse_manager', sites: [] },
};

const verifier: TokenVerifier = {
  async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); },
};
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) {
    const u = USERS[uid];
    return u ? [{ userId: u.id, orgId: u.org, membershipId: `m-${uid}`, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : [];
  },
  async loadUser(m) { return { fullName: m.userId, email: `${m.userId}@x.com`, locale: 'ar' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds(m) { return USERS[m.roleId]!.sites; },
};

async function run(fn: (c: Client, repo: MemoryWorkRepo, clock: { today: string }) => Promise<void>) {
  const repo = new MemoryWorkRepo();
  for (const u of Object.values(USERS)) repo.addMember(u.org, u.id);
  const clock = { today: '2026-10-03' };
  const server = createApi({
    verifier, store, work: repo, logger: { error: () => undefined },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => clock.today },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client: Client = async (who, method, path, body, raw) => {
    const res = await fetch(base + path, {
      method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn(client, repo, clock); } finally { await new Promise((r) => server.close(r)); }
}
type Client = (who: string | null, method: string, path: string, body?: unknown, raw?: string) => Promise<{ status: number; body: any }>;

const issueBody = (over = {}) => ({ title: 'Leaking hose', type: 'hazard', priority: 'high', ...over });
const actionBody = (over = {}) => ({ title: 'Replace hose', type: 'corrective', priority: 'high', ...over });

test('requires authentication', async () => {
  await run(async (c) => {
    assert.equal((await c(null, 'GET', '/issues')).status, 401);
    assert.equal((await c(null, 'POST', '/actions', actionBody())).status, 401);
  });
});

test('create issue: 201, defaults, timeline "created"; validation and bad JSON are reported safely', async () => {
  await run(async (c) => {
    const r = await c('manager', 'POST', '/issues', issueBody({ siteId: SITE_A, dueDate: '2026-10-10' }));
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'open');
    assert.equal(r.body.reporterId, USERS.manager!.id);
    assert.equal(r.body.overdue, false);
    const tl = await c('manager', 'GET', `/issues/${r.body.id}/timeline`);
    assert.deepEqual(tl.body.items.map((e: any) => e.event), ['created']);

    const bad = await c('manager', 'POST', '/issues', { title: 'x', type: 'nope', priority: '', dueDate: '2026-10-01' });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'validation');
    assert.deepEqual(Object.keys(bad.body.errors).sort(), ['dueDate', 'priority', 'title', 'type']);

    assert.equal((await c('manager', 'POST', '/issues', undefined, '{not json')).status, 400);
    assert.equal((await c('manager', 'POST', '/issues', [1, 2])).status, 400);
  });
});

test('who can create: employee yes, viewer no', async () => {
  await run(async (c) => {
    assert.equal((await c('employee', 'POST', '/issues', issueBody())).status, 201);
    assert.equal((await c('viewer', 'POST', '/issues', issueBody())).status, 403);
  });
});

test('visibility: employee sees only own issues, supervisor sees their site, other org sees nothing', async () => {
  await run(async (c) => {
    const own = (await c('employee', 'POST', '/issues', issueBody({ title: 'Mine' }))).body;
    const other = (await c('employee2', 'POST', '/issues', issueBody({ title: 'Theirs' }))).body;
    const onSite = (await c('manager', 'POST', '/issues', issueBody({ title: 'On site', siteId: SITE_A }))).body;
    const elsewhere = (await c('manager', 'POST', '/issues', issueBody({ title: 'Elsewhere', siteId: SITE_X }))).body;

    const titles = async (who: string) => (await c(who, 'GET', '/issues')).body.items.map((i: any) => i.title).sort();
    assert.deepEqual(await titles('employee'), ['Mine']);
    assert.deepEqual(await titles('supervisor'), ['On site']);
    assert.deepEqual(await titles('manager'), ['Elsewhere', 'Mine', 'On site', 'Theirs']);
    assert.deepEqual(await titles('managerB'), []);

    assert.equal((await c('employee', 'GET', `/issues/${other.id}`)).status, 404, 'someone else issue is hidden');
    assert.equal((await c('employee', 'GET', `/issues/${own.id}`)).status, 200);
    assert.equal((await c('managerB', 'GET', `/issues/${onSite.id}`)).status, 404, 'cross-org is hidden');
    assert.equal((await c('supervisor', 'GET', `/issues/${elsewhere.id}`)).status, 404);
  });
});

test('issue lifecycle: assignment rules, transitions, optimistic locking, timeline with old/new values', async () => {
  await run(async (c) => {
    const i = (await c('manager', 'POST', '/issues', issueBody({ siteId: SITE_A }))).body;

    // assigned needs an assignee
    assert.deepEqual((await c('manager', 'PATCH', `/issues/${i.id}`, { version: 1, status: 'assigned' })).body.code, 'missing_assignee');
    // assignee must be a member of the org
    const ghost = '00000000-0000-0000-0000-00000000dead';
    assert.equal((await c('manager', 'PATCH', `/issues/${i.id}`, { version: 1, assigneeId: ghost })).body.errors.assigneeId[0].code, 'invalid_reference');

    const a = await c('manager', 'PATCH', `/issues/${i.id}`, { version: 1, assigneeId: USERS.supervisor!.id, status: 'assigned' });
    assert.equal(a.status, 200);
    assert.equal(a.body.status, 'assigned');
    assert.equal(a.body.version, 2);

    // stale version => conflict
    assert.equal((await c('manager', 'PATCH', `/issues/${i.id}`, { version: 1, priority: 'low' })).status, 409);
    // invalid jump
    assert.equal((await c('manager', 'PATCH', `/issues/${i.id}`, { version: 2, status: 'closed' })).body.code, 'invalid_transition');
    // unknown field
    assert.equal((await c('manager', 'PATCH', `/issues/${i.id}`, { version: 2, reporterId: USERS.viewer!.id })).body.errors.reporterId[0].code, 'unknown_field');
    // no-op does not bump version
    assert.equal((await c('manager', 'PATCH', `/issues/${i.id}`, { version: 2, priority: 'high' })).body.version, 2);

    await c('manager', 'PATCH', `/issues/${i.id}`, { version: 2, status: 'in_progress' });
    await c('manager', 'PATCH', `/issues/${i.id}`, { version: 3, status: 'resolved' });
    const closed = await c('manager', 'PATCH', `/issues/${i.id}`, { version: 4, status: 'closed' });
    assert.equal(closed.body.status, 'closed');

    const tl = (await c('manager', 'GET', `/issues/${i.id}/timeline`)).body.items;
    assert.deepEqual(tl.map((e: any) => `${e.event}:${e.field}`), [
      'created:null',
      'status_changed:status', 'assigned:assigneeId', // first PATCH changed both
      'status_changed:status', 'status_changed:status', 'status_changed:status',
    ]);
    const first = tl.find((e: any) => e.field === 'assigneeId');
    assert.equal(first.oldValue, null);
    assert.equal(first.newValue, USERS.supervisor!.id);
    assert.equal(tl.every((e: any) => e.actorUserId === USERS.manager!.id), true);
  });
});

test('permissions on edit: reporter employee cannot edit; supervisor edits within site only', async () => {
  await run(async (c) => {
    const mine = (await c('employee', 'POST', '/issues', issueBody({ siteId: SITE_A }))).body;
    assert.equal((await c('employee', 'PATCH', `/issues/${mine.id}`, { version: 1, title: 'Changed by me' })).status, 403);
    assert.equal((await c('supervisor', 'PATCH', `/issues/${mine.id}`, { version: 1, title: 'Changed by sup' })).status, 200);
    const far = (await c('manager', 'POST', '/issues', issueBody({ siteId: SITE_X }))).body;
    assert.equal((await c('supervisor', 'PATCH', `/issues/${far.id}`, { version: 1, title: 'Nope nope' })).status, 404);
  });
});

test('pagination walks all items once, newest first', async () => {
  await run(async (c) => {
    for (let n = 1; n <= 5; n++) await c('manager', 'POST', '/issues', issueBody({ title: `Issue ${n}` }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { status: number; body: any } = await c('manager', 'GET', `/issues?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map((i: any) => i.title));
      cursor = r.body.nextCursor; pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['Issue 5', 'Issue 4', 'Issue 3', 'Issue 2', 'Issue 1']);
    assert.equal((await c('manager', 'GET', '/issues?limit=500')).status, 422);
    assert.equal((await c('manager', 'GET', '/issues?status=weird')).status, 422);
    assert.equal((await c('manager', 'GET', '/issues?cursor=evil')).status, 422);
  });
});

test('action lifecycle: assignee works it, cannot cancel, completion is stamped, self-verification blocked', async () => {
  await run(async (c, _repo, clock) => {
    const issue = (await c('manager', 'POST', '/issues', issueBody({ siteId: SITE_A }))).body;
    const a = await c('manager', 'POST', '/actions', actionBody({ siteId: SITE_A, issueId: issue.id, assigneeId: USERS.employee!.id, dueDate: '2026-10-10' }));
    assert.equal(a.status, 201);
    assert.equal(a.body.status, 'todo');
    const id = a.body.id;

    assert.equal((await c('employee', 'PATCH', `/actions/${id}`, { version: 1, status: 'in_progress' })).status, 200);
    assert.equal((await c('employee', 'PATCH', `/actions/${id}`, { version: 2, status: 'cancelled' })).status, 403);
    assert.equal((await c('employee', 'PATCH', `/actions/${id}`, { version: 2, title: 'Renamed by me' })).status, 403);
    assert.equal((await c('employee2', 'GET', `/actions/${id}`)).status, 404, 'unrelated employee cannot see it');
    assert.equal((await c('employee', 'PATCH', `/actions/${id}`, { version: 2, status: 'pending_verification' })).status, 200);

    // overdue is derived from the clock
    clock.today = '2026-10-20';
    assert.equal((await c('employee', 'GET', `/actions/${id}`)).body.effectiveStatus, 'overdue');
    clock.today = '2026-10-03';

    // a supervisor who is also the assignee cannot verify own work; a different supervisor-level user can
    const own = (await c('manager', 'POST', '/actions', actionBody({ siteId: SITE_A, assigneeId: USERS.supervisor!.id }))).body;
    await c('supervisor', 'PATCH', `/actions/${own.id}`, { version: 1, status: 'in_progress' });
    await c('supervisor', 'PATCH', `/actions/${own.id}`, { version: 2, status: 'pending_verification' });
    assert.equal((await c('supervisor', 'PATCH', `/actions/${own.id}`, { version: 3, status: 'completed' })).body.code, 'self_verification');

    const done = await c('supervisor', 'PATCH', `/actions/${id}`, { version: 3, status: 'completed' });
    assert.equal(done.status, 200);
    assert.equal(done.body.completedAt, '2026-10-03T10:00:00.000Z');
    const reopened = await c('manager', 'PATCH', `/actions/${id}`, { version: 4, status: 'in_progress' });
    assert.equal(reopened.body.completedAt, null);
  });
});

test('action: assigning requires action.assign; issue link must be visible; inspector cannot assign', async () => {
  await run(async (c) => {
    assert.equal((await c('inspector', 'POST', '/actions', actionBody({ assigneeId: USERS.employee!.id }))).status, 403);
    assert.equal((await c('inspector', 'POST', '/actions', actionBody())).status, 201);
    const hidden = (await c('manager', 'POST', '/issues', issueBody({ siteId: SITE_X }))).body;
    const r = await c('supervisor', 'POST', '/actions', actionBody({ issueId: hidden.id }));
    assert.equal(r.status, 422);
    assert.equal(r.body.errors.issueId[0].code, 'invalid_reference');
  });
});

test('comments: add, reply, list; parent must belong to the same action; timeline logs it', async () => {
  await run(async (c) => {
    const a1 = (await c('manager', 'POST', '/actions', actionBody({ siteId: SITE_A, assigneeId: USERS.employee!.id }))).body;
    const a2 = (await c('manager', 'POST', '/actions', actionBody({ siteId: SITE_A }))).body;
    const c1 = await c('employee', 'POST', `/actions/${a1.id}/comments`, { body: 'Parts ordered' });
    assert.equal(c1.status, 201);
    assert.equal((await c('manager', 'POST', `/actions/${a1.id}/comments`, { body: 'Thanks', parentId: c1.body.id })).status, 201);
    assert.equal((await c('manager', 'POST', `/actions/${a2.id}/comments`, { body: 'Cross', parentId: c1.body.id })).body.errors.parentId[0].code, 'invalid_reference');
    assert.equal((await c('manager', 'POST', `/actions/${a1.id}/comments`, { body: '   ' })).status, 422);
    assert.equal((await c('employee2', 'POST', `/actions/${a1.id}/comments`, { body: 'Not mine' })).status, 404);
    const list = await c('employee', 'GET', `/actions/${a1.id}/comments`);
    assert.deepEqual(list.body.items.map((x: any) => x.body), ['Parts ordered', 'Thanks']);
    const tl = (await c('manager', 'GET', `/actions/${a1.id}/timeline`)).body.items;
    assert.equal(tl.filter((e: any) => e.event === 'comment_added').length, 2);
  });
});

test('unknown work routes and malformed ids are 404', async () => {
  await run(async (c) => {
    assert.equal((await c('manager', 'GET', '/issues/not-a-uuid')).status, 404);
    assert.equal((await c('manager', 'DELETE', '/issues/00000000-0000-0000-0000-000000000009')).status, 404);
    assert.equal((await c('manager', 'GET', '/issues/00000000-0000-0000-0000-000000000009')).status, 404);
  });
});
