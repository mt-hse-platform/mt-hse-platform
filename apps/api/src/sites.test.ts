import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const USERS: Record<string, { id: string; org: string; role: RoleKey }> = {
  admin:    { id: '00000000-0000-0000-0000-000000000001', org: 'org-a', role: 'org_admin' },
  employee: { id: '00000000-0000-0000-0000-000000000003', org: 'org-a', role: 'employee' },
  adminB:   { id: '00000000-0000-0000-0000-000000000007', org: 'org-b', role: 'org_admin' },
};
const verifier: TokenVerifier = { async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); } };
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) { const u = USERS[uid]; return u ? [{ userId: u.id, orgId: u.org, membershipId: uid, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : []; },
  async loadUser(m) { return { fullName: m.userId, email: 'x@x.com', locale: 'ar' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds() { return []; },
};

async function run(fn: (c: (who: string | null, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const server = createApi({ verifier, store, work: new MemoryWorkRepo(), logger: { error: () => undefined } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c = async (who: string | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn(c); } finally { await new Promise((r) => server.close(r)); }
}

test('sites: members can list their organization sites; only managers create them; organizations are isolated', async () => {
  await run(async (c) => {
    assert.equal((await c(null, 'GET', '/sites')).status, 401);
    assert.deepEqual((await c('employee', 'GET', '/sites')).body.items, []);
    assert.equal((await c('employee', 'POST', '/sites', { name: 'Station A' })).status, 403);

    const a = await c('admin', 'POST', '/sites', { name: '  Station A  ' });
    assert.equal(a.status, 201);
    assert.equal(a.body.site.name, 'Station A');
    await c('admin', 'POST', '/sites', { name: 'Batching Plant 2' });

    assert.deepEqual((await c('employee', 'GET', '/sites')).body.items.map((x: any) => x.name), ['Batching Plant 2', 'Station A']);
    assert.deepEqual((await c('adminB', 'GET', '/sites')).body.items, []);
    assert.equal((await c('admin', 'POST', '/sites', { name: 'Station A' })).status, 409, 'duplicate name');
    assert.equal((await c('admin', 'POST', '/sites', { name: 'x' })).body.errors.name[0].code, 'min_length');
    assert.equal((await c('admin', 'POST', '/sites', {})).body.errors.name[0].code, 'required');
    assert.equal((await c('admin', 'POST', '/sites', { name: 'Okay name', extra: 1 })).body.errors.extra[0].code, 'unknown_field');
  });
});
