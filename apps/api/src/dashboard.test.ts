import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const SITE_A = '00000000-0000-0000-0000-0000000051a1';
const USERS: Record<string, { id: string; org: string; role: RoleKey; sites: string[] }> = {
  manager:  { id: '00000000-0000-0000-0000-000000000001', org: ORG_A, role: 'hse_manager', sites: [] },
  employee: { id: '00000000-0000-0000-0000-000000000003', org: ORG_A, role: 'employee', sites: [SITE_A] },
  viewer:   { id: '00000000-0000-0000-0000-000000000005', org: ORG_A, role: 'viewer', sites: [SITE_A] },
};
const verifier: TokenVerifier = { async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); } };
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) { const u = USERS[uid]; return u ? [{ userId: u.id, orgId: u.org, membershipId: uid, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : []; },
  async loadUser(m) { return { fullName: m.userId, email: 'x@x.com', locale: 'ar' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds(m) { return USERS[m.roleId]!.sites; },
};

type Client = (who: string | null, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function run(fn: (c: Client, repo: MemoryWorkRepo) => Promise<void>) {
  const repo = new MemoryWorkRepo();
  for (const [name, u] of Object.entries(USERS)) {
    repo.addMember(u.org, u.id);
    repo.memberRows.push({ orgId: u.org, membershipId: `m-${name}`, userId: u.id, fullName: `Name ${name}`, email: `${name}@x.com`, roleId: 'r', roleKey: u.role, roleName: u.role, status: name === 'viewer' ? 'inactive' : 'active', siteIds: u.sites, version: 1, createdAt: '2026-10-01T00:00:00Z' });
  }
  const server = createApi({ verifier, store, work: repo, logger: { error: () => undefined }, clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c: Client = async (who, method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn(c, repo); } finally { await new Promise((r) => server.close(r)); }
}

const ISSUE = { type: 'hazard', priority: 'high' };
const ACTION = { type: 'corrective', priority: 'high' };

/** Builds a small, known data set. Today is 2026-10-03 in these tests. */
async function seed(c: Client, repo: MemoryWorkRepo) {
  const me = USERS.manager!.id; const emp = USERS.employee!.id;
  repo.siteNames[SITE_A] = 'A';
  const a1 = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Late and mine', dueDate: '2026-10-03', assigneeId: emp })).body; // due today (valid when creating)
  repo.actions.find((x) => x.id === a1.id)!.dueDate = '2026-10-01';                                                                        // make it overdue
  const a2 = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Future and mine', dueDate: '2026-10-20', assigneeId: emp })).body;
  const a3 = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Not assigned' })).body;
  const a4 = (await c('manager', 'POST', '/actions', { ...ACTION, title: 'Done late', dueDate: '2026-10-03', assigneeId: emp })).body;
  repo.actions.find((x) => x.id === a4.id)!.dueDate = '2026-09-01';
  await c('manager', 'PATCH', `/actions/${a4.id}`, { version: 1, status: 'in_progress' });
  await c('manager', 'PATCH', `/actions/${a4.id}`, { version: 2, status: 'completed' });
  const i1 = (await c('employee', 'POST', '/issues', { ...ISSUE, title: 'Issue by employee' })).body;
  const i2 = (await c('manager', 'POST', '/issues', { ...ISSUE, title: 'Manager issue', siteId: undefined })).body;
  repo.issues.find((x) => x.id === i2.id)!.dueDate = '2026-10-02';
  void me; void a2; void a3; void i1;
  return { a1, a4 };
}

test('list filters: assigned to me, overdue, and their combination with status', async () => {
  await run(async (c, repo) => {
    await seed(c, repo);
    const titles = async (who: string, qs: string) => (await c(who, 'GET', `/actions${qs}`)).body.items.map((i: any) => i.title).sort();
    assert.deepEqual(await titles('employee', '?mine=1'), ['Done late', 'Future and mine', 'Late and mine']);
    assert.deepEqual(await titles('manager', '?mine=1'), [], 'nothing is assigned to the manager');
    assert.deepEqual(await titles('manager', '?overdue=1'), ['Late and mine'], 'completed items are never overdue');
    assert.deepEqual(await titles('employee', '?mine=1&overdue=1'), ['Late and mine']);
    assert.deepEqual(await titles('employee', '?mine=1&status=completed'), ['Done late']);
    assert.deepEqual(await titles('manager', '?overdue=0'), ['Done late', 'Future and mine', 'Late and mine', 'Not assigned'], '0 means "no filter"');

    assert.deepEqual((await c('manager', 'GET', '/issues?overdue=1')).body.items.map((i: any) => i.title), ['Manager issue']);
    assert.equal((await c('manager', 'GET', '/actions?mine=yes')).status, 422);
    assert.equal((await c('manager', 'GET', '/issues?overdue=2')).status, 422);
  });
});

test('dashboard: counters follow what the caller may read', async () => {
  await run(async (c, repo) => {
    await seed(c, repo);
    assert.equal((await c(null, 'GET', '/dashboard')).status, 401);

    const m = (await c('manager', 'GET', '/dashboard')).body;
    assert.equal(m.today, '2026-10-03');
    assert.deepEqual(m.actions.byStatus, { todo: 3, completed: 1 });
    assert.equal(m.actions.overdue, 1);
    assert.equal(m.actions.mine, 0);
    assert.deepEqual(m.issues.byStatus, { open: 2 });
    assert.equal(m.issues.overdue, 1);
    assert.deepEqual(m.inspections, { byStatus: {}, overdue: 0, mine: 0 });

    const e = (await c('employee', 'GET', '/dashboard')).body;
    assert.equal(e.actions.mine, 2, 'two open actions are assigned to the employee');
    assert.equal(e.actions.overdue, 1);
    assert.deepEqual(e.issues.byStatus, { open: 1 }, 'the employee only sees their own issue');
    assert.equal(e.inspections, null, 'employees cannot read inspections');
  });
});

test('people: only people who can assign see the member names, and only active members', async () => {
  await run(async (c) => {
    const ok = await c('manager', 'GET', '/people');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.items.map((x: any) => x.fullName).sort(), ['Name employee', 'Name manager'], 'the inactive viewer is not offered');
    assert.deepEqual(Object.keys(ok.body.items[0]).sort(), ['fullName', 'userId'], 'no e-mail or role is exposed');
    assert.equal((await c('employee', 'GET', '/people')).status, 403);
    assert.equal((await c(null, 'GET', '/people')).status, 401);
  });
});
