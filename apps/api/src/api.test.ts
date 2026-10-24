import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const rec = (over: Partial<MembershipRecord>): MembershipRecord => ({
  userId: 'u-alice', orgId: ORG_A, membershipId: 'm-alice-a', roleId: 'role-supervisor',
  userActive: true, membershipActive: true, ...over,
});

const DB: Record<string, MembershipRecord[]> = {
  'fb-alice': [rec({})],
  'fb-bob-inactive-user': [rec({ userId: 'u-bob', membershipId: 'm-bob', userActive: false })],
  'fb-carol-inactive-membership': [rec({ userId: 'u-carol', membershipId: 'm-carol', membershipActive: false })],
  'fb-dave-two-orgs': [
    rec({ userId: 'u-dave', orgId: ORG_A, membershipId: 'm-dave-a' }),
    rec({ userId: 'u-dave', orgId: ORG_B, membershipId: 'm-dave-b' }),
  ],
};

const verifier: TokenVerifier = {
  async verify(token) {
    if (token.startsWith('tok-')) return { uid: `fb-${token.slice(4)}` };
    throw new Error('invalid token (internal detail that must never reach the client)');
  },
};

const store: IdentityStore = {
  async resolveByFirebaseUid(uid) { return DB[uid] ?? []; },
  async loadUser(m) { return { fullName: `Name of ${m.userId}`, email: `${m.userId}@example.com`, locale: 'ar' }; },
  async loadGrants() { return DEFAULT_ROLE_GRANTS.supervisor; },
  async loadSiteIds(m) { return [`site-of-${m.orgId}`]; },
};

async function withServer(
  overrides: Partial<IdentityStore>,
  fn: (call: (path: string, headers?: Record<string, string>) => Promise<{ status: number; body: any; raw: string; headers: Headers }>, logged: unknown[]) => Promise<void>,
) {
  const logged: unknown[] = [];
  const server = createApi({ verifier, store: { ...store, ...overrides }, logger: { error: (m, meta) => logged.push([m, meta]) } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const call = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const raw = await res.text();
    return { status: res.status, body: JSON.parse(raw), raw, headers: res.headers };
  };
  try { await fn(call, logged); } finally { await new Promise((r) => server.close(r)); }
}

const bearer = (name: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer tok-${name}`, ...extra });

test('GET /health is public', async () => {
  await withServer({}, async (call) => {
    assert.deepEqual((await call('/health')).body, { ok: true });
  });
});

test('missing, malformed or invalid token => 401 with a stable code and no internal detail', async () => {
  await withServer({}, async (call) => {
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer' }, { authorization: 'Bearer garbage' }] as Record<string, string>[]) {
      const r = await call('/auth/session', headers);
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { code: 'unauthenticated' });
      assert.ok(!r.raw.includes('internal detail'));
    }
  });
});

test('valid user gets session with org, grants and sites', async () => {
  await withServer({}, async (call) => {
    const r = await call('/auth/session', bearer('alice'));
    assert.equal(r.status, 200);
    assert.equal(r.body.orgId, ORG_A);
    assert.equal(r.body.user.id, 'u-alice');
    assert.deepEqual(r.body.grants, DEFAULT_ROLE_GRANTS.supervisor);
    assert.deepEqual(r.body.siteIds, ['site-of-org-a']);
  });
});

test('valid Firebase account that is not provisioned gets 403', async () => {
  await withServer({}, async (call) => {
    const r = await call('/auth/session', bearer('stranger'));
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { code: 'forbidden' });
  });
});

test('deactivated user or deactivated membership gets 403 even with a valid token', async () => {
  await withServer({}, async (call) => {
    assert.equal((await call('/auth/session', bearer('bob-inactive-user'))).status, 403);
    assert.equal((await call('/auth/session', bearer('carol-inactive-membership'))).status, 403);
  });
});

test('user in two orgs: org must be chosen; cannot pick an org they do not belong to', async () => {
  await withServer({}, async (call) => {
    const none = await call('/auth/session', bearer('dave-two-orgs'));
    assert.equal(none.status, 409);
    assert.deepEqual(none.body, { code: 'org_required' });

    const b = await call('/auth/session', bearer('dave-two-orgs', { 'x-org-id': ORG_B }));
    assert.equal(b.status, 200);
    assert.equal(b.body.orgId, ORG_B);
    assert.deepEqual(b.body.siteIds, ['site-of-org-b']);

    const foreign = await call('/auth/session', bearer('dave-two-orgs', { 'x-org-id': 'org-evil' }));
    assert.equal(foreign.status, 403);

    // A single-org user cannot switch into someone else's org via the header.
    const alice = await call('/auth/session', bearer('alice', { 'x-org-id': ORG_B }));
    assert.equal(alice.status, 403);
  });
});

test('unknown route => 404 json', async () => {
  await withServer({}, async (call) => {
    const r = await call('/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { code: 'not_found' });
  });
});

test('unexpected failure => 500 generic body, details only in logs', async () => {
  await withServer(
    { async resolveByFirebaseUid() { throw new Error('connection refused to 10.0.0.5:5432 password=secret'); } },
    async (call, logged) => {
      const r = await call('/auth/session', bearer('alice'));
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { code: 'internal' });
      assert.ok(!r.raw.includes('secret') && !r.raw.includes('10.0.0.5'));
      assert.equal(logged.length, 1);
    },
  );
});

test('responses are not cacheable and carry nosniff', async () => {
  await withServer({}, async (call) => {
    for (const path of ['/health', '/nope']) {
      const r = await call(path);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
  });
});
