import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_RULES, checkUpload } from '../../../../packages/engines/src/media/rules.ts';
import { AUDIO_BITS_PER_SECOND, MAX_RECORD_SECONDS, audioSlotsLeft, formatDuration, pickAudioMime, recordedBlob } from './audio.ts';

test('picks the best format the browser supports', () => {
  assert.equal(pickAudioMime(() => true), 'audio/webm;codecs=opus', 'Chrome / Android');
  assert.equal(pickAudioMime((m) => m === 'audio/mp4'), 'audio/mp4', 'Safari / iPhone');
  assert.equal(pickAudioMime((m) => m.startsWith('audio/ogg')), 'audio/ogg;codecs=opus', 'Firefox');
  assert.equal(pickAudioMime(() => false), null, 'no recording support');
});

test('a browser that throws while asking is treated as "not supported", not as a crash', () => {
  assert.equal(pickAudioMime(() => { throw new Error('boom'); }), null);
  assert.equal(pickAudioMime((m) => { if (m.includes('opus')) throw new Error('x'); return m === 'audio/webm'; }), 'audio/webm');
});

test('every format we may record is one the server accepts', () => {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    const base = m.split(';')[0]!;
    assert.ok(MEDIA_RULES.audio.mimes.includes(base), m);
  }
});

test('a recording is accepted by the server rules (real container bytes, matching declared type)', () => {
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(40).fill(1)]);
  const mp4 = Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from('ftypM4A '), ...new Array(40).fill(1)]);
  assert.deepEqual(checkUpload('audio', 'audio/webm;codecs=opus', webm), { ok: true, mime: 'audio/webm' });
  assert.deepEqual(checkUpload('audio', 'audio/mp4', mp4), { ok: true, mime: 'audio/mp4' });
});

test('timer text', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(65.9), '1:05');
  assert.equal(formatDuration(300), '5:00');
  for (const bad of [-4, NaN, Infinity]) assert.equal(formatDuration(bad), '0:00', String(bad));
});

test('voice-note slots left follow the server limit and never go negative', () => {
  assert.equal(audioSlotsLeft(0), MEDIA_RULES.audio.maxPerQuestion);
  assert.equal(audioSlotsLeft(MEDIA_RULES.audio.maxPerQuestion), 0);
  assert.equal(audioSlotsLeft(99), 0);
  assert.equal(audioSlotsLeft(-3), MEDIA_RULES.audio.maxPerQuestion);
});

test('recorded pieces are joined with the recorder type, or the chosen type when the recorder reports none', () => {
  const b = recordedBlob([new Blob([new Uint8Array(10)]), new Blob([new Uint8Array(5)])], 'audio/webm;codecs=opus', 'audio/webm');
  assert.equal(b?.size, 15);
  assert.equal(b?.type, 'audio/webm;codecs=opus');
  assert.equal(recordedBlob([new Blob([new Uint8Array(3)])], '', 'audio/mp4')?.type, 'audio/mp4');
});

test('nothing recorded, or too big for the server, gives no file', () => {
  assert.equal(recordedBlob([], 'audio/webm', 'audio/webm'), null);
  assert.equal(recordedBlob([new Blob([])], 'audio/webm', 'audio/webm'), null);
  const big = { size: MEDIA_RULES.audio.maxBytes + 1 } as Blob;
  assert.equal(recordedBlob([big], 'audio/webm', 'audio/webm'), null);
});

test('the time limit keeps a recording well under the size limit', () => {
  const bytes = (MAX_RECORD_SECONDS * AUDIO_BITS_PER_SECOND) / 8;
  assert.ok(bytes < MEDIA_RULES.audio.maxBytes / 4, `${bytes} bytes`);
});
