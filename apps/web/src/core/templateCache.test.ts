import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, NetworkError } from './apiClient.ts';
import type { KeyValueStore } from './session.ts';
import { TemplateCache } from './templateCache.ts';
import type { PublishedTemplate, TemplateApi } from './templateCache.ts';
import type { TemplateContent } from '../../../../packages/engines/src/template/types.ts';

const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
};
const content = (tag: string) => ({ pages: [{ id: tag, title: { en: tag }, items: [] }] }) as unknown as TemplateContent;
const tpl = (id: string, versionId: string | null, en = id): PublishedTemplate => ({ id, name: { en }, description: null, publishedVersionId: versionId });

function fakeApi(initial: PublishedTemplate[]) {
  const state = { list: initial, listError: null as unknown, contentErrors: new Set<string>(), fetched: [] as string[] };
  const api: TemplateApi = {
    async listPublished() { if (state.listError) throw state.listError; return state.list; },
    async getVersionContent(templateId, versionId) {
      state.fetched.push(versionId);
      if (state.contentErrors.has(versionId)) throw new NetworkError();
      return content(`${templateId}@${versionId}`);
    },
  };
  return { api, state };
}
const make = (initial: PublishedTemplate[]) => {
  const store = memoryStore(); const f = fakeApi(initial);
  return { store, ...f, cache: new TemplateCache({ store, api: f.api, now: () => new Date('2026-10-24T09:00:00Z') }) };
};

test('refresh downloads every published template with its content', async () => {
  const s = make([tpl('t1', 'v1', 'Plant'), tpl('t2', 'v2')]);
  await s.cache.init();
  assert.equal(await s.cache.refresh(), 'ok');
  assert.deepEqual(s.cache.list().map((t) => [t.id, t.versionId]), [['t1', 'v1'], ['t2', 'v2']]);
  assert.deepEqual(s.cache.get('t1')?.name, { en: 'Plant' });
  assert.ok(s.cache.getContent('v1'));
  assert.equal(s.cache.getContent('nope'), null);
});

test('survives a restart: it works with no connection at all', async () => {
  const s = make([tpl('t1', 'v1')]);
  await s.cache.init();
  await s.cache.refresh();
  const again = new TemplateCache({ store: s.store, api: { async listPublished() { throw new NetworkError(); }, async getVersionContent() { throw new NetworkError(); } } });
  await again.init();
  assert.equal(again.list().length, 1);
  assert.ok(again.getContent('v1'));
  assert.equal(await again.refresh(), 'offline');
  assert.equal(again.list().length, 1, 'a failed refresh keeps what it had');
});

test('unchanged versions are not downloaded again', async () => {
  const s = make([tpl('t1', 'v1')]);
  await s.cache.init();
  await s.cache.refresh();
  await s.cache.refresh();
  assert.deepEqual(s.state.fetched, ['v1']);
});

test('a re-published template: the new version is downloaded, the old one is dropped unless something still needs it', async () => {
  const s = make([tpl('t1', 'v1')]);
  await s.cache.init();
  await s.cache.refresh();
  s.state.list = [tpl('t1', 'v2')];
  await s.cache.refresh();
  assert.equal(s.cache.get('t1')?.versionId, 'v2');
  assert.equal(s.cache.getContent('v1'), null, 'not needed any more');

  s.state.list = [tpl('t1', 'v3')];
  await s.cache.refresh(['v2']);                              // an unfinished offline start still uses v2
  assert.equal(s.cache.get('t1')?.versionId, 'v3');
  assert.ok(s.cache.getContent('v2'), 'kept for the unfinished start');
});

test('a template that is no longer published disappears (after a successful refresh)', async () => {
  const s = make([tpl('t1', 'v1'), tpl('t2', 'v2')]);
  await s.cache.init();
  await s.cache.refresh();
  s.state.list = [tpl('t2', 'v2')];
  await s.cache.refresh();
  assert.deepEqual(s.cache.list().map((t) => t.id), ['t2']);
  assert.equal(s.cache.getContent('v1'), null);
});

test('templates without a published version are skipped', async () => {
  const s = make([tpl('t1', null), tpl('t2', 'v2')]);
  await s.cache.init();
  await s.cache.refresh();
  assert.deepEqual(s.cache.list().map((t) => t.id), ['t2']);
});

test('a failed list keeps everything and reports why', async () => {
  const s = make([tpl('t1', 'v1')]);
  await s.cache.init();
  await s.cache.refresh();
  s.state.listError = new NetworkError();
  assert.equal(await s.cache.refresh(), 'offline');
  s.state.listError = new ApiError(401, 'unauthenticated');
  assert.equal(await s.cache.refresh(), 'auth');
  s.state.listError = new ApiError(503, 'x');
  assert.equal(await s.cache.refresh(), 'offline');
  s.state.listError = new ApiError(403, 'forbidden');
  assert.equal(await s.cache.refresh(), 'failed');
  assert.equal(s.cache.list().length, 1);
});

test('one template failing to download does not lose the others, nor its older copy', async () => {
  const s = make([tpl('t1', 'v1'), tpl('t2', 'v2')]);
  await s.cache.init();
  await s.cache.refresh();
  s.state.list = [tpl('t1', 'v1b'), tpl('t2', 'v2b'), tpl('t3', 'v3')];
  s.state.contentErrors = new Set(['v1b', 'v3']);
  assert.equal(await s.cache.refresh(), 'failed');
  assert.equal(s.cache.get('t1')?.versionId, 'v1', 'older copy kept (the server accepts an older published version)');
  assert.equal(s.cache.get('t2')?.versionId, 'v2b', 'the others updated');
  assert.equal(s.cache.get('t3'), null, 'never downloaded: not offered offline');
});

test('a 401 while downloading content stops the refresh', async () => {
  const s = make([tpl('t1', 'v1')]);
  await s.cache.init();
  s.api.getVersionContent = async () => { throw new ApiError(401, 'unauthenticated'); };
  assert.equal(await s.cache.refresh(), 'auth');
  assert.equal(s.cache.list().length, 0);
});

test('concurrent refreshes share one run', async () => {
  const s = make([tpl('t1', 'v1')]);
  await s.cache.init();
  const [a, b] = await Promise.all([s.cache.refresh(), s.cache.refresh()]);
  assert.deepEqual([a, b], ['ok', 'ok']);
  assert.deepEqual(s.state.fetched, ['v1']);
});

test('ensure fetches a missing version once, and says false when it cannot', async () => {
  const s = make([]);
  await s.cache.init();
  assert.equal(await s.cache.ensure('t9', 'v9'), true);
  assert.ok(s.cache.getContent('v9'));
  assert.equal(await s.cache.ensure('t9', 'v9'), true);
  assert.deepEqual(s.state.fetched, ['v9']);
  s.state.contentErrors.add('vX');
  assert.equal(await s.cache.ensure('t9', 'vX'), false);
  assert.equal(s.cache.getContent('vX'), null);
});

test('clear empties the device copy; a corrupted copy is ignored', async () => {
  const s = make([tpl('t1', 'v1')]);
  await s.cache.init();
  await s.cache.refresh();
  await s.cache.clear();
  assert.equal(s.cache.list().length, 0);
  assert.equal(s.store.data.size, 0);
  s.store.data.set('mthse.templates.v1', '{{{');
  await s.cache.init();
  assert.equal(s.cache.list().length, 0);
  s.store.data.set('mthse.templates.v1', JSON.stringify({ v: 2, templates: 'x' }));
  await s.cache.init();
  assert.equal(s.cache.list().length, 0);
});

test('sites are downloaded with the templates and kept when a later download fails', async () => {
  const s = make([tpl('t1', 'v1')]);
  let fail = false;
  s.api.listSites = async () => { if (fail) throw new NetworkError(); return [{ id: 's1', name: 'Plant 1' }, { id: 's2', name: 'Plant 2' }]; };
  await s.cache.init();
  assert.deepEqual(s.cache.sites(), []);
  await s.cache.refresh();
  assert.deepEqual(s.cache.sites().map((x) => x.id), ['s1', 's2']);
  fail = true;
  assert.equal(await s.cache.refresh(), 'ok', 'templates fine, sites failing is not a failed refresh');
  assert.deepEqual(s.cache.sites().map((x) => x.id), ['s1', 's2'], 'old list kept');
  const again = new TemplateCache({ store: s.store, api: s.api });
  await again.init();
  assert.deepEqual(again.sites().map((x) => x.name), ['Plant 1', 'Plant 2'], 'survives a restart');
});

test('a copy saved before sites existed still loads', async () => {
  const s = make([]);
  s.store.data.set('mthse.templates.v1', JSON.stringify({ v: 1, templates: [], versions: {} }));
  await s.cache.init();
  assert.deepEqual(s.cache.sites(), []);
});
