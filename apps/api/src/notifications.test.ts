import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { runSweepOnce } from './sweeper.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const ORG_B = '00000000-0000-0000-0000-00000000bbbb';
const SITE_A = '00000000-0000-0000-0000-0000000051a1';
const USERS: Record<string, { id: string; org: string; role: RoleKey; sites: string[]; name: string }> = {
  manager:  { id: '00000000-0000-0000-0000-000000000001', org: ORG_A, role: 'hse_manager', sites: [], name: 'Manager Mona' },
  worker:   { id: '00000000-0000-0000-0000-000000000003', org: ORG_A, role: 'employee', sites: [SITE_A], name: 'Worker Wael' },
  worker2:  { id: '00000000-0000-0000-0000-000000000004', org: ORG_A, role: 'employee', sites: [SITE_A], name: 'Worker Walid' },
  managerB: { id: '00000000-0000-0000-0000-000000000007', org: ORG_B, role: 'hse_manager', sites: [], name: 'Other Org' },
};
const verifier: TokenVerifier = { async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); } };
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) { const u = USERS[uid]; return u ? [{ userId: u.id, orgId: u.org, membershipId: uid, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : []; },
  async loadUser(m) { const u = USERS[m.roleId]!; return { fullName: u.name, email: 'x@x.com', locale: 'en' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds(m) { return USERS[m.roleId]!.sites; },
};

type Client = (who: string | null, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function run(fn: (c: Client, repo: MemoryWorkRepo) => Promise<void>) {
  const repo = new MemoryWorkRepo();
  for (const u of Object.values(USERS)) repo.addMember(u.org, u.id);
  const server = createApi({ verifier, store, work: repo, logger: { error: () => undefined }, clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c: Client = async (who, method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn(c, repo); } finally { await new Promise((r) => server.close(r)); }
}

const ACTION = { type: 'corrective', priority: 'high' };
const ISSUE = { type: 'hazard', priority: 'medium' };
const inbox = async (c: Client, who: string, qs = '') => (await c(who, 'GET', `/notifications${qs}`)).body.items as any[];
const unread = async (c: Client, who: string) => (await c(who, 'GET', '/notifications/unread-count')).body.count as number;

test('assigning an action notifies the assignee (not the person who assigned it, not oneself)', async () => {
  await run(async (c) => {
    const a = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Fix the guard', assigneeId: USERS.worker!.id })).body;
    assert.equal(await unread(c, 'worker'), 1);
    assert.equal(await unread(c, 'manager'), 0, 'the person who assigned is not notified');
    const [n] = await inbox(c, 'worker');
    assert.equal(n.type, 'action_assigned');
    assert.equal(n.entityType, 'action');
    assert.equal(n.entityId, a.id);
    assert.deepEqual(n.data, { entityTitle: 'Fix the guard', actorName: 'Manager Mona' });
    assert.equal(n.actorUserId, USERS.manager!.id);
    assert.equal(n.readAt, null);

    await c('manager', 'POST', '/actions', { ...ACTION, title: 'My own task', assigneeId: USERS.manager!.id });
    assert.equal(await unread(c, 'manager'), 0, 'assigning to yourself is not news');
    await c('manager', 'POST', '/actions', { ...ACTION, title: 'Unassigned task' });
    assert.equal(await unread(c, 'worker2'), 0);
  });
});

test('re-assigning notifies only the new assignee; unchanged or cleared assignment notifies nobody', async () => {
  await run(async (c) => {
    const a = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Move me' })).body;
    await c('manager', 'PATCH', `/actions/${a.id}`, { version: 1, assigneeId: USERS.worker!.id });
    assert.equal(await unread(c, 'worker'), 1);
    await c('manager', 'PATCH', `/actions/${a.id}`, { version: 2, assigneeId: USERS.worker!.id, priority: 'low' });
    assert.equal(await unread(c, 'worker'), 1, 'same assignee again: no repeat');
    await c('manager', 'PATCH', `/actions/${a.id}`, { version: 3, assigneeId: USERS.worker2!.id });
    assert.equal(await unread(c, 'worker2'), 1);
    assert.equal(await unread(c, 'worker'), 1, 'the previous assignee is not spammed');
    await c('manager', 'PATCH', `/actions/${a.id}`, { version: 4, assigneeId: null });
    assert.equal(await unread(c, 'worker2'), 1, 'un-assigning notifies nobody');
  });
});

test('issues: assignment at creation and by edit', async () => {
  await run(async (c) => {
    const i = (await c('manager', 'POST', '/issues', { ...ISSUE, title: 'Loose cable', assigneeId: USERS.worker!.id })).body;
    const [n] = await inbox(c, 'worker');
    assert.equal(n.type, 'issue_assigned'); assert.equal(n.entityId, i.id); assert.equal(n.data.entityTitle, 'Loose cable');
    const j = (await c('manager', 'POST', '/issues', { ...ISSUE, title: 'Slippery floor' })).body;
    await c('manager', 'PATCH', `/issues/${j.id}`, { version: 1, assigneeId: USERS.worker2!.id });
    assert.equal((await inbox(c, 'worker2'))[0].type, 'issue_assigned');
  });
});

test('submitting work for verification notifies the owner of the action', async () => {
  await run(async (c) => {
    const a = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Replace pipe', assigneeId: USERS.worker!.id })).body;
    await c('worker', 'PATCH', `/actions/${a.id}`, { version: 1, status: 'in_progress' });
    assert.equal(await unread(c, 'manager'), 0, 'starting work is not worth a notification');
    await c('worker', 'PATCH', `/actions/${a.id}`, { version: 2, status: 'pending_verification' });
    const [n] = await inbox(c, 'manager');
    assert.equal(n.type, 'action_pending_verification');
    assert.deepEqual(n.data, { entityTitle: 'Replace pipe', actorName: 'Worker Wael' });
  });
});

test('comments notify the other people involved, once each, never the author', async () => {
  await run(async (c) => {
    const a = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Discuss me', assigneeId: USERS.worker!.id })).body;
    await c('worker', 'POST', `/actions/${a.id}/comments`, { body: 'Parts ordered' });
    assert.equal(await unread(c, 'manager'), 1, 'the owner hears the assignee');
    assert.equal(await unread(c, 'worker'), 1, 'only the earlier assignment notification');
    await c('manager', 'POST', `/actions/${a.id}/comments`, { body: 'Thanks' });
    assert.equal(await unread(c, 'worker'), 2, 'the assignee hears the owner');
    assert.equal(await unread(c, 'manager'), 1);
    assert.equal(await unread(c, 'worker2'), 0, 'an unrelated colleague hears nothing');
    const types = (await inbox(c, 'worker')).map((x) => x.type).sort();
    assert.deepEqual(types, ['action_assigned', 'comment_added']);
  });
});

test('notifications are strictly personal; reading marks only your own', async () => {
  await run(async (c) => {
    await c('manager', 'POST', '/actions', { ...ACTION, title: 'For Wael', assigneeId: USERS.worker!.id });
    await c('manager', 'POST', '/actions', { ...ACTION, title: 'For Walid', assigneeId: USERS.worker2!.id });
    assert.deepEqual((await inbox(c, 'worker')).map((x) => x.data.entityTitle), ['For Wael']);
    assert.deepEqual((await inbox(c, 'managerB')), []);
    const mine = (await inbox(c, 'worker'))[0].id;

    const theirs = (await inbox(c, 'worker2'))[0].id;
    const r1 = await c('worker', 'POST', '/notifications/read', { ids: [theirs] });
    assert.equal(r1.body.changed, 0, 'cannot mark someone else\'s notification');
    assert.equal(await unread(c, 'worker2'), 1);

    const r2 = await c('worker', 'POST', '/notifications/read', { ids: [mine] });
    assert.deepEqual(r2.body, { changed: 1, unread: 0 });
    assert.equal((await inbox(c, 'worker'))[0].readAt !== null, true);
    assert.deepEqual(await inbox(c, 'worker', '?unread=1'), []);
    assert.equal((await c('worker', 'POST', '/notifications/read', { ids: [mine] })).body.changed, 0, 'already read');
  });
});

test('mark everything as read, validation, pagination and authentication', async () => {
  await run(async (c) => {
    for (let n = 0; n < 5; n++) await c('manager', 'POST', '/actions', { ...ACTION, title: `Task ${n}`, assigneeId: USERS.worker!.id });
    assert.equal(await unread(c, 'worker'), 5);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { body: any } = await c('worker', 'GET', `/notifications?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.body.items.map((x: any) => x.data.entityTitle)); cursor = r.body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ['Task 4', 'Task 3', 'Task 2', 'Task 1', 'Task 0'], 'newest first, no duplicates');

    assert.deepEqual((await c('worker', 'POST', '/notifications/read', { all: true })).body, { changed: 5, unread: 0 });
    assert.equal((await c('worker', 'POST', '/notifications/read', {})).status, 422);
    assert.equal((await c('worker', 'POST', '/notifications/read', { ids: ['nope'] })).status, 422);
    assert.equal((await c('worker', 'POST', '/notifications/read', { ids: [] })).status, 422);
    assert.equal((await c('worker', 'POST', '/notifications/read', { all: true, ids: [] })).status, 422);
    assert.equal((await c('worker', 'POST', '/notifications/read', { all: true, x: 1 })).body.errors.x[0].code, 'unknown_field');
    assert.equal((await c('worker', 'GET', '/notifications?unread=2')).status, 422);
    assert.equal((await c('worker', 'GET', '/notifications?limit=500')).status, 422);
    assert.equal((await c(null, 'GET', '/notifications')).status, 401);
    assert.equal((await c(null, 'GET', '/notifications/unread-count')).status, 401);
  });
});

test('overdue sweep: once per item, only open assigned items, only active people', async () => {
  await run(async (c, repo) => {
    const late = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Late', dueDate: '2026-10-03', assigneeId: USERS.worker!.id })).body;
    const later = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Not yet', dueDate: '2026-10-20', assigneeId: USERS.worker!.id })).body;
    const done = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Finished', dueDate: '2026-10-03', assigneeId: USERS.worker!.id })).body;
    await c('manager', 'POST', '/actions', { ...ACTION, title: 'Nobody', dueDate: '2026-10-03' });
    const issue = (await c('manager', 'POST', '/issues', { ...ISSUE, title: 'Late issue', dueDate: '2026-10-03', assigneeId: USERS.worker2!.id })).body;
    for (const id of [late.id, done.id]) repo.actions.find((x) => x.id === id)!.dueDate = '2026-10-01';
    repo.issues.find((x) => x.id === issue.id)!.dueDate = '2026-10-02';
    await c('manager', 'PATCH', `/actions/${done.id}`, { version: 1, status: 'in_progress' });
    await c('manager', 'PATCH', `/actions/${done.id}`, { version: 2, status: 'completed' });
    void later;

    const clock = { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' };
    const logged: unknown[] = [];
    assert.equal(await runSweepOnce(repo, clock, { error: (...a) => logged.push(a) }), 2, 'one action and one issue');
    assert.equal(await runSweepOnce(repo, clock, { error: () => undefined }), 0, 'running again creates nothing');
    assert.equal(await runSweepOnce(repo, { ...clock, today: () => '2026-10-15' }, { error: () => undefined }), 0, 'and not again on later days');

    const w = (await inbox(c, 'worker')).filter((x) => x.type === 'action_overdue');
    assert.deepEqual(w.map((x) => x.data), [{ entityTitle: 'Late', dueDate: '2026-10-01' }]);
    assert.equal(w[0].actorUserId, null, 'automatic: no actor');
    assert.equal((await inbox(c, 'worker2')).filter((x) => x.type === 'issue_overdue').length, 1);
    assert.deepEqual(logged, []);

    // an item that becomes overdue later is picked up by the next sweep
    repo.actions.find((x) => x.id === later.id)!.dueDate = '2026-10-10';
    assert.equal(await runSweepOnce(repo, { ...clock, today: () => '2026-10-15' }, { error: () => undefined }), 1);
  });
});

test('a failing sweep is logged and never throws', async () => {
  const repo = new MemoryWorkRepo();
  repo.sweepOverdue = async () => { throw new Error('database down'); };
  const logged: unknown[][] = [];
  const n = await runSweepOnce(repo, { now: () => new Date(), today: () => '2026-10-03' }, { error: (...a) => logged.push(a) });
  assert.equal(n, 0);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]![0], 'overdue_sweep_failed');
});
