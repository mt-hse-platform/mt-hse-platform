import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, NetworkError } from './apiClient.ts';
import { fitWithin, idsOf, uploadError, uploadPath, withId, withoutId, MAX_PHOTO_EDGE } from './media.ts';

test('photos are shrunk to fit, keep their proportions and are never enlarged', () => {
  assert.deepEqual(fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 }, 'portrait');
  assert.deepEqual(fitWithin(1200, 800, 1600), { width: 1200, height: 800 }, 'already small');
  assert.deepEqual(fitWithin(1600, 1600, 1600), { width: 1600, height: 1600 });
  assert.deepEqual(fitWithin(10000, 1, 1600), { width: 1600, height: 1 }, 'extreme panorama keeps at least one pixel');
  assert.equal(MAX_PHOTO_EDGE, 1600);
});

test('the answer of a photo question is a clean list of media ids', () => {
  assert.deepEqual(idsOf(['a', 'b']), ['a', 'b']);
  for (const junk of [null, undefined, 'a', 5, {}, [1, null, '', 'ok']]) assert.ok(Array.isArray(idsOf(junk)));
  assert.deepEqual(idsOf([1, null, '', 'ok']), ['ok']);
  assert.deepEqual(withId(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(withId(['a'], 'a'), ['a'], 'no duplicates');
  assert.deepEqual(withId(null, 'x'), ['x']);
  assert.deepEqual(withoutId(['a', 'b'], 'a'), ['b']);
  assert.equal(withoutId(['a'], 'a'), null, 'removing the last file clears the answer');
});

test('upload address carries only what is set, safely encoded', () => {
  assert.equal(uploadPath({ ownerType: 'inspection', ownerId: 'i1', kind: 'photo', questionId: 'q_photo' }), '/media?ownerType=inspection&ownerId=i1&kind=photo&questionId=q_photo');
  assert.equal(uploadPath({ ownerType: 'issue', ownerId: 'x', kind: 'file' }), '/media?ownerType=issue&ownerId=x&kind=file');
  const p = uploadPath({ ownerType: 'inspection', ownerId: 'i1', kind: 'photo', caption: 'a&b=c', lat: 30.1, lng: 0, takenAt: '2026-10-03T10:00:00Z' });
  const q = new URL(`http://x${p}`).searchParams;
  assert.equal(q.get('caption'), 'a&b=c');
  assert.equal(q.get('lat'), '30.1');
  assert.equal(q.get('lng'), '0', 'zero is a real coordinate');
});

test('upload failures become messages the person can act on', () => {
  assert.deepEqual(uploadError(new NetworkError()), { key: 'media.needsConnection' });
  assert.deepEqual(uploadError(new ApiError(413, 'payload_too_large')), { key: 'validation.file_too_large', params: { maxMb: 15 } });
  assert.deepEqual(uploadError(new ApiError(422, 'validation', { file: [{ code: 'file_type' }] })), { key: 'validation.file_type', params: undefined });
  assert.deepEqual(uploadError(new ApiError(422, 'validation', { file: [{ code: 'file_too_large', params: { maxMb: 8 } }] })), { key: 'validation.file_too_large', params: { maxMb: 8 } });
  assert.deepEqual(uploadError(new ApiError(422, 'validation', { file: [{ code: 'too_many_selections', params: { max: 20 } }] })), { key: 'validation.too_many_selections', params: { max: 20 } });
  assert.deepEqual(uploadError(new ApiError(422, 'not_editable')), { key: 'error.not_editable' });
  assert.deepEqual(uploadError(new ApiError(403, 'forbidden')), { key: 'error.permission_denied' });
  assert.deepEqual(uploadError(new ApiError(422, 'validation', { file: [{ code: 'something_new' }] })), { key: 'error.validation' }, 'unknown codes fall back to a generic message');
  assert.deepEqual(uploadError(new Error('boom')), { key: 'error.unknown' });
});
