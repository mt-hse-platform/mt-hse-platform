import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, NetworkError } from './apiClient.ts';
import { BACKOFF_MS } from './inspectionSync.ts';
import type { Scheduler } from './inspectionSync.ts';
import type { KeyValueStore } from './session.ts';
import { PhotoQueue, isLocalId, stripLocalIds, toUploadOutcome } from './photoQueue.ts';
import type { BlobStore, DeliverHandler, PhotoUploader, UploadOutcome } from './photoQueue.ts';

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
};
const memoryBlobs = (): BlobStore & { data: Map<string, Blob> } => {
  const data = new Map<string, Blob>();
  return { data, async put(k, b) { data.set(k, b); }, async get(k) { return data.get(k) ?? null; }, async remove(k) { data.delete(k); } };
};

class FakeScheduler implements Scheduler {
  now = 0; private seq = 0; private tasks: { id: number; at: number; fn: () => void }[] = [];
  set(fn: () => void, ms: number) { const id = ++this.seq; this.tasks.push({ id, at: this.now + ms, fn }); return id; }
  clear(h: unknown) { this.tasks = this.tasks.filter((t) => t.id !== h); }
  get pending() { return this.tasks.length; }
  async advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t.id !== due.id);
      this.now = due.at; due.fn(); await settle();
    }
    this.now = target; await settle();
  }
}

/** Scripted uploader: outcomes are consumed in order; once the script is empty every upload succeeds. */
function fakeUploader(script: UploadOutcome[] = []) {
  const calls: { questionId?: string; ownerId: string; size: number; kind?: string }[] = [];
  const removed: string[] = [];
  let n = 0;
  let gate: Promise<void> | null = null;
  const up: PhotoUploader & { calls: typeof calls; removed: string[]; hold(): () => void } = {
    calls, removed,
    hold() { let release!: () => void; gate = new Promise<void>((r) => { release = () => { gate = null; r(); }; }); return release; },
    async upload(params, blob) {
      calls.push({ questionId: params.questionId, ownerId: params.ownerId, size: blob.size, kind: params.kind });
      if (gate) await gate;
      return script.shift() ?? { kind: 'ok', mediaId: `m${++n}` };
    },
    async remove(id) { removed.push(id); },
  };
  return up;
}

const photo = (bytes = 3) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
const input = (over: Partial<{ inspectionId: string; questionId: string; blob: Blob }> = {}) => ({
  inspectionId: 'i1', questionId: 'q1', kind: 'photo' as const, blob: photo(), takenAt: '2026-10-24T10:00:00Z', ...over,
});

function setup(script: UploadOutcome[] = []) {
  const store = memoryStore(); const blobs = memoryBlobs(); const uploader = fakeUploader(script); const scheduler = new FakeScheduler();
  let authErrors = 0; let seq = 0;
  const make = () => new PhotoQueue({ store, blobs, uploader, scheduler, newId: () => `id${++seq}`, onAuthError: () => { authErrors++; } });
  const queue = make();
  const delivered: { questionId: string; mediaId: string }[] = [];
  const handler: DeliverHandler = async (it) => { delivered.push({ questionId: it.questionId, mediaId: it.mediaId }); return true; };
  return { store, blobs, uploader, scheduler, queue, make, delivered, handler, authErrors: () => authErrors };
}

test('online: the file is uploaded, handed to the screen once, and nothing is left on the device', async () => {
  const s = setup();
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  const item = await s.queue.enqueue(input());
  assert.ok(isLocalId(item.id));
  await settle();
  assert.deepEqual(s.delivered, [{ questionId: 'q1', mediaId: 'm1' }]);
  assert.equal(s.queue.unfinishedCount('i1'), 0);
  assert.equal(s.blobs.data.size, 0, 'the local copy is deleted after delivery');
  assert.equal(s.store.data.size, 0, 'the persistent list is empty again');
  assert.equal(s.uploader.calls.length, 1);
});

test('the upload carries the question, the inspection and the real bytes', async () => {
  const s = setup();
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  await s.queue.enqueue(input({ questionId: 'q_photo', blob: photo(7) }));
  await settle();
  assert.deepEqual(s.uploader.calls, [{ questionId: 'q_photo', ownerId: 'i1', size: 7, kind: 'photo' }]);
});

test('offline: the file stays, is retried with backoff, and is delivered when the network returns', async () => {
  const s = setup([{ kind: 'network' }, { kind: 'network' }]);
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  await s.queue.enqueue(input());
  await settle();
  assert.equal(s.uploader.calls.length, 1);
  assert.equal(s.queue.unfinishedCount('i1'), 1);
  assert.equal(s.blobs.data.size, 1, 'the photo is safe on the device while offline');
  assert.deepEqual(s.delivered, []);

  await s.scheduler.advance(BACKOFF_MS[0]! - 1);
  assert.equal(s.uploader.calls.length, 1, 'no early retry');
  await s.scheduler.advance(1);
  assert.equal(s.uploader.calls.length, 2, 'first retry after the first backoff');
  await s.scheduler.advance(BACKOFF_MS[1]!);
  assert.equal(s.uploader.calls.length, 3);
  assert.deepEqual(s.delivered, [{ questionId: 'q1', mediaId: 'm1' }]);
  assert.equal(s.queue.unfinishedCount('i1'), 0);
});

test('"online" event retries at once instead of waiting for the timer', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  await s.queue.enqueue(input());
  await settle();
  assert.equal(s.delivered.length, 0);
  s.queue.notifyOnline();
  await settle();
  assert.equal(s.delivered.length, 1);
});

test('files wait in the line in order; one network failure stops the rest of the pass', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  const release = s.uploader.hold();                       // both files are in the line before the first upload answers
  await s.queue.enqueue(input({ questionId: 'qa' }));
  await s.queue.enqueue(input({ questionId: 'qb' }));
  release();
  await settle();
  assert.equal(s.uploader.calls.length, 1, 'does not hammer the network with the second file');
  s.queue.notifyOnline();
  await settle();
  assert.deepEqual(s.delivered.map((d) => d.questionId), ['qa', 'qb'], 'order kept');
});

test('app closed after the upload but before the answer was saved: it is NOT uploaded twice', async () => {
  const s = setup();
  await s.queue.init();                                   // no screen attached: upload happens, delivery waits
  await s.queue.enqueue(input());
  await settle();
  assert.equal(s.uploader.calls.length, 1);
  assert.equal(s.queue.unfinishedCount('i1'), 1, 'uploaded but not yet part of the answer');

  const reopened = s.make();                               // "restart": new object, same storage
  await reopened.init();
  await settle();
  assert.equal(s.uploader.calls.length, 1, 'no second upload after restart');
  const got: string[] = [];
  reopened.attach('i1', async (it) => { got.push(it.mediaId); return true; });
  await settle();
  assert.deepEqual(got, ['m1']);
  assert.equal(reopened.unfinishedCount('i1'), 0);
  assert.equal(s.blobs.data.size, 0);
});

test('a file queued before a restart is uploaded after it', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.queue.init();
  await s.queue.enqueue(input());
  await settle();
  const reopened = s.make();
  const got: string[] = [];
  await reopened.init();
  reopened.attach('i1', async (it) => { got.push(it.mediaId); return true; });
  await settle();
  assert.equal(got.length, 1);
  assert.equal(s.uploader.calls.length, 2);
});

test('a file the server refuses is marked failed, keeps the others going, and can be retried', async () => {
  const s = setup([{ kind: 'rejected', key: 'validation.file_type' }]);
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  const bad = await s.queue.enqueue(input({ questionId: 'qa' }));
  await s.queue.enqueue(input({ questionId: 'qb' }));
  await settle();
  assert.deepEqual(s.delivered.map((d) => d.questionId), ['qb'], 'the good file was not blocked');
  const left = s.queue.list('i1');
  assert.equal(left.length, 1);
  assert.equal(left[0]!.failed?.key, 'validation.file_type');
  assert.equal(s.queue.unfinishedCount('i1'), 1, 'a failed file still blocks completion until the person deals with it');
  assert.equal(s.blobs.data.size, 1, 'the photo is kept so it can be retried');

  await s.queue.retry(bad.id);
  await settle();
  assert.deepEqual(s.delivered.map((d) => d.questionId), ['qb', 'qa']);
  assert.equal(s.queue.unfinishedCount('i1'), 0);
});

test('session expired: stops, tells the app once, and resumes after signing in', async () => {
  const s = setup([{ kind: 'auth' }]);
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  await s.queue.enqueue(input());
  await settle();
  assert.equal(s.authErrors(), 1);
  assert.equal(s.scheduler.pending, 0, 'no retry timer while the session is invalid');
  await s.queue.enqueue(input({ questionId: 'qb' }));
  await settle();
  assert.equal(s.uploader.calls.length, 1, 'nothing more is sent with an invalid session');
  s.queue.notifyOnline();
  await settle();
  assert.equal(s.delivered.length, 2);
});

test('without a screen for that inspection the file waits; a screen for ANOTHER inspection does not take it', async () => {
  const s = setup();
  await s.queue.init();
  const other: string[] = [];
  s.queue.attach('i2', async (it) => { other.push(it.mediaId); return true; });
  await s.queue.enqueue(input({ inspectionId: 'i1' }));
  await settle();
  assert.deepEqual(other, []);
  assert.equal(s.queue.unfinishedCount('i1'), 1);
  assert.equal(s.queue.unfinishedCount('i2'), 0);
});

test('the screen refuses (inspection closed): the file is marked failed, not silently lost or forgotten', async () => {
  const s = setup();
  await s.queue.init();
  s.queue.attach('i1', async () => false);
  await s.queue.enqueue(input());
  await settle();
  const [it] = s.queue.list('i1');
  assert.equal(it?.failed?.key, 'media.queueClosed');
  assert.equal(s.blobs.data.size, 1);
});

test('a screen that throws does not lose the file: it is delivered next time', async () => {
  const s = setup();
  await s.queue.init();
  s.queue.attach('i1', async () => { throw new Error('boom'); });
  await s.queue.enqueue(input());
  await settle();
  assert.equal(s.queue.unfinishedCount('i1'), 1);
  s.queue.attach('i1', s.handler);
  await settle();
  assert.equal(s.delivered.length, 1);
  assert.equal(s.queue.unfinishedCount('i1'), 0);
});

test('a missing local copy is reported instead of looping forever', async () => {
  const s = setup();
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  const release = s.uploader.hold();
  const a = await s.queue.enqueue(input({ questionId: 'qa' }));
  await settle();
  const b = await s.queue.enqueue(input({ questionId: 'qb' }));
  s.blobs.data.delete(b.id);                               // the browser cleared its storage
  release();
  await settle();
  assert.equal(s.queue.list('i1').find((i) => i.id === b.id)?.failed?.key, 'media.queueLost');
  assert.ok(a.id);
});

test('removing a waiting file deletes the local copy and the record', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  const it = await s.queue.enqueue(input());
  await settle();
  await s.queue.discard(it.id);
  assert.equal(s.queue.unfinishedCount('i1'), 0);
  assert.equal(s.blobs.data.size, 0);
  assert.equal(s.store.data.size, 0);
  s.queue.notifyOnline();
  await settle();
  assert.equal(s.uploader.calls.length, 1, 'a removed file is never uploaded');
});

test('removing a file WHILE it is uploading deletes the uploaded copy and never delivers it', async () => {
  const s = setup();
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  const release = s.uploader.hold();
  const it = await s.queue.enqueue(input());
  await settle();
  await s.queue.discard(it.id);
  release();
  await settle();
  assert.deepEqual(s.uploader.removed, ['m1'], 'the orphan on the server is cleaned up');
  assert.deepEqual(s.delivered, []);
  assert.equal(s.queue.unfinishedCount('i1'), 0);
});

test('removing an uploaded-but-not-attached file also removes it from the server', async () => {
  const s = setup();
  await s.queue.init();
  const it = await s.queue.enqueue(input());
  await settle();
  await s.queue.discard(it.id);
  assert.deepEqual(s.uploader.removed, ['m1']);
});

test('discardQuestion removes only that question files', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.queue.init();
  await s.queue.enqueue(input({ questionId: 'qa' }));
  await s.queue.enqueue(input({ questionId: 'qa' }));
  await s.queue.enqueue(input({ questionId: 'qb' }));
  await settle();
  await s.queue.discardQuestion('i1', 'qa');
  assert.deepEqual(s.queue.list('i1').map((i) => i.questionId), ['qb']);
});

test('clear (sign-out) empties the list and the device copies', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.queue.init();
  await s.queue.enqueue(input());
  await settle();
  await s.queue.clear();
  assert.equal(s.queue.totalCount(), 0);
  assert.equal(s.blobs.data.size, 0);
  assert.equal(s.store.data.size, 0);
});

test('subscribers are told about every change and can stop listening', async () => {
  const s = setup();
  await s.queue.init();
  let n = 0;
  const off = s.queue.subscribe(() => { n++; });
  await s.queue.enqueue(input());
  await settle();
  assert.ok(n >= 2);
  off();
  const before = n;
  await s.queue.enqueue(input());
  await settle();
  assert.equal(n, before);
});

test('a corrupted saved list is ignored, not fatal', async () => {
  const s = setup();
  s.store.data.set('mthse.photoq.v1', '{not json');
  await s.queue.init();
  assert.equal(s.queue.totalCount(), 0);
});

test('placeholders never reach the server answer', () => {
  assert.deepEqual(stripLocalIds(['srv1', 'local:a', 'srv2']), ['srv1', 'srv2']);
  assert.equal(stripLocalIds(['local:a']), null, 'only placeholders left = not answered');
  const same = ['a', 'b'];
  assert.equal(stripLocalIds(same), same, 'untouched when there is nothing to strip');
  assert.equal(stripLocalIds(null), null);
  assert.equal(stripLocalIds('x'), 'x');
  assert.equal(isLocalId('local:x'), true);
  assert.equal(isLocalId('9f1c'), false);
  assert.equal(isLocalId(5), false);
});

test('upload failures are classified: retry later, sign in again, or give up', () => {
  assert.deepEqual(toUploadOutcome(new NetworkError()), { kind: 'network' });
  assert.deepEqual(toUploadOutcome(new ApiError(401, 'unauthenticated')), { kind: 'auth' });
  for (const status of [408, 429, 500, 502, 503]) assert.deepEqual(toUploadOutcome(new ApiError(status, 'x')), { kind: 'network' }, String(status));
  assert.deepEqual(toUploadOutcome(new ApiError(413, 'payload_too_large')), { kind: 'rejected', key: 'validation.file_too_large', params: { maxMb: 15 } });
  const type = toUploadOutcome(new ApiError(422, 'validation', { file: [{ code: 'file_type' }] }));
  assert.equal(type.kind, 'rejected');
  assert.equal(toUploadOutcome(new ApiError(403, 'forbidden')).kind, 'rejected');
  assert.deepEqual(toUploadOutcome(new TypeError('failed to fetch')), { kind: 'network' });
});

test('discardInspection removes the files of that inspection only', async () => {
  const s = setup([{ kind: 'network' }]);
  await s.queue.init();
  await s.queue.enqueue(input({ inspectionId: 'i1', questionId: 'qa' }));
  await s.queue.enqueue(input({ inspectionId: 'i1', questionId: 'qb' }));
  await s.queue.enqueue(input({ inspectionId: 'i2', questionId: 'qa' }));
  await settle();
  await s.queue.discardInspection('i1');
  assert.equal(s.queue.unfinishedCount('i1'), 0);
  assert.equal(s.queue.unfinishedCount('i2'), 1);
  assert.equal(s.blobs.data.size, 1);
});

test('a voice note goes through the same line and is uploaded as audio', async () => {
  const s = setup();
  await s.queue.init();
  s.queue.attach('i1', s.handler);
  const blob = new Blob([new Uint8Array(9)], { type: 'audio/webm;codecs=opus' });
  const it = await s.queue.enqueue({ inspectionId: 'i1', questionId: 'q_voice', kind: 'audio', blob, takenAt: '2026-10-24T10:00:00Z' });
  assert.equal(it.mime, 'audio/webm;codecs=opus');
  await settle();
  assert.deepEqual(s.uploader.calls, [{ questionId: 'q_voice', ownerId: 'i1', size: 9, kind: 'audio' }]);
  assert.deepEqual(s.delivered, [{ questionId: 'q_voice', mediaId: 'm1' }]);
});
