import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildBootstrapSql, sqlLiteral } from './bootstrapSql.ts';
import { DEFAULT_ROLE_GRANTS, ROLE_KEYS } from '../packages/shared/src/permissions.ts';

const UID = 'AbCdEfGhIjKlMnOpQrStUvWxYz12';
const base = { orgName: 'ريلاينس ريدى ميكس', adminEmail: 'MT.HSE.Platform@gmail.com', adminFullName: 'محمد طاهر', firebaseUid: UID };

/** Removes properly quoted SQL string literals so we can inspect what is left (the "code" part). */
const stripLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''");

test('generates org, all 7 roles, every grant, admin user and membership', () => {
  const sql = buildBootstrapSql(base);
  assert.ok(sql.includes("'ريلاينس ريدى ميكس'"));
  assert.ok(sql.includes("'محمد طاهر'"));
  assert.ok(sql.includes("'mt.hse.platform@gmail.com'"), 'email is normalised to lower case');
  for (const key of ROLE_KEYS) assert.ok(sql.includes(`'${key}'`), key);
  const rows = sql.match(/\(v_role, v_org, '[a-z]+\.[a-z]+', '(org|site|own|assigned)'\)/g) ?? [];
  const expected = Object.values(DEFAULT_ROLE_GRANTS).reduce((n, g) => n + g.length, 0);
  assert.equal(rows.length, expected);
  assert.ok(sql.includes('INSERT INTO memberships (org_id, user_id, role_id) VALUES (v_org, v_user, v_admin_role)'));
  assert.ok(sql.startsWith('-- ') && sql.includes('BEGIN;') && sql.trimEnd().endsWith('COMMIT;'));
});

test('sqlLiteral doubles quotes and rejects control characters', () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.throws(() => sqlLiteral('a\u0000b'));
  assert.throws(() => sqlLiteral('a\nb'));
});

test('SQL injection attempt stays inside string literals', () => {
  const evil = "x'); DROP TABLE users; --";
  const sql = buildBootstrapSql({ ...base, orgName: evil, adminFullName: evil });
  assert.ok(!/DROP/i.test(stripLiterals(sql)), 'DROP appears outside a string literal');
  assert.ok(sql.includes("'x''); DROP TABLE users; --'"));
});

test('invalid input is rejected before any SQL is produced', () => {
  assert.throws(() => buildBootstrapSql({ ...base, orgName: ' ' }));
  assert.throws(() => buildBootstrapSql({ ...base, adminEmail: 'not-an-email' }));
  assert.throws(() => buildBootstrapSql({ ...base, adminEmail: "a'b@x.com" }));
  assert.throws(() => buildBootstrapSql({ ...base, firebaseUid: 'short' }));
  assert.throws(() => buildBootstrapSql({ ...base, firebaseUid: UID + "'; --" }));
  assert.throws(() => buildBootstrapSql({ ...base, locale: 'fr' as 'ar' }));
});

test('CLI prints SQL, and fails with a clear message when arguments are missing', () => {
  const out = execFileSync('node', ['scripts/bootstrap-org.ts', '--org', 'Test Co', '--email', 'a@b.co', '--name', 'Tester', '--uid', UID], { encoding: 'utf8' });
  assert.ok(out.includes("'Test Co'"));
  const bad = spawnSync('node', ['scripts/bootstrap-org.ts', '--org', 'Test Co'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Required/);
  assert.equal(bad.stdout, '');
});
