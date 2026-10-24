import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, NetworkError } from './apiClient.ts';
import { BACKOFF_MS, InspectionSync, createSyncApi, toPutOutcome } from './inspectionSync.ts';
import type { PutOutcome, RemoteResponse, Scheduler, SyncApi } from './inspectionSync.ts';
import type { KeyValueStore } from './session.ts';

const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
};

/** Deterministic timers. */
class FakeScheduler implements Scheduler {
  now = 0; private seq = 0; private tasks: { id: number; at: number; fn: () => void }[] = [];
  set(fn: () => void, ms: number) { const id = ++this.seq; this.tasks.push({ id, at: this.now + ms, fn }); return id; }
  clear(h: unknown) { this.tasks = this.tasks.filter((t) => t.id !== h); }
  get pending() { return this.tasks.length; }
  /** advance time, run due tasks, and let the async work they start settle */
  async advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t.id !== due.id);
      this.now = due.at; due.fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
}
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

/** A server with the same semantics as PUT /inspections/:id/responses/:q, with failure injection. */
class FakeServer implements SyncApi {
  data = new Map<string, RemoteResponse>();
  calls: { q: string; value: unknown; baseVersion: number }[] = [];
  next: ('network' | 'lost_reply' | 'auth' | 'locked' | 'invalid' | 'server_error' | 'hold')[] = [];
  held: (() => void)[] = [];
  async putResponse(_id: string, q: string, value: unknown, baseVersion: number): Promise<PutOutcome> {
    this.calls.push({ q, value, baseVersion });
    const fail = this.next.shift();
    if (fail === 'network') return { kind: 'network' };
    if (fail === 'auth') return { kind: 'auth' };
    if (fail === 'locked') return { kind: 'rejected', code: 'not_editable' };
    if (fail === 'invalid') return { kind: 'rejected', code: 'validation' };
    if (fail === 'server_error') return toPutOutcome(new ApiError(503, 'internal'));
    if (fail === 'hold') await new Promise<void>((r) => this.held.push(r));
    const cur = this.data.get(q);
    const out = this.apply(q, value, baseVersion, cur);
    return fail === 'lost_reply' ? { kind: 'network' } : out;
  }
  private apply(q: string, value: unknown, baseVersion: number, cur: RemoteResponse | undefined): PutOutcome {
    if (!cur) {
      if (baseVersion !== 0) return { kind: 'conflict', current: null };
      this.data.set(q, { value, version: 1 }); return { kind: 'ok', version: 1 };
    }
    if (cur.version !== baseVersion) return { kind: 'conflict', current: { ...cur } };
    const row = { value, version: cur.version + 1 }; this.data.set(q, row); return { kind: 'ok', version: row.version };
  }
  /** another device writes the answer */
  external(q: string, value: unknown) { const cur = this.data.get(q); this.data.set(q, { value, version: (cur?.version ?? 0) + 1 }); }
  release() { this.held.splice(0).forEach((r) => r()); }
  snapshot(): Record<string, RemoteResponse> { return Object.fromEntries(this.data); }
}

async function setup(opts: { server?: FakeServer; store?: ReturnType<typeof memoryStore>; init?: Record<string, RemoteResponse> } = {}) {
  const server = opts.server ?? new FakeServer();
  const store = opts.store ?? memoryStore();
  const sched = new FakeScheduler();
  const changes: string[] = [];
  let authErrors = 0;
  const sync = new InspectionSync({ inspectionId: 'i1', api: server, store, scheduler: sched, onChange: () => changes.push(sync.getStatus()), onAuthError: () => { authErrors++; } });
  await sync.init(opts.init ?? server.snapshot());
  return { server, store, sched, sync, changes, authErrors: () => authErrors };
}

test('an answer is visible immediately, saved after the debounce, and the status follows', async () => {
  const t = await setup();
  await t.sync.setAnswer('q1', 'yes');
  assert.equal(t.sync.getValue('q1'), 'yes', 'local value at once');
  assert.equal(t.sync.getStatus(), 'saving');
  assert.equal(t.server.calls.length, 0, 'not sent yet (debounce)');
  await t.sched.advance(500);
  assert.deepEqual(t.server.calls, [{ q: 'q1', value: 'yes', baseVersion: 0 }]);
  assert.equal(t.sync.getStatus(), 'saved');
  assert.equal(t.sync.getVersion('q1'), 1);
  assert.equal(t.sync.pendingCount(), 0);
  assert.equal(t.store.data.size, 0, 'outbox is empty again');
});

test('rapid edits of the same question are coalesced into one request', async () => {
  const t = await setup();
  for (const v of ['a', 'ab', 'abc']) { await t.sync.setAnswer('q1', v); await t.sched.advance(100); }
  await t.sched.advance(500);
  assert.deepEqual(t.server.calls, [{ q: 'q1', value: 'abc', baseVersion: 0 }]);
});

test('different questions are sent one after another, in the order they were answered', async () => {
  const t = await setup();
  await t.sync.setAnswer('q2', 'x'); await t.sync.setAnswer('q1', 'y'); await t.sync.setAnswer('q3', 'z');
  await t.sched.advance(500);
  assert.deepEqual(t.server.calls.map((c) => c.q), ['q2', 'q1', 'q3']);
});

test('an edit made while the previous one is in flight is sent next with the new server version', async () => {
  const server = new FakeServer(); server.next = ['hold'];
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'first');
  await t.sched.advance(500);                       // request 1 is now waiting
  assert.equal(server.calls.length, 1);
  await t.sync.setAnswer('q1', 'second');           // typed while in flight
  server.release(); await settle(); await t.sched.advance(500);
  assert.deepEqual(server.calls, [{ q: 'q1', value: 'first', baseVersion: 0 }, { q: 'q1', value: 'second', baseVersion: 1 }]);
  assert.deepEqual(server.data.get('q1'), { value: 'second', version: 2 });
  assert.equal(t.sync.getStatus(), 'saved');
});

test('offline: the answer is kept, the status says offline, and it is retried with backoff', async () => {
  const server = new FakeServer(); server.next = ['network', 'network', 'network'];
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'yes');
  await t.sched.advance(500);
  assert.equal(t.sync.getStatus(), 'offline');
  assert.equal(t.sync.getValue('q1'), 'yes');
  await t.sched.advance(BACKOFF_MS[0]! - 1); assert.equal(server.calls.length, 1, 'not yet');
  await t.sched.advance(1);                         assert.equal(server.calls.length, 2, 'after 1s');
  await t.sched.advance(BACKOFF_MS[1]!);            assert.equal(server.calls.length, 3, 'after 2s more');
  await t.sched.advance(BACKOFF_MS[2]!);            // 4s: third failure was already consumed; this one succeeds
  assert.equal(server.calls.length, 4);
  assert.equal(t.sync.getStatus(), 'saved');
  assert.deepEqual(server.data.get('q1'), { value: 'yes', version: 1 });
});

test('backoff grows and is capped at 30 seconds; a temporary server error counts as offline', async () => {
  const server = new FakeServer(); server.next = Array(8).fill('server_error');
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'yes');
  await t.sched.advance(500);
  assert.equal(t.sync.getStatus(), 'offline');
  let prev = server.calls.length;
  for (let n = 0; n < 7; n++) {
    const delay = BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]!;
    await t.sched.advance(delay - 1); assert.equal(server.calls.length, prev, `attempt ${n}: too early`);
    await t.sched.advance(1);         assert.equal(server.calls.length, prev + 1, `attempt ${n}: on time`);
    prev++;
  }
  assert.equal(BACKOFF_MS[BACKOFF_MS.length - 1], 30000);
});

test('coming back online flushes immediately and resets the backoff', async () => {
  const server = new FakeServer(); server.next = ['network'];
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'yes');
  await t.sched.advance(500);
  assert.equal(t.sync.getStatus(), 'offline');
  t.sync.notifyOnline(); await settle();
  assert.equal(t.sync.getStatus(), 'saved');
  assert.equal(server.calls.length, 2);
  assert.equal(t.sched.pending, 0, 'no retry timer left');
});

test('answers typed offline survive closing the app and are sent later with their original base version', async () => {
  const server = new FakeServer();
  server.data.set('q1', { value: 'old', version: 3 });
  server.next = ['network'];
  const store = memoryStore();
  const a = await setup({ server, store });
  await a.sync.setAnswer('q1', 'typed offline');
  await a.sched.advance(500);
  assert.equal(a.sync.getStatus(), 'offline');
  a.sync.dispose();                                  // app closed

  const b = await setup({ server, store });          // app reopened: init restores the outbox
  assert.equal(b.sync.getValue('q1'), 'typed offline');
  assert.equal(b.sync.getStatus(), 'saving');
  await b.sched.advance(0);
  assert.deepEqual(server.calls.at(-1), { q: 'q1', value: 'typed offline', baseVersion: 3 });
  assert.equal(b.sync.getStatus(), 'saved');
  assert.deepEqual(server.data.get('q1'), { value: 'typed offline', version: 4 });
});

test('a corrupted outbox is ignored; a finished (locked) inspection discards it', async () => {
  const store = memoryStore(); store.data.set('mthse.pending.i1', '{broken');
  const t = await setup({ store });
  assert.equal(t.sync.pendingCount(), 0);
  const store2 = memoryStore(); store2.data.set('mthse.pending.i1', JSON.stringify({ v: 1, pending: { q1: { value: 'x', baseVersion: 0 } } }));
  const sync = new InspectionSync({ inspectionId: 'i1', api: new FakeServer(), store: store2, scheduler: new FakeScheduler() });
  await sync.init({}, { locked: true });
  assert.equal(sync.getStatus(), 'locked');
  assert.equal(store2.data.size, 0);
});

test('conflict with another device: nothing is overwritten; keep_local resends on top of the server version', async () => {
  const server = new FakeServer(); server.data.set('q1', { value: 'a', version: 1 });
  const t = await setup({ server });
  server.external('q1', 'from device B');            // version 2 on the server, we still think 1
  await t.sync.setAnswer('q1', 'from device A');
  await t.sched.advance(500);
  assert.equal(t.sync.getStatus(), 'conflict');
  assert.deepEqual(t.sync.conflicts().q1, { local: 'from device A', server: { value: 'from device B', version: 2 } });
  assert.equal(server.data.get('q1')!.value, 'from device B', 'server value untouched');
  const callsBefore = server.calls.length;
  await t.sched.advance(60_000);
  assert.equal(server.calls.length, callsBefore, 'a conflicted answer is not retried automatically');

  await t.sync.resolveConflict('q1', 'keep_local'); await t.sched.advance(0);
  assert.deepEqual(server.calls.at(-1), { q: 'q1', value: 'from device A', baseVersion: 2 });
  assert.deepEqual(server.data.get('q1'), { value: 'from device A', version: 3 });
  assert.equal(t.sync.getStatus(), 'saved');
});

test('conflict: keep_server adopts the other value and sends nothing more', async () => {
  const server = new FakeServer(); server.data.set('q1', { value: 'a', version: 1 });
  const t = await setup({ server });
  server.external('q1', 'from device B');
  await t.sync.setAnswer('q1', 'from device A'); await t.sched.advance(500);
  const calls = server.calls.length;
  await t.sync.resolveConflict('q1', 'keep_server'); await t.sched.advance(1000);
  assert.equal(server.calls.length, calls);
  assert.equal(t.sync.getValue('q1'), 'from device B');
  assert.equal(t.sync.getVersion('q1'), 2);
  assert.equal(t.sync.getStatus(), 'saved');
  assert.equal(t.sync.pendingCount(), 0);
});

test('other answers keep syncing while one question is in conflict', async () => {
  const server = new FakeServer(); server.data.set('q1', { value: 'a', version: 1 });
  const t = await setup({ server });
  server.external('q1', 'B');
  await t.sync.setAnswer('q1', 'A'); await t.sync.setAnswer('q2', 'fine');
  await t.sched.advance(500);
  assert.equal(server.data.get('q2')!.value, 'fine');
  assert.equal(t.sync.getStatus(), 'conflict');
  await t.sync.setAnswer('q1', 'A edited');           // editing a conflicted question updates the local side
  assert.equal(t.sync.conflicts().q1!.local, 'A edited');
});

test('lost reply: the server applied the answer but the client never heard; the retry is recognised, not a conflict', async () => {
  const server = new FakeServer(); server.next = ['lost_reply'];
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'yes');
  await t.sched.advance(500);
  assert.equal(t.sync.getStatus(), 'offline');
  assert.equal(server.data.get('q1')!.version, 1, 'it did reach the server');
  await t.sched.advance(BACKOFF_MS[0]!);              // retry with baseVersion 0 => 409 with the same value
  assert.equal(t.sync.getStatus(), 'saved');
  assert.deepEqual(t.sync.conflicts(), {});
  assert.equal(t.sync.getVersion('q1'), 1);
});

test('rejected answers (validation) are dropped from the outbox and reported; a new edit clears the error', async () => {
  const server = new FakeServer(); server.next = ['invalid'];
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'bad'); await t.sched.advance(500);
  assert.deepEqual(t.sync.errors(), { q1: 'validation' });
  assert.equal(t.sync.pendingCount(), 0);
  assert.equal(t.sync.getStatus(), 'saved');
  await t.sync.setAnswer('q1', 'good');
  assert.deepEqual(t.sync.errors(), {});
  await t.sched.advance(500);
  assert.equal(server.data.get('q1')!.value, 'good');
});

test('not_editable (inspection completed elsewhere) locks the session and stops all sending', async () => {
  const server = new FakeServer(); server.next = ['locked'];
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'x'); await t.sync.setAnswer('q2', 'y');
  await t.sched.advance(500);
  assert.equal(t.sync.getStatus(), 'locked');
  assert.equal(server.calls.length, 1);
  await t.sync.setAnswer('q3', 'z'); await t.sched.advance(60_000);
  assert.equal(server.calls.length, 1);
  assert.equal(t.store.data.size, 0);
});

test('expired session: stop, tell the app once, never retry', async () => {
  const server = new FakeServer(); server.next = ['auth'];
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'x'); await t.sched.advance(500);
  assert.equal(t.sync.getStatus(), 'auth');
  assert.equal(t.authErrors(), 1);
  await t.sched.advance(120_000);
  assert.equal(server.calls.length, 1);
  assert.equal(t.sync.pendingCount(), 1, 'the answer is kept for after sign-in');
  assert.equal(t.store.data.size, 1);
});

test('clearing an answer is synced as null; unchanged values cause no request', async () => {
  const server = new FakeServer(); server.data.set('q1', { value: 'a', version: 1 });
  const t = await setup({ server });
  await t.sync.setAnswer('q1', 'a'); await t.sched.advance(500);
  assert.equal(server.calls.length, 0, 'same as the server value');
  await t.sync.setAnswer('q1', null); await t.sched.advance(500);
  assert.deepEqual(server.calls, [{ q: 'q1', value: null, baseVersion: 1 }]);
  assert.equal(t.sync.getValue('q1'), null);
});

test('HTTP adapter and error mapping', async () => {
  assert.deepEqual(toPutOutcome(new NetworkError()), { kind: 'network' });
  assert.deepEqual(toPutOutcome(new ApiError(401, 'unauthenticated')), { kind: 'auth' });
  assert.deepEqual(toPutOutcome(new ApiError(409, 'conflict', { current: { value: 'x', version: 4 } })), { kind: 'conflict', current: { value: 'x', version: 4 } });
  assert.deepEqual(toPutOutcome(new ApiError(409, 'conflict', { current: null })), { kind: 'conflict', current: null });
  assert.deepEqual(toPutOutcome(new ApiError(422, 'not_editable')), { kind: 'rejected', code: 'not_editable' });
  assert.deepEqual(toPutOutcome(new ApiError(403, 'forbidden')), { kind: 'rejected', code: 'forbidden' });
  assert.deepEqual(toPutOutcome(new ApiError(500, 'internal')), { kind: 'network' });
  assert.deepEqual(toPutOutcome(new ApiError(429, 'x')), { kind: 'network' });
  assert.deepEqual(toPutOutcome(new TypeError('boom')), { kind: 'network' });

  const seen: { path: string; init: any }[] = [];
  const api = createSyncApi({ async request(path, init) { seen.push({ path, init }); return { response: { version: 7 } } as never; } });
  assert.deepEqual(await api.putResponse('i1', 'q1', 'v', 2), { kind: 'ok', version: 7 });
  assert.deepEqual(seen[0], { path: '/inspections/i1/responses/q1', init: { method: 'PUT', body: { value: 'v', baseVersion: 2 } } });
  const failing = createSyncApi({ async request() { throw new ApiError(409, 'conflict', { current: { value: 1, version: 2 } }); } });
  assert.deepEqual(await failing.putResponse('i1', 'q1', 'v', 1), { kind: 'conflict', current: { value: 1, version: 2 } });
});
