import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, NetworkError, createApiClient } from './apiClient.ts';
import { SessionCache } from './session.ts';
import type { KeyValueStore } from './session.ts';
import { bootSession } from './bootstrap.ts';
import type { SessionResponse } from './bootstrap.ts';
import { userMessageKey } from '../../../../packages/i18n/src/index.ts';

const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async remove(k) { data.delete(k); },
  };
};

const RESPONSE: SessionResponse = {
  user: { id: 'u1', fullName: 'Test', email: 't@x.com', locale: 'ar' },
  orgId: 'org-1',
  grants: [{ permission: 'issue.read', scope: 'org' }],
  siteIds: [],
};
const DAY = 24 * 60 * 60 * 1000;

function setup(fetchSession: () => Promise<SessionResponse>, user: { uid: string } | null = { uid: 'fb-1' }) {
  const store = memoryStore();
  const cache = new SessionCache(store);
  let now = 1_000_000;
  const boot = () => bootSession({ auth: { currentUser: async () => user }, cache, fetchSession, now: () => now });
  return { store, cache, boot, advance: (ms: number) => { now += ms; } };
}

test('online start: ready, not offline, session cached', async () => {
  const t = setup(async () => RESPONSE);
  const r = await t.boot();
  assert.equal(r.status, 'ready');
  assert.equal(r.status === 'ready' && r.offline, false);
  assert.equal(t.store.data.size, 1);
});

test('offline start after a previous online session: uses cache', async () => {
  let online = true;
  const t = setup(async () => { if (online) return RESPONSE; throw new NetworkError(); });
  await t.boot();
  online = false;
  t.advance(2 * DAY);
  const r = await t.boot();
  assert.equal(r.status, 'ready');
  assert.equal(r.status === 'ready' && r.offline, true);
  assert.equal(r.status === 'ready' && r.session.orgId, 'org-1');
});

test('offline with no cache: network error, not signed out', async () => {
  const t = setup(async () => { throw new NetworkError(); });
  assert.deepEqual(await t.boot(), { status: 'error', code: 'network' });
});

test('offline cache older than the session timeout is not used', async () => {
  let online = true;
  const t = setup(async () => { if (online) return RESPONSE; throw new NetworkError(); });
  await t.boot();
  online = false;
  t.advance(8 * DAY);
  assert.deepEqual(await t.boot(), { status: 'error', code: 'network' });
});

test('cache of another Firebase user is never used', async () => {
  const store = memoryStore();
  const cache = new SessionCache(store);
  await cache.save({ ...RESPONSE, firebaseUid: 'fb-OTHER' }, 1_000_000);
  const r = await bootSession({
    auth: { currentUser: async () => ({ uid: 'fb-1' }) }, cache,
    fetchSession: async () => { throw new NetworkError(); }, now: () => 1_000_001,
  });
  assert.deepEqual(r, { status: 'error', code: 'network' });
});

test('403 (deactivated) wins over the cache and clears it', async () => {
  let mode: 'ok' | 'forbidden' = 'ok';
  const t = setup(async () => { if (mode === 'ok') return RESPONSE; throw new ApiError(403, 'forbidden'); });
  await t.boot();
  mode = 'forbidden';
  assert.deepEqual(await t.boot(), { status: 'signed_out', reason: 'forbidden' });
  assert.equal(t.store.data.size, 0);
});

test('401 signs out and clears the cache', async () => {
  let mode: 'ok' | 'expired' = 'ok';
  const t = setup(async () => { if (mode === 'ok') return RESPONSE; throw new ApiError(401, 'unauthenticated'); });
  await t.boot();
  mode = 'expired';
  assert.deepEqual(await t.boot(), { status: 'signed_out', reason: 'session_expired' });
  assert.equal(t.store.data.size, 0);
});

test('no Firebase user: signed out and any cache is wiped', async () => {
  const t = setup(async () => RESPONSE, null);
  await t.cache.save({ ...RESPONSE, firebaseUid: 'fb-1' }, 1);
  assert.deepEqual(await t.boot(), { status: 'signed_out', reason: 'no_user' });
  assert.equal(t.store.data.size, 0);
});

test('an unverified e-mail is reported so the app can ask the user to verify it', async () => {
  assert.deepEqual(await setup(async () => { throw new ApiError(403, 'email_not_verified'); }).boot(), { status: 'email_unverified' });
  assert.deepEqual(await setup(async () => { throw new ApiError(403, 'forbidden'); }).boot(), { status: 'signed_out', reason: 'forbidden' });
});

test('org_required and unknown server errors are reported distinctly', async () => {
  assert.deepEqual(await setup(async () => { throw new ApiError(409, 'org_required'); }).boot(), { status: 'org_required' });
  assert.deepEqual(await setup(async () => { throw new ApiError(500, 'internal'); }).boot(), { status: 'error', code: 'internal' });
  assert.deepEqual(await setup(async () => { throw new Error('weird'); }).boot(), { status: 'error', code: 'unknown' });
});

test('corrupted cache content is ignored safely', async () => {
  const store = memoryStore();
  store.data.set('mthse.session.v1', '{not json');
  const cache = new SessionCache(store);
  assert.equal(await cache.load('fb-1', 1, DAY), null);
});

test('api client: headers, error mapping and safe messages', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const mk = (res: () => Promise<Response>, orgId?: string) => createApiClient({
    baseUrl: 'https://api.test', getToken: async () => 'T0K', getOrgId: () => orgId,
    fetchFn: (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return res(); }) as typeof fetch,
  });

  const ok = await mk(async () => new Response(JSON.stringify({ a: 1 }), { status: 200 }), 'org-9').request<{ a: number }>('/x');
  assert.deepEqual(ok, { a: 1 });
  assert.equal(calls[0]!.url, 'https://api.test/x');
  assert.equal(calls[0]!.headers['authorization'], 'Bearer T0K');
  assert.equal(calls[0]!.headers['x-org-id'], 'org-9');

  await assert.rejects(mk(async () => new Response(JSON.stringify({ code: 'forbidden' }), { status: 403 })).request('/x'),
    (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === 'forbidden' && userMessageKey(e) === 'error.permission_denied');
  await assert.rejects(mk(async () => new Response('<html>boom stack trace</html>', { status: 502 })).request('/x'),
    (e: unknown) => e instanceof ApiError && e.code === 'unknown' && !String(e.message).includes('boom'));
  await assert.rejects(mk(async () => { throw new TypeError('Failed to fetch'); }).request('/x'),
    (e: unknown) => e instanceof NetworkError && userMessageKey(e) === 'error.network');
});
