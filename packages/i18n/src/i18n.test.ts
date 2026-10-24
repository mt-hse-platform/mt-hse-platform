import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, directionOf, translate, translateValidation, userMessageKey } from './index.ts';
import { validateField } from '../../engines/src/validation.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('Arabic and English have exactly the same keys', () => {
  assert.deepEqual(Object.keys(dictionaries.ar).sort(), Object.keys(dictionaries.en).sort());
});

test('no empty translations, and placeholders match between languages', () => {
  for (const key of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
    assert.ok(dictionaries.ar[key].trim().length > 0, `empty ar: ${key}`);
    assert.deepEqual(placeholders(dictionaries.ar[key]), placeholders(dictionaries.en[key]), `placeholders differ: ${key}`);
  }
});

test('direction follows locale', () => {
  assert.equal(directionOf('ar'), 'rtl');
  assert.equal(directionOf('en'), 'ltr');
});

test('interpolation works in both languages', () => {
  assert.equal(translate('en', 'validation.min_length', { min: 3 }), 'Must be at least 3 characters.');
  assert.match(translate('ar', 'validation.min_length', { min: 3 }), /3/);
});

test('every validation code the engine can emit has a translation', () => {
  const samples = [
    validateField('', { type: 'text', required: true }),
    validateField('a', { type: 'text', minLength: 2, maxLength: 0 }),
    validateField(1.5, { type: 'number', min: 5, max: 0 }),
    validateField('x', { type: 'number' }),
    validateField('2026-13-01', { type: 'date' }),
    validateField('2026-01-01', { type: 'date', minDate: '2026-02-01' }),
    validateField('2026-03-01', { type: 'date', maxDate: '2026-02-01' }),
    validateField('99:99', { type: 'time' }),
    validateField('zzz', { type: 'datetime' }),
    validateField('q', { type: 'single_select', options: ['a'] }),
    validateField(['a', 'b'], { type: 'multi_select', options: ['a', 'b'], maxSelections: 1 }),
    validateField({ name: 'x', mimeType: 'text/plain', sizeBytes: 9e9 }, { type: 'file', allowedMimeTypes: ['image/png'], maxFileBytes: 1 }),
    validateField(5, { type: 'text' }),
  ].flat();
  assert.ok(samples.length > 10);
  for (const e of samples) {
    for (const locale of ['ar', 'en'] as const) {
      const msg = translateValidation(locale, e);
      assert.notEqual(msg, translate(locale, 'error.unknown'), `missing translation for code ${e.code}`);
      assert.ok(!/\{\w+\}/.test(msg), `unreplaced placeholder in ${e.code}/${locale}: ${msg}`);
    }
  }
});

test('technical errors map to safe messages and never leak raw text', () => {
  assert.equal(userMessageKey({ code: 'permission-denied', message: 'FirebaseError: Missing or insufficient permissions' }), 'error.permission_denied');
  assert.equal(userMessageKey({ code: 'auth/wrong-password' }), 'error.auth_invalid');
  assert.equal(userMessageKey({ code: 'auth/id-token-expired' }), 'error.session_expired');
  assert.equal(userMessageKey({ status: 403 }), 'error.permission_denied');
  assert.equal(userMessageKey({ status: 401 }), 'error.session_expired');
  assert.equal(userMessageKey(new TypeError('Failed to fetch')), 'error.network');
  assert.equal(userMessageKey({ code: 'auth/network-request-failed' }), 'error.network');
  assert.equal(userMessageKey(new Error('boom: SELECT * FROM users')), 'error.unknown');
  assert.equal(userMessageKey({ code: 'org_required' }), 'error.org_required');
  for (const [code, key] of [['not_found', 'error.not_found'], ['conflict', 'error.conflict'], ['pdf_unavailable', 'error.pdf_unavailable'], ['incomplete', 'runner.missing'], ['template_invalid', 'error.template_invalid'], ['last_admin', 'error.last_admin'], ['already_invited', 'error.already_invited'], ['email_not_verified', 'error.email_not_verified'], ['auth/email-already-in-use', 'error.email_in_use'], ['auth/weak-password', 'login.passwordShort']] as const) {
    assert.equal(userMessageKey({ code }), key, code);
  }
  assert.equal(userMessageKey(null), 'error.unknown');
  for (const locale of ['ar', 'en'] as const) {
    const msg = translate(locale, userMessageKey({ code: 'permission-denied', message: 'FirebaseError: x' }));
    assert.ok(!msg.includes('Firebase'));
  }
});
