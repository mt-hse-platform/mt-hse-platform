// Tests the deployment scripts in ops/ with stand-ins for psql, docker compose and rclone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIGRATIONS = join(ROOT, 'db/migrations');
const sorted = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

function tmp(): string { return mkdtempSync(join(tmpdir(), 'mthse-ops-')); }
function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const lines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);

/** psql stand-in: remembers applied migrations, logs commands, can fail on one file. Secrets passed with -v go to a separate log. */
function fakePsql(dir: string) {
  script(dir, 'psql', String.raw`
state="$STUB_DIR/applied"; log="$STUB_DIR/log"; vlog="$STUB_DIR/vlog"
sql=""; file=""; stdin_mode=1
while [ $# -gt 0 ]; do
  case "$1" in
    -c) sql="$2"; stdin_mode=0; shift 2;;
    -f) file="$2"; stdin_mode=0; shift 2;;
    -v) echo "$2" >> "$vlog"; shift 2;;
    *) shift;;
  esac
done
[ "$stdin_mode" = "1" ] && sql="$(cat)"
if [ -n "$file" ]; then
  echo "file $(basename "$file")" >> "$log"
  [ "$(basename "$file")" = "${'$'}{STUB_FAIL_ON:-}" ] && { echo "ERROR: simulated failure" >&2; exit 3; }
  exit 0
fi
echo "sql $sql" >> "$log"
case "$sql" in
  "SELECT 1 FROM schema_migrations WHERE name = '"*) n="${'$'}{sql#*name = \'}"; n="${'$'}{n%\'}"; grep -qx "$n" "$state" 2>/dev/null && echo 1 || true;;
  "INSERT INTO schema_migrations (name) VALUES ('"*) n="${'$'}{sql#*VALUES (\'}"; n="${'$'}{n%\')}"; echo "$n" >> "$state";;
esac
exit 0
`.replaceAll("${'$'}", '$'));
}

function runMigrate(stub: string, env: Record<string, string> = {}) {
  return spawnSync('sh', [join(ROOT, 'ops/migrate.sh')], {
    encoding: 'utf8', env: { PATH: `${stub}:${process.env.PATH}`, MIGRATIONS_DIR: MIGRATIONS, STUB_DIR: stub, ...env },
  });
}

test('migrations are applied in file-name order, once each', () => {
  assert.ok(sorted.length >= 5, 'the real migrations are present');
  assert.deepEqual(sorted, [...sorted].sort(), 'names sort in the intended order');
  const d = tmp(); fakePsql(d);
  const first = runMigrate(d);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(lines(join(d, 'log')).filter((l) => l.startsWith('file ')).map((l) => l.slice(5)), sorted);
  assert.deepEqual(lines(join(d, 'applied')), sorted);

  const second = runMigrate(d);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(lines(join(d, 'log')).filter((l) => l.startsWith('file ')).length, sorted.length, 'nothing is applied twice');
  assert.equal((second.stdout.match(/skip/g) ?? []).length, sorted.length);
});

test('a failing migration stops the run, is not recorded, and later ones are not attempted', () => {
  const d = tmp(); fakePsql(d);
  const failing = sorted[2]!;
  const r = runMigrate(d, { STUB_FAIL_ON: failing });
  assert.notEqual(r.status, 0);
  assert.deepEqual(lines(join(d, 'applied')), sorted.slice(0, 2));
  const attempted = lines(join(d, 'log')).filter((l) => l.startsWith('file ')).map((l) => l.slice(5));
  assert.deepEqual(attempted, sorted.slice(0, 3));
  assert.ok(!r.stdout.includes('migrations complete'));
});

test('application password: passed as a psql variable, never written into the SQL text', () => {
  const secret = "s3cr3t'pass$word!";
  const d = tmp(); fakePsql(d);
  const r = runMigrate(d, { APP_DB_PASSWORD: secret });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(join(d, 'log'), 'utf8');
  assert.ok(log.includes(`sql ALTER ROLE app_user LOGIN PASSWORD :'pw';`));
  assert.ok(!log.includes(secret), 'the secret is not in any SQL');
  assert.ok(readFileSync(join(d, 'vlog'), 'utf8').includes(`pw=${secret}`));
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));

  const d2 = tmp(); fakePsql(d2);
  runMigrate(d2);
  assert.ok(!readFileSync(join(d2, 'log'), 'utf8').includes('ALTER ROLE'), 'no password configured => no ALTER');
});

// ---------------- backup / restore / bootstrap ----------------

function fakeCompose(dir: string) {
  return script(dir, 'fakecompose', String.raw`
echo "compose $*" >> "$STUB_DIR/log"
case "$*" in
  *pg_dump*)
    [ "${'$'}{FAIL_DUMP:-0}" = "1" ] && { echo "pg_dump: error" >&2; exit 1; }
    head -c "${'$'}{DUMP_BYTES:-6000}" /dev/urandom | base64  # random text does not compress away, like a real dump
    [ "${'$'}{FAIL_LATE:-0}" = "1" ] && { echo "pg_dump: connection lost halfway" >&2; exit 1; }
    exit 0;;
  *" tar "*)
    [ "${'$'}{FAIL_TAR:-0}" = "1" ] && { echo "tar: error" >&2; exit 1; }
    head -c 3000 /dev/urandom | gzip -c;;
  *psql*) cat > "$STUB_DIR/stdin-$$" 2>/dev/null || true; [ -s "$STUB_DIR/stdin-$$" ] && cp "$STUB_DIR/stdin-$$" "$STUB_DIR/last-stdin"; rm -f "$STUB_DIR/stdin-$$";;
  *node*) echo "SELECT 'bootstrap sql';";;
esac
`.replaceAll("${'$'}", '$'));
}

function runBackup(d: string, out: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [join(ROOT, 'ops/backup.sh')], {
    encoding: 'utf8', env: { PATH: `${d}:${process.env.PATH}`, COMPOSE_CMD: join(d, 'fakecompose'), BACKUP_DIR: out, STUB_DIR: d, ...env },
  });
}

test('backup: creates a valid compressed dump and removes only old backups', () => {
  const d = tmp(); fakeCompose(d); const out = join(d, 'out'); spawnSync('mkdir', ['-p', out]);
  const old = join(out, 'mthse-20200101-000000.sql.gz'); writeFileSync(old, 'old');
  const t = Date.now() / 1000 - 30 * 86400; utimesSync(old, t, t);
  const recent = join(out, 'mthse-20261001-000000.sql.gz'); writeFileSync(recent, 'recent');
  const oldMedia = join(out, 'media-20200101-000000.tar.gz'); writeFileSync(oldMedia, 'old'); utimesSync(oldMedia, t, t);
  const recentMedia = join(out, 'media-20261001-000000.tar.gz'); writeFileSync(recentMedia, 'recent');
  writeFileSync(join(out, 'notes.txt'), 'keep me'); utimesSync(join(out, 'notes.txt'), t, t);

  const r = runBackup(d, out);
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(out).sort();
  assert.ok(!files.includes('mthse-20200101-000000.sql.gz') && !files.includes('media-20200101-000000.tar.gz'), 'older than 14 days: deleted (database and files)');
  assert.ok(files.includes('mthse-20261001-000000.sql.gz') && files.includes('media-20261001-000000.tar.gz'), 'recent: kept');
  const freshMedia = files.filter((f) => /^media-\d{8}-\d{6}\.tar\.gz$/.test(f) && f !== 'media-20261001-000000.tar.gz');
  assert.equal(freshMedia.length, 1, 'the uploaded files are archived too');
  assert.equal(spawnSync('gzip', ['-t', join(out, freshMedia[0]!)]).status, 0);
  assert.ok(lines(join(d, 'log')).some((l) => l.includes('exec -T api tar -C /data/media')));
  assert.ok(files.includes('notes.txt'), 'unrelated files are never touched');
  const fresh = files.filter((f) => /^mthse-\d{8}-\d{6}\.sql\.gz$/.test(f) && f !== 'mthse-20261001-000000.sql.gz');
  assert.equal(fresh.length, 1);
  assert.equal(spawnSync('gzip', ['-t', join(out, fresh[0]!)]).status, 0);
  assert.ok(!files.some((f) => f.endsWith('.partial')));
  assert.ok(lines(join(d, 'log')).some((l) => l.includes('exec -T postgres pg_dump -U postgres -d mthse')));
});

test('backup: a failing or suspiciously small dump never leaves a file that looks like a good backup', () => {
  for (const env of [{ FAIL_DUMP: '1' }, { DUMP_BYTES: '100' }, { FAIL_LATE: '1' }] as Record<string, string>[]) { // FAIL_LATE: a dump that dies halfway but is already big enough
    const d = tmp(); fakeCompose(d); const out = join(d, 'out');
    const r = runBackup(d, out, env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.deepEqual(readdirSync(out), [], `nothing left behind for ${JSON.stringify(env)}`);
  }
});

test('backup: a failing files archive fails the run without leaving a partial file; the database dump stays valid', () => {
  const d = tmp(); fakeCompose(d); const out = join(d, 'out');
  const r = runBackup(d, out, { FAIL_TAR: '1' });
  assert.notEqual(r.status, 0);
  const files = readdirSync(out);
  assert.ok(!files.some((f) => f.endsWith('.partial')) && !files.some((f) => f.startsWith('media-')), 'no partial or fake archive');
  assert.equal(files.filter((f) => f.startsWith('mthse-')).length, 1, 'the completed database dump is kept');
});

test('backup: copies the new file to the remote when RCLONE_REMOTE is set', () => {
  const d = tmp(); fakeCompose(d);
  script(d, 'rclone', 'echo "rclone $*" >> "$STUB_DIR/log"');
  const out = join(d, 'out');
  const r = runBackup(d, out, { RCLONE_REMOTE: 'gdrive:mthse-backups' });
  assert.equal(r.status, 0, r.stderr);
  const call = lines(join(d, 'log')).find((l) => l.startsWith('rclone'))!;
  assert.match(call, /^rclone copy .*mthse-\d{8}-\d{6}\.sql\.gz gdrive:mthse-backups$/);
  assert.ok(lines(join(d, 'log')).some((l) => /^rclone copy .*media-\d{8}-\d{6}\.tar\.gz gdrive:mthse-backups$/.test(l)), 'the files archive is copied as well');
  const d2 = tmp(); fakeCompose(d2);
  assert.equal(runBackup(d2, join(d2, 'out')).status, 0);
  assert.ok(!lines(join(d2, 'log')).some((l) => l.startsWith('rclone')), 'no remote configured => no rclone call');
});

test('restore: never overwrites the live database by accident; validates its inputs', () => {
  const d = tmp(); fakeCompose(d);
  const good = join(d, 'b.sql.gz'); spawnSync('sh', ['-c', `echo 'SELECT 1;' | gzip > ${good}`]);
  const run = (args: string[]) => spawnSync('bash', [join(ROOT, 'ops/restore.sh'), ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH!, COMPOSE_CMD: join(d, 'fakecompose'), STUB_DIR: d },
  });

  const refused = run([good, 'mthse']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Refusing/);
  assert.equal(run([join(d, 'missing.gz')]).status, 1);
  assert.equal(run([good, 'x; DROP DATABASE mthse']).status, 2, 'database names are validated');
  const notGzip = join(d, 'plain.sql'); writeFileSync(notGzip, 'not gzip');
  assert.notEqual(run([notGzip]).status, 0);
  assert.equal(lines(join(d, 'log')).length, 0, 'none of the refused runs touched the database');

  const ok = run([good]);
  assert.equal(ok.status, 0, ok.stderr);
  const log = lines(join(d, 'log')).join('\n');
  assert.ok(log.includes('DROP DATABASE IF EXISTS mthse_restore') && log.includes('CREATE DATABASE mthse_restore') && log.includes('-d mthse_restore'));
  assert.ok(readFileSync(join(d, 'last-stdin'), 'utf8').includes('SELECT 1;'), 'the dump is piped into psql');
  assert.equal(run([good, 'mthse', '--force']).status, 0, 'explicit --force is allowed');
});

test('bootstrap script: needs exactly four arguments and pipes the generated SQL into psql', () => {
  const d = tmp(); fakeCompose(d);
  const env = { PATH: process.env.PATH!, COMPOSE_CMD: join(d, 'fakecompose'), STUB_DIR: d };
  assert.equal(spawnSync('bash', [join(ROOT, 'ops/bootstrap-org.sh'), 'only one'], { encoding: 'utf8', env }).status, 1);
  const r = spawnSync('bash', [join(ROOT, 'ops/bootstrap-org.sh'), 'ريلاينس ريدى ميكس', 'a@b.co', "Mohamed O'Taher", 'UID123456789012345678901'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const log = lines(join(d, 'log')).join('\n');
  assert.ok(log.includes('--org ريلاينس ريدى ميكس --email a@b.co --name Mohamed O\'Taher --uid UID123456789012345678901'), 'arguments arrive intact');
  assert.ok(readFileSync(join(d, 'last-stdin'), 'utf8').includes('bootstrap sql'));
});

test('deploy script refuses to run without .env.production', () => {
  if (existsSync(join(ROOT, '.env.production'))) return;
  const r = spawnSync('bash', [join(ROOT, 'ops/deploy.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing \.env\.production/);
});

test('production compose file: required settings are mandatory and the database has no published port', () => {
  const y = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8');
  for (const v of ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'FIREBASE_PROJECT_ID', 'DOMAIN']) assert.ok(y.includes(`\${${v}:?`), `${v} must be required`);
  const pg = y.slice(y.indexOf('  postgres:'), y.indexOf('  migrate:'));
  assert.ok(!/^\s+ports:/m.test(pg), 'postgres must not publish ports');
  assert.ok(y.includes('service_completed_successfully'), 'the API waits for the migrations');
  assert.ok(!/POSTGRES_PASSWORD/.test(y.slice(y.indexOf('  api:'), y.indexOf('  caddy:'))), 'the API never receives the database administrator password');
  const example = readFileSync(join(ROOT, '.env.production.example'), 'utf8');
  for (const v of ['DOMAIN', 'POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'FIREBASE_PROJECT_ID']) assert.ok(new RegExp(`^${v}=`, 'm').test(example), v);
  assert.ok(readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('.env.production'));
});
