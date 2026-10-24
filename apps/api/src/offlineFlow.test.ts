// The whole "start an inspection without a connection" journey: the app's real offline code (template copy, start
// draft, answers outbox) talking to the real API, with the connection cut and restored in the middle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import { batchingPlantTemplate } from '../../../packages/engines/src/template/fixtures.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';
import { createApiClient } from '../../web/src/core/apiClient.ts';
import { createEndpoints } from '../../web/src/core/endpoints.ts';
import { InspectionSync, createSyncApi } from '../../web/src/core/inspectionSync.ts';
import { OfflineStarts, createEnsuringSyncApi, createStartApi } from '../../web/src/core/offlineStart.ts';
import { TemplateCache } from '../../web/src/core/templateCache.ts';
import type { KeyValueStore } from '../../web/src/core/session.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const SITE_A = '00000000-0000-0000-0000-0000000051a1';
const USERS: Record<string, { id: string; role: RoleKey; sites: string[] }> = {
  manager:    { id: '00000000-0000-0000-0000-000000000001', role: 'hse_manager', sites: [] },
  inspector:  { id: '00000000-0000-0000-0000-000000000006', role: 'inspector', sites: [SITE_A] },
  supervisor: { id: '00000000-0000-0000-0000-000000000002', role: 'supervisor', sites: [SITE_A] },
};
const verifier: TokenVerifier = { async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); } };
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) {
    const u = USERS[uid];
    return u ? [{ userId: u.id, orgId: ORG_A, membershipId: `m-${uid}`, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : [];
  },
  async loadUser(m) { return { fullName: m.userId, email: `${m.userId}@x.com`, locale: 'ar' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds(m) { return USERS[m.roleId]!.sites; },
};

const memoryStore = (): KeyValueStore => {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
};
/** A scheduler that never fires by itself: the tests call flush() explicitly, so nothing depends on timing. */
const idleScheduler = { set: () => 0, clear: () => undefined };

type Net = { online: boolean; dropNextResponse: boolean };

async function journey(fn: (ctx: {
  base: string; net: Net; repo: MemoryWorkRepo;
  device: (who: string) => { endpoints: ReturnType<typeof createEndpoints>; syncApi: ReturnType<typeof createSyncApi> };
  admin: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
}) => Promise<void>) {
  const repo = new MemoryWorkRepo();
  for (const u of Object.values(USERS)) repo.addMember(ORG_A, u.id);
  const server = createApi({ verifier, store, work: repo, logger: { error: () => undefined }, clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const net: Net = { online: true, dropNextResponse: false };
  const fetchFn: typeof fetch = async (input, init) => {
    if (!net.online) throw new TypeError('offline');
    const res = await fetch(input, init);
    if (net.dropNextResponse) { net.dropNextResponse = false; throw new TypeError('connection lost before the answer arrived'); }
    return res;
  };
  const device = (who: string) => {
    const client = createApiClient({ baseUrl: base, getToken: async () => `tok-${who}`, fetchFn });
    return { endpoints: createEndpoints(client), syncApi: createSyncApi(client) };
  };
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: 'Bearer tok-manager', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn({ base, net, repo, device, admin }); } finally { await new Promise((r) => server.close(r)); }
}

const publish = async (admin: Parameters<Parameters<typeof journey>[0]>[0]['admin']) => {
  const t = (await admin('POST', '/templates', { name: { en: 'Batching plant' }, content: batchingPlantTemplate() })).body;
  const p = (await admin('POST', `/templates/${t.template.id}/publish`, { version: t.draftVersion })).body;
  return { templateId: t.template.id as string, versionId: p.version.id as string };
};

function offlineDevice(who: string, d: ReturnType<Parameters<Parameters<typeof journey>[0]>[0]['device']>, kv: KeyValueStore = memoryStore()) {
  const starts = new OfflineStarts({ store: kv, api: createStartApi((b) => d.endpoints.startInspection(b)) });
  const cache = new TemplateCache({
    store: kv,
    api: {
      async listPublished() { return (await d.endpoints.listTemplates({ status: 'published', limit: 100 })).items.map((t) => ({ id: t.id, name: t.name, description: t.description, publishedVersionId: t.publishedVersionId })); },
      getVersionContent: async (tid, vid) => (await d.endpoints.getVersion(tid, vid)).version.content,
      listSites: async () => (await d.endpoints.listSites()).items.map((s) => ({ id: s.id, name: s.name })),
    },
  });
  const newSync = (id: string, serverResponses = {}) => {
    const sync = new InspectionSync({ inspectionId: id, api: createEnsuringSyncApi(d.syncApi, starts), store: kv, scheduler: idleScheduler, debounceMs: 0 });
    return sync.init(serverResponses).then(() => sync);
  };
  return { who, kv, starts, cache, newSync };
}

const ANSWERS: Record<string, unknown> = { q_helmet: 'no', q_vest: 'yes', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 };

test('start offline, answer offline, reconnect: one inspection on the server with every answer, then complete it', async () => {
  await journey(async ({ net, device, admin }) => {
    const { templateId, versionId } = await publish(admin);
    const d = device('inspector');
    const app = offlineDevice('inspector', d);
    await app.starts.init(); await app.cache.init();

    assert.equal(await app.cache.refresh(), 'ok');                       // while online: templates + sites are copied to the device
    assert.equal(app.cache.get(templateId)?.versionId, versionId);
    assert.deepEqual(app.cache.sites().map((s) => s.id), []);            // (this fixture has no sites)

    net.online = false;                                                  // ---- the connection is gone ----
    assert.equal(await app.cache.ensure(templateId, versionId), true, 'the copy on the device is enough');
    const draft = await app.starts.create({ templateId, templateVersionId: versionId, siteId: SITE_A, title: 'Basement round', startedBy: USERS.inspector!.id });
    assert.deepEqual(await app.starts.ensureCreated(draft.id), { kind: 'offline' });
    assert.ok(app.cache.getContent(versionId), 'the screen can render the questions from the device copy');

    const sync = await app.newSync(draft.id);
    for (const [q, v] of Object.entries(ANSWERS)) await sync.setAnswer(q, v);
    await sync.flush();
    assert.equal(sync.getStatus(), 'offline');
    assert.equal(sync.pendingCount(), 5, 'all answers wait in the outbox');
    assert.deepEqual((await admin('GET', '/inspections?limit=100')).body.items, [], 'the server knows nothing yet');

    net.online = true;                                                   // ---- the connection is back ----
    await sync.flush();
    assert.equal(sync.getStatus(), 'saved');
    assert.equal(app.starts.list().length, 0, 'the draft was consumed');
    const list = (await admin('GET', '/inspections?limit=100')).body.items;
    assert.equal(list.length, 1, 'exactly one inspection');
    assert.equal(list[0].id, draft.id);
    assert.equal(list[0].title, 'Basement round');
    assert.equal(list[0].startedBy, USERS.inspector!.id);
    const got = (await d.endpoints.getInspection(draft.id));
    for (const [q, v] of Object.entries(ANSWERS)) assert.deepEqual(got.responses[q]?.value, v, q);

    const done = await d.endpoints.completeInspection(draft.id);
    assert.equal(done.inspection.status, 'completed');
  });
});

test('the first answer of the start request is lost on the way back: sending it again creates nothing twice', async () => {
  await journey(async ({ net, device, admin }) => {
    const { templateId, versionId } = await publish(admin);
    const app = offlineDevice('inspector', device('inspector'));
    await app.starts.init(); await app.cache.init(); await app.cache.refresh();
    const draft = await app.starts.create({ templateId, templateVersionId: versionId, siteId: SITE_A, startedBy: USERS.inspector!.id });

    net.dropNextResponse = true;                                         // the server creates it, but the app never hears back
    assert.deepEqual(await app.starts.ensureCreated(draft.id), { kind: 'offline' });
    assert.equal((await admin('GET', '/inspections?limit=100')).body.items.length, 1, 'it did reach the server');
    assert.equal(app.starts.list().length, 1, 'the app still thinks it is waiting');

    assert.deepEqual(await app.starts.ensureCreated(draft.id), { kind: 'ready' }, 'the repeat is recognised');
    assert.equal((await admin('GET', '/inspections?limit=100')).body.items.length, 1, 'still exactly one');
    assert.equal(app.starts.list().length, 0);
  });
});

test('the template is re-published while the device is offline: the inspection stays on the version that was filled in', async () => {
  await journey(async ({ net, device, admin }) => {
    const { templateId, versionId: v1 } = await publish(admin);
    const d = device('inspector');
    const app = offlineDevice('inspector', d);
    await app.starts.init(); await app.cache.init(); await app.cache.refresh();

    net.online = false;
    const draft = await app.starts.create({ templateId, templateVersionId: v1, siteId: SITE_A, startedBy: USERS.inspector!.id });
    const sync = await app.newSync(draft.id);
    await sync.setAnswer('q_helmet', 'no');

    const nd = (await admin('POST', `/templates/${templateId}/drafts`)).body.version;                       // meanwhile, at the office
    const v2 = (await admin('POST', `/templates/${templateId}/publish`, { version: nd.version })).body.version.id as string;
    assert.notEqual(v1, v2);

    net.online = true;
    await sync.flush();
    assert.equal(sync.getStatus(), 'saved');
    assert.equal((await d.endpoints.getInspection(draft.id)).inspection.templateVersionId, v1, 'not silently moved to v2');
    await app.cache.refresh(app.starts.list().map((x) => x.templateVersionId));
    assert.equal(app.cache.get(templateId)?.versionId, v2, 'new inspections will use the new version');
  });
});

test('the app is closed while offline: answers and the start survive, and everything is sent after a restart', async () => {
  await journey(async ({ net, device, admin }) => {
    const { templateId, versionId } = await publish(admin);
    const kv = memoryStore();
    const first = offlineDevice('inspector', device('inspector'), kv);
    await first.starts.init(); await first.cache.init(); await first.cache.refresh();
    net.online = false;
    const draft = await first.starts.create({ templateId, templateVersionId: versionId, siteId: SITE_A, startedBy: USERS.inspector!.id });
    const s1 = await first.newSync(draft.id);
    await s1.setAnswer('q_vest', 'yes');
    await s1.setAnswer('q_rating', 4);

    // ---- app closed and reopened later, still offline, then online ----
    const second = offlineDevice('inspector', device('inspector'), kv);
    await second.starts.init(); await second.cache.init();
    assert.equal(second.starts.get(draft.id)?.templateId, templateId, 'the start was remembered');
    assert.ok(second.cache.getContent(versionId), 'and so were the templates');
    const s2 = await second.newSync(draft.id);
    assert.equal(s2.pendingCount(), 2, 'and the unsent answers');
    net.online = true;
    await second.starts.flushAll();
    await s2.flush();
    assert.equal(s2.getStatus(), 'saved');
    const got = await device('inspector').endpoints.getInspection(draft.id);
    assert.equal(got.responses.q_vest?.value, 'yes');
    assert.equal(got.responses.q_rating?.value, 4);
    assert.equal(second.starts.list().length, 0);
  });
});

test('a start the server refuses (no permission) is reported, not silently dropped, and its answers are not sent', async () => {
  await journey(async ({ net, device, admin }) => {
    const { templateId, versionId } = await publish(admin);
    const app = offlineDevice('supervisor', device('supervisor'));
    await app.starts.init(); await app.cache.init(); await app.cache.refresh();
    net.online = false;
    // a site-scoped supervisor MUST pick a site; starting without one is refused by the server
    const draft = await app.starts.create({ templateId, templateVersionId: versionId, startedBy: USERS.supervisor!.id });
    const sync = await app.newSync(draft.id);
    await sync.setAnswer('q_helmet', 'no');
    net.online = true;
    await sync.flush();
    assert.equal(app.starts.get(draft.id)?.failedCode, 'forbidden', 'kept and marked, so the person can see and cancel it');
    assert.deepEqual((await admin('GET', '/inspections?limit=100')).body.items, [], 'nothing was created');
    // The sync engine itself reports "saved" (it has nothing left to send), so the screen shows a separate red notice
    // based on failedCode; this assertion is what that notice relies on.
    assert.ok(app.starts.get(draft.id), 'the draft is still listed, so the screen can warn and offer to cancel it');
  });
});

test('with a site chosen from the offline copy, the same supervisor can start offline', async () => {
  await journey(async ({ net, device, admin }) => {
    const { templateId, versionId } = await publish(admin);
    const app = offlineDevice('supervisor', device('supervisor'));
    await app.starts.init(); await app.cache.init(); await app.cache.refresh();
    net.online = false;
    const draft = await app.starts.create({ templateId, templateVersionId: versionId, siteId: SITE_A, startedBy: USERS.supervisor!.id });
    const sync = await app.newSync(draft.id);
    await sync.setAnswer('q_helmet', 'no');
    net.online = true;
    await sync.flush();
    assert.equal(sync.getStatus(), 'saved');
    assert.equal(app.starts.list().length, 0);
  });
});
