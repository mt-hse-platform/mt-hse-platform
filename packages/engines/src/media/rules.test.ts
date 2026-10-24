import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_RULES, checkUpload, sniffMime } from './rules.ts';

const bytes = (...head: number[]) => Uint8Array.from([...head, ...new Array(64).fill(7)]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = Uint8Array.from([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP'), ...new Array(32).fill(0)]);
const PDF = Uint8Array.from([...Buffer.from('%PDF-1.7\n'), ...new Array(32).fill(0)]);
const M4A = Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from('ftypM4A '), ...new Array(32).fill(0)]);
const MP3 = Uint8Array.from([...Buffer.from('ID3'), 3, 0, 0, 0, 0, 0, 0, ...new Array(32).fill(0)]);

test('content is recognised from its bytes', () => {
  assert.equal(sniffMime(JPEG), 'image/jpeg');
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(WEBP), 'image/webp');
  assert.equal(sniffMime(PDF), 'application/pdf');
  assert.equal(sniffMime(M4A), 'audio/mp4');
  assert.equal(sniffMime(MP3), 'audio/mpeg');
  assert.equal(sniffMime(Uint8Array.from(Buffer.from('<html><script>alert(1)</script></html>'))), null);
  assert.equal(sniffMime(Uint8Array.from(Buffer.from('MZ\x90\x00 executable ........'))), null);
  assert.equal(sniffMime(Uint8Array.from([1, 2, 3])), null, 'too short');
  assert.equal(sniffMime(Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))), null, 'SVG is never accepted');
});

test('uploads are accepted only when kind, declared type and real bytes agree', () => {
  assert.deepEqual(checkUpload('photo', 'image/jpeg', JPEG), { ok: true, mime: 'image/jpeg' });
  assert.deepEqual(checkUpload('photo', 'image/jpeg; charset=binary', JPEG), { ok: true, mime: 'image/jpeg' });
  assert.deepEqual(checkUpload('photo', 'IMAGE/PNG', PNG), { ok: true, mime: 'image/png' });
  assert.deepEqual(checkUpload('signature', 'image/png', PNG), { ok: true, mime: 'image/png' });
  assert.deepEqual(checkUpload('file', 'application/pdf', PDF), { ok: true, mime: 'application/pdf' });
  assert.deepEqual(checkUpload('audio', 'audio/mp4', M4A), { ok: true, mime: 'audio/mp4' });

  assert.deepEqual(checkUpload('photo', 'image/png', JPEG), { ok: false, code: 'type_mismatch' }, 'header says PNG, bytes say JPEG');
  assert.deepEqual(checkUpload('photo', 'image/jpeg', Uint8Array.from(Buffer.from('<script>alert(1)</script>........'))), { ok: false, code: 'unsupported_type' });
  assert.deepEqual(checkUpload('photo', 'application/pdf', PDF), { ok: false, code: 'unsupported_type' }, 'a PDF is not a photo');
  assert.deepEqual(checkUpload('signature', 'image/jpeg', JPEG), { ok: false, code: 'unsupported_type' }, 'signatures are PNG only');
  assert.deepEqual(checkUpload('video', 'video/mp4', M4A), { ok: false, code: 'invalid_kind' });
  assert.deepEqual(checkUpload('photo', 'image/jpeg', new Uint8Array(0)), { ok: false, code: 'empty' });
  const big = new Uint8Array(MEDIA_RULES.photo.maxBytes + 1); big.set(JPEG);
  assert.deepEqual(checkUpload('photo', 'image/jpeg', big), { ok: false, code: 'too_large' });
  const sigBig = new Uint8Array(MEDIA_RULES.signature.maxBytes + 1); sigBig.set(PNG);
  assert.deepEqual(checkUpload('signature', 'image/png', sigBig), { ok: false, code: 'too_large' });
});
