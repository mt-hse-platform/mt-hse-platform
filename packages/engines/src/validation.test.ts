import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateField, validateForm } from './validation.ts';

const codes = (r: ReturnType<typeof validateField>) => r.map((e) => e.code);

test('required: empty, whitespace, null and empty array are rejected; 0 and false-like values are not empty', () => {
  for (const v of [undefined, null, '', '   ', []]) {
    assert.deepEqual(codes(validateField(v, { type: 'text', required: true })), ['required']);
  }
  assert.deepEqual(validateField(0, { type: 'number', required: true }), []);
});

test('optional empty value passes without further checks', () => {
  assert.deepEqual(validateField('', { type: 'number', min: 5 }), []);
});

test('text length limits', () => {
  assert.deepEqual(codes(validateField('ab', { type: 'text', minLength: 3 })), ['min_length']);
  assert.deepEqual(codes(validateField('abcdef', { type: 'text', maxLength: 5 })), ['max_length']);
  assert.deepEqual(validateField('abcd', { type: 'text', minLength: 3, maxLength: 5 }), []);
  assert.deepEqual(codes(validateField(12, { type: 'text' })), ['invalid_type']);
});

test('number: integer, range, numeric strings, garbage', () => {
  assert.deepEqual(codes(validateField(1.5, { type: 'number' })), ['not_integer']);
  assert.deepEqual(validateField(1.5, { type: 'decimal' }), []);
  assert.deepEqual(codes(validateField(-1, { type: 'number', min: 0 })), ['min']);
  assert.deepEqual(codes(validateField(11, { type: 'number', max: 10 })), ['max']);
  assert.deepEqual(validateField('7', { type: 'number', min: 1, max: 10 }), []);
  assert.deepEqual(codes(validateField('abc', { type: 'number' })), ['invalid_number']);
  assert.deepEqual(codes(validateField(Infinity, { type: 'decimal' })), ['invalid_number']);
});

test('date: format, impossible dates, min/max range', () => {
  assert.deepEqual(validateField('2026-02-28', { type: 'date' }), []);
  assert.deepEqual(codes(validateField('2026-02-30', { type: 'date' })), ['invalid_date']);
  assert.deepEqual(codes(validateField('28/02/2026', { type: 'date' })), ['invalid_date']);
  assert.deepEqual(codes(validateField('2026-01-01', { type: 'date', minDate: '2026-02-01' })), ['date_before_min']);
  assert.deepEqual(codes(validateField('2026-03-01', { type: 'date', maxDate: '2026-02-01' })), ['date_after_max']);
});

test('time and datetime', () => {
  assert.deepEqual(validateField('23:59', { type: 'time' }), []);
  assert.deepEqual(codes(validateField('24:00', { type: 'time' })), ['invalid_time']);
  assert.deepEqual(validateField('2026-10-02T10:30:00Z', { type: 'datetime' }), []);
  assert.deepEqual(codes(validateField('not a date', { type: 'datetime' })), ['invalid_datetime']);
});

test('select and multi-select', () => {
  const opts = ['yes', 'no', 'na'];
  assert.deepEqual(validateField('yes', { type: 'single_select', options: opts }), []);
  assert.deepEqual(codes(validateField('maybe', { type: 'single_select', options: opts })), ['invalid_option']);
  assert.deepEqual(validateField(['yes', 'no'], { type: 'multi_select', options: opts, maxSelections: 2 }), []);
  assert.deepEqual(codes(validateField(['yes', 'no', 'na'], { type: 'multi_select', options: opts, maxSelections: 2 })), ['too_many_selections']);
  assert.deepEqual(codes(validateField(['zzz'], { type: 'multi_select', options: opts })), ['invalid_option']);
});

test('file type and size', () => {
  const rule = { type: 'file' as const, allowedMimeTypes: ['image/jpeg', 'image/png'], maxFileBytes: 5 * 1048576 };
  assert.deepEqual(validateField({ name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 }, rule), []);
  assert.deepEqual(codes(validateField({ name: 'a.exe', mimeType: 'application/x-msdownload', sizeBytes: 1000 }, rule)), ['file_type']);
  const big = validateField({ name: 'a.png', mimeType: 'image/png', sizeBytes: 6 * 1048576 }, rule);
  assert.deepEqual(big, [{ code: 'file_too_large', params: { maxMb: 5 } }]);
});

test('validateForm skips fields hidden by conditional logic', () => {
  const rules = {
    a: { type: 'text' as const, required: true },
    b: { type: 'text' as const, required: true },
  };
  const all = validateForm({}, rules);
  assert.equal(all.ok, false);
  assert.deepEqual(Object.keys(all.errors).sort(), ['a', 'b']);

  const partial = validateForm({}, rules, (k) => k !== 'b');
  assert.deepEqual(Object.keys(partial.errors), ['a']);

  assert.deepEqual(validateForm({ a: 'x', b: 'y' }, rules), { ok: true, errors: {} });
});
