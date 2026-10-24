import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier, VerifiedToken } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const ORG_B = '00000000-0000-0000-0000-00000000bbbb';
const ROLE = (k: string) => `00000000-0000-0000-0000-0000000000${{ org_admin: '11', hse_manager: '12', inspector: '13', super_admin: '14', user_manager: '15' }[k]}`;
const id = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;

type Tok = { uid: string; email: string; verified: boolean };

async function run(fn: (c: Client, w: World) => Promise<void>) {
  const repo = new MemoryWorkRepo();
  const tokens: Record<string, Tok> = {};
  const accounts: Record<string, { userId: string; fullName: string; email: string }> = {};
  const w: World = { repo, tokens, accounts, claimCalls: 0 };

  for (const [key, name] of [['org_admin', 'Org Admin'], ['hse_manager', 'HSE Manager'], ['inspector', 'Inspector'], ['super_admin', 'Super Admin'], ['user_manager', 'User Manager']]) {
    repo.roles.push({ orgId: ORG_A, id: ROLE(key!), key: key!, name: name! });
  }
  repo.roles.push({ orgId: ORG_B, id: '00000000-0000-0000-0000-000000000099', key: 'org_admin', name: 'Org Admin B' });
  const seed = (n: number, name: string, role: RoleKey, org = ORG_A, sites: string[] = []) => {
    const userId = id(n);
    const email = `${name}@x.com`;
    accounts[`fb-${name}`] = { userId, fullName: name, email };
    tokens[name] = { uid: `fb-${name}`, email, verified: true };
    repo.memberRows.push({
      orgId: org, membershipId: id(n + 50), userId, fullName: name, email, roleId: org === ORG_A ? ROLE(role) : '00000000-0000-0000-0000-000000000099',
      roleKey: role, roleName: role, status: 'active', siteIds: sites, version: 1, createdAt: '2026-10-01T00:00:00.000Z',
    });
  };
  seed(1, 'admin1', 'org_admin'); seed(2, 'admin2', 'org_admin'); seed(3, 'manager', 'hse_manager');
  seed(4, 'inspector', 'inspector'); seed(5, 'superadmin', 'super_admin'); seed(6, 'adminB', 'org_admin', ORG_B);
  seed(7, 'hrmanager', 'user_manager' as RoleKey); // a custom role that may manage users but is not an administrator

  const verifier: TokenVerifier = {
    async verify(t): Promise<VerifiedToken> {
      const tok = t.startsWith('tok-') ? tokens[t.slice(4)] : undefined;
      if (!tok) throw new Error('bad');
      return { uid: tok.uid, email: tok.email, emailVerified: tok.verified };
    },
  };
  const store: IdentityStore = {
    async resolveByFirebaseUid(uid) {
      const acc = accounts[uid];
      if (!acc) return [];
      return repo.memberRows.filter((m) => m.userId === acc.userId).map((m) => ({
        userId: m.userId, orgId: m.orgId, membershipId: m.membershipId, roleId: m.roleKey ?? '', userActive: true, membershipActive: m.status === 'active',
      } as MembershipRecord));
    },
    async loadUser(m) { const a = Object.values(accounts).find((x) => x.userId === m.userId)!; return { fullName: a.fullName, email: a.email, locale: 'ar' }; },
    async loadGrants(m) { return m.roleId === 'user_manager' ? [{ permission: 'user.manage' as const, scope: 'org' as const }] : DEFAULT_ROLE_GRANTS[m.roleId as RoleKey]; },
    async loadSiteIds(m) { return repo.memberRows.find((x) => x.membershipId === m.membershipId)!.siteIds; },
    async claimInvitations(uid, email) {
      w.claimCalls++;
      const e = email.toLowerCase();
      let n = 0;
      for (const inv of repo.invitations.filter((i) => i.email === e && i.status === 'pending')) {
        const acc = (accounts[uid] ??= { userId: randomUUID(), fullName: inv.fullName, email: e });
        const role = repo.roles.find((r) => r.id === inv.roleId)!;
        repo.memberRows.push({
          orgId: inv.orgId, membershipId: randomUUID(), userId: acc.userId, fullName: inv.fullName, email: e, roleId: inv.roleId,
          roleKey: role.key, roleName: role.name, status: 'active', siteIds: [...inv.siteIds], version: 1, createdAt: '2026-10-03T10:00:00.000Z',
        });
        inv.status = 'accepted'; n++;
      }
      return n;
    },
  };

  const server = createApi({ verifier, store, work: repo, logger: { error: () => undefined }, clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c: Client = async (who, method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn(c, w); } finally { await new Promise((r) => server.close(r)); }
}
type Client = (who: string | null, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type World = { repo: MemoryWorkRepo; tokens: Record<string, Tok>; accounts: Record<string, { userId: string; fullName: string; email: string }>; claimCalls: number };

const memberOf = async (c: Client, who: string, name: string) => (await c(who, 'GET', '/users')).body.members.find((m: any) => m.fullName === name);
const invite = (c: Client, body: Record<string, unknown>, who = 'admin1') => c(who, 'POST', '/users/invitations', body);
const goodInvite = (extra: Record<string, unknown> = {}) => ({ email: 'new@x.com', fullName: 'New Person', roleId: ROLE('inspector'), ...extra });

test('user management is for administrators only; roles list hides super_admin', async () => {
  await run(async (c) => {
    assert.equal((await c(null, 'GET', '/users')).status, 401);
    for (const who of ['manager', 'inspector']) {
      assert.equal((await c(who, 'GET', '/users')).status, 403, who);
      assert.equal((await c(who, 'GET', '/roles')).status, 403, who);
      assert.equal((await invite(c, goodInvite(), who)).status, 403, who);
      assert.equal((await c(who, 'PATCH', `/users/${id(54)}`, { version: 1, status: 'inactive' })).status, 403, who);
    }
    const roles = (await c('admin1', 'GET', '/roles')).body.items;
    assert.deepEqual(roles.map((r: any) => r.key).sort(), ['hse_manager', 'inspector', 'org_admin', 'user_manager']);
    const list = (await c('admin1', 'GET', '/users')).body;
    assert.equal(list.members.length, 6, 'only members of the own organization');
    assert.ok(!list.members.some((m: any) => m.fullName === 'adminB'));
  });
});

test('invite: validation, unknown roles and sites, duplicates', async () => {
  await run(async (c) => {
    const site = (await c('admin1', 'POST', '/sites', { name: 'Station A' })).body.site.id;
    const bad = async (body: Record<string, unknown>, field: string, code: string) => {
      const r = await invite(c, body);
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.equal(r.body.errors[field][0].code, code, field);
    };
    await bad(goodInvite({ email: undefined }), 'email', 'required');
    await bad(goodInvite({ email: 'not-an-email' }), 'email', 'invalid_type');
    await bad(goodInvite({ email: "a'b@x.com" }), 'email', 'invalid_type');
    await bad(goodInvite({ fullName: 'x' }), 'fullName', 'min_length');
    await bad(goodInvite({ roleId: undefined }), 'roleId', 'required');
    await bad(goodInvite({ roleId: '00000000-0000-0000-0000-00000000dead' }), 'roleId', 'invalid_reference');
    await bad(goodInvite({ roleId: ROLE('super_admin') }), 'roleId', 'invalid_reference');
    await bad(goodInvite({ siteIds: ['nope'] }), 'siteIds', 'invalid_type');
    await bad(goodInvite({ siteIds: ['00000000-0000-0000-0000-00000000dead'] }), 'siteIds', 'invalid_reference');
    await bad(goodInvite({ extra: 1 }), 'extra', 'unknown_field');

    const ok = await invite(c, goodInvite({ email: '  New@X.com ', siteIds: [site, site] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.invitation.email, 'new@x.com', 'normalised to lower case');
    assert.deepEqual(ok.body.invitation.siteIds, [site], 'duplicates removed');
    assert.equal(ok.body.invitation.status, 'pending');
    assert.equal((await invite(c, goodInvite())).body.code, 'already_invited');
    assert.equal((await invite(c, goodInvite({ email: 'manager@x.com' }))).body.code, 'already_member');
    assert.equal((await c('admin1', 'GET', '/users')).body.invitations.length, 1);
  });
});

test('revoking an invitation: only pending ones, and the person can no longer join', async () => {
  await run(async (c, w) => {
    const inv = (await invite(c, goodInvite())).body.invitation;
    assert.equal((await c('manager', 'POST', `/users/invitations/${inv.id}/revoke`)).status, 403);
    assert.equal((await c('adminB', 'POST', `/users/invitations/${inv.id}/revoke`)).status, 404, 'other organization');
    assert.equal((await c('admin1', 'POST', `/users/invitations/${inv.id}/revoke`)).body.invitation.status, 'revoked');
    assert.equal((await c('admin1', 'POST', `/users/invitations/${inv.id}/revoke`)).status, 404, 'already revoked');
    assert.equal((await c('admin1', 'GET', '/users')).body.invitations.length, 0);

    w.tokens.newbie = { uid: 'fb-newbie', email: 'new@x.com', verified: true };
    assert.equal((await c('newbie', 'GET', '/auth/session')).status, 403, 'revoked invitation grants nothing');
    assert.deepEqual(w.repo.timeline.filter((t) => t.entityType === 'invitation').map((t) => t.event), ['created', 'revoked']);
  });
});

test('first sign-in of an invited person: needs a verified e-mail, then becomes a member with the invited role and sites', async () => {
  await run(async (c, w) => {
    const site = (await c('admin1', 'POST', '/sites', { name: 'Station A' })).body.site.id;
    await invite(c, goodInvite({ roleId: ROLE('inspector'), siteIds: [site] }));
    w.tokens.newbie = { uid: 'fb-newbie', email: 'New@x.com', verified: false };

    const unverified = await c('newbie', 'GET', '/auth/session');
    assert.equal(unverified.status, 403);
    assert.equal(unverified.body.code, 'email_not_verified');
    assert.equal(w.claimCalls, 0, 'an unverified address can never claim an invitation');

    w.tokens.newbie!.verified = true;
    const ok = await c('newbie', 'GET', '/auth/session');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.fullName, 'New Person');
    assert.deepEqual(ok.body.siteIds, [site]);
    assert.deepEqual(ok.body.grants, DEFAULT_ROLE_GRANTS.inspector);
    assert.equal(w.claimCalls, 1);

    assert.equal((await c('newbie', 'GET', '/auth/session')).status, 200);
    assert.equal(w.claimCalls, 1, 'existing members do not trigger a claim again');
    assert.equal((await c('admin1', 'GET', '/users')).body.invitations.length, 0);
    assert.ok(await memberOf(c, 'admin1', 'New Person'));
  });
});

test('a verified person without an invitation, and an unverified one, get no access', async () => {
  await run(async (c, w) => {
    w.tokens.stranger = { uid: 'fb-stranger', email: 'stranger@x.com', verified: true };
    const r = await c('stranger', 'GET', '/auth/session');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'forbidden');
    w.tokens.stranger2 = { uid: 'fb-stranger2', email: 'stranger2@x.com', verified: false };
    assert.equal((await c('stranger2', 'GET', '/auth/session')).body.code, 'email_not_verified');
    assert.equal((await c('stranger', 'GET', '/users')).status, 403, 'and no data is reachable');
  });
});

test('change role and sites; deactivation cuts access immediately and reactivation restores it', async () => {
  await run(async (c, w) => {
    const siteA = (await c('admin1', 'POST', '/sites', { name: 'Station A' })).body.site.id;
    const siteB = (await c('admin1', 'POST', '/sites', { name: 'Station B' })).body.site.id;
    let m = await memberOf(c, 'admin1', 'inspector');
    assert.equal(m.version, 1);

    const r1 = await c('admin1', 'PATCH', `/users/${m.membershipId}`, { version: 1, roleId: ROLE('hse_manager'), siteIds: [siteA, siteB] });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.member.roleKey, 'hse_manager');
    assert.deepEqual(r1.body.member.siteIds.sort(), [siteA, siteB].sort());
    assert.equal(r1.body.member.version, 2);
    const session = (await c('inspector', 'GET', '/auth/session')).body;
    assert.deepEqual(session.grants, DEFAULT_ROLE_GRANTS.hse_manager, 'new role applies at once');

    assert.equal((await c('admin1', 'PATCH', `/users/${m.membershipId}`, { version: 1, status: 'inactive' })).status, 409, 'stale version');
    const off = await c('admin1', 'PATCH', `/users/${m.membershipId}`, { version: 2, status: 'inactive' });
    assert.equal(off.body.member.status, 'inactive');
    assert.equal((await c('inspector', 'GET', '/auth/session')).status, 403, 'deactivated user is locked out immediately');
    const on = await c('admin1', 'PATCH', `/users/${m.membershipId}`, { version: 3, status: 'active' });
    assert.equal(on.body.member.status, 'active');
    assert.equal((await c('inspector', 'GET', '/auth/session')).status, 200);

    // no-op does not bump the version
    m = await memberOf(c, 'admin1', 'inspector');
    assert.equal((await c('admin1', 'PATCH', `/users/${m.membershipId}`, { version: m.version, status: 'active' })).body.member.version, m.version);
    assert.deepEqual(w.repo.timeline.filter((t) => t.entityType === 'user').map((t) => t.event), ['role_changed', 'sites_changed', 'deactivated', 'reactivated']);
  });
});

test('safety rules: no self-service, super_admin can neither be edited nor granted', async () => {
  await run(async (c) => {
    const me = await memberOf(c, 'admin1', 'admin1');
    assert.equal((await c('admin1', 'PATCH', `/users/${me.membershipId}`, { version: 1, status: 'inactive' })).body.code, 'cannot_modify_self');
    assert.equal((await c('admin1', 'PATCH', `/users/${me.membershipId}`, { version: 1, roleId: ROLE('inspector') })).body.code, 'cannot_modify_self');

    const sup = await memberOf(c, 'admin1', 'superadmin');
    assert.equal((await c('admin1', 'PATCH', `/users/${sup.membershipId}`, { version: 1, status: 'inactive' })).status, 403);

    const insp = await memberOf(c, 'admin1', 'inspector');
    const toSuper = await c('admin1', 'PATCH', `/users/${insp.membershipId}`, { version: 1, roleId: ROLE('super_admin') });
    assert.equal(toSuper.body.errors.roleId[0].code, 'invalid_reference', 'super_admin can never be granted through the API');
  });
});

test('the last active administrator can be neither demoted nor deactivated', async () => {
  await run(async (c, w) => {
    // setup: leave admin1 as the only administrator (the super admin and admin2 become ordinary managers)
    for (const name of ['admin2', 'superadmin']) {
      const row = w.repo.memberRows.find((m) => m.fullName === name)!;
      row.roleKey = 'hse_manager'; row.roleId = ROLE('hse_manager');
    }
    // 'hrmanager' may manage users but is not an administrator, so it cannot hide behind itself
    const admin1 = await memberOf(c, 'hrmanager', 'admin1');
    const off = await c('hrmanager', 'PATCH', `/users/${admin1.membershipId}`, { version: 1, status: 'inactive' });
    assert.equal(off.status, 422);
    assert.equal(off.body.code, 'last_admin');
    assert.equal((await c('hrmanager', 'PATCH', `/users/${admin1.membershipId}`, { version: 1, roleId: ROLE('inspector') })).body.code, 'last_admin');
    assert.equal((await memberOf(c, 'hrmanager', 'admin1')).status, 'active', 'nothing changed');

    // promoting another administrator first makes the removal legitimate
    const admin2 = await memberOf(c, 'hrmanager', 'admin2');
    assert.equal((await c('hrmanager', 'PATCH', `/users/${admin2.membershipId}`, { version: admin2.version, roleId: ROLE('org_admin') })).status, 200);
    const done = await c('hrmanager', 'PATCH', `/users/${admin1.membershipId}`, { version: 1, status: 'inactive' });
    assert.equal(done.status, 200);
    assert.equal(done.body.member.status, 'inactive');
    assert.equal((await c('admin1', 'GET', '/users')).status, 403, 'the deactivated administrator is locked out');
  });
});

test('validation of updates and isolation between organizations', async () => {
  await run(async (c) => {
    const m = await memberOf(c, 'admin1', 'inspector');
    const path = `/users/${m.membershipId}`;
    assert.equal((await c('admin1', 'PATCH', path, { status: 'inactive' })).body.errors.version[0].code, 'required');
    assert.equal((await c('admin1', 'PATCH', path, { version: 1, status: 'banned' })).body.errors.status[0].code, 'invalid_option');
    assert.equal((await c('admin1', 'PATCH', path, { version: 1, roleId: 'x' })).body.errors.roleId[0].code, 'invalid_type');
    assert.equal((await c('admin1', 'PATCH', path, { version: 1, roleId: '00000000-0000-0000-0000-00000000dead' })).body.errors.roleId[0].code, 'invalid_reference');
    assert.equal((await c('admin1', 'PATCH', path, { version: 1, siteIds: ['00000000-0000-0000-0000-00000000dead'] })).body.errors.siteIds[0].code, 'invalid_reference');
    assert.equal((await c('admin1', 'PATCH', path, { version: 1, email: 'x@y.com' })).body.errors.email[0].code, 'unknown_field');
    assert.equal((await c('admin1', 'PATCH', '/users/00000000-0000-0000-0000-00000000dead', { version: 1, status: 'inactive' })).status, 404);
    assert.equal((await c('admin1', 'GET', '/users/not-a-uuid')).status, 404);
    assert.deepEqual((await c('adminB', 'GET', '/users')).body.members.map((x: any) => x.fullName), ['adminB']);
  });
});
