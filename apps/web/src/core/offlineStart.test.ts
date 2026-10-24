import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, NetworkError } from './apiClient.ts';
import type { PutOutcome, SyncApi } from './inspectionSync.ts';
import type { KeyValueStore } from './session.ts';
import { OfflineStarts, createEnsuringSyncApi, toStartOutcome } from './offlineStart.ts';
import type { StartApi, StartBody, StartOutcome } from './offlineStart.ts';

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
};

function fakeApi(script: StartOutcome[] = []) {
  const calls: StartBody[] = [];
  let gate: Promise<void> | null = null;
  const api: StartApi & { calls: StartBody[]; hold(): () => void } = {
    calls,
    hold() { let release!: () => void; gate = new Promise<void>((r) => { release = () => { gate = null; r(); }; }); return release; },
    async start(body) { calls.push(body); if (gate) await gate; return script.shift() ?? { kind: 'ok' }; },
  };
  return api;
}

function setup(script: StartOutcome[] = []) {
  const store = memoryStore(); const api = fakeApi(script); let n = 0;
  const make = () => new OfflineStarts({ store, api, newId: () => `id-${++n}`, now: () => new Date('2026-10-24T09:00:00Z') });
  return { store, api, starts: make(), make };
}
const tpl = { templateId: 't1', templateVersionId: 'v1', startedBy: 'me' };

test('a start is remembered on the device before anything is sent', async () => {
  const s = setup();
  await s.starts.init();
  const d = await s.starts.create({ ...tpl, siteId: 'site1', title: '  Night round  ' });
  assert.equal(d.id, 'id-1');
  assert.equal(d.title, 'Night round', 'trimmed');
  assert.equal(s.api.calls.length, 0, 'creating never touches the network by itself');
  assert.equal(s.starts.list().length, 1);
  assert.ok(s.store.data.has('mthse.starts.v1'));
});

test('online: the server is asked once with the app\'s own id and the version the app used, then the draft is gone', async () => {
  const s = setup();
  await s.starts.init();
  const d = await s.starts.create({ ...tpl, siteId: 'site1', title: 'Round' });
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'ready' });
  assert.deepEqual(s.api.calls, [{ id: 'id-1', templateId: 't1', templateVersionId: 'v1', siteId: 'site1', title: 'Round' }]);
  assert.equal(s.starts.list().length, 0);
  assert.equal(s.store.data.size, 0);
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'ready' }, 'afterwards: nothing more to do, no second request');
  assert.equal(s.api.calls.length, 1);
});

test('optional fields are left out of the request when empty', async () => {
  const s = setup();
  await s.starts.init();
  const d = await s.starts.create(tpl);
  await s.starts.ensureCreated(d.id);
  assert.deepEqual(s.api.calls[0], { id: 'id-1', templateId: 't1', templateVersionId: 'v1' });
});

test('offline: the draft stays and is sent later; the id never changes', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.starts.init();
  const d = await s.starts.create(tpl);
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'offline' });
  assert.equal(s.starts.list().length, 1);
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'ready' });
  assert.deepEqual(s.api.calls.map((c) => c.id), ['id-1', 'id-1']);
});

test('restart: a draft saved before closing the app is still there and is sent next time', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.starts.init();
  const d = await s.starts.create(tpl);
  await s.starts.ensureCreated(d.id);
  const reopened = s.make();
  await reopened.init();
  assert.equal(reopened.list()[0]?.id, d.id);
  assert.deepEqual(await reopened.ensureCreated(d.id), { kind: 'ready' });
});

test('simultaneous callers (the screen, the answers outbox) share ONE request', async () => {
  const s = setup();
  await s.starts.init();
  const d = await s.starts.create(tpl);
  const release = s.api.hold();
  const a = s.starts.ensureCreated(d.id);
  const b = s.starts.ensureCreated(d.id);
  const c = s.starts.ensureCreated(d.id);
  release();
  assert.deepEqual(await Promise.all([a, b, c]), [{ kind: 'ready' }, { kind: 'ready' }, { kind: 'ready' }]);
  assert.equal(s.api.calls.length, 1);
});

test('the server refuses for good: the draft is kept, marked, and not retried', async () => {
  const s = setup([{ kind: 'rejected', code: 'no_published_version' }]);
  await s.starts.init();
  const d = await s.starts.create(tpl);
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'rejected', code: 'no_published_version' });
  assert.equal(s.starts.get(d.id)?.failedCode, 'no_published_version');
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'rejected', code: 'no_published_version' });
  assert.equal(s.api.calls.length, 1, 'no second request for a refused start');
  await s.starts.flushAll();
  assert.equal(s.api.calls.length, 1);
});

test('signed out: stops and reports it; coming back online/signing in tries again', async () => {
  const s = setup([{ kind: 'auth' }]);
  await s.starts.init();
  const d = await s.starts.create(tpl);
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'auth' });
  assert.deepEqual(await s.starts.ensureCreated(d.id), { kind: 'auth' });
  assert.equal(s.api.calls.length, 1, 'no requests with an invalid session');
  s.starts.notifyOnline();
  await settle();
  assert.equal(s.starts.list().length, 0);
});

test('flushAll sends the oldest first and stops at the first offline answer', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.starts.init();
  await s.starts.create(tpl);
  await s.starts.create({ ...tpl, templateId: 't2' });
  await s.starts.flushAll();
  assert.equal(s.api.calls.length, 1, 'did not try the second one while offline');
  await s.starts.flushAll();
  assert.deepEqual(s.api.calls.map((c) => c.id), ['id-1', 'id-1', 'id-2']);
  assert.equal(s.starts.list().length, 0);
});

test('discard removes a draft; clear (sign-out) removes all', async () => {
  const s = setup();
  await s.starts.init();
  const a = await s.starts.create(tpl);
  await s.starts.create(tpl);
  await s.starts.discard(a.id);
  assert.equal(s.starts.list().length, 1);
  await s.starts.clear();
  assert.equal(s.starts.list().length, 0);
  assert.equal(s.store.data.size, 0);
});

test('discarding while the request is running does not bring the draft back', async () => {
  const s = setup([{ kind: 'rejected', code: 'forbidden' }]);
  await s.starts.init();
  const d = await s.starts.create(tpl);
  const release = s.api.hold();
  const p = s.starts.ensureCreated(d.id);
  await s.starts.discard(d.id);
  release();
  await p;
  assert.equal(s.starts.list().length, 0);
});

test('the screen sees a draft as an in-progress inspection', async () => {
  const s = setup();
  await s.starts.init();
  const d = await s.starts.create({ ...tpl, title: 'Round', siteId: 's' });
  const dto = s.starts.toInspection(d);
  assert.equal(dto.id, d.id);
  assert.equal(dto.status, 'in_progress');
  assert.equal(dto.startedBy, 'me');
  assert.equal(dto.templateVersionId, 'v1');
});

test('a corrupted saved list is ignored', async () => {
  const s = setup();
  s.store.data.set('mthse.starts.v1', 'oops{');
  await s.starts.init();
  assert.equal(s.starts.list().length, 0);
});

test('subscribers hear about changes', async () => {
  const s = setup();
  await s.starts.init();
  let n = 0;
  const off = s.starts.subscribe(() => { n++; });
  const d = await s.starts.create(tpl);
  await s.starts.ensureCreated(d.id);
  assert.ok(n >= 2);
  off();
  const before = n;
  await s.starts.create(tpl);
  assert.equal(n, before);
});

test('failures are classified: retry later, sign in again, or refused', () => {
  assert.deepEqual(toStartOutcome(new NetworkError()), { kind: 'network' });
  assert.deepEqual(toStartOutcome(new ApiError(401, 'unauthenticated')), { kind: 'auth' });
  for (const st of [408, 429, 500, 503]) assert.deepEqual(toStartOutcome(new ApiError(st, 'x')), { kind: 'network' }, String(st));
  assert.deepEqual(toStartOutcome(new ApiError(422, 'no_published_version')), { kind: 'rejected', code: 'no_published_version' });
  assert.deepEqual(toStartOutcome(new ApiError(409, 'conflict')), { kind: 'rejected', code: 'conflict' });
  assert.deepEqual(toStartOutcome(new TypeError('failed to fetch')), { kind: 'network' });
});

// ---------- the answers outbox waits for the creation ----------

function fakeSyncApi() {
  const puts: string[] = [];
  const base: SyncApi = { async putResponse(i, q): Promise<PutOutcome> { puts.push(`${i}/${q}`); return { kind: 'ok', version: 1 }; } };
  return { base, puts };
}

test('answers for a not-yet-created inspection are NOT sent; they are held back as "offline"', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.starts.init();
  const d = await s.starts.create(tpl);
  const { base, puts } = fakeSyncApi();
  const api = createEnsuringSyncApi(base, s.starts);
  assert.deepEqual(await api.putResponse(d.id, 'q1', 'yes', 0), { kind: 'network' });
  assert.deepEqual(puts, []);
});

test('once the creation succeeds the answers go through', async () => {
  const s = setup();
  await s.starts.init();
  const d = await s.starts.create(tpl);
  const { base, puts } = fakeSyncApi();
  const api = createEnsuringSyncApi(base, s.starts);
  assert.deepEqual(await api.putResponse(d.id, 'q1', 'yes', 0), { kind: 'ok', version: 1 });
  assert.deepEqual(await api.putResponse(d.id, 'q2', 'no', 0), { kind: 'ok', version: 1 });
  assert.deepEqual(puts, [`${d.id}/q1`, `${d.id}/q2`]);
  assert.equal(s.api.calls.length, 1, 'created once, not once per answer');
});

test('an inspection that is already on the server is not delayed at all', async () => {
  const s = setup();
  await s.starts.init();
  const { base, puts } = fakeSyncApi();
  assert.deepEqual(await createEnsuringSyncApi(base, s.starts).putResponse('server-made', 'q1', 1, 0), { kind: 'ok', version: 1 });
  assert.deepEqual(puts, ['server-made/q1']);
  assert.equal(s.api.calls.length, 0);
});

test('signed-out and refused starts are passed on to the sync engine in its own words', async () => {
  const auth = setup([{ kind: 'auth' }]);
  await auth.starts.init();
  const a = await auth.starts.create(tpl);
  assert.deepEqual(await createEnsuringSyncApi(fakeSyncApi().base, auth.starts).putResponse(a.id, 'q', 1, 0), { kind: 'auth' });
  const bad = setup([{ kind: 'rejected', code: 'forbidden' }]);
  await bad.starts.init();
  const b = await bad.starts.create(tpl);
  assert.deepEqual(await createEnsuringSyncApi(fakeSyncApi().base, bad.starts).putResponse(b.id, 'q', 1, 0), { kind: 'rejected', code: 'forbidden' });
});
