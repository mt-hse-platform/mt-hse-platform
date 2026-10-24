import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskBlobStore, MemoryBlobStore, isValidBlobKey } from './blobStore.ts';

const ORG = '00000000-0000-0000-0000-00000000aaaa';
const ID = '11111111-2222-3333-4444-555555555555';
const KEY = `${ORG}/2026/${ID}`;

test('only well-formed keys are accepted; traversal and odd shapes are rejected', () => {
  assert.equal(isValidBlobKey(KEY), true);
  for (const bad of ['', '../etc/passwd', `${ORG}/2026/../${ID}`, `/${KEY}`, `${KEY}/extra`, `${ORG}/26/${ID}`, `${ORG}/2026/${ID}.png`, `${ORG}\\2026\\${ID}`, `${KEY}\0`, 'a/b/c']) {
    assert.equal(isValidBlobKey(bad), false, JSON.stringify(bad));
  }
});

test('disk store: round trip, overwrite, missing file, idempotent delete, no temporary files left', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mthse-blobs-'));
  const s = new DiskBlobStore(root);
  assert.equal(await s.get(KEY), null);
  await s.put(KEY, Buffer.from('first'));
  assert.equal((await s.get(KEY))!.toString(), 'first');
  await s.put(KEY, Buffer.from('second'));
  assert.equal((await s.get(KEY))!.toString(), 'second');
  assert.deepEqual(readdirSync(join(root, ORG, '2026')), [ID], 'only the final file remains');
  await s.delete(KEY);
  await s.delete(KEY);
  assert.equal(await s.get(KEY), null);
  assert.ok(!existsSync(join(root, ORG, '2026', ID)));
});

test('stores never touch paths outside their root, and buffers are copied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mthse-blobs-'));
  const s = new DiskBlobStore(root);
  for (const op of [() => s.put('../escape', Buffer.from('x')), () => s.get('../../etc/passwd'), () => s.delete('/etc/passwd')]) {
    await assert.rejects(op(), /invalid blob key/);
  }
  const m = new MemoryBlobStore();
  const data = Buffer.from('abc');
  await m.put(KEY, data);
  data[0] = 0x7a;
  assert.equal((await m.get(KEY))!.toString(), 'abc', 'later changes to the caller buffer do not alter stored data');
  await assert.rejects(m.put('nope', data), /invalid blob key/);
});
